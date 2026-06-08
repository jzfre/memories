# Review Pack - Sprint 1 (Memories)

## Goal
Local Memory Gateway: ingest an Obsidian vault into Postgres; expose scoped
search/fetch over MCP + REST; audit every call.

## What was implemented
- pnpm monorepo (`packages/shared`, `apps/memory-gateway`, `apps/worker` placeholder)
- `@memories/shared`: types, Zod schemas, frontmatter parsing (+defaults/warnings),
  heading-aware chunker, id/checksum helpers
- Prisma schema + hand-written init migration (tsvector GENERATED column + GIN index)
- Config loader (config.yaml + env overrides)
- Policy layer (namespace/sensitivity intersection) enforced below all adapters
- Ingestion (idempotent scan, checksum skip, archive-missing, un-archive-on-restore)
- Retrieval: full-text `search` (ts_rank), `fetch`, `health`
- Audit log + retrieval traces on every call
- Adapters: Fastify REST, MCP stdio server, scan CLI
- Vitest unit + integration suites incl. cross-namespace/sensitivity leakage tests

## What was intentionally not implemented
Embeddings/vector search, proposals/write-back, entities/relations, Graphify,
secrets, file-watcher, worker app. (Deferred per the design doc.)

## Architecture decisions made
- Policy below adapters (structural leakage prevention)
- Postgres full-text via generated tsvector + GIN; Prisma `$queryRaw`
- MCP tool wire names use underscores (dots are invalid in tool names)
- Exact namespace matching (hierarchy/prefix matching deferred)

## Files changed
`git diff --stat c186de2^..HEAD`: 68 files changed, 4435 insertions(+)
(c186de2 = first sprint code commit "chore: scaffold pnpm monorepo".)

## Database migrations
- `20260607000000_init` — documents, chunks (+tsv/GIN), audit_log, retrieval_traces

## MCP tools exposed
memory_search, memory_fetch, health_status

## REST endpoints exposed
GET /health, POST /ingest/scan, POST /memory/search, GET /memory/documents/:id

## Security assumptions
- No secrets stored; no write-back; no shell/arbitrary-DB tools
- Retrieved content is annotated as data, not instructions
- Cross-scope retrieval requires config change (no runtime escalation)

## Test commands run
`pnpm db:up && pnpm -r test && pnpm -r typecheck`

## Test output summary
- `@memories/shared`: 4 files, 13 tests passed (schemas, ids, frontmatter, chunker)
- `@memories/memory-gateway`: 11 files, 31 tests passed (config, policy, audit,
  db-harness, ingest, archive, search, fetch-health, api, mcp, cli)
- Total: 44 tests passed; `pnpm -r typecheck` clean (both packages)

## Live end-to-end (real vault)
- `pnpm scan` against `/Users/jzfre/Documents/Obsidian Vault`: 7 added
  (5 seeded notes + Welcome.md + daily note), 2 frontmatter warnings (non-fatal)
- `GET /health` → `{ documents: 7, chunks: 8, db: "ok" }`
- `POST /memory/search {"query":"obsidian canonical"}` → top result is the
  "Use Obsidian Markdown + Git" decision
- `POST /memory/search {"query":"mcp"}` → returns the MCP reading note

## Known limitations
- Exact namespace matching only (no hierarchy)
- One-shot scan (no watcher)
- ts_rank-only ranking (no recency/confidence weighting yet)

## Questions for architect
- Should namespace matching become hierarchical/prefix-based in Phase 4
  (e.g. allow `work/client-a` to also match `work/client-a/project-x`)?
- Ranking: is ts_rank acceptable until embeddings land, or do we want
  recency/confidence weighting sooner?

## Suggested next sprint
Phase 4 (proposals/write-back) or Phase 5 (embeddings/hybrid retrieval).
