import { Prisma } from "@prisma/client";
import { checksum, chunkId, chunkMarkdown, documentIdFromPath, parseNote } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { writeAudit } from "../audit/index";
import { scanVaultFiles } from "./scanner";

export interface ScanReport {
  added: number;
  updated: number;
  skipped: number;
  archived: number;
  warnings: { path: string; messages: string[] }[];
}

export async function scanVault(opts: { dryRun?: boolean; client?: string } = {}): Promise<ScanReport> {
  const config = loadConfig();
  const defaults = {
    namespace: config.policy.default_namespace,
    sensitivity: config.policy.default_sensitivity,
  };
  const files = scanVaultFiles(config.vault.root);
  const report: ScanReport = { added: 0, updated: 0, skipped: 0, archived: 0, warnings: [] };
  const seenIds = new Set<string>();

  for (const f of files) {
    const sum = checksum(f.content);
    const { frontmatter, title, body, warnings } = parseNote(f.content, f.relPath, defaults);
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
            content: c.content,
            tokenCount: c.tokenCount,
          })),
        });
      }
    });
    existing ? report.updated++ : report.added++;
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
