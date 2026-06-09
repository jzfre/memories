import { Prisma } from "@prisma/client";
import { checksum, chunkId, chunkMarkdown, documentIdFromPath, parseNote } from "@memories/shared";
import type { ValidationIssue, ParseStatus, ValidationStatus } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { writeAudit } from "../audit/index";
import { getDefaultEmbedder, toVectorLiteral, type Embedder } from "../embed/index";
import { scanVaultFiles } from "./scanner";

export interface ScanReport {
  added: number;
  updated: number;
  skipped: number;
  archived: number;
  embedded: number;
  embedErrors: number;
  incomplete: number;
  invalid: number;
  warnings: { path: string; messages: string[] }[];
}

export interface IngestDeps {
  embedder?: Embedder;
}

/** Text fed to the embedder for a chunk: title + heading give it document context. */
function chunkEmbedText(title: string, headingPath: string | null, content: string): string {
  return [title, headingPath ?? "", content].filter(Boolean).join("\n");
}

function deriveValidation(warnings: string[]): {
  parseStatus: ParseStatus;
  validationStatus: ValidationStatus;
  issues: ValidationIssue[];
} {
  const parseErr = warnings.find((w) => w.startsWith("frontmatter parse error"));
  if (parseErr) {
    return {
      parseStatus: "error",
      validationStatus: "invalid",
      issues: [{ code: "frontmatter_parse_error", message: parseErr }],
    };
  }
  const issues: ValidationIssue[] = [];
  for (const w of warnings) {
    if (w.includes("missing 'namespace'")) issues.push({ code: "missing_namespace", message: w });
    if (w.includes("missing 'sensitivity'")) issues.push({ code: "missing_sensitivity", message: w });
  }
  return { parseStatus: "parsed", validationStatus: issues.length ? "incomplete" : "valid", issues };
}

