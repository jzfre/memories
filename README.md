# Memories

Memories gives AI clients authenticated access to separate Markdown knowledge bases. It reads current notes, searches names and topics, and saves recoverable versions before changing a note. The connected AI client supplies research and reasoning.

Obsidian Sync connects a desktop vault to the server, where official Headless Sync and the Memories MCP service run continuously. Each independently synced vault has its own copy of this flow:

```text
Desktop Obsidian ⇄ Obsidian Sync ⇄ Server vault ⇄ Memories MCP ⇄ AI clients
                                                │
                                                └─ Private history and maintenance state
```

## How vaults work

Examples use `personal` and `work`. Vault IDs are configurable; add more entries
to private configuration without changing application code.

- Each vault has its own notes, private history/state, and HTTP credential.
- A credential selects exactly one vault before any MCP tool runs. Tools cannot
  switch vaults or search across them.
- Configure `personal` as the client's global connection. A work project replaces
  the same connection named `memories` with its work credential.
- Project directories do not route requests automatically. Configure each client
  in the environment where the agent runs, including VM/container guests.
- `kb_peek.vault` must match the project's assignment. A missing or mismatched
  connection must stop memory access, without falling back to another vault.

All nine tools, the overview resource, search results, and recoverable history
stay within the authenticated vault. HTTP always requires a credential; an
unauthenticated request does not fall back to personal. Local stdio defaults to
personal and rejects an unknown explicit selection.

## Quick start: personal and work

Requires Node.js 22+, pnpm 9.15.9, and Python 3 for this configuration example.
From a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm test:compiled
```

Create empty vault directories and a private registry outside the repository.
This example generates distinct credentials and refuses to overwrite an existing
registry. For existing notes, use their actual vault/state paths instead; follow
the [migration guide](deploy/README.md#multiple-vaults) before moving synced data.

```sh
python3 - <<'PY'
import json
import os
from pathlib import Path
from secrets import token_urlsafe

base = Path.home()
config = base / '.config/memories/vaults.json'
if config.exists():
    raise SystemExit('Registry already exists; review it instead of overwriting.')
config.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
vaults = []
for vault_id in ('personal', 'work'):
    path = base / ('memories-vault' if vault_id == 'personal' else 'memories-vaults/work')
    state = base / '.local/state' / ('memories' if vault_id == 'personal' else 'memories-work')
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    vaults.append({'id': vault_id, 'path': str(path), 'state': str(state), 'token': token_urlsafe(32)})
fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'vaults': vaults}, stream, indent=2)
    stream.write('\n')
print('Created private personal/work registry; credentials were not printed.')
PY
```

Start the HTTP server in the foreground:

```sh
export MEMORIES_CONFIG="$HOME/.config/memories/vaults.json"
export MEMORIES_CAPABILITY_URL=true
pnpm mcp:http
```

The listener binds `127.0.0.1:3333`. A local client can use `/mcp` with its vault's
bearer token, or `/<token>/mcp` with capability URLs enabled above. Retrieve the
correct token from the private registry; keep tokens and complete secret URLs
out of chat, logs, and Git. Remote clients need an HTTPS endpoint forwarded to
this listener, such as `https://memories.example.com`; see
[server deployment](deploy/README.md) for persistent services and HTTPS.

## Connect a client and verify its vault

Follow the [client setup guide](docs/agents.md#project-isolation) for concrete
Codex and Claude Code configurations: global `personal`, project-local `work`,
and the client workflow skill. Use only the assigned vault's credential. A remote
project client does not need the server's complete registry or vault files.

Start a new client session in the intended project and ask it to call `kb_peek`.
The returned `vault` must be `work` in the configured work project and `personal`
outside it. Fetch one returned note, if available, to verify actual access.
Configure and verify every new repository/worktree; do not assume a parent
outside its Git root supplies the project connection. Disable independent
connectors that would expose another vault in that session.

For an agent performing setup, provide the server account and paths, intended
vault IDs, project roots, and authenticated endpoint through private settings.
Require it to verify the assigned vault in each client before reading any notes.
Private project names and mappings must never be copied into repository files.

## Local process and synchronization

When the client already has authorized access to the server's local files, it can
launch a stdio MCP using the registry above:

```sh
export MEMORIES_CONFIG="$HOME/.config/memories/vaults.json"
export MEMORIES_VAULT_ID=work
pnpm mcp
```

Run `unset MEMORIES_VAULT_ID` for personal. For legacy single-vault setup:

```sh
unset MEMORIES_CONFIG MEMORIES_VAULT_ID
export MEMORIES_VAULT="/absolute/path/to/vault"
export MEMORIES_STATE="/absolute/path/outside/vault/memories-state"
pnpm mcp
```

The legacy example assumes `MEMORIES_CONFIG` is unset; a configured registry
takes precedence. Legacy HTTP also requires `MEMORIES_TOKEN`. `pnpm maintenance`
refreshes reports for the selected local vault; search reads current files.

Sync is separate from MCP: each independently synced vault needs its own Obsidian
remote vault and local Sync configuration. A single remote vault split into
folders does not provide this separation. Obsidian Sync encryption passwords are
separate from MCP credentials. See the [Sync deployment guide](deploy/README.md)
for desktop/server configuration, verification, and recovery.

## Further documentation

- [Review TODO and verification](TODO.md)
- [Review findings and proposed improvements](docs/review.md)

- [Architecture, nine MCP tools, authentication and operating limits](docs/filesystem-memories.md)
- [Readable notes, proposed kinds/templates and authorization design](docs/note-model.md)
- [Server deployment, verification and recovery](deploy/README.md)
- [Client workflow](skills/using-memories/SKILL.md)
- [ChatGPT connection fields, activation, mobile support and troubleshooting](docs/chatgpt.md)
- [Other AI harnesses: MCP connection and portable skill installation](docs/agents.md)

The application code is in `apps/memory-server`. Keep the vault, credentials and
runtime history outside this repository. Synchronization and MCP history
complement independent backups; they do not replace them. The
[registry example](deploy/vaults.example.json) also shows an optional `family`
vault. Keep real project names, directory mappings, and deployment details in
private configuration outside this repository.
