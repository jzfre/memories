import { Prisma } from "@prisma/client";
import { UNTRUSTED_CONTENT_NOTE, type SearchResponse } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { resolveScope } from "../policy/index";
import { writeAudit, writeTrace } from "../audit/index";

export interface SearchArgs {
  query: string;
  namespaces?: string[];
  sensitivity_allowed?: string[];
  top_k?: number;
}

interface Row {
  document_id: string;
  chunk_id: string;
  title: string;
  path: string;
  kind: string;
  confidence: string | null;
  status: string;
  review_state: string | null;
  snippet: string;
  score: number;
}

export async function search(args: SearchArgs, ctx: { client: string }): Promise<SearchResponse> {
  const { actor } = loadConfig();
  const scope = resolveScope({
    namespaces: args.namespaces,
    sensitivityAllowed: args.sensitivity_allowed,
  });
  const topK = args.top_k ?? 10;

  if (scope.namespaces.length === 0 || scope.sensitivities.length === 0) {
    await writeAudit({
      actor,
      client: ctx.client,
      action: "memory.search",
      namespace: (args.namespaces ?? []).join(",") || "n/a",
      sensitivityRequested: (args.sensitivity_allowed ?? []).join(",") || null,
      inputs: args,
      returnedDocumentIds: [],
      approved: false,
    });
    const traceId = await writeTrace({
      actor,
      query: args.query,
      namespaceFilter: scope.namespaces,
      selectedChunkIds: [],
      selectedDocumentIds: [],
    });
    return { results: [], trace_id: traceId, safety_note: UNTRUSTED_CONTENT_NOTE };
  }

  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT
      d.id AS document_id,
      c.id AS chunk_id,
      d.title AS title,
      d.path AS path,
      d.kind AS kind,
      d.confidence AS confidence,
      d.status AS status,
      d.frontmatter->>'review_state' AS review_state,
      ts_headline('english', c.content, websearch_to_tsquery('english', ${args.query}),
        'StartSel=**,StopSel=**,MaxFragments=2,MaxWords=30,MinWords=8') AS snippet,
      ts_rank(c.tsv, websearch_to_tsquery('english', ${args.query})) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.tsv @@ websearch_to_tsquery('english', ${args.query})
      AND d.namespace IN (${Prisma.join(scope.namespaces)})
      AND d.sensitivity IN (${Prisma.join(scope.sensitivities)})
      AND d.status <> 'archived'
    ORDER BY score DESC
    LIMIT ${topK}
  `);

  const results = rows.map((r) => ({
    document_id: r.document_id,
    chunk_id: r.chunk_id,
    title: r.title,
    snippet: r.snippet,
    score: Number(r.score),
    source: {
      path: r.path,
      kind: r.kind,
      confidence: r.confidence,
      status: r.status,
      review_state: r.review_state,
    },
  }));

  const documentIds = [...new Set(rows.map((r) => r.document_id))];
  const traceId = await writeTrace({
    actor,
    query: args.query,
    namespaceFilter: scope.namespaces,
    selectedChunkIds: rows.map((r) => r.chunk_id),
    selectedDocumentIds: documentIds,
    rankingDebug: { top_k: topK, ranking: "ts_rank" },
  });
  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.search",
    namespace: scope.namespaces.join(","),
    sensitivityRequested: scope.sensitivities.join(","),
    inputs: args,
    returnedDocumentIds: documentIds,
    approved: true,
  });

  return { results, trace_id: traceId, safety_note: UNTRUSTED_CONTENT_NOTE };
}
