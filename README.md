# Memories

Local-first Memory Gateway: ingest an Obsidian vault into Postgres and serve
namespace/sensitivity-scoped `search` and `fetch` over MCP and a thin REST API.
Postgres is a rebuildable index; the Obsidian vault + Git is canonical.

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
sensitivities. `VAULT_ROOT` / `MEMORIES_CONFIG` env vars override it.

## Tests

```bash
pnpm db:up
pnpm -r test
pnpm -r typecheck
```

## MCP tools

- `memory_search` (memory.search) — scoped full-text search
- `memory_fetch` (memory.fetch) — fetch one document by id
- `health_status` (health.status) — gateway/index health

> Tool wire names use underscores because MCP/Claude tool names cannot contain dots.
