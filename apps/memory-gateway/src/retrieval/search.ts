import { Prisma } from "@prisma/client";
import { UNTRUSTED_CONTENT_NOTE, type SearchResponse } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { resolveScope } from "../policy/index";
import { writeAudit, writeTrace } from "../audit/index";
import { getDefaultEmbedder, toVectorLiteral, type Embedder } from "../embed/index";

export interface SearchArgs {
  query: string;
  namespaces?: string[];
  sensitivity_allowed?: string[];
  top_k?: number;
}

export interface SearchDeps {
  embedder?: Embedder;
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
}

// Reciprocal-rank-fusion constant. Larger = flatter contribution from deep ranks.
const FUSE_K = 60;

const HEADLINE_OPTS = "StartSel=**,StopSel=**,MaxFragments=2,MaxWords=30,MinWords=8";

export async function search(
  args: SearchArgs,
  ctx: { client: string },
  deps: SearchDeps = {},
): Promise<SearchResponse> {
  const { actor } = loadConfig();
  const scope = resolveScope({
    namespaces: args.namespaces,
    sensitivityAllowed: args.sensitivity_allowed,
  });
  const topK = args.top_k ?? 10;
  const embedder = deps.embedder ?? getDefaultEmbedder();

  // Fail closed: an empty namespace OR sensitivity intersection denies without ever
  // touching the corpus (no FTS, no vector), and still records the denial.
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

  const candLimit = Math.max(topK * 4, 20);
  const scopeWhere = Prisma.sql`
    d.namespace IN (${Prisma.join(scope.namespaces)})
    AND d.sensitivity IN (${Prisma.join(scope.sensitivities)})
    AND d.status <> 'archived'`;
  const headlineQ = Prisma.sql`websearch_to_tsquery('english', ${args.query})`;

  // ---- Full-text candidates (precision-first AND, OR-fallback for recall) ----
  const ftsQuery = (tsq: Prisma.Sql) =>
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        d.id AS document_id, c.id AS chunk_id, d.title AS title, d.path AS path, d.kind AS kind,
        d.confidence AS confidence, d.status AS status, d.frontmatter->>'review_state' AS review_state,
        ts_headline('english', coalesce(nullif(c.content, ''), c.title), ${tsq}, ${HEADLINE_OPTS}) AS snippet
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.tsv @@ ${tsq} AND ${scopeWhere}
      ORDER BY ts_rank(c.tsv, ${tsq}) DESC
      LIMIT ${candLimit}`);

  const andQuery = Prisma.sql`websearch_to_tsquery('english', ${args.query})`;
  const orQuery = Prisma.sql`replace(plainto_tsquery('english', ${args.query})::text, ' & ', ' | ')::tsquery`;
  let ftsRows = await ftsQuery(andQuery);
  let usedOrFallback = false;
  if (ftsRows.length === 0) {
    ftsRows = await ftsQuery(orQuery);
    usedOrFallback = true;
  }

  // ---- Vector candidates (best-effort; semantic recall) ----
  let vecRows: Row[] = [];
  let vectorUsed = false;
  try {
    if (embedder.dim > 0 && (await embedder.available())) {
      const qvec = toVectorLiteral(await embedder.embedQuery(args.query));
      vecRows = await prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT
          d.id AS document_id, c.id AS chunk_id, d.title AS title, d.path AS path, d.kind AS kind,
          d.confidence AS confidence, d.status AS status, d.frontmatter->>'review_state' AS review_state,
          ts_headline('english', coalesce(nullif(c.content, ''), c.title), ${headlineQ}, ${HEADLINE_OPTS}) AS snippet
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL AND ${scopeWhere}
        ORDER BY c.embedding <=> ${qvec}::vector ASC
        LIMIT ${candLimit}`);
      vectorUsed = true;
    }
  } catch {
    // Embedding endpoint unavailable/slow — degrade gracefully to full-text only.
  }

  // ---- Reciprocal-rank fusion across the two ranked candidate lists ----
  const fused = new Map<string, { row: Row; score: number }>();
  const fuse = (rows: Row[]) =>
    rows.forEach((row, i) => {
      const inc = 1 / (FUSE_K + i + 1);
      const e = fused.get(row.chunk_id);
      if (e) e.score += inc;
      else fused.set(row.chunk_id, { row, score: inc });
    });
  fuse(ftsRows);
  fuse(vecRows);
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);

  const results = ranked.map(({ row, score }) => ({
    document_id: row.document_id,
    chunk_id: row.chunk_id,
    title: row.title,
    snippet: row.snippet,
    score,
    source: {
      path: row.path,
      kind: row.kind,
      confidence: row.confidence,
      status: row.status,
      review_state: row.review_state,
    },
  }));

  const selectedChunkIds = ranked.map((r) => r.row.chunk_id);
  const documentIds = [...new Set(ranked.map((r) => r.row.document_id))];
  const traceId = await writeTrace({
    actor,
    query: args.query,
    namespaceFilter: scope.namespaces,
    selectedChunkIds,
    selectedDocumentIds: documentIds,
    rankingDebug: {
      top_k: topK,
      ranking: "hybrid_rrf",
      vector: vectorUsed,
      or_fallback: usedOrFallback,
      fts_candidates: ftsRows.length,
      vector_candidates: vecRows.length,
    },
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
