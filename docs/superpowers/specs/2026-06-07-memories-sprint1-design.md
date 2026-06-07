# Memories — Sprint 1 Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-06-07
**Owner:** jr@aqui.technology
**Source architecture:** `docs/implementation-plan.md` (Knowledge Intelligence OS)
**This document scopes only Sprint 1.** Later phases are referenced but not designed here.

---

## 1. Purpose

`memories` is the first, deliberately narrow slice of the Knowledge Intelligence OS: a
local-first **Memory Gateway** that ingests Markdown notes from a canonical Obsidian vault
into a Postgres index and exposes safe, scoped **search** and **fetch** over MCP (with a thin
REST mirror for manual testing).

The governing rule from the architecture holds in this sprint and forever after:

> Obsidian Markdown + Git is canonical. Postgres is a rebuildable index. Every retrieval is
> scoped by namespace and sensitivity, and every call is audited.

This sprint exists to make the system *useful and testable* as early as possible, while the
owner explores what they actually want. It must therefore stay small and avoid locking in
decisions that later phases (embeddings, proposals, Graphify) would want to revisit.

---

## 2. Scope

### In scope

1. **Vault scanner / ingestion** — idempotent CLI scan of the vault into Postgres.
2. **Index** — `documents`, `chunks`, `audit_log`, `retrieval_traces` tables; Postgres
   full-text search via a `tsvector` column + GIN index.
3. **Retrieval core** — `search` and `fetch`, scoped by namespace + sensitivity.
4. **Policy layer** — namespace/sensitivity enforcement that lives *below* every adapter.
5. **MCP server** (stdio) — `memory.search`, `memory.fetch`, `health.status`.
6. **Thin REST API** (Fastify) — `GET /health`, `POST /ingest/scan`, `POST /memory/search`,
   `GET /memory/documents/:id`.
7. **Audit + traces** — every MCP/REST call logged; searches additionally traced.
8. **Vault seeding** — namespace skeleton + ~5 schema-correct example notes in the real vault.
9. **Tests** — unit + integration, including cross-namespace/sensitivity leakage tests.

### Out of scope (deferred to later phases)

- Embeddings / vector / hybrid search (Phase 5)
- Write-back, proposals, review workflow (Phase 4)
- Entities, relations, graph tools (later)
- Graphify integration (Phase 6)
- Secrets resolution (never in early phases)
- File-watcher daemon (one-shot CLI scan only for now)
- `apps/worker` implementation (placeholder only)

### Non-negotiable constraints (from plan §26)

- Postgres is an index, not the source of truth.
- Namespace and sensitivity filters are enforced.
- No direct write-back to the canonical vault.
- No secrets handling, no shell-execution tool, no arbitrary DB query tool.
- All MCP calls are audited.
- Keep the implementation small and testable.

---

## 3. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Project name | `memories` | Owner directive (renamed from `memory`). |
| Language / runtime | TypeScript (ESM), Node 24 | Matches `brain-gym`; owner most proficient in TS. |
| ORM / migrations | Prisma | Matches `brain-gym` (Prisma 5.x); reuse known patterns. |
| Package manager | pnpm workspaces | Owner directive: full monorepo scaffold. |
| HTTP framework | Fastify | Lightweight, mature, good local service ergonomics. |
| MCP SDK | Official MCP TypeScript SDK, stdio transport | Local clients (Claude Code, VS Code). |
| Validation | Zod | Matches `brain-gym`. |
| Testing | Vitest | Matches `brain-gym`. |
| Frontmatter parser | `gray-matter` | Plan §21. |
| Canonical vault | `/Users/jzfre/Documents/Obsidian Vault` (real, currently empty) | Owner created it for this purpose. |
| DB image | `pgvector/pgvector:pg16` | Future-ready for Phase 5; no vector usage yet. |
| Tool names | `memory.*` (e.g. `memory.search`) | Plan default; reads naturally. Server/package is `memories`. |
| REST | Included (health/search/fetch/ingest) | Enables curl/Postman testing without an MCP client. |
| Vault seeding | Seed the real vault with structure + ~5 examples | First scan has real content; tests use a separate fixture vault. |

---

## 4. Architecture

The defining principle: **MCP, REST, and CLI are thin adapters over one shared core, and the
policy layer sits below all of them.** No adapter can reach the database except through policy,
so "no cross-namespace retrieval" is a structural guarantee rather than a convention.

