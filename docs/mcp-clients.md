# Connecting MCP clients

The Memories MCP server speaks stdio. Launch it via the repo-root `mcp` script so
it runs with the correct working directory (`.env` + `config.yaml` resolve from there).

## Claude Code (`.mcp.json` in a project, or `claude mcp add`)

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

## VS Code (`.vscode/mcp.json`)

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

After connecting, the client should list `memory_search`, `memory_fetch`, and
`health_status`. All calls are recorded in the `audit_log` table.

For LM Studio, Hermes, OpenClaw/IronClaw, and local model policy, see
[docs/executors.md](executors.md).
