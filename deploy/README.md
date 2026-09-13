# Deploy the filesystem Memories server

This unit runs `apps/memory-server` on Rocinante as `jzfre`, using Node.js 22 or
later at `/usr/bin/node`. It does not run the legacy database gateway. Commands
below run on Rocinante; this directory alone does not install or start anything.

Before activation, verify that `/home/jzfre/memories-vault` contains the current
Mac vault and that Obsidian Headless Sync has completed its initial download.
Keep the verified pre-migration archive. Obsidian authentication and sync are
managed separately from this service.

## Prepare the application and private state

Deploy the reviewed repository and lockfile to `/home/jzfre/services/memories`,
with dependencies installed there. With the project's pnpm available:

```bash
cd /home/jzfre/services/memories
pnpm install --frozen-lockfile
pnpm --filter @memories/memory-server build
test -f apps/memory-server/dist/main.js
install -d -m 0700 /home/jzfre/.config/memories /home/jzfre/.local/state/memories
test -d /home/jzfre/memories-vault
```

Create the environment file as `jzfre`. This generates a random token directly
into a private file and refuses to overwrite an existing configuration:

```bash
python3 - <<'PY'
import os
from pathlib import Path
from secrets import token_urlsafe

path = Path('/home/jzfre/.config/memories/server.env')
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

The HTTP server binds `127.0.0.1` in application code. Authentication uses
`Authorization: Bearer <token>` at `/mcp`. Capability URL mode additionally
accepts `/<token>/mcp`; that complete URL is a credential. Store it only in
private client configuration, and keep it out of logs, the vault and reports.
A local HTTPS reverse proxy or Cloudflare Tunnel can forward to
`http://127.0.0.1:3333`. Configuring public routing is a separate deployment step.

The unit makes the filesystem read-only except for the vault, runtime state and
private temporary space. `ProtectHome=read-only` keeps the executable and its
dependencies visible under `/home/jzfre/services/memories`; it does not hide
that directory. Both `ReadWritePaths` directories must exist before startup.
Update those paths together with the environment file if relocating data.
History and maintenance state stay outside the synced vault and need their own
backup. The Node.js JIT is left enabled.

## Install and verify

### Continuous Obsidian Sync

