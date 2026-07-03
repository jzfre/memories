# Memories

Local-first Knowledge Intelligence OS: ingest a Markdown vault into Postgres and serve
namespace/sensitivity-scoped search, fetch, direct note writes, and context packs over
MCP and a thin REST API.  Postgres is a rebuildable index; the vault (its own git repo)
is canonical.

**Peer-work model:** AI clients (Claude Code, ChatGPT, …) write notes directly into the
vault via MCP — nothing sits waiting on you first. The owner reviews by editing, the
same way you'd read a colleague's edit after the fact. The only gates are two guards on
the write path (secret detection, a structural frontmatter guard) — see "Writing notes
directly" below.

## Architecture

**Start with [DOCUMENTATION.md](DOCUMENTATION.md)** — how the system actually works:
the two-repository model (canonical vault vs. this tool), where AI is used (local
embeddings only; frontier models are clients that can also write), full data flows, and
the peer-work write model in depth.

Also: `docs/superpowers/specs/2026-06-07-memories-sprint1-design.md` (original design),
`docs/superpowers/specs/2026-07-02-simplification-peer-model-design.md` (the design
record for the direct-write model below), and `docs/implementation-plan.md` (roadmap —
predates that simplification, so any pending-review/sign-off workflow it describes is
historical).

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
pnpm mcp                                          # stdio transport (Claude Code, VS Code, LM Studio, …)
pnpm --filter @memories/memory-gateway mcp:http   # HTTP transport (ChatGPT connector) — see docs/chatgpt-connector.md
```

## Configuration

Edit `config.yaml` (repo root): vault path, policy allowlists (`allowed_namespaces`,
`allowed_sensitivity`), the `actor` label used in audit rows, per-client `connectors`
(transport, auth, `capabilities: [read, write]`, scope), and `note_rules`
(`quarantine_invalid`, per-issue `severities` overrides — informational only; nothing in
`note_rules` blocks a write). `VAULT_ROOT` / `MEMORIES_CONFIG` env vars override the
vault path / config file location.

## CLI commands

All commands run from the repo root via pnpm scripts. There is no separate gating
command — notes are written directly by AI clients over MCP (or edited by hand in the
vault).

| Command                                               | Description                                               |
|-------------------------------------------------------|-------------------------------------------------------------|
| `pnpm scan`                                           | Ingest / re-ingest vault into Postgres index               |
| `pnpm scan --dry-run`                                 | Preview what would change without writing                  |
| `pnpm rebuild`                                        | Wipe the derived index and re-scan from scratch             |
| `pnpm reembed`                                        | Backfill embeddings for chunks that lack one                |
| `pnpm status`                                         | Show document/chunk/embedding/validation counts             |
| `pnpm audit:search`                                   | Search the audit log (alias for the `audit` subcommand)     |
| `pnpm audit:search --action memory.search`            | Filter audit log by action                                  |
| `pnpm api`                                            | Start REST API server on port 8787                          |
| `pnpm mcp`                                            | Start MCP stdio server (claude-code profile)                |
| `pnpm --filter @memories/memory-gateway mcp:http`     | Start MCP HTTP server (chatgpt profile; token-gated)         |
| `pnpm test` / `pnpm -r test`                          | Run full test suite                                         |

## MCP tools

Wire names use underscores (MCP tool names cannot contain dots); titles use dots. The
stdio profile (Claude Code, VS Code, LM Studio, …) exposes 9 tools. `memory_write_note`
and `memory_update_note` only register when the connecting profile's `capabilities`
include `write` in `config.yaml` (both shipped profiles — `claude-code` and `chatgpt` —
enable it today).

| Wire name                  | Title                      | Description                                                          |
|-----------------------------|-----------------------------|------------------------------------------------------------------------|
| `memory_protocol`          | `memory.protocol`          | Returns the KB protocol — the canonical vault note `99-meta/PROTOCOL.md` |
| `memory_search`            | `memory.search`            | Scoped full-text (+ hybrid when embeddings enabled) search           |
| `memory_fetch`             | `memory.fetch`             | Fetch one document by id (scoped)                                    |
| `health_status`            | `health.status`            | Gateway and index health (db, document/chunk counts)                 |
| `memory_context_pack`      | `memory.context_pack`      | Build a token-budgeted context pack for a goal                       |
| `memory_recent`            | `memory.recent`            | List most recently indexed documents within scope                    |
| `memory_explain_sources`   | `memory.explain_sources`   | Explain the retrieval trace for a prior search                       |
| `memory_write_note`        | `memory.write_note`        | Write a new note directly into the vault (gated by `write` capability) |
| `memory_update_note`       | `memory.update_note`       | Replace an existing note's body, frontmatter preserved (gated by `write`) |

The `chatgpt` HTTP profile additionally registers two ChatGPT-canonical tools —
`search` and `fetch` — required by ChatGPT's connector/deep-research tool-naming
convention, for 11 tools total on that profile. See
[docs/chatgpt-connector.md](docs/chatgpt-connector.md).

The working rules for what/how to write live in the vault note `99-meta/PROTOCOL.md`,
which every MCP client also receives as server instructions at connect (no separate
per-client copy to keep in sync).

## REST endpoints

REST is read/operate-only today; there is no REST route for writing or updating notes
(use the MCP tools above).

| Method | Path                         | Description                                          |
|--------|------------------------------|-------------------------------------------------------|
| GET    | `/health`                    | Gateway and index health                             |
| GET    | `/status`                    | Detailed index status (validation, embedding counts) |
| POST   | `/ingest/scan`               | Trigger vault scan                                   |
| POST   | `/memory/search`             | Scoped search                                        |
| GET    | `/memory/documents/:id`      | Fetch document by id                                 |
| POST   | `/memory/context-pack`       | Build context pack for a goal                        |
| GET    | `/audit`                     | Search audit log (filter: `?action=&client=&approved=&limit=`) |

`GET /audit` is not itself audited (to avoid recursion noise in the audit log).

## Writing notes directly (peer model)

AI clients write into the vault immediately via `memory_write_note` /
`memory_update_note` — nothing is queued for a decision and no code needs to change
hands. The owner reviews the same way they'd review any edit: by opening the note in
Obsidian/SilverBullet and changing it. Server-side file versioning (Syncthing
`.stversions` on the always-on deployment) is the undo.

Only two guards run on every write, and nothing else blocks:

1. **Secret detection** — content that looks like credentials (private keys, AWS/GitHub
   tokens, `password=…`, bearer tokens, long hex/base64 secrets) is refused. Reference
   secrets as `secret_ref: op://vault/item` instead.
