# Deploy Memories on a Linux server

The supplied units use the example Linux account `memories` and run official Obsidian Headless Sync as a lingering user service. Replace this account, its home paths and `memories.example.com` consistently with your own deployment values. Commands below run as that account on the server. The example layout keeps source and the compiled application at `/home/memories/Code/personal/memories`, deployment configuration and operations at `/home/memories/services/memories`, the personal vault at `/home/memories/memories-vault`, and private state at `/home/memories/.local/state/memories`.

## Prepare synchronization

Use Node.js 22+ and an active Obsidian Sync subscription. Follow the current [official Headless installation](https://obsidian.md/help/headless) and [Sync guide](https://obsidian.md/help/sync/headless). The supplied unit expects the package installed under `~/.local`:

```sh
npm install --global --prefix "$HOME/.local" obsidian-headless
export PATH="$HOME/.local/bin:$PATH"
ob login
ob sync-list-remote
```

Enter credentials interactively. Start with a verified backup of the current desktop vault, seed or verify the intended encrypted remote vault from that copy, and confirm its identity before attaching the server. Configure an initially empty local directory:

```sh
install -d -m 0700 ~/memories-vault
ob sync-setup --vault '<verified-vault-id-or-name>' --path ~/memories-vault --device-name memories-server
ob sync-config --path ~/memories-vault --mode pull-only --configs '' --conflict-strategy conflict
ob sync --path ~/memories-vault
```

Compare the downloaded relative paths and SHA-256 hashes with the current desktop copy. Verify selected attachments separately. Keep private settings, Git metadata and runtime state out of data synchronization. Once the copy matches, enable bidirectional mode:

```sh
ob sync-config --path ~/memories-vault --mode bidirectional
```

Use desktop Sync on the desktop and Headless Sync on the server. Do not run both Sync clients against the same vault on one device. Test a temporary note in both directions and verify deletion propagation before relying on continuous operation.

## Build and configure Memories

Deploy the reviewed code and lockfile, then run:

```sh
cd /home/memories/Code/personal/memories
pnpm install --frozen-lockfile
pnpm build
install -d -m 0700 ~/services/memories/config ~/.local/state/memories ~/.local/state/memories-work ~/.local/state/memories-family ~/memories-vaults/work ~/memories-vaults/family
```

Create a private environment file. This example refuses to overwrite an existing configuration and does not print the generated credential:

```sh
python3 - <<'PY'
import os
from pathlib import Path
from secrets import token_urlsafe

path = Path.home() / 'services/memories/config/server.env'
values = [
    'MEMORIES_VAULT=/home/memories/memories-vault',
    'MEMORIES_STATE=/home/memories/.local/state/memories',
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

The example private environment file is `~/services/memories/config/server.env`.
Keep the existing credential during ordinary upgrades. This example enables capability URLs for clients that need them; the runtime default is off. Store the complete URL only in private client configuration. Prefer bearer headers for clients that support them. Authentication details and limits are in the [operating guide](../docs/filesystem-memories.md#configuration-and-access).

The application binds `127.0.0.1:3333`. The system service runs with no capabilities and a read-only filesystem except the configured vault, private state and temporary directory. If paths change, update both the environment file and `ReadWritePaths` in the unit. All local MCP writers must share the same state directory.

## Enable services

```sh
cd /home/memories/Code/personal/memories
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/obsidian-headless.service ~/services/memories/obsidian-headless.service
ln -sfn /home/memories/services/memories/obsidian-headless.service ~/.config/systemd/user/obsidian-headless.service
systemctl --user daemon-reload
sudo loginctl enable-linger memories
systemctl --user enable --now obsidian-headless.service
install -m 0644 deploy/memories.service ~/services/memories/memories.service
sudo systemd-analyze verify ~/services/memories/memories.service
sudo ln -sfn /home/memories/services/memories/memories.service /etc/systemd/system/memories.service
sudo systemctl daemon-reload
sudo systemctl enable --now memories.service
```

The canonical deployed units live in `~/services/memories/`; installed systemd
paths are symlinks to those files. Edit deployed units there, or deliberately
refresh them from these tracked templates, then reload the appropriate manager.

Lingering starts Headless Sync at boot without an SSH session. Its account credentials and encryption key remain in the official client's private configuration.

## HTTPS and client verification

For example, a Cloudflare Tunnel can forward `memories.example.com` to `http://127.0.0.1:3333`. Substitute your own hostname and keep your tunnel identity, credential-file settings and other ingress rules. The Memories rule belongs before the final catch-all:

```yaml
ingress:
  - hostname: memories.example.com
    service: http://127.0.0.1:3333
  - service: http_status:404
```

Ensure the proxied DNS record targets your configured tunnel. Validate any ingress change before restarting `cloudflared`:

```sh
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared.service
sudo ss -ltnp 'sport = :3333'
systemctl --user is-active obsidian-headless.service
sudo systemctl is-active memories.service
```

The listener must remain on loopback. An unauthenticated request to your configured HTTPS `/mcp` endpoint must return 401. From an authorized MCP client, verify all nine tools, `kb_peek`, search and fetch. Then create a temporary note, edit it, inspect its history, restart Memories, and restore the previous content using its current hash. Fetch the note again and remove it with `kb_remove` and its returned hash; confirm deletion reaches the desktop. Verify recovery with `kb_history` and `kb_restore` using an empty `expected_hash`, then remove the temporary note again. Preserve test evidence outside the vault without credentials or private note bodies.

Connect Codex and Claude Code using the [agent setup guide](../docs/agents.md). Follow the [ChatGPT web/mobile guide](../docs/chatgpt.md) to configure the separate account connection and verify discovery and a real retrieval before marking that client connected. Service startup alone does not establish client compatibility.

## Standalone production releases

An existing service may run a compiled release outside the development checkout.
Preserve that layout during an upgrade. The release builder copies only `dist`,
the package manifest, and production dependencies, fixes pnpm's workspace
self-reference, rejects external or broken symlinks, and writes a SHA-256 file
manifest. It refuses an existing destination or a destination inside the checkout.
Use the pinned pnpm version and populate its package store with the frozen install
before packaging; packaging itself runs offline against the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
release_dir="$(mktemp -d)/release"
pnpm release "$release_dir"
MEMORIES_TEST_ENTRY="$release_dir/dist/main.js" pnpm test:compiled
tar -czf "$release_dir.tar.gz" -C "$release_dir" .
sha256sum "$release_dir.tar.gz"
```

The compiled smoke check exercises the chosen artifact over stdio and HTTP using
temporary vaults. It covers all configured test scopes, removal/recovery, and
restart recovery. Keep the archive digest and `release-manifest.json` with the
private deployment receipt. Transport the archive through the authorized admin
route, compare its SHA-256 before extraction, and extract into a **new** release
directory under `~/services/memories/releases/<release-id>`. Preserve symlinks;
do not copy only `dist` or link back to development `node_modules`. Use a compatible
Node.js 22+ runtime on the target host.

Before activation, inspect the effective systemd configuration and retain the
current release and selector. Update the existing production-release override,
if one is already in use, rather than introducing competing selectors. A generic
selector looks like this after replacing the account and release ID:

```ini
[Service]
WorkingDirectory=/home/memories/services/memories/releases/<release-id>
ExecStart=
ExecStart=/usr/bin/node /home/memories/services/memories/releases/<release-id>/dist/main.js
```

Retain the current environment file, vault registry, credentials, listener,
write-path restrictions and Sync units. Validate the resulting unit, reload
systemd, restart Memories and perform the authenticated checks above. If startup
or retrieval fails, restore the previous selector, reload and restart; keep the
vault and history intact. A successful archive smoke check does not establish
production filesystem permissions or desktop Sync behavior.

## Upgrades, backups and recovery

### Multiple vaults

The examples use `personal`, `work` and `family`; actual vault IDs and paths belong
in private deployment and client configuration. Copy `deploy/vaults.example.json`
to the private deployment configuration, replace
placeholder credentials, and set `MEMORIES_CONFIG` in `config/server.env`. Preserve
the current personal token, vault path and history path. Generate independent
credentials for `work` and `family`. Keep the JSON mode 0600, outside all vaults and
Git. Restart the service after configuration changes.

For example, add this to the private `server.env` after preparing the registry:

```ini
MEMORIES_CONFIG=/home/memories/services/memories/config/vaults.json
```

The registry takes precedence over legacy `MEMORIES_VAULT`, `MEMORIES_STATE`, and
`MEMORIES_TOKEN`. The [README quick start](../README.md#quick-start-personal-and-work)
shows how to generate a fresh personal/work registry without printing tokens.
Preserve existing paths and credentials when upgrading an installed service.

The supplied system unit permits writes to the personal vault/state and to
`/home/memories/memories-vaults/{work,family}` with the corresponding
`/home/memories/.local/state/memories-{work,family}` directories. Create all configured
directories before starting the unit. Keep the existing personal Sync unit;
install `obsidian-headless@.service` in the deployment directory and symlink it
from the user systemd directory for independently configured `work` and `family`
Sync instances.

For a fresh work vault, first create its separate remote vault in Obsidian Sync,
then connect an empty local directory using the remote ID returned by
`ob sync-list-remote`. Enter its Sync encryption password interactively; this is
not its MCP credential:

```sh
ob sync-setup --vault '<work-remote-vault-id>' --path ~/memories-vaults/work --device-name memories-server
ob sync-config --path ~/memories-vaults/work --mode pull-only --configs '' --conflict-strategy conflict
ob sync --path ~/memories-vaults/work
```

Compare the downloaded files with the authoritative copy before enabling writes.
Once verified, enable bidirectional Sync and the corresponding user service:

```sh
ob sync-config --path ~/memories-vaults/work --mode bidirectional
install -m 0644 deploy/obsidian-headless@.service ~/services/memories/obsidian-headless@.service
ln -sfn "$HOME/services/memories/obsidian-headless@.service" ~/.config/systemd/user/obsidian-headless@.service
systemctl --user daemon-reload
systemctl --user enable --now obsidian-headless@work.service
```

Configure a separate local desktop vault against that same work remote and verify
changes/deletions in both directions. Repeat with the selected ID/path for any
additional vault. Only instantiate the template for paths under
`~/memories-vaults/<id>`; customize it for other layouts.

Each independently synced vault needs its own remote Obsidian vault and an eligible Sync plan. If
Obsidian reports a vault limit, leave source notes in place until the owner
upgrades. Never remove synced originals before the destination and recovery
backup are verified. Stop MCP and source Sync during the final move; preserve
relative paths and transfer the corresponding `history/SHA256(relative-path)`
directories to the new private state. Remove migrated history from personal too,
otherwise `kb_restore` could recreate project notes in personal. Refresh all
maintenance reports after migration. Cross-vault links need explicit review.

Verify hashes, destination Sync completion, removal propagation from personal,
and real MCP retrieval with each credential. A work token must not read or restore
personal/family notes. Apply and verify project client overrides on every
relevant device; existing chats may need a fresh connection.
See [agent setup](../docs/agents.md#project-isolation).

Before an upgrade, retain the current application build, units and environment file privately. Run the test suite, typecheck, build and compiled smoke check from the [operating guide](../docs/filesystem-memories.md#verification), then replace the build and restart Memories. Recheck authentication and a read after restart.

Back up the complete vault, private history/state, and required configuration with encryption. Keep a copy independent of both synced devices and test decryption and restoration. MCP history and Obsidian version history are useful undo layers; neither replaces an independent backup.

To restore a note, inspect `kb_history` and use `kb_restore`; it saves the current version first. Pass the fetched current hash as `expected_hash`, or an empty string when recreating a removed note. Removal preserves private history; it is not a permanent purge of the note or its synchronized backups. To recover a complete vault, stop the writer and Sync, restore a verified backup into an isolated directory, compare it with the current data, and deliberately choose what to bring back before reconnecting synchronization.

For an application rollback, stop Memories, restore the reviewed build and matching unit, reload systemd and start it again. Preserve the current vault and history. Restore the environment file only when its configuration needs reverting; credential changes require updating every client.

Inspect failures with `sudo journalctl -u memories.service -n 50 --no-pager` and `journalctl --user -u obsidian-headless.service -n 50 --no-pager`. Do not copy credentials or full private URLs into reports. For a stuck `write.lock`, inspect its owner process first; never delete a live owner's lock.
