import type { EmbeddingStatus, ValidationStatus } from "@memories/shared";
import { prisma } from "../db/client";

/** A stored 'current' embedding is 'stale' once its document changed after embeddedAt. */
export function deriveEmbeddingFreshness(doc: {
  embeddingStatus: string;
  embeddedAt: Date | null;
  updatedAt: Date;
}): EmbeddingStatus {
  if (doc.embeddingStatus === "current" && doc.embeddedAt && doc.updatedAt > doc.embeddedAt) {
    return "stale";
  }
  return doc.embeddingStatus as EmbeddingStatus;
}

export interface IndexStatusIssue {
  path: string;
  validationStatus: ValidationStatus;
  validationIssues: unknown;
  embeddingStatus: EmbeddingStatus;
}

export interface IndexStatus {
  totals: { documents: number; chunks: number; embedded: number };
  validation: Record<ValidationStatus, number>;
  embedding: Record<EmbeddingStatus, number>;
  issues: IndexStatusIssue[];
}

export async function computeIndexStatus(): Promise<IndexStatus> {
  const docs = await prisma.document.findMany({
    where: { status: { not: "archived" } },
    select: {
      path: true,
      validationStatus: true,
      validationIssues: true,
      embeddingStatus: true,
      embeddedAt: true,
      updatedAt: true,
    },
  });
  const chunks = await prisma.chunk.count();
  const embeddedRows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM chunks WHERE embedding IS NOT NULL`;

  const validation: Record<ValidationStatus, number> = { valid: 0, incomplete: 0, invalid: 0 };
  const embedding: Record<EmbeddingStatus, number> = { disabled: 0, pending: 0, current: 0, stale: 0, error: 0 };
  const issues: IndexStatusIssue[] = [];

  for (const d of docs) {
    validation[d.validationStatus as ValidationStatus]++;
    const ef = deriveEmbeddingFreshness(d);
    embedding[ef]++;
    if (d.validationStatus !== "valid" || ef === "stale" || ef === "pending" || ef === "error") {
      issues.push({
        path: d.path,
        validationStatus: d.validationStatus as ValidationStatus,
        validationIssues: d.validationIssues,
        embeddingStatus: ef,
      });
    }
  }

  return {
    totals: { documents: docs.length, chunks, embedded: embeddedRows[0].count },
    validation,
    embedding,
    issues,
  };
}