```
   CLI (tsx)          MCP server (stdio)        REST (Fastify)
      │                     │                        │
      └─────────────┬───────┴───────────┬────────────┘
                    ▼                    ▼
           ingest/ (scan,chunk)   retrieval/ (search,fetch)
                    │                    │
                    └──────► policy/ (namespace + sensitivity) ◄── always enforced
                                         │
                             audit/ (audit_log + retrieval_traces)
                                         │
                                    db/ (Prisma → Postgres)
```

This mirrors the Redux model from the architecture plan: `search`/`fetch` are *selectors* over
canonical state; the adapters are interchangeable *UIs*; policy + audit are *middleware*.

### Module responsibilities (`apps/memory-gateway/src/`)

- **`config/`** — load + Zod-validate `config.yaml` and env (`DATABASE_URL`, `VAULT_ROOT`).
  Exposes typed config: vault root, policy allowlists, default namespace/sensitivity,
  exposed MCP tools.
- **`db/`** — Prisma client wrapper + typed query helpers. Owns the raw `$queryRaw` full-text
  search SQL.
- **`ingest/`** — `scanner` (walk vault, checksum, detect add/change/delete), `parser`
  (frontmatter + defaults), `chunker` (heading-aware), `indexer` (upsert documents/chunks).
- **`policy/`** — given a requested scope, intersect with the configured allowlist; produce
  the namespace/sensitivity filter applied to every query; reject disallowed scopes.
- **`retrieval/`** — `search(query, scope, top_k)` and `fetch(documentId, scope)`. Pure
  selectors; call policy + db; never trust caller-supplied filters without policy intersection.
- **`audit/`** — write `audit_log` per call and `retrieval_traces` per search.
- **`api/`** — Fastify routes; thin, delegate to retrieval/ingest.
- **`mcp/`** — MCP server registering the three tools; thin, delegate to the same core.
- **`cli/`** — `tsx` entrypoint: `scan` command (and `--dry-run`).

### `packages/shared/` (`@memories/shared`)

Framework-agnostic, no Prisma dependency:
- **`types/`** — domain types (Namespace, Sensitivity, Kind, ReviewState, Confidence, etc.).
- **`schemas/`** — Zod schemas for frontmatter and MCP/REST tool I/O.
- **`frontmatter/`** — parse + apply defaults + validate, returning typed result + warnings.
- **`ids/`** — stable document/chunk id derivation; sha256 checksum helper.

---

## 5. Repository layout

```
memories/
  pnpm-workspace.yaml
  package.json                 # root scripts (dev, test, scan, db:*)
  tsconfig.base.json
  docker-compose.yml           # Postgres (pgvector/pgvector:pg16)
  config.yaml                  # vault root, policy, exposed tools
  .env.example                 # DATABASE_URL, VAULT_ROOT
  .gitignore
  README.md
  packages/
    shared/                    # @memories/shared
      src/{types,schemas,frontmatter,ids,index}.ts
      package.json · tsconfig.json
  apps/
    memory-gateway/            # @memories/memory-gateway
      src/{config,db,ingest,policy,retrieval,audit,api,mcp,cli}/
      prisma/{schema.prisma, migrations/}
      tests/{fixtures/vault/, *.test.ts}
      package.json · tsconfig.json · vitest.config.ts
    worker/
      README.md                # placeholder; Phase 5+ (embeddings, Graphify)
  vault-templates/
    decision.md · finding.md · brain-gym-memo.md · runbook.md · project-context.md
  scripts/
    dev.sh · scan-vault.sh
  docs/
    implementation-plan.md     # the full Knowledge Intelligence OS plan
    superpowers/specs/2026-06-07-memories-sprint1-design.md
```

`apps/worker` is a README-only placeholder (not yet a live workspace package) so we carry no
dead code; it is wired when Phase 5 needs background processing.

---

## 6. Data model

Only four tables this sprint (a strict subset of plan §13). Prisma models for
`documents`, `chunks`, `audit_log`, `retrieval_traces`. Full-text uses a `tsvector` generated
column + GIN index added via a hand-written migration (Prisma does not model `tsvector`
natively), and queried with `websearch_to_tsquery` + `ts_rank` through `$queryRaw`.

```sql
-- documents: one row per canonical Markdown file
documents(
  id text primary key,              -- frontmatter.id if present, else derived from path
  path text not null unique,        -- vault-relative path
  title text not null,
  kind text not null,               -- decision | finding | note | ...
  namespace text not null,
  sensitivity text not null,
  status text not null,
  confidence text,
  checksum text not null,           -- sha256 of file content
  frontmatter jsonb not null default '{}',
  body_text text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  indexed_at timestamptz
)

-- chunks: heading-aware splits of the body, full-text searchable
chunks(
  id text primary key,              -- `${document_id}#${chunk_index}`
  document_id text not null references documents(id) on delete cascade,
  chunk_index int not null,
  heading_path text,
  content text not null,
  token_count int,
  tsv tsvector,                     -- generated; GIN-indexed (via migration)
  created_at timestamptz not null default now()
)

