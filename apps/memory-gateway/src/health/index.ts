import { prisma } from "../db/client";
import { loadConfig } from "../config/index";
import { writeAudit } from "../audit/index";

export interface HealthStatus {
  status: "ok" | "degraded";
  db: "ok" | "error";
  documents: number;
  chunks: number;
  last_indexed_at: Date | null;
}

export async function healthStatus(ctx: { client?: string } = {}): Promise<HealthStatus> {
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "error";
  }
  const documents = db === "ok" ? await prisma.document.count() : 0;
  const chunks = db === "ok" ? await prisma.chunk.count() : 0;
  const agg = db === "ok" ? await prisma.document.aggregate({ _max: { indexedAt: true } }) : null;

  // Audit lightly; never let an audit failure (e.g. db down) break the health check.
  try {
    const { actor } = loadConfig();
    await writeAudit({
      actor,
      client: ctx.client ?? "system",
      action: "health.status",
      namespace: "n/a",
      sensitivityRequested: null,
      inputs: {},
      returnedDocumentIds: [],
      approved: true,
    });
  } catch {
    /* health must not fail because auditing failed */
  }

  return {
    status: db === "ok" ? "ok" : "degraded",
    db,
    documents,
    chunks,
    last_indexed_at: agg?._max.indexedAt ?? null,
  };
}
