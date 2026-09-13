import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VaultStore } from './vault.js';
import { Maintenance } from './state.js';
import { createMcp } from './mcp.js';
import { startHttp } from './http.js';

async function main() {
  const root = process.env.MEMORIES_VAULT;
  if (!root) throw new Error('Set MEMORIES_VAULT to the local vault directory');
  const state = resolve(process.env.MEMORIES_STATE ?? join(homedir(), '.local/state/memories'));
  const store = new VaultStore(resolve(root), state);
  const maintenance = new Maintenance(store, state);
  if (process.argv.includes('--maintenance')) { process.stdout.write(JSON.stringify(await maintenance.refresh(), null, 2) + '\n'); return; }
  if (process.argv.includes('--stdio')) {
    await createMcp(store, maintenance).connect(new StdioServerTransport());
    return;
  }
  const interval = Number(process.env.MEMORIES_MAINTENANCE_SECONDS ?? '900');
  const port = Number(process.env.MEMORIES_PORT ?? '3333');
  if (!Number.isSafeInteger(interval) || interval < 10) throw new Error('Invalid maintenance interval');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const running = await startHttp({ store, maintenance, port, token: process.env.MEMORIES_TOKEN ?? '', capabilityUrl: process.env.MEMORIES_CAPABILITY_URL === 'true' });
  await maintenance.refresh();
  const timer = setInterval(() => { void maintenance.refresh().catch(() => process.stderr.write('Maintenance failed; previous report retained\n')); }, interval * 1000);
  process.stderr.write(`Memories listening on ${running.url}\n`);
  const stop = async () => { clearInterval(timer); await running.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(error => { process.stderr.write(`Memories startup failed: ${error.message}\n`); process.exitCode = 1; });
