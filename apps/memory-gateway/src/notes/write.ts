/**
 * Direct-write notes module (peer-work model): AI writes vault files immediately,
 * no approve/reject pipeline. The owner reviews by editing the file (Syncthing
 * versioning is the undo). Guards are the ONLY gate: secrets and frontmatter
 * injection are refused; everything else lands.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { documentIdFromPath } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { writeAudit } from "../audit/index";
import { scanVault } from "../ingest/indexer";

// ---------------------------------------------------------------------------
// Secret detector (recovered from the deleted proposals/validate.ts)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  // password[:=] <value>; valid op:// references are stripped before scanning
  /password\s*[:=]\s*\S+/i,
  /Bearer [A-Za-z0-9._-]{20,}/,
  /(secret|token|key)\s*[:=]\s*[A-Fa-f0-9]{40,}/i,
  /(secret|token|key)\s*[:=]\s*[A-Za-z0-9+/=]{40,}/i,
];

/**
 * Returns a list of matched secret patterns found in `text`.
 * Explicitly ignores `secret_ref: op://…` 1Password-style references.
 */
export function detectSecrets(text: string): string[] {
  const sanitized = text.replace(/secret_ref:\s*op:\/\/[^\s]*/gi, "");
  const matches: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(sanitized)) matches.push(pattern.source);
  }
  return matches;
}

const ALLOWED_SENSITIVITIES = ["public", "internal"];

// ---------------------------------------------------------------------------
// Small helpers (recovered/adapted from the deleted proposals/index.ts)
// ---------------------------------------------------------------------------

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lowercase + strip anything that could inject a new YAML line/key. */
function sanitizeKind(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\-_]/g, "") || "note";
}

/**
 * Tags charset (lowercase alnum plus . _ / -), preserving '/' for hierarchical tags
 * like `db/postgres`. Defense-in-depth against YAML injection via tag values.
 */
function sanitizeTag(value: string): string {
  return value.replace(/[^a-z0-9._/-]/g, "");
}

/** Wrap a string as a YAML double-quoted scalar, escaping backslashes/quotes. */
function quoteYamlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function frontmatterDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Find the end of the frontmatter block (the position of the character after the
 * closing "---\n") and return the character offset. Returns null if the content has
 * no leading frontmatter block.
 */
function frontmatterEndOffset(content: string): number | null {
  if (!content.startsWith("---")) return null;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return null;
  const rest = content.slice(firstNewline + 1);
  const match = rest.match(/^---[ \t]*$/m);
  if (!match || match.index === undefined) return null;
  const closingStart = firstNewline + 1 + match.index;
  const closingEnd = closingStart + 3; // "---"
  let off = closingEnd;
  if (content[off] === "\r") off++;
  if (content[off] === "\n") off++;
  return off;
}

function assertNoFrontmatterInjection(content: string): void {
  const trimmed = content.trimStart();
  const firstLine = trimmed.split("\n")[0] ?? "";
  if (/^---\s*$/.test(firstLine)) {
    throw new Error(
      "Content must not begin with a frontmatter block (a line of just \"---\"); the gateway writes frontmatter itself. Provide the body only.",
    );
  }
}

function assertNoSecrets(text: string): void {
  const matches = detectSecrets(text);
  if (matches.length > 0) {
    throw new Error(
      "Refusing to write: this looks like it contains credentials or secrets. Reference secrets as `secret_ref: op://vault/item` instead of embedding them.",
    );
  }
}