export async function scanVault(
  opts: { dryRun?: boolean; client?: string } = {},
  deps: IngestDeps = {},
): Promise<ScanReport> {
  const config = loadConfig();
  const defaults = {
    namespace: config.policy.default_namespace,
    sensitivity: config.policy.default_sensitivity,
  };
  const files = scanVaultFiles(config.vault.root);
  const report: ScanReport = { added: 0, updated: 0, skipped: 0, archived: 0, embedded: 0, embedErrors: 0, incomplete: 0, invalid: 0, warnings: [] };
  const seenIds = new Set<string>();

  // Embeddings are best-effort: probe once, and skip silently if unavailable.
  const embedder = deps.embedder ?? getDefaultEmbedder();
  const canEmbed = !opts.dryRun && embedder.dim > 0 && (await embedder.available());

  for (const f of files) {
    const sum = checksum(f.content);
    const { frontmatter, title, body, warnings } = parseNote(f.content, f.relPath, defaults);
    const validation = deriveValidation(warnings);
    const id = frontmatter.id ?? documentIdFromPath(f.relPath);
    seenIds.add(id);
    if (warnings.length) report.warnings.push({ path: f.relPath, messages: warnings });

    const existing = await prisma.document.findUnique({
      where: { id },
      select: { checksum: true, status: true },
    });
    if (existing && existing.checksum === sum && existing.status !== "archived") {
      report.skipped++;
      continue;
    }
    if (opts.dryRun) {
      existing ? report.updated++ : report.added++;
      continue;
    }

    const now = new Date();
    const chunks = chunkMarkdown(body);
    await prisma.$transaction(async (tx) => {
      await tx.document.upsert({
        where: { id },
        create: {
          id,
          path: f.relPath,
          title,
          kind: frontmatter.kind,
          namespace: frontmatter.namespace,
          sensitivity: frontmatter.sensitivity,
          status: frontmatter.status,
          confidence: frontmatter.confidence,
          checksum: sum,
          frontmatter: frontmatter.raw as Prisma.InputJsonValue,
          parseStatus: validation.parseStatus,
          validationStatus: validation.validationStatus,
          validationIssues: validation.issues as unknown as Prisma.InputJsonValue,
          embeddingStatus: canEmbed ? "pending" : "disabled",
          embeddedAt: null,
          lastError: null,
          bodyText: body,
          createdAt: now,
          updatedAt: now,
          indexedAt: now,
        },
        update: {
          path: f.relPath,
          title,
          kind: frontmatter.kind,
          namespace: frontmatter.namespace,
          sensitivity: frontmatter.sensitivity,
          status: frontmatter.status,
          confidence: frontmatter.confidence,
          checksum: sum,
          frontmatter: frontmatter.raw as Prisma.InputJsonValue,
          parseStatus: validation.parseStatus,
          validationStatus: validation.validationStatus,
          validationIssues: validation.issues as unknown as Prisma.InputJsonValue,
          embeddingStatus: canEmbed ? "pending" : "disabled",
          embeddedAt: null,
          lastError: null,
          bodyText: body,
          updatedAt: now,
          indexedAt: now,
        },
      });
      await tx.chunk.deleteMany({ where: { documentId: id } });
      if (chunks.length) {
        await tx.chunk.createMany({
          data: chunks.map((c) => ({
            id: chunkId(id, c.chunkIndex),
            documentId: id,
            chunkIndex: c.chunkIndex,
            headingPath: c.headingPath,
            title,
            meta: [frontmatter.namespace, frontmatter.kind, ...frontmatter.tags].filter(Boolean).join(" "),
            content: c.content,
            tokenCount: c.tokenCount,
          })),
        });
      }
    });

    // Compute embeddings for this document's chunks (best-effort, outside the txn).
    if (canEmbed && chunks.length) {
      try {
        const vectors = await embedder.embedDocuments(
          chunks.map((c) => chunkEmbedText(title, c.headingPath, c.content)),
        );
        await Promise.all(
          chunks.map((c, i) =>
            prisma.$executeRaw`UPDATE chunks SET embedding = ${toVectorLiteral(vectors[i])}::vector WHERE id = ${chunkId(id, c.chunkIndex)}`,
          ),
        );
        await prisma.document.update({ where: { id }, data: { embeddingStatus: "current", embeddedAt: now } });
        report.embedded += chunks.length;
      } catch (e) {
        await prisma.document.update({
          where: { id },
          data: { embeddingStatus: "error", lastError: (e as Error).message },
        });
        report.embedErrors += 1;
      }
    } else if (canEmbed && chunks.length === 0) {
      // Empty note: nothing to embed, but it is not "pending".
      await prisma.document.update({ where: { id }, data: { embeddingStatus: "current", embeddedAt: now } });
    }
    existing ? report.updated++ : report.added++;
    if (validation.validationStatus === "incomplete") report.incomplete++;
    if (validation.validationStatus === "invalid") report.invalid++;
  }

  if (!opts.dryRun) {
    const live = await prisma.document.findMany({
      where: { status: { not: "archived" } },
      select: { id: true },
    });
    const toArchive = live.filter((d) => !seenIds.has(d.id)).map((d) => d.id);
    if (toArchive.length) {
      await prisma.document.updateMany({
        where: { id: { in: toArchive } },
        data: { status: "archived" },
      });
      report.archived = toArchive.length;
    }
  }

  await writeAudit({
    actor: config.actor,
    client: opts.client ?? "cli",
    action: "ingest.scan",
    namespace: "n/a",
    sensitivityRequested: null,
    inputs: { dryRun: opts.dryRun ?? false },
    returnedDocumentIds: [],
    approved: true,
  });

  return report;
}

/**
 * Backfill embeddings for chunks that don't have one yet (e.g. after enabling
 * embeddings, or after the pgvector migration). Best-effort and resumable: it loops
 * until no null-embedding chunks remain. Returns the number embedded.
 */
export async function embedPending(deps: IngestDeps = {}, batchSize = 32): Promise<{ embedded: number }> {
  const embedder = deps.embedder ?? getDefaultEmbedder();
  if (!(embedder.dim > 0 && (await embedder.available()))) return { embedded: 0 };

  let embedded = 0;
  for (;;) {
    const rows = await prisma.$queryRaw<
      { id: string; title: string; heading_path: string | null; content: string }[]
    >(Prisma.sql`SELECT id, title, heading_path, content FROM chunks WHERE embedding IS NULL LIMIT ${batchSize}`);
    if (rows.length === 0) break;
    const vectors = await embedder.embedDocuments(
      rows.map((r) => chunkEmbedText(r.title, r.heading_path, r.content)),
    );
    await Promise.all(
      rows.map((r, i) =>
        prisma.$executeRaw`UPDATE chunks SET embedding = ${toVectorLiteral(vectors[i])}::vector WHERE id = ${r.id}`,
      ),
    );
    embedded += rows.length;
  }
  await prisma.$executeRawUnsafe(
    `UPDATE documents d SET embedding_status='current', embedded_at=now()
     WHERE d.embedding_status IN ('pending','error','disabled')
       AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id=d.id AND c.embedding IS NULL)`,
  );
  return { embedded };
}
