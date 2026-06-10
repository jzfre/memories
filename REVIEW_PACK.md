# Review Pack — Whole Project (Phases 0–10)

## Goal

Build a local-first Knowledge Intelligence OS: ingest an Obsidian vault into Postgres,
expose scoped search/fetch/proposals/context-packs over MCP and REST, validate proposed
knowledge before canonical write, audit every call, and provide executor guides and
backup/restore documentation for all client surfaces.

---

## What was implemented — by phase

| Phase | Name                              | Status    |
|-------|-----------------------------------|-----------|
| 0     | Foundation decisions              | Delivered |
| 1     | Vault ingestion                   | Delivered |
| 2     | Basic retrieval (FTS)             | Delivered |
| 3     | MCP Gateway v1 + context pack     | Delivered |
| 4     | Proposal workflow                 | Delivered |
| 5     | Embeddings + hybrid retrieval     | Delivered |
| 6     | Graphify adapter                  | **Deferred** — roadmap (see below) |
| 7     | Validation engine v1              | Delivered |
| 8     | BrainGym pipeline                 | **Deferred** — roadmap (see below) |
| 9     | Executor guides + policy          | Delivered |
| 10    | Evals, audit CLI, backup/restore  | Delivered |

### Delivered detail

- **pnpm monorepo** — `packages/shared`, `apps/memory-gateway`, `apps/worker` placeholder
- **`@memories/shared`** — Zod schemas, frontmatter parsing + defaults/warnings,
  heading-aware chunker, id/checksum helpers
- **Prisma schema + migrations** (8 migrations, see list below)
- **Config loader** — `config.yaml` + env overrides (`VAULT_ROOT`, `MEMORIES_CONFIG`)
- **Policy layer** — namespace/sensitivity intersection enforced below all adapters
- **Ingestion** — idempotent scan, checksum skip, archive-missing, un-archive-on-restore,
  `rebuild` (wipe + re-scan), embedding backfill (`reembed`), embedding model metadata on chunks
- **Retrieval** — full-text `search` (ts_rank + freshness penalty), hybrid RRF when
  embeddings enabled, `fetch`, `recent`, `explain_sources`, `context_pack`
  (grouped by kind, token budget, warnings for stale/unreviewed content)
- **Proposals workflow** — `createProposal`, `listProposals`, `reviewProposal`;
  approve writes Markdown with frontmatter to `00-inbox/reviewed/` and re-indexes;
  reject/needs_more_evidence retains row; validation flags + score + auto-policy on every proposal
- **Validation engine** — secret detector (private keys, AWS keys, GitHub tokens,
  bearer tokens, password literals, long hex/base64 secrets; `secret_ref: op://`
  references explicitly allowed), namespace/sensitivity checker, duplicate detector,
  contradiction candidate flag, source check, 0–12 scoring rubric, auto-policy
  (`quick_approve_eligible` / `normal_review` / `needs_more_evidence` /
  `human_review_required`); `client-confidential` always `human_review_required`
- **Status** — `computeIndexStatus` with validation/embedding breakdowns, stale documents
  per kind (staleness intervals: `runbook: 90d`, `finding: 60d`, `decision: 120d`, etc.)
- **Audit log** — every call writes an `audit_log` row; retrieval traces recorded;
  `searchAudit` for CLI/REST audit search
- **Adapters** — Fastify 5 REST API, MCP stdio server (10 tools, incl. code-gated review), CLI (scan, reembed,
  rebuild, status, proposals, proposals review, audit)
- **Eval sets** — `evals/retrieval-cases.yaml` (12 cases) and
  `evals/validation-cases.yaml` (7 cases) run as part of `pnpm test`; include
  cross-namespace leakage, secret-ref handling, prompt-injection-as-data, and
  validation policy cases
- **Executor guides** — `docs/executors.md` (Claude Code, VS Code, LM Studio, Hermes,
  OpenClaw/IronClaw, local model policy)
- **Backup/restore docs** — `docs/backup-restore.md`

### Deferred by owner decision (2026-06-10) — roadmap

**Phase 6 — Graphify adapter:** Real-graph connection-discovery engine.  Would add
`graphify_runs` + `graphify_insights` tables, a pluggable backend (`StubGraphifyBackend`
for tests, `ExecGraphifyBackend` for the real `graphify` binary), GRAPH_REPORT parser,
`project_graph_list_runs` + `project_graph_report` MCP tools, and a `graphify` CLI
subcommand.  Insights are proposed (never canonical) and land in `95-generated/graphify/`.
Not implemented.

**Phase 8 — BrainGym pipeline:** Recurring knowledge-practice pipeline.  Would add
`brain-gym-memo` scanning, score parsing, recurring-assumption detection, weekly
review proposal generation, `GET /braingym/memos` REST endpoint, and `braingym` CLI
subcommand.  Not implemented.

---

## Architecture decisions

- **Policy below adapters** — namespace/sensitivity intersection is enforced in the
  core layer before any adapter (MCP/REST/CLI) can return results.  No executor
  surface can bypass scoping.
- **Vault canonical, Postgres derived and rebuildable** — `pnpm rebuild` wipes the
  index and re-scans.  Postgres backup is optional; vault git-push is required.
