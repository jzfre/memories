import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { resolveScope } from "../policy/index";
import { writeAudit } from "../audit/index";

export interface RecentDocument {
  document_id: string;
  title: string;
  path: string;
  kind: string;
  namespace: string;
  indexed_at: Date | null;
}

export interface TraceExplanation {
  trace_id: string;
  query: string;
  namespace_filter: string[];
  selected_document_ids: string[];
  selected_chunk_ids: string[];
  ranking_debug: unknown;
  created_at: Date;
}

export async function recentDocuments(
  { limit }: { limit?: number },
  ctx: { client: string },
): Promise<RecentDocument[]> {
  const { actor } = loadConfig();
  const scope = resolveScope({});
  const take = Math.min(limit ?? 10, 50);

  const docs = await prisma.document.findMany({
    where: {
      namespace: { in: scope.namespaces },
      sensitivity: { in: scope.sensitivities },
      status: { not: "archived" },
    },
    orderBy: { indexedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      path: true,
      kind: true,
      namespace: true,
      indexedAt: true,
    },
  });

  const results: RecentDocument[] = docs.map((d) => ({
    document_id: d.id,
    title: d.title,
    path: d.path,
    kind: d.kind,
    namespace: d.namespace,
    indexed_at: d.indexedAt,
  }));

  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.recent",
    namespace: scope.namespaces.join(","),
    sensitivityRequested: scope.sensitivities.join(","),
    inputs: { limit },
    returnedDocumentIds: results.map((r) => r.document_id),
    approved: true,
  });

  return results;
}

export async function explainSources(
  traceId: string,
  ctx: { client: string },
): Promise<TraceExplanation | null> {
  const { actor } = loadConfig();

  const trace = await prisma.retrievalTrace.findUnique({ where: { id: traceId } });
  const found = !!trace;

  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.explain_sources",
    namespace: "n/a",
    sensitivityRequested: null,
    inputs: { trace_id: traceId },
    returnedDocumentIds: found ? trace!.selectedDocumentIds : [],
    approved: found,
  });

  if (!trace) return null;

  return {
    trace_id: trace.id,
    query: trace.query,
    namespace_filter: trace.namespaceFilter,
    selected_document_ids: trace.selectedDocumentIds,
    selected_chunk_ids: trace.selectedChunkIds,
    ranking_debug: trace.rankingDebug,
    created_at: trace.createdAt,
  };
}
