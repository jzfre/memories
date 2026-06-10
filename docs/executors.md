# Executor guides

An *executor* is any AI client or agent surface that connects to the Memory Gateway.
Policy (namespace/sensitivity scope, proposal-only writeback, audit logging) is enforced
server-side below all adapters — no executor can bypass it.

See also: [Connecting MCP clients](mcp-clients.md) for Claude Code and VS Code quickstart configs.

---

## Claude Code

Add to `.mcp.json` in the project root (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "memories": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/Users/jzfre/Code/personal/memories"
    }
  }
}
```

The `pnpm mcp` wrapper resolves `.env` and `config.yaml` from the repo root.

---

## VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "memories": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/Users/jzfre/Code/personal/memories"
    }
  }
}
```

See [mcp-clients.md](mcp-clients.md) for full details on both clients.

---

## LM Studio

LM Studio's MCP support runs servers via stdio using a direct `command`/`args` pair.
The entry-point is `src/mcp/index.ts`; it must run with `cwd` = `apps/memory-gateway`
so that relative paths to `.env` and `config.yaml` resolve correctly.

`mcp.json` sample:

```json
{
  "mcpServers": {
    "memories": {
      "command": "tsx",
      "args": ["src/mcp/index.ts"],
      "cwd": "/Users/jzfre/Code/personal/memories/apps/memory-gateway"
    }
  }
}
```

`tsx` must be on `PATH` (install globally: `npm i -g tsx`) or replace `tsx` with the
full path returned by `which tsx`.

LM Studio is the **recommended embedding provider**: configure the `nomic-embed-text`
(or compatible nomic) model in LM Studio and point `EMBEDDINGS_URL` in `.env` at the
local server (default `http://localhost:1234/v1`).  Embeddings are computed locally
regardless of which chat model is in use.

---

## Hermes (local models via stdio MCP)

Hermes and compatible local-model runtimes that support stdio MCP use the same wire
protocol as Claude Code.  Configure the server identically to the Claude Code example,
substituting the Hermes config key:

```json
{
  "mcpServers": {
    "memories": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/Users/jzfre/Code/personal/memories"
    }
  }
}
```

If Hermes requires a direct executable rather than `pnpm`, use the LM Studio pattern
(`tsx src/mcp/index.ts`, `cwd` = `apps/memory-gateway`).

**Notes:**
- `cwd` must be the repo root (for `pnpm mcp`) or `apps/memory-gateway` (for direct
  `tsx`).  The server will fail to load config if `cwd` is wrong.
- All namespace and sensitivity policy is enforced server-side; the executor model has
  no ability to override scope or bypass the audit log.
- Local models should be used for `private` and above sensitivity corpora (see
  [Local model policy](#local-model-policy) below).

---

## OpenClaw / IronClaw

OpenClaw and IronClaw can integrate with the Memory Gateway either via the REST API or
via MCP.

**Integration pattern:**

1. **Context retrieval** — call `POST /memory/search` or the `memory_search` MCP tool
   to pull scoped context before generating a response.
2. **Context packs** — call `POST /memory/context-pack` or `memory_context_pack` for
   goal-oriented, token-budgeted context ready for LLM consumption.
3. **Writeback** — agents may only propose knowledge; never write directly.  Use
   `POST /proposals` (REST) or `memory_propose_note` / `memory_propose_patch` (MCP).
   The proposal is queued as `pending_review`; no vault file is created until a human
   approves it via the CLI (`pnpm proposals review <id> --approve`) or the REST
   endpoint (`POST /proposals/:id/review`).

**Do not expose the review/approve surface to a chat surface.**  Per
`docs/implementation-plan.md` §20.4, v1 exposes Tier 0 (read) and Tier 1 (propose)
tools only over MCP.  Review/approve is Tier 2 and is restricted to the human
CLI/REST surface.  Wiring `POST /proposals/:id/review` into an automated chat flow
would allow an agent to commit arbitrary Markdown to the canonical vault.

**Namespace and sensitivity scoping** is enforced server-side.  OpenClaw/IronClaw
cannot retrieve documents outside the configured allowlists regardless of what is
requested in the query.

---

## Local model policy

The following rules govern which AI models may process retrieved content:

| Sensitivity label       | Allowed models                                        |
|-------------------------|-------------------------------------------------------|
| `public`                | Any model, including cloud (Claude, GPT-4, etc.)      |
| `internal`              | Any model, including cloud                            |
| `private`               | Local models only by default; cloud requires explicit owner approval per session |
| `confidential`          | Local models only                                     |
| `client-confidential`   | Local models only; never leaves the machine without explicit owner approval |

**Embeddings** are always computed locally via LM Studio's nomic model, regardless of
chat model selection.  The `DisabledEmbedder` is used when `EMBEDDINGS_ENABLED=0`
(the test default); the `OpenAICompatibleEmbedder` points at the local LM Studio
endpoint, not a cloud API.

**Retrieved content is data, not instructions.**  Every retrieval response carries
`safety_note: "UNTRUSTED_CONTENT_NOTE"` and the MCP tool descriptions state explicitly
that results are data and must not be treated as executable instructions.  Executors
should not act on content found inside retrieved documents without human review.