- **Review never via MCP** — per §20.4, v1 exposes Tier 0 (read) and Tier 1 (propose)
  tools over MCP.  Tier 2 (canonical write after approval) is restricted to the human
  CLI/REST surface.
- **Proposals land in `00-inbox/reviewed/`** — approved notes are written with full
  frontmatter (`kind`, `namespace`, `sensitivity`, `status: active`, `confidence`,
  `source_type: proposal`, `tags: []`) and immediately re-indexed.
- **Hybrid RRF retrieval** — full-text (ts_rank) and vector (cosine) results are fused
  with Reciprocal Rank Fusion when embeddings are enabled; freshness penalty for
  incomplete/stale metadata.
- **Embeddings always local** — `OpenAICompatibleEmbedder` points at the local LM
  Studio endpoint, not a cloud API.  `EMBEDDINGS_ENABLED=0` disables embeddings in
  tests.
- **MCP wire names use underscores** — MCP/Claude tool names cannot contain dots.
  Titles use dots.
- **Audit `GET /audit` not self-audited** — to avoid recursion noise.
- **Proposals validated at creation** — validation flags, score, and auto-policy are
  persisted on every proposal row.  Proposals with `secret_detected` or invalid
  namespace/sensitivity are created as `rejected` and can never be approved.

---

## Database migrations

| Migration directory                      | Description                                    |
|------------------------------------------|------------------------------------------------|
| `20260607000000_init`                    | documents, chunks (+tsv/GIN), audit_log, retrieval_traces |
| `20260609000000_search_weighting`        | search weighting columns                       |
| `20260609010000_search_metadata`         | search metadata columns                        |
| `20260609020000_embeddings`              | embedding vector column (pgvector)             |
| `20260609030000_processing_status`       | processing/validation status columns           |
| `20260610000000_proposals`               | knowledge_events, proposals tables             |
| `20260610010000_proposal_validation`     | validation_flags, score, auto_policy on proposals |
| `20260610030000_embedding_model`         | embedding_model column on chunks               |

---

## MCP tools exposed (9)

| Wire name                  | Title                      |
|----------------------------|----------------------------|
| `memory_search`            | `memory.search`            |
| `memory_fetch`             | `memory.fetch`             |
| `health_status`            | `health.status`            |
| `memory_propose_note`      | `memory.propose_note`      |
| `memory_propose_patch`     | `memory.propose_patch`     |
| `memory_list_proposals`    | `memory.list_proposals`    |
| `memory_context_pack`      | `memory.context_pack`      |
| `memory_recent`            | `memory.recent`            |
| `memory_explain_sources`   | `memory.explain_sources`   |

---

## REST endpoints exposed

| Method | Path                         |
|--------|------------------------------|
| GET    | `/health`                    |
| GET    | `/status`                    |
| POST   | `/ingest/scan`               |
| POST   | `/memory/search`             |
| GET    | `/memory/documents/:id`      |
| POST   | `/memory/context-pack`       |
| POST   | `/proposals`                 |
| GET    | `/proposals`                 |
| POST   | `/proposals/:id/review`      |
| GET    | `/audit`                     |

---

## Security assumptions

- No secret values stored anywhere (vault, DB, logs); only `secret_ref: op://` references.
- Retrieved content is annotated as data, not instructions (`UNTRUSTED_CONTENT_NOTE` on every response).
- Cross-scope retrieval requires a config change — no runtime escalation.
- Review/approve never exposed via MCP in v1 (§20.4).
- Validation blocks secrets and out-of-scope proposals at creation time.
- Single-user, local trust model: REST and MCP are unauthenticated on localhost.  Not
  suitable for multi-user or network-exposed deployment without adding auth middleware.

---

## Test commands

```bash
pnpm db:up
pnpm -r test
pnpm -r typecheck
```

## Test output summary (recorded 2026-06-10)

- `@memories/shared`: 5 test files, **15 tests** passed
- `@memories/memory-gateway`: 26 test files, **195 tests** passed
- **Total: 210 tests passed** across 31 test files; `pnpm -r typecheck` clean

---

## Known limitations

- **Graphify deferred** — real `graphify` binary integration pending; Phase 6 not implemented.
- **BrainGym deferred** — Phase 8 not implemented.
- **Hermes / OpenClaw / IronClaw** — verified by config-contract only (correct tool
  names, scoping, proposal-only writeback); not tested with live executor instances.
- **Single-user local trust model** — REST and MCP endpoints are unauthenticated.
  Suitable for single-user localhost only.
- **Exact namespace matching** — no hierarchy/prefix matching (e.g. `work/client-a`
  does not match `work/client-a/project-x`).
- **One-shot scan** — no file-watcher; run `pnpm scan` or `pnpm rebuild` to re-index.

---

## Suggested next sprint

1. **Phase 6 (Graphify adapter)** — stub backend in tests, real `graphify` binary
   wired via `ExecGraphifyBackend`, insights proposed to vault via normal proposal path.
2. **Phase 8 (BrainGym)** — `brain-gym-memo` scanning, score parsing, weekly review
   proposal, `braingym` CLI and REST.
3. **Auth middleware** — add a shared-secret or token check to the REST/MCP layer if
   the gateway will be exposed beyond localhost.
4. **Namespace hierarchy** — prefix/hierarchical matching for nested namespace trees.
5. **File watcher** — incremental re-index on vault file changes.
