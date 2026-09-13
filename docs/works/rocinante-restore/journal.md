# Rocinante restore

Superseded on 2026-09-13 by the filesystem MCP and official Obsidian Sync deployment.
The configuration below is retained as a legacy restore option, not the active service.
See [current architecture](../../filesystem-memories.md).

## 2026-09-12

- Restore the gateway from the current project code and rebuild Postgres from the current Mac vault. The Mac vault is authoritative for the initial seed; never restore the old Eternity vault over it.
- Deploy from `/home/jzfre/services/memories` with `docker-compose.rocinante.yml`. Require `VAULT_HOST_PATH=/home/jzfre/memories-vault`; a missing source directory is an error. The vault and Syncthing must permit UID/GID `1000:1000` to create and update files.
- Supply a random URL-safe `MEMORIES_DB_PASSWORD`, a random `MCP_HTTP_TOKEN`, and any optional `MCP_HTTP_PUBLIC_BASE_URL` through the untracked `.env`. Do not record credentials or capability URLs in this journal.
- Postgres 16 with pgvector and CPU Ollama have persistent volumes and no published ports. Only the gateway is published, at `127.0.0.1:8788`, for the host's Cloudflare tunnel.
- Start the database and Ollama first, pull `nomic-embed-text:v1.5`, and verify `/v1/embeddings` returns 768-dimensional vectors before starting the gateway. The gateway migrates, scans, then serves MCP. Its existing scope policy remains unchanged.
- A host systemd timer will scan after Syncthing edits. Invoke `./node_modules/.bin/tsx src/cli/index.ts scan` inside the gateway; serialize scheduled runs. If embeddings were unavailable during a scan, run the same CLI with `reembed`, because unchanged files are otherwise skipped.
- Gateway startup uses the installed Prisma and tsx binaries directly so UID 1000 does not depend on root's Corepack cache. No application code or existing documentation was changed for this configuration.
- Verify through a real MCP client: missing/wrong token rejection, initialize and tool listing, health, search and fetch, expected corpus/vector counts, and a controlled write/update round trip through Syncthing. The MCP HTTP transport has no unauthenticated health route. Keep destructive test suites on a separate test database and fixture vault.
- `MCP_HTTP_PUBLIC_BASE_URL` currently builds citation URLs; the MCP HTTP transport does not itself serve the generated `/memory/documents/<id>` routes. Leaving it unset uses `memory://` citations.

Deployment and end-to-end checks are owned by the main restore task; this journal records configuration intent, not a claim that production is verified.
