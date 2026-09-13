# Memories

Memories gives AI clients authenticated access to a personal Markdown knowledge base. It reads current notes, searches names and topics, and saves recoverable versions before changing a note. The connected AI client supplies research and reasoning.

Obsidian Sync connects the Mac vault to Rocinante, where official Headless Sync and the Memories MCP service run continuously. Codex uses the authenticated HTTPS endpoint. For other clients, follow the [ChatGPT web/mobile setup](docs/chatgpt.md) or [AI agent setup](docs/agents.md).

```text
Mac Obsidian ⇄ Obsidian Sync ⇄ Rocinante vault ⇄ Memories MCP ⇄ AI clients
                                              │
                                              └─ Private history and maintenance state
```

Requires Node.js 22+ and pnpm 9.15.9. From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
```

For a local MCP client, configure these environment variables and launch `pnpm mcp`:

```sh
export MEMORIES_VAULT="/absolute/path/to/vault"
export MEMORIES_STATE="/absolute/path/outside/vault/memories-state"
pnpm mcp
```

`pnpm mcp:http` starts the loopback HTTP service and requires a private `MEMORIES_TOKEN`. Public access uses HTTPS through Cloudflare Tunnel. `pnpm maintenance` refreshes maintenance reports; search itself always reads current files.

- [Architecture, eight MCP tools, authentication and operating limits](docs/filesystem-memories.md)
- [Rocinante deployment, verification and recovery](deploy/README.md)
- [Client workflow](skills/using-memories/SKILL.md)
- [ChatGPT connection fields, activation, mobile support and troubleshooting](docs/chatgpt.md)
- [Other AI harnesses: MCP connection and portable skill installation](docs/agents.md)

The application code is in `apps/memory-server`. Keep the vault, credentials and runtime history outside this repository. Synchronization and MCP history complement independent backups; they do not replace them.
