/**
 * Direct-write notes module (peer-work model): AI writes vault files immediately,
 * no approve/reject pipeline. The owner reviews by editing the file (Syncthing
 * versioning is the undo). Guards are the ONLY gate: secrets and frontmatter
 * injection are refused; everything else lands.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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

/**
 * The filename IS the title (both Obsidian and SilverBullet display the page name),
 * so keep it human-readable: preserve case and spaces, strip only characters that
 * break filesystems or [[wikilinks]]/#tags, collapse whitespace, cap the length.
 */
function fileTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^\[\]{}`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || "Untitled";
}

/**
 * Models often start `content` with their own `# Title` even though the gateway
 * prepends the canonical one — strip a single leading H1 so notes always have
 * exactly one H1 (the title).
 */
function stripLeadingH1(content: string): string {
  return content.replace(/^\s*#[ \t][^\n]*\n+/, "");
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

/**
 * Assert that `target` stays inside the vault root even after symlink resolution.
 * `resolve()`/`startsWith()` checks operate on strings and do NOT follow symlinks, so a
 * symlinked directory inside the vault could redirect a write outside it. We canonicalize
 * both paths with realpathSync and compare. `target` must already exist (callers check).
 * `vaultRoot` is realpathed too so a vault mounted under a symlinked prefix (e.g. macOS
 * /var → /private/var) still compares correctly.
 */
function assertInsideVault(target: string, vaultRoot: string, label: string): void {
  const realVaultRoot = realpathSync(vaultRoot);
  const realTarget = realpathSync(target);
  if (realTarget !== realVaultRoot && !realTarget.startsWith(realVaultRoot + sep)) {
    throw new Error(`Invalid ${label}: resolves (via a symlink) outside the vault.`);
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
 *  - folder is required; there is no inbox fallback.
 *  - it must normalize to a path with no ".."/leading "."/"_" segments,
 *    must resolve inside the vault root, and must already exist as a directory
 *    (we never create arbitrary trees on the owner's behalf).
 * Returns the normalized (slash-joined, no leading/trailing slash) folder path.
 */
function resolveTargetFolder(vaultRoot: string, folderInput: string | undefined): string {
  if (!folderInput) {
    throw new Error(
      "Folder is required. Choose an existing vault section folder such as `0x05 Projects/Personal`; there is no inbox fallback.",
    );
  }

  const raw = folderInput;
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

  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
    throw new Error(
      `Folder "${normalized}" does not exist in the vault. \`folder\` must be an existing vault folder ` +
        `(create it yourself first, or choose one of the 0xNN section folders).`,
    );
  }

  // Symlink-safe containment: resolve()/startsWith above is pure string math, so a
  // symlinked directory inside the vault (e.g. propagated by Syncthing, or planted by
  // another local process) could still point OUTSIDE. Canonicalize both sides and
  // re-check before we trust the target.
  assertInsideVault(resolvedTarget, resolvedVaultRoot, `folder "${raw}"`);

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
  folder: string;
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

  // --- Filename (human-readable title, collision-safe) ---
  const base = fileTitle(input.title);
  let fileName = `${base}.md`;
  let suffix = 2;
  while (existsSync(join(targetDir, fileName))) {
    fileName = `${base} ${suffix}.md`;
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

  const body = stripLeadingH1(input.content);
  const md = `${fmLines.join("\n")}\n\n# ${input.title.trim()}\n\n${body}\n`;

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
  // Symlink-safe re-check on the containing directory (which exists): the string check
  // above does not follow symlinks, so a symlinked directory could redirect the write out.
  assertInsideVault(dirname(resolvedFilePath), resolvedVaultRoot, `document path "${doc.path}"`);

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
