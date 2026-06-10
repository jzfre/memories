# Memories

Local-first Knowledge Intelligence OS: ingest an Obsidian vault into Postgres and serve
namespace/sensitivity-scoped search, fetch, proposals, and context packs over MCP and a
thin REST API.  Postgres is a rebuildable index; the Obsidian vault + Git is canonical.

## Architecture

`docs/superpowers/specs/2026-06-07-memories-sprint1-design.md` (design) and
`docs/implementation-plan.md` (full roadmap).

## Prerequisites

- Node 20+ and pnpm
- Docker (for Postgres)

## Quick start

```bash
pnpm install
cp apps/memory-gateway/.env.example apps/memory-gateway/.env
pnpm generate         # generate the Prisma client (required before scan/api)
pnpm db:up            # start Postgres (pgvector)
pnpm migrate          # apply DB migrations
pnpm scan             # ingest the vault configured in config.yaml
pnpm api              # REST API on http://127.0.0.1:8787
```

Run the MCP server (usually launched by an MCP client, see docs/mcp-clients.md):

```bash
pnpm mcp
```

## Configuration

Edit `config.yaml` (repo root): vault path, allowed namespaces, allowed
sensitivities.  `VAULT_ROOT` / `MEMORIES_CONFIG` env vars override it.

## CLI commands

All commands run from the repo root via pnpm scripts:

| Command                                               | Description                                               |
|-------------------------------------------------------|-----------------------------------------------------------|
| `pnpm scan`                                           | Ingest / re-ingest vault into Postgres index              |
| `pnpm scan -- --dry-run`                              | Preview what would change without writing                 |
| `pnpm rebuild`                                        | Wipe the derived index and re-scan from scratch           |
| `pnpm reembed`                                        | Backfill embeddings for chunks that lack one              |
| `pnpm status`                                         | Show document/chunk/embedding/validation counts           |
| `pnpm proposals`                                      | List pending proposals                                    |
| `pnpm proposals -- --state approved`                  | Filter by review state                                    |
| `pnpm proposals -- review <id> --approve`             | Approve a proposal (writes Markdown to vault)             |
| `pnpm proposals -- review <id> --reject`              | Reject a proposal (retained in DB)                        |
| `pnpm proposals -- review <id> --needs-evidence`      | Request more evidence                                     |
| `pnpm audit:search`                                   | Search the audit log (alias for `audit` subcommand)       |
| `pnpm audit:search -- --action memory.search`         | Filter audit log by action                                |
| `pnpm api`                                            | Start REST API server on port 8787                        |
| `pnpm mcp`                                            | Start MCP stdio server                                    |
| `pnpm test` / `pnpm -r test`                          | Run full test suite                                       |

## MCP tools

All 9 tools are exposed on the `memories` MCP server.  Wire names use underscores
(MCP tool names cannot contain dots); titles use dots.

| Wire name                  | Title                      | Description                                                          |
|----------------------------|----------------------------|----------------------------------------------------------------------|
| `memory_search`            | `memory.search`            | Scoped full-text (+ hybrid when embeddings enabled) search           |
| `memory_fetch`             | `memory.fetch`             | Fetch one document by id (scoped)                                    |
| `health_status`            | `health.status`            | Gateway and index health (db, document/chunk counts)                 |
| `memory_propose_note`      | `memory.propose_note`      | Propose a new knowledge note for human review                        |
| `memory_propose_patch`     | `memory.propose_patch`     | Propose a content patch to an existing document                      |
| `memory_list_proposals`    | `memory.list_proposals`    | List pending (or filtered) proposals                                 |
| `memory_context_pack`      | `memory.context_pack`      | Build a token-budgeted context pack for a goal                       |
| `memory_recent`            | `memory.recent`            | List most recently indexed documents within scope                    |
| `memory_explain_sources`   | `memory.explain_sources`   | Explain the retrieval trace for a prior search                       |

v1 exposes Tier 0 (read) and Tier 1 (propose) tools only.  Review/approve is
Tier 2 and is restricted to the human CLI/REST surface (see `docs/implementation-plan.md` §20.4).

## REST endpoints

| Method | Path                         | Description                                          |
|--------|------------------------------|------------------------------------------------------|
| GET    | `/health`                    | Gateway and index health                             |
| GET    | `/status`                    | Detailed index status (validation, embedding counts) |
| POST   | `/ingest/scan`               | Trigger vault scan                                   |
| POST   | `/memory/search`             | Scoped search                                        |
| GET    | `/memory/documents/:id`      | Fetch document by id                                 |
| POST   | `/memory/context-pack`       | Build context pack for a goal                        |
| POST   | `/proposals`                 | Create a proposal (note or patch)                    |
| GET    | `/proposals`                 | List proposals (filter: `?state=&namespace=`)        |
| POST   | `/proposals/:id/review`      | Review a proposal (approve / reject / needs_more_evidence) |
| GET    | `/audit`                     | Search audit log (filter: `?action=&client=&approved=&limit=`) |

`GET /audit` is not itself audited (to avoid recursion noise in the audit log).

## Proposals workflow

Agents submit knowledge proposals via MCP (`memory_propose_note`,
`memory_propose_patch`) or REST (`POST /proposals`).  Proposals are validated and
queued as `pending_review` — the canonical vault is not touched.

A human reviews via CLI (`pnpm proposals`) or REST (`POST /proposals/:id/review`).
Approving a note proposal writes a Markdown file with full frontmatter to
`00-inbox/reviewed/YYYY-MM-DD-<slug>.md` in the vault and re-indexes it immediately.
Approving a patch proposal replaces the body of the target document.  Rejected
proposals are retained in the database for audit purposes.

## Evals

`evals/retrieval-cases.yaml` and `evals/validation-cases.yaml` define fixed test
cases that run as part of `pnpm test`.  They cover:

- Retrieval: scoping (cross-namespace leakage), secret-ref handling, prompt-injection
  content returned as data only.
- Validation: secret detection, wrong namespace, duplicate detection,
  `client-confidential` human-review enforcement, clean sourced proposals.

## Tests

```bash
pnpm db:up
pnpm -r test
pnpm -r typecheck
```

## Further reading

- [Connecting MCP clients](docs/mcp-clients.md)
- [Executor guides](docs/executors.md) — Claude Code, VS Code, LM Studio, Hermes, OpenClaw/IronClaw, local model policy
- [Backup and restore](docs/backup-restore.md)
- [Implementation plan](docs/implementation-plan.md)
