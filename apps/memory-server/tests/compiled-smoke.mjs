import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// An explicit entry lets the same checks exercise the deployed, self-contained artifact.
const entry = process.env.MEMORIES_TEST_ENTRY
  ? resolve(process.env.MEMORIES_TEST_ENTRY)
  : fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'memories-compiled-'));
const vault = join(fixture, 'vault');
await mkdir(vault);
const env = { PATH: process.env.PATH, MEMORIES_VAULT: vault, MEMORIES_STATE: join(fixture, 'state') };
const parse = r => { assert.notEqual(r.isError, true); return JSON.parse(r.content[0].text); };
async function connect(overrides = {}) {
  const client = new Client({ name: 'compiled-smoke', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--stdio'], env: { ...env, ...overrides }, stderr: 'pipe' }));
  return client;
}
let client;
let httpProcess;
try {
  client = await connect();
  assert.equal((await client.listTools()).tools.length, 9);
  const first = parse(await client.callTool({ name: 'kb_write', arguments: { path: 'Smoke.md', content: '# Smoke\nFirst version', expected_hash: '' } }));
  parse(await client.callTool({ name: 'kb_edit', arguments: { path: 'Smoke.md', find: 'First', replace: 'Second', expected_hash: first.hash } }));
  const history = parse(await client.callTool({ name: 'kb_history', arguments: { path: 'Smoke.md' } }));
  await client.close();
  client = await connect();
  parse(await client.callTool({ name: 'kb_restore', arguments: { path: 'Smoke.md', version: history[0].version } }));
  assert.match(parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } })).text, /First version/);
  assert.equal(parse(await client.callTool({ name: 'kb_peek', arguments: { topic: 'Smoke' } })).noteCount, 1);
  const restored = parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } }));
  parse(await client.callTool({ name: 'kb_remove', arguments: { path: 'Smoke.md', expected_hash: restored.hash } }));
  assert.equal((await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } })).isError, true);
  const removedHistory = parse(await client.callTool({ name: 'kb_history', arguments: { path: 'Smoke.md' } }));
  parse(await client.callTool({ name: 'kb_restore', arguments: { path: 'Smoke.md', version: removedHistory[0].version, expected_hash: '' } }));
  await client.close();
  const entries = [{ id: 'personal', path: vault, state: env.MEMORIES_STATE, token: 'personal-compiled-test-credential-with-32-bytes' }];
  for (const id of ['work', 'family']) {
    const path = join(fixture, id);
    await mkdir(path);
    await writeFile(join(path, 'Smoke.md'), `# ${id} only`);
    entries.push({ id, path, state: join(fixture, `state-${id}`), token: `${id}-compiled-test-credential-with-32-bytes` });
  }
  const config = join(fixture, 'vaults.json');
  await writeFile(config, JSON.stringify({ vaults: entries }));
  for (const id of ['personal', 'work', 'family']) {
    client = await connect({ MEMORIES_CONFIG: config, ...(id === 'personal' ? {} : { MEMORIES_VAULT_ID: id }) });
    assert.equal(parse(await client.callTool({ name: 'kb_peek', arguments: {} })).vault, id);
    const text = parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } })).text;
    assert.match(text, id === 'personal' ? /First version/ : new RegExp(`${id} only`));
    await client.close();
  }
  const unknown = spawnSync(process.execPath, [entry, '--stdio'], { env: { ...env, MEMORIES_CONFIG: config, MEMORIES_VAULT_ID: 'unknown' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown vault/);
  const overflow = spawnSync(process.execPath, [entry], { env: { ...env, MEMORIES_MAINTENANCE_SECONDS: '2147484' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(overflow.status, 1);
  assert.match(overflow.stderr, /Invalid maintenance interval/);
  // Exercise the compiled HTTP entry as well: source-mode tests do not prove a
  // copied release can start with only its own production dependencies.
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  httpProcess = spawn(process.execPath, [entry], {
    env: { ...env, MEMORIES_CONFIG: config, MEMORIES_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  httpProcess.stderr.resume();
  const url = `http://127.0.0.1:${port}/mcp`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (httpProcess.exitCode !== null) throw new Error('Compiled HTTP process exited before readiness');
    try { assert.equal((await fetch(url)).status, 401); ready = true; break; }
    catch { await delay(50); }
  }
  assert.equal(ready, true, 'Compiled HTTP process did not become ready');
  for (const scope of entries) {
    client = new Client({ name: 'compiled-http-smoke', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${scope.token}` } },
    }));
    assert.equal((await client.listTools()).tools.length, 9);
    assert.equal(parse(await client.callTool({ name: 'kb_peek', arguments: {} })).vault, scope.id);
    const note = parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } }));
    parse(await client.callTool({ name: 'kb_remove', arguments: { path: 'Smoke.md', expected_hash: note.hash } }));
    const history = parse(await client.callTool({ name: 'kb_history', arguments: { path: 'Smoke.md' } }));
    const version = history.find(item => item.hash === note.hash);
    assert.ok(version);
    parse(await client.callTool({ name: 'kb_restore', arguments: { path: 'Smoke.md', version: version.version, expected_hash: '' } }));
    assert.equal(parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } })).text, note.text);
    await client.close();
  }
  console.log('Compiled stdio and HTTP smoke passed: three isolated vaults, remove/recovery, restart recovery, unknown scope and timer overflow rejected.');
} finally {
  await client?.close();
  if (httpProcess && httpProcess.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => httpProcess.kill('SIGKILL'), 5000);
      httpProcess.once('exit', () => { clearTimeout(timer); resolve(); });
      httpProcess.kill('SIGTERM');
    });
  }
  await rm(fixture, { recursive: true, force: true });
}
