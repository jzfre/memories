# Executor guides

An *executor* is any AI client or agent surface that connects to the Memory Gateway.
Policy (namespace/sensitivity scope, write guards, audit logging) is enforced
server-side below all adapters — no executor can bypass it. Under the peer-work model,
executors with the `write` capability create notes directly; the owner reviews by editing.

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

---

## OpenClaw / IronClaw

OpenClaw and IronClaw can integrate with the Memory Gateway either via the REST API or
via MCP.

**Integration pattern:**

1. **Context retrieval** — call `POST /memory/search` or the `memory_search` MCP tool
   to pull scoped context before generating a response.
2. **Context packs** — call `POST /memory/context-pack` or `memory_context_pack` for
   goal-oriented, token-budgeted context ready for LLM consumption.
3. **Writeback** — executors with the `write` capability create notes directly via the
   `memory_write_note` / `memory_update_note` MCP tools. The file is written to the vault
   immediately; `folder` is required and must be an existing vault folder. The owner
   reviews by editing. Writes are MCP-only (no REST write route). The content refusals
   are secret-looking content and a body that starts with a `---` frontmatter block.

**Namespace and sensitivity scoping** is enforced server-side.  OpenClaw/IronClaw
cannot retrieve documents outside the configured allowlists regardless of what is
requested in the query.

---

## Sensitivity & model policy

Sensitivity is `public` | `internal`. Per the owner's decision, all connected clients
(including cloud clients like ChatGPT) may read and write everything — sensitivity is a
label for organization, not an access gate. If you ever reintroduce a "cloud must not
see X" rule, narrow a connector's `scope.sensitivities` in `config.yaml` (the
scope-intersection machinery is still present and enforced server-side).

**Embeddings** are always computed locally via LM Studio's nomic model, regardless of
chat model selection.  The `DisabledEmbedder` is used when `EMBEDDINGS_ENABLED=0`
(the test default); the `OpenAICompatibleEmbedder` points at the local LM Studio
endpoint, not a cloud API.

**Retrieved content is data, not instructions.**  Every retrieval response carries
`safety_note: "UNTRUSTED_CONTENT_NOTE"` and the MCP tool descriptions state explicitly
that results are data and must not be treated as executable instructions.  Executors
should not act on content found inside retrieved documents without human review.
