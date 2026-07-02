# Connecting ChatGPT to your memories (read + write)

ChatGPT runs in OpenAI's cloud, so it can only reach a **public HTTPS** MCP endpoint.
This guide exposes the gateway's HTTP MCP transport via a tunnel. **Peer model:** ChatGPT
reads everything and writes notes directly into the vault; the owner reviews by editing
(changes are versioned server-side).

## Prerequisites

- A ChatGPT plan with **developer mode / custom connectors** enabled. On Business/
  Enterprise/Edu this is **subject to a workspace admin** allowing it — confirm first.
- Postgres up and the index built: `docker compose up -d db && pnpm --filter @memories/memory-gateway db:migrate && pnpm --filter @memories/memory-gateway scan`.

## 1. Set a token

In `apps/memory-gateway/.env` (gitignored): `MCP_HTTP_TOKEN=<a long random string, ≥32 chars>`.
Optionally set `MCP_HTTP_PUBLIC_BASE_URL` to your tunnel URL prefix for citation links.
Until a token is set, the HTTP endpoint fails closed (every request gets 401).

## 2. Start the HTTP transport

```bash
pnpm --filter @memories/memory-gateway mcp:http
# listening on 127.0.0.1:8788, path: /<MCP_HTTP_TOKEN>/mcp
```

## 3. Tunnel it

Cloudflare named tunnel (stable hostname, recommended) or `ngrok http 8788` for a quick
test. Your connector URL is: `https://<public-host>/<MCP_HTTP_TOKEN>/mcp`.

> The token in the URL is a credential — treat the whole URL as a secret.

## 4. Add the connector in ChatGPT

Settings → Apps & Connectors → Advanced → **Developer mode** → add a connector with the
URL from step 3, **auth = none** (the token is in the URL). Enable its tools per
conversation. ChatGPT sees the read tools (`search`, `fetch`, `memory_search`,
`memory_fetch`, `memory_recent`, `memory_context_pack`, `memory_explain_sources`,
`memory_protocol`, `health_status`) plus the write tools `memory_write_note` and
`memory_update_note`.

## 5. How writes work

`memory_write_note` creates a real `.md` file in the vault immediately (default folder
`00-inbox/`); `memory_update_note` replaces a note's body. There is no approval step —
review by editing the note in Obsidian/SilverBullet. The only refusals: content that
looks like credentials, and bodies that start with `---`. The working rules live in the
vault note `99-meta/PROTOCOL.md`, which every MCP client receives at connect.

## Security notes

- Token in URL = capability auth (MVP). The OAuth 2.1 flow is the recommended hardening
  before leaving the endpoint always-on.
- The connector sees and writes **everything** (`public` + `internal`) — the owner's
  explicit choice. Narrow `connectors.chatgpt.scope` in `config.yaml` to reduce egress
  if that ever changes.
- The endpoint binds to `127.0.0.1` and is only reachable through the tunnel; every
  request is token-gated (constant-time check) before any MCP/DB work. Server-side
  file versioning (Syncthing `.stversions`) keeps history of every AI write.