/** Atomic-ish write: write to a temp file in the same directory, then rename over the target. */
function atomicWrite(filePath: string, dir: string, fileName: string, content: string): void {
  const tmpPath = join(dir, `.tmp-${fileName}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * Resolve+validate the target folder (relative to the vault root):
 *  - default (no folder given) is "00-inbox", auto-created if missing.
 *  - an explicit folder must normalize to a path with no ".."/leading "."/"_"
 *    segments, must resolve inside the vault root, and must already exist as a
 *    directory (we never create arbitrary trees on the owner's behalf) — except
 *    "00-inbox" itself, which is always auto-created.
 * Returns the normalized (slash-joined, no leading/trailing slash) folder path.
 */
function resolveTargetFolder(vaultRoot: string, folderInput: string | undefined): string {
  const raw = folderInput ?? "00-inbox";
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  const invalidSegment = segments.find((s) => s === ".." || s.startsWith(".") || s.startsWith("_"));
  if (segments.length === 0 || normalized.includes("..") || invalidSegment) {
    throw new Error(
      `Invalid folder "${raw}": folder path segments must not start with "." or "_" and must not contain "..".`,
    );
  }

  const resolvedTarget = resolve(vaultRoot, normalized);
  const resolvedVaultRoot = resolve(vaultRoot);
  if (resolvedTarget !== resolvedVaultRoot && !resolvedTarget.startsWith(resolvedVaultRoot + sep)) {
    throw new Error(`Invalid folder "${raw}": resolves outside the vault.`);
  }

  if (normalized === "00-inbox") {
    mkdirSync(resolvedTarget, { recursive: true });
    return normalized;
  }

  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
    throw new Error(
      `Folder "${normalized}" does not exist in the vault. \`folder\` must be an existing vault folder ` +
        `(create it yourself first, or omit \`folder\` to land in 00-inbox).`,
    );
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// writeNote
// ---------------------------------------------------------------------------

export interface WriteNoteInput {
  title: string;
  content: string;
  kind?: string;
  tags?: string[];
  sensitivity?: string;
  folder?: string;
  source_refs?: string[];
}

export interface WriteNoteResult {
  document_id: string;
  path: string;
}

export async function writeNote(input: WriteNoteInput, ctx: { client: string }): Promise<WriteNoteResult> {
  const config = loadConfig();
  const vaultRoot = config.vault.root;

  // --- Guards (the ONLY blocks) ---
  assertNoSecrets(input.content + "\n" + input.title);
  assertNoFrontmatterInjection(input.content);

  const sensitivity = input.sensitivity ?? "internal";
  if (!ALLOWED_SENSITIVITIES.includes(sensitivity)) {
    throw new Error(`Invalid sensitivity "${sensitivity}". Allowed values: ${ALLOWED_SENSITIVITIES.join(", ")}.`);
  }

  // --- Folder resolution ---
  const folder = resolveTargetFolder(vaultRoot, input.folder);
  const targetDir = join(vaultRoot, folder);

  // --- Filename (collision-safe) ---
  const slug = slugify(input.title);
  let fileName = `${slug}.md`;
  let suffix = 2;
  while (existsSync(join(targetDir, fileName))) {
    fileName = `${slug}-${suffix}.md`;
    suffix++;
  }
  const filePath = join(targetDir, fileName);
  const relPath = `${folder}/${fileName}`;

  // --- Frontmatter + body ---
  const kind = sanitizeKind(input.kind ?? "note");
  const tags = (input.tags ?? []).map((t) => sanitizeTag(t));
  const sourceRefs = input.source_refs ?? [];

  const fmLines = ["---", `kind: ${kind}`, `sensitivity: ${sensitivity}`, `tags: [${tags.join(", ")}]`];
  if (sourceRefs.length > 0) {
    fmLines.push(`source_refs: [${sourceRefs.map((r) => quoteYamlString(r)).join(", ")}]`);
  }
  fmLines.push(`created: ${frontmatterDate(new Date())}`, "---");

  const md = `${fmLines.join("\n")}\n\n# ${input.title}\n\n${input.content}\n`;

  // --- Atomic write ---
  atomicWrite(filePath, targetDir, fileName, md);

  // --- Index immediately ---
  await scanVault({ client: ctx.client }, {});
  const documentId = documentIdFromPath(relPath);

  await writeAudit({
    actor: config.actor,
    client: ctx.client,
    action: "memory.write_note",
    namespace: folder,
    sensitivityRequested: sensitivity,
    inputs: input,
    returnedDocumentIds: [documentId],
    approved: true,
  });

  return { document_id: documentId, path: relPath };
}

// ---------------------------------------------------------------------------
// updateNote
// ---------------------------------------------------------------------------

export interface UpdateNoteResult {
  document_id: string;
  path: string;
}

export async function updateNote(
  documentId: string,
  content: string,
  ctx: { client: string },
): Promise<UpdateNoteResult> {
  const config = loadConfig();
  const vaultRoot = config.vault.root;

  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }

  const filePath = join(vaultRoot, doc.path);
  const resolvedFilePath = resolve(filePath);
  const resolvedVaultRoot = resolve(vaultRoot);
  if (!resolvedFilePath.startsWith(resolvedVaultRoot + sep)) {
    throw new Error(
      `Path traversal detected: resolved path "${resolvedFilePath}" is outside vault root "${resolvedVaultRoot}".`,
    );
  }

  // --- Guards (same two content guards as writeNote; no title here) ---
  assertNoSecrets(content);
  assertNoFrontmatterInjection(content);

  const originalContent = readFileSync(filePath, "utf8");
  const fmEnd = frontmatterEndOffset(originalContent);
  const newContent = fmEnd !== null ? `${originalContent.slice(0, fmEnd)}\n${content}\n` : `${content}\n`;

  const dir = dirname(resolvedFilePath);
  const fileName = doc.path.split("/").pop() ?? doc.path;
  atomicWrite(resolvedFilePath, dir, fileName, newContent);

  await scanVault({ client: ctx.client }, {});

  await writeAudit({
    actor: config.actor,
    client: ctx.client,
    action: "memory.update_note",
    namespace: doc.namespace,
    sensitivityRequested: doc.sensitivity,
    inputs: { document_id: documentId, content },
    returnedDocumentIds: [documentId],
    approved: true,
  });

  return { document_id: documentId, path: doc.path };
}