-- audit_log: one row per MCP/REST call
audit_log(
  id text primary key,
  actor text not null,              -- e.g. user/agent identity
  client text not null,             -- mcp | rest | cli
  action text not null,             -- memory.search | memory.fetch | ingest.scan | health
  namespace text not null,          -- requested scope (joined) or 'n/a'
  sensitivity_requested text,
  inputs_hash text,
  returned_document_ids text[] not null default '{}',
  approved boolean,
  created_at timestamptz not null default now()
)

-- retrieval_traces: one row per search, for debugging ranking
retrieval_traces(
  id text primary key,
  actor text not null,
  query text not null,
  namespace_filter text[] not null,
  selected_chunk_ids text[] not null default '{}',
  selected_document_ids text[] not null default '{}',
  ranking_debug jsonb not null default '{}',
  created_at timestamptz not null default now()
)
```

---

## 7. Ingestion

`pnpm scan` (a `tsx` CLI invoking `ingest/`) performs an **idempotent** pass:

1. Walk `VAULT_ROOT` for `*.md`, skipping `.obsidian/`, `.git/`, `.DS_Store`, and any
   `.graphifyignore`-style excludes (basic ignore list this sprint).
2. For each file: compute sha256 → if a `documents` row exists with the same checksum, **skip**.
3. Parse frontmatter with `gray-matter`. **Tolerate missing/partial frontmatter**: fill config
   defaults (`namespace=personal`, `sensitivity=private`, `kind=note`, `status=active`,
   `confidence=unknown`), derive `title` from H1 or filename, and emit a **warning** (never a
   hard failure — the real vault contains an empty daily note and a frontmatter-less
   `Welcome.md`).
4. Derive `id` (frontmatter.id or path-derived slug) and chunk the body by Markdown headings,
   tracking `heading_path`, capping chunk size (≈1500 chars), assigning `chunk_index`.
5. Upsert `documents` + replace its `chunks`. Set `indexed_at`.
6. Files present in DB but missing on disk → mark `status='archived'` (configurable; default
   archive, not delete).

Scan reports a summary: added / updated / skipped / archived / warnings.

---

## 8. Retrieval + policy

### `memory.search`

Input (plan §15.1): `{ query, namespaces[], sensitivity_allowed[], top_k }`. The policy layer
**intersects** the requested `namespaces`/`sensitivity_allowed` with the configured allowlist;
anything outside the allowlist is dropped (and if the request asks *only* for disallowed
scopes, it returns empty + is audited as denied). The SQL applies the resulting filter as a
hard `WHERE namespace = ANY($allowed) AND sensitivity = ANY($allowed)` *in addition to*
full-text matching, so leakage is impossible even if a caller lies.

Output: results with `document_id`, `chunk_id`, `title`, `snippet`, `score`, and source
(`path`, `kind`, `confidence`, `review_state`), plus a `trace_id`.

Ranking this sprint = `ts_rank` only (semantic/recency/confidence weighting is Phase 5+).

### `memory.fetch`

Input: `{ document_id }` (+ implicit scope). Returns the full document **only if** its
namespace/sensitivity is within the allowlist; otherwise not-found (never reveal existence of
out-of-scope docs). Audited.

### `health.status`

Returns gateway + DB connectivity, document/chunk counts, last scan time. Audited lightly.

### Policy configuration (`config.yaml`)

```yaml
policy:
  default_namespace: personal
  default_sensitivity: private
  allowed_namespaces: [personal, career, brain-gym, home, public-research]
  allowed_sensitivity: [public, internal, private]
  # client-confidential / secret-adjacent excluded by default this sprint