2. **Body must not start with `---`** — the gateway owns the frontmatter block; a body
   starting with its own `---` would corrupt the file or let content re-scope the note,
   so it's refused.

`memory_write_note` composes minimal frontmatter from its arguments and writes an
atomic file (temp file + rename, same directory) to `<folder || 00-inbox>/<slug>.md`
(name collisions get a `-2`, `-3`, … suffix), then re-scans so the note is searchable
immediately. `folder` must resolve inside the vault and already exist (except
`00-inbox`, which is auto-created). `memory_update_note` replaces a note's body after
its existing frontmatter, which is preserved verbatim.

Frontmatter on a written note is intentionally minimal — no `status`, `confidence`, or
`namespace` on this surface:

| Field | Values | Default |
|---|---|---|
| `sensitivity` | `public` \| `internal` | `internal` |
| `kind` | `note` `finding` `decision` `runbook` `project-context` `reading-note` `brain-gym-memo` `summary` `insight` | `note` |
| `tags` | lowercase, `.` `_` `/` `-`, ≤50 chars | `[]` |
| `source_refs` | provenance strings (chat/date, URLs, paths) | omitted if none |
| `created` | `YYYY-MM-DD` | write-time date |

See [skills/capturing-memories/SKILL.md](skills/capturing-memories/SKILL.md) for the
full note-writing workflow AI clients follow (search-before-write, wikilinking,
structured-kind section templates), and
[DOCUMENTATION.md §4](DOCUMENTATION.md#4-the-write-model-in-depth) for the write path
in detail.

## Connectors

Each MCP-connecting client resolves to a profile in `config.yaml`'s `connectors` map:
transport (`stdio` | `http`), auth, `capabilities` (`read`/`write`), and scope
(namespace/sensitivity allowlist intersection — `"*"` today for both, i.e. every client
sees and can write everything, an explicit owner decision).

| Profile | Transport | Capabilities | Notes |
|---|---|---|---|
| `claude-code` | stdio | `[read, write]` | Used by every stdio launch (`pnpm mcp`), so VS Code, LM Studio, Hermes, etc. get this profile too |
| `chatgpt` | http, token-gated | `[read, write]` | Public HTTPS endpoint via tunnel; see [docs/chatgpt-connector.md](docs/chatgpt-connector.md) |

## Evals

`evals/retrieval-cases.yaml` defines fixed retrieval test cases that run as part of
`pnpm test`: scoping (cross-namespace leakage), secret-ref handling (a `secret_ref:
op://…` note is retrievable; a real secret is not), and prompt-injection content
returned as inert data.

## Tests

```bash
pnpm db:up
pnpm -r test
pnpm -r typecheck
```

## Further reading

- [ChatGPT connector](docs/chatgpt-connector.md) — public HTTPS MCP endpoint, tunneling, write-tool exposure
- [Connecting MCP clients](docs/mcp-clients.md)
- [Executor guides](docs/executors.md) — Claude Code, VS Code, LM Studio, Hermes, OpenClaw/IronClaw, local model policy
- [Backup and restore](docs/backup-restore.md)
- [Deploying on a restricted/locked-down machine](docs/deploy-restricted.md) — Artifactory mirrors, FTS-only mode, Git LFS for the model
- [Implementation plan](docs/implementation-plan.md)
