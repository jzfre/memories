import type { EmbeddingStatus, ValidationStatus } from "@memories/shared";
import { prisma } from "../db/client";

export const REVIEW_INTERVALS_DAYS: Record<string, number> = {
  runbook: 90,
  finding: 60,
  decision: 120,
  "project-context": 60,
  "reading-note": 90,
  "brain-gym-memo": 30,
  note: 180,
};

export const DEFAULT_REVIEW_INTERVAL_DAYS = 180;

export function isDocStale(kind: string, updatedAt: Date, now: Date): boolean {
  const intervalDays = REVIEW_INTERVALS_DAYS[kind] ?? DEFAULT_REVIEW_INTERVAL_DAYS;
  const msElapsed = now.getTime() - updatedAt.getTime();
  return msElapsed > intervalDays * 24 * 60 * 60 * 1000;
}

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

export interface StaleDocument {
  path: string;
  kind: string;
  updatedAt: Date;
}

export interface IndexStatus {
  totals: {
    documents: number;
    chunks: number;
    embedded: number;
    stale_documents: number;
    /** Most common non-null embedding_model across all chunks, or null when none. */
    embedding_model: string | null;
    /**
     * Dimensions of the stored vectors. The column type is vector(768), so when a model
     * is present this is always 768; null when no chunks have been embedded.
     */
    embedding_dimensions: number | null;
  };
  validation: Record<ValidationStatus, number>;
  embedding: Record<EmbeddingStatus, number>;
  issues: IndexStatusIssue[];
  stale_documents: StaleDocument[];
}

export async function computeIndexStatus(): Promise<IndexStatus> {
  const now = new Date();
  const docs = await prisma.document.findMany({
    where: { status: { not: "archived" } },
    select: {
      path: true,
      kind: true,
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
  // Most common non-null embedding_model (mode), or null if none have been embedded.
  const modelRows = await prisma.$queryRaw<{ embedding_model: string | null }[]>`
    SELECT embedding_model
    FROM chunks
    WHERE embedding_model IS NOT NULL
    GROUP BY embedding_model
    ORDER BY count(*) DESC
    LIMIT 1`;
  const topModel: string | null = modelRows.length > 0 ? modelRows[0].embedding_model : null;

  const validation: Record<ValidationStatus, number> = { valid: 0, incomplete: 0, invalid: 0 };
  const embedding: Record<EmbeddingStatus, number> = { disabled: 0, pending: 0, current: 0, stale: 0, error: 0 };
  const issues: IndexStatusIssue[] = [];
  const stale_documents: StaleDocument[] = [];

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
    if (d.kind && isDocStale(d.kind, d.updatedAt, now)) {
      stale_documents.push({ path: d.path, kind: d.kind, updatedAt: d.updatedAt });
    }
  }

  return {
    totals: {
      documents: docs.length,
      chunks,
      embedded: embeddedRows[0].count,
      stale_documents: stale_documents.length,
      embedding_model: topModel,
      // The column type is vector(768); report dimensions when a model is present.
      embedding_dimensions: topModel ? 768 : null,
    },
    validation,
    embedding,
    issues,
    stale_documents,
  };
}