```

Cross-namespace or higher-sensitivity access requires explicit config change (no runtime
escalation path exists in Sprint 1).

---

## 9. MCP + REST surface

**MCP tools (stdio):** `memory.search`, `memory.fetch`, `health.status`. Tool inputs/outputs
validated with the shared Zod schemas. A Claude Code / VS Code MCP config example is included
in the README.

**REST (Fastify):**
- `GET  /health` → health.status
- `POST /ingest/scan` → run a scan (body: optional `{ dry_run }`)
- `POST /memory/search` → search
- `GET  /memory/documents/:id` → fetch

Both adapters call the identical core functions; neither contains policy logic of its own.

**Explicitly NOT exposed (plan §14.6 / §20.4):** `memory.write_directly`, `secret.reveal`,
`shell.execute_arbitrary`, `database.query_arbitrary`, cross-scope search without approval.

### Retrieved-content safety

Search/fetch responses wrap note bodies as **data, not instructions** (plan §20.3): a metadata
note that retrieved content may contain untrusted instructions and must not be executed. This
is a response annotation this sprint, not an enforcement mechanism.

---

## 10. Vault seeding

Because the real vault is empty, create (with owner consent — granted):

1. The §11 namespace folder skeleton inside `/Users/jzfre/Documents/Obsidian Vault`.
2. ~5 example notes built from `vault-templates/`, each with valid frontmatter spanning a few
   namespaces and sensitivities (e.g. a decision in `personal`, a brain-gym memo in
   `brain-gym`, a reading note in `public-research`) so search/scoping is demonstrable.

Automated tests use a **separate in-repo fixture vault** (`apps/memory-gateway/tests/fixtures/
vault/`) and never touch the real vault. The fixture is intentionally adversarial for the
leakage tests: it contains notes in **at least two distinct namespaces** (e.g. `work/client-a`
and `work/client-b`), at least one **out-of-allowlist sensitivity** (`client-confidential`),
and at least one note with **no frontmatter** and one **empty file** — so filtering,
default-filling, and fail-closed behavior are all exercised against known inputs.

---

## 11. Testing strategy (Vitest)

**Unit (no DB):**
- frontmatter parse + default-filling + warnings (incl. empty file, no-frontmatter file)
- chunker (heading paths, size cap, indices)
- id derivation + checksum stability
- policy intersection (request ∩ allowlist) edge cases

**Integration (test Postgres — same container, separate DB, migrations applied):**
- ingest the fixture vault → assert document/chunk rows; re-scan → assert idempotency (skips)
- edit a fixture file → re-scan → assert update; remove → assert archived
- search returns expected docs with snippets + trace row written
- fetch returns a doc; fetch out-of-scope id → not found
- **security:** request scoped to namespace B never returns namespace A content; disallowed
  sensitivity never returned; both cases produce audit rows
- audit_log row written for every search/fetch/scan call

A `vitest.config.ts` and a test-DB setup helper (create/drop test database, run migrations)
mirror the `brain-gym` approach (docker compose `db`, separate database name).

---

## 12. Acceptance criteria

From plan §24 Phases 1–3, scoped to this sprint:

1. `pnpm scan` ingests the seeded vault; documents/chunks present; re-scan is idempotent;
   missing files archived; frontmatter warnings reported (not fatal).
2. `POST /memory/search` and `memory.search` (MCP) return only allowed namespaces/sensitivities,
   with document ids, snippets, paths, confidence, review_state.
3. `memory.fetch` / `GET /memory/documents/:id` return scoped documents; out-of-scope → not found.
4. Every MCP/REST call writes an `audit_log` row; every search writes a `retrieval_traces` row.
5. Claude Code (and VS Code) can connect to the MCP server and call all three tools.
6. Cross-namespace/sensitivity leakage tests **fail closed**.
7. `pnpm test` passes; `pnpm typecheck` clean.
8. A `REVIEW_PACK.md` is produced (plan §29 template) for architecture review.

---

## 13. Risks & mitigations

- **Prisma + `tsvector`/GIN not natively modeled** → manage the column + index via raw SQL in a
  migration; query via `$queryRaw`. Documented, tested pattern.
- **Messy real-vault frontmatter** → ingestion fills defaults + warns; never hard-fails.
- **Scope creep (owner "not 100% sure")** → keep the core stable and adapters thin so pivots
  touch adapters/config, not the data model.
- **Accidental cross-scope leak** → policy below all adapters + explicit leakage tests.
- **Renaming/moving the real vault later** → vault root is config/env driven, not hardcoded.

---

## 14. Open questions (deferred, not blocking Sprint 1)

- Which local embedding model for Phase 5 (plan §32).
- File-watcher vs scheduled scan for continuous ingestion.
- Whether a daily note (often empty) should be indexed at all or skipped by policy.
- Review UI surface (Obsidian vs web vs CLI) — relevant only once proposals exist (Phase 4).

---

## 15. Next step

Proceed to the **writing-plans** skill to produce a detailed, step-by-step implementation plan
from this design (scaffold → shared package → db/migrations → ingest → retrieval/policy →
audit → REST → MCP → tests → seed vault → REVIEW_PACK).
