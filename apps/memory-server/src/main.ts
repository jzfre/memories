import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadVaults, selectVault } from './config.js';
import { createMcp } from './mcp.js';
import { startHttp } from './http.js';

async function main() {
  const vaults = await loadVaults(process.env);
  if (process.argv.includes('--maintenance') || process.argv.includes('--stdio')) {
    const vault = selectVault(vaults, process.env.MEMORIES_VAULT_ID);
    if (process.argv.includes('--maintenance')) { process.stdout.write(JSON.stringify(await vault.maintenance.refresh(), null, 2) + '\n'); return; }
    await createMcp(vault.store, vault.maintenance, vault.id).connect(new StdioServerTransport());
    return;
  }
  const interval = Number(process.env.MEMORIES_MAINTENANCE_SECONDS ?? '900');
  const port = Number(process.env.MEMORIES_PORT ?? '3333');
  // Node clamps delays above 2^31 - 1 ms to 1 ms, which would cause a scan loop.
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > Math.floor(2_147_483_647 / 1000)) throw new Error('Invalid maintenance interval');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const running = await startHttp({ vaults, port, capabilityUrl: process.env.MEMORIES_CAPABILITY_URL === 'true' });
  // Derived reports must not prevent an otherwise healthy vault from serving.
  // Keep both startup and periodic failures local to their vault; tool calls still
  // return their errors so clients never mistake a failed scan for fresh results.
  const refresh = () => Promise.all(vaults.map(vault => vault.maintenance.refresh().catch(() => {
    process.stderr.write(`Maintenance failed for ${vault.id}; existing report retained if available\n`);
  })));
  const timer = setInterval(() => { void refresh(); }, interval * 1000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await running.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.stderr.write(`Memories listening on ${running.url}\n`);
  await refresh();
}
main().catch(error => { process.stderr.write(`Memories startup failed: ${error.message}\n`); process.exitCode = 1; });