The tracked `obsidian-headless.service` matches the deployed user service. It
expects official `obsidian-headless` installed under `~/.local`, a completed
`ob login` and `ob sync-setup`, and the verified vault at `~/memories-vault`.
Follow the [Sync cutover](../docs/filesystem-memories.md#official-sync-cutover)
before enabling this service. Run as `jzfre` on Rocinante:

```bash
cd /home/jzfre/services/memories
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/obsidian-headless.service ~/.config/systemd/user/obsidian-headless.service
systemctl --user daemon-reload
sudo loginctl enable-linger jzfre
systemctl --user enable --now obsidian-headless.service
systemctl --user is-active obsidian-headless.service
systemctl --user is-enabled obsidian-headless.service
```

Lingering starts the user service at boot without an interactive SSH login.
Account credentials and the vault encryption key remain in the official client's
private configuration, outside this repository. Mac uses Obsidian desktop Sync.

### Memories MCP

Save the previous application build, unit and environment file privately before
replacing an existing deployment. Keep the same token when updating the build.
After the initial vault and sync verification:

```bash
cd /home/jzfre/services/memories
sudo systemd-analyze verify deploy/memories.service
sudo install -m 0644 deploy/memories.service /etc/systemd/system/memories.service
sudo systemctl daemon-reload
sudo systemctl enable --now memories.service
sudo systemctl is-active memories.service
sudo systemctl is-enabled memories.service
sudo ss -ltnp 'sport = :3333'
```

The listener must be `127.0.0.1:3333`. Check authentication and an MCP handshake
without exposing the token or reading note content:

```bash
cd /home/jzfre/services/memories/apps/memory-server
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = await readFile('/home/jzfre/.config/memories/server.env', 'utf8');
const token = env.split('\n').find(line => line.startsWith('MEMORIES_TOKEN='))?.slice(15);
if (!token || Buffer.byteLength(token) < 32) throw new Error('Missing valid token');
const url = new URL('http://127.0.0.1:3333/mcp');
if ((await fetch(url)).status !== 401) throw new Error('Unauthenticated access must fail');
const client = new Client({ name: 'deployment-check', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const result = await client.listTools();
  if (!result.tools.some(tool => tool.name === 'kb_peek')) throw new Error('Expected tool missing');
  console.log('Authentication and MCP tool discovery passed.');
} finally {
  await client.close();
}
JS
```

Repeat the handshake after `sudo systemctl restart memories.service`. Use
`sudo journalctl -u memories.service -n 50 --no-pager` for startup failures.
Actual sync round trips, remote client access and note restoration still require
their own checks; service startup alone does not establish those results.

## Cloudflare route cutover

Pre-cutover snapshot on 2026-09-13: both `mcp.aqui.technology` and
`memories.aqui.technology` were proxied CNAME records targeting the old Eternity
tunnel, `449722f6-c5d3-46f3-8239-fbeb77377a93.cfargotunnel.com`. That tunnel had
no active connections. Rocinante's tunnel is
`c5d11ed9-d544-48b6-8369-2e774ea71626`, named `rocinante`, and had four active
connections. Its `/etc/cloudflared/config.yml` contained only the final
`http_status:404` ingress rule. Public DNS shows Cloudflare edge addresses and
does not reveal these proxied CNAME targets; check the Cloudflare DNS records
when verifying a future cutover.

The cutover was completed on 2026-09-13 after the real vault and authentication
checks passed. `mcp.aqui.technology` now targets the Rocinante tunnel and the
ingress below is active. Public HTTPS authentication, tool discovery,
search/read/write/history and restore after service restart passed. The old
`memories.aqui.technology` web-editor hostname remains unchanged. Exact rollback
files are in `/home/jzfre/.local/state/memories/cloudflare-cutover-20260913T120850Z`.
Refreshing the owner's actual ChatGPT connection is the remaining client step.

After vault migration and the authenticated local MCP checks pass, preserve the
current Cloudflare configuration and DNS record before changing them. Keep the
existing tunnel and credential-file settings, then add this hostname before
the final catch-all rule in `/etc/cloudflared/config.yml`:

```yaml
ingress:
  - hostname: mcp.aqui.technology
    service: http://127.0.0.1:3333
  - service: http_status:404
```

Retain any other hostname rules added since this snapshot. Validate the config,
restart the connector, and move only the MCP DNS record to Rocinante:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared.service
cloudflared tunnel route dns --overwrite-dns c5d11ed9-d544-48b6-8369-2e774ea71626 mcp.aqui.technology
```

The last command changes the existing record to the Rocinante tunnel's
`c5d11ed9-d544-48b6-8369-2e774ea71626.cfargotunnel.com` target. Run it as `jzfre`
so `cloudflared` can use that user's existing origin certificate without copying
credentials. Verify the authenticated MCP handshake through HTTPS, and verify
that unauthenticated `/mcp` requests still receive 401. Capability URLs retain
their complete path through this hostname rule.

`memories.aqui.technology` previously served the web editor. This MCP runtime
does not provide a web editor, so its DNS record is not part of this cutover.

## Roll back

Stop this deployment with `sudo systemctl disable --now memories.service`.
Restore the previous reviewed application build and unit, then run
`sudo systemctl daemon-reload` and restart that deployment. Restore an earlier
environment file only if configuration changed; changing its token also requires
updating clients. Preserve the vault, history/state, sync configuration and
independent backups throughout rollback. Do not replace current Markdown with
an old server replica as part of an application rollback.
If the public route changed, restore its recorded DNS and ingress configuration
as needed. Restoring the old Eternity DNS target alone does not recover a live
service while that tunnel has no active connections.
