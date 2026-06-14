# Connecting ChatGPT to your memories (read + propose)

ChatGPT runs in OpenAI's cloud, so it can only reach a **public HTTPS** MCP endpoint.
This guide exposes the gateway's HTTP MCP transport via a tunnel. Reads (incl. `private`
notes, per config) are sent to OpenAI; writes are limited to *proposals* (no approval tool
is exposed — approval stays terminal-only).

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

## 3. Tunnel it (ngrok)

```bash
ngrok http 8788
```

Copy the public URL, e.g. `https://abcd-12-34.ngrok-free.app`.
Your connector URL is: `https://abcd-12-34.ngrok-free.app/<MCP_HTTP_TOKEN>/mcp`.

> Free ngrok URLs change on restart — you'll re-paste the URL each session. A paid ngrok
> static domain or a Cloudflare Tunnel gives a stable URL. Keep the tunnel **off when not
> in use**; the token in the URL is a credential.

## 4. Add the connector in ChatGPT

Settings → Apps & Connectors → Advanced → **Developer mode** → add a connector with the
URL from step 3, **auth = none** (the token is in the URL). Enable its tools per
conversation. ChatGPT will see `search`, `fetch`, `memory_propose_note`,
`memory_propose_patch`, `memory_list_proposals`, plus read tools — but **not** an approve
tool.

## 5. Approving what ChatGPT proposes

Proposals queue exactly like Claude Code's. Approve from your terminal:
`pnpm --filter @memories/memory-gateway proposals` (read the code) then
`pnpm --filter @memories/memory-gateway proposals review <id> --approve`.

## Security notes

- Token in URL = capability auth (MVP). The OAuth 2.1 flow is the recommended hardening
  before leaving the endpoint always-on.
- Scope: `connectors.chatgpt.scope` controls what ChatGPT can read. Default is all
  namespaces + all sensitivities (incl. `private`). Narrow it in `config.yaml` to reduce
  egress.
- The endpoint binds to `127.0.0.1` and is only reachable through the tunnel you start;
  every request is token-gated (constant-time check) before any MCP/DB work.
```
