import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(join(tmpdir(), 'memories-compiled-'));
const vault = join(fixture, 'vault');
await mkdir(vault);
const env = { PATH: process.env.PATH, MEMORIES_VAULT: vault, MEMORIES_STATE: join(fixture, 'state') };
const parse = r => { assert.notEqual(r.isError, true); return JSON.parse(r.content[0].text); };
async function connect() {
  const client = new Client({ name: 'compiled-smoke', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--stdio'], env, stderr: 'pipe' }));
  return client;
}
let client;
try {
  client = await connect();
  assert.equal((await client.listTools()).tools.length, 8);
  const first = parse(await client.callTool({ name: 'kb_write', arguments: { path: 'Smoke.md', content: '# Smoke\nFirst version', expected_hash: '' } }));
  parse(await client.callTool({ name: 'kb_edit', arguments: { path: 'Smoke.md', find: 'First', replace: 'Second', expected_hash: first.hash } }));
  const history = parse(await client.callTool({ name: 'kb_history', arguments: { path: 'Smoke.md' } }));
  await client.close();
  client = await connect();
  parse(await client.callTool({ name: 'kb_restore', arguments: { path: 'Smoke.md', version: history[0].version } }));
  assert.match(parse(await client.callTool({ name: 'fetch', arguments: { id: 'Smoke.md' } })).text, /First version/);
  assert.equal(parse(await client.callTool({ name: 'kb_peek', arguments: { topic: 'Smoke' } })).noteCount, 1);
  console.log('Compiled stdio smoke passed: create, edit, restart, restore, peek.');
} finally { await client?.close(); await rm(fixture, { recursive: true, force: true }); }
