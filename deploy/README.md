# Deploy Memories on Rocinante

The supplied units run Memories as `jzfre` and official Obsidian Headless Sync as a lingering user service. Commands below run on Rocinante. The application is at `/home/jzfre/services/memories`, the vault at `/home/jzfre/memories-vault`, and private state at `/home/jzfre/.local/state/memories`.

## Prepare synchronization

Use Node.js 22+ and an active Obsidian Sync subscription. Follow the current [official Headless installation](https://obsidian.md/help/headless) and [Sync guide](https://obsidian.md/help/sync/headless). The supplied unit expects the package installed under `~/.local`:

```sh
npm install --global --prefix "$HOME/.local" obsidian-headless
export PATH="$HOME/.local/bin:$PATH"
ob login
ob sync-list-remote
```

Enter credentials interactively. Start with a verified backup of the current Mac vault, seed or verify the intended encrypted remote vault from that copy, and confirm its identity before attaching the server. Configure an initially empty local directory:

```sh
install -d -m 0700 ~/memories-vault
ob sync-setup --vault '<verified-vault-id-or-name>' --path ~/memories-vault --device-name rocinante
ob sync-config --path ~/memories-vault --mode pull-only --configs '' --conflict-strategy conflict
ob sync --path ~/memories-vault
```

Compare the downloaded relative paths and SHA-256 hashes with the current Mac. Verify selected attachments separately. Keep private settings, Git metadata and runtime state out of data synchronization. Once the copy matches, enable bidirectional mode:

```sh
ob sync-config --path ~/memories-vault --mode bidirectional
```

Mac uses desktop Sync; Rocinante uses Headless Sync. Do not run both Sync clients against the same vault on one device. Test a temporary note in both directions and verify deletion propagation before relying on continuous operation.

## Build and configure Memories

Deploy the reviewed code and lockfile, then run:

```sh
cd /home/jzfre/services/memories
pnpm install --frozen-lockfile
pnpm build
install -d -m 0700 ~/.config/memories ~/.local/state/memories
```

Create a private environment file. This example refuses to overwrite an existing configuration and does not print the generated credential:

```sh
python3 - <<'PY'
import os
from pathlib import Path
from secrets import token_urlsafe

path = Path.home() / '.config/memories/server.env'
values = [
    'MEMORIES_VAULT=/home/jzfre/memories-vault',
    'MEMORIES_STATE=/home/jzfre/.local/state/memories',
    'MEMORIES_PORT=3333',
    'MEMORIES_TOKEN=' + token_urlsafe(32),
    'MEMORIES_CAPABILITY_URL=true',
]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write('\n'.join(values) + '\n')
print('Created private server configuration.')
PY
```

Keep the existing credential during ordinary upgrades. Rocinante explicitly enables capability URLs for its configured Codex connection, as shown above; the runtime default is off. Store the complete URL only in private client configuration. Prefer bearer headers for clients that support them. Authentication details and limits are in the [operating guide](../docs/filesystem-memories.md#configuration-and-access).

The application binds `127.0.0.1:3333`. The system service runs with no capabilities and a read-only filesystem except the configured vault, private state and temporary directory. If paths change, update both the environment file and `ReadWritePaths` in the unit. All local MCP writers must share the same state directory.

## Enable services

```sh
cd /home/jzfre/services/memories
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/obsidian-headless.service ~/.config/systemd/user/obsidian-headless.service
systemctl --user daemon-reload
sudo loginctl enable-linger jzfre
systemctl --user enable --now obsidian-headless.service
sudo systemd-analyze verify deploy/memories.service
sudo install -m 0644 deploy/memories.service /etc/systemd/system/memories.service
sudo systemctl daemon-reload
sudo systemctl enable --now memories.service
```

Lingering starts Headless Sync at boot without an SSH session. Its account credentials and encryption key remain in the official client's private configuration.

## HTTPS and client verification

Cloudflare Tunnel forwards `mcp.aqui.technology` to `http://127.0.0.1:3333`. Keep the existing tunnel identity, credential-file settings and other ingress rules. The Memories rule belongs before the final catch-all:

```yaml
ingress:
  - hostname: mcp.aqui.technology
    service: http://127.0.0.1:3333
  - service: http_status:404
```

Ensure the proxied DNS record targets the configured Rocinante tunnel. Validate any ingress change before restarting `cloudflared`:

```sh
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared.service
sudo ss -ltnp 'sport = :3333'
systemctl --user is-active obsidian-headless.service
sudo systemctl is-active memories.service
```

The listener must remain on loopback. An unauthenticated request to `https://mcp.aqui.technology/mcp` must return 401. From an authorized MCP client, verify all eight tools, `kb_peek`, search and fetch. Then create a temporary note, edit it, inspect its history, restart Memories, and restore the previous content. Verify the result on the Mac, remove the test note, and confirm deletion reaches the server. Preserve test evidence outside the vault without credentials or private note bodies.

Codex is connected to this HTTPS service. Follow the [ChatGPT web/mobile guide](../docs/chatgpt.md) to configure the separate account connection and verify discovery and a real retrieval before marking that client connected. Other harnesses can use the [agent setup guide](../docs/agents.md). Service startup alone does not establish client compatibility.

## Upgrades, backups and recovery

Before an upgrade, retain the current application build, units and environment file privately. Run the test suite, typecheck, build and compiled smoke check from the [operating guide](../docs/filesystem-memories.md#verification), then replace the build and restart Memories. Recheck authentication and a read after restart.

Back up the complete vault, private history/state, and required configuration with encryption. Keep a copy independent of both synced devices and test decryption and restoration. MCP history and Obsidian version history are useful undo layers; neither replaces an independent backup.

To restore a note, inspect `kb_history` and use `kb_restore`; it saves the current version first. To recover a complete vault, stop the writer and Sync, restore a verified backup into an isolated directory, compare it with the current data, and deliberately choose what to bring back before reconnecting synchronization.

For an application rollback, stop Memories, restore the reviewed build and matching unit, reload systemd and start it again. Preserve the current vault and history. Restore the environment file only when its configuration needs reverting; credential changes require updating every client.

Inspect failures with `sudo journalctl -u memories.service -n 50 --no-pager` and `journalctl --user -u obsidian-headless.service -n 50 --no-pager`. Do not copy credentials or full private URLs into reports. For a stuck `write.lock`, inspect its owner process first; never delete a live owner's lock.
