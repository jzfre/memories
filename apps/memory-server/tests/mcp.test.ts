import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../src/mcp.js';
import { VaultStore } from '../src/vault.js';
import { Maintenance } from '../src/state.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; vi.restoreAllMocks(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'memories-mcp-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'vault'));
  const store = new VaultStore(join(dir, 'vault'), join(dir, 'state'));
  const maintenance = new Maintenance(store, store.stateDir);
  const server = createMcp(store, maintenance);
  const client = new Client({ name: 'mcp-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { store, maintenance, client, dir };
}
const data = (value: any) => JSON.parse(value.content[0].text);

it('counts folder names that coincide with Object prototype properties', async () => {
  const { store, client } = await setup();
  for (const folder of ['__proto__', 'constructor', 'toString']) {
    await store.write(`${folder}/Note.md`, '# Note');
  }
  const result = data(await client.callTool({ name: 'kb_peek', arguments: {} }));
  expect(result.noteCount).toBe(3);
  expect(result.folders).toEqual(JSON.parse('{"__proto__":1,"constructor":1,"toString":1}'));
});

it('rejects overlapping edit matches without changing the note or history', async () => {
  const { store, client } = await setup();
  const note = await store.write('Note.md', '# Note\naaa');
  const result = await client.callTool({ name: 'kb_edit', arguments: {
    path: note.path, find: 'aa', replace: 'b', expected_hash: note.hash,
  } });
  expect(result.isError).toBe(true);
  expect((await store.read(note.path)).hash).toBe(note.hash);
  expect(await store.history(note.path)).toEqual([]);
});

it('does not interpret replacement text as JavaScript substitution patterns', async () => {
  const { store, client } = await setup();
  const note = await store.write('Note.md', '# Note\nreplace me');
  const replacement = "$& $` $' $$";
  expect((await client.callTool({ name: 'kb_edit', arguments: {
    path: note.path, find: 'replace me', replace: replacement, expected_hash: note.hash,
  } })).isError).not.toBe(true);
  expect((await store.read(note.path)).content).toBe('# Note\n' + replacement);
});

it('sanitizes resource failures as well as tool failures', async () => {
  const { maintenance, client, dir } = await setup();
  vi.spyOn(maintenance, 'overview').mockRejectedValue(new Error(`EACCES ${dir}/private-state`));
  await expect(client.readResource({ uri: 'memories://overview' })).rejects.toThrow('The overview could not be read');
  try { await client.readResource({ uri: 'memories://overview' }); }
  catch (error) { expect(String(error)).not.toContain(dir); }
});

it('bounds nested and oversized tool input even on the stdio-compatible transport', async () => {
  const { client } = await setup();
  let nested: unknown = 'leaf';
  for (let i = 0; i < 1100; i++) nested = { nested };
  for (const extra of [nested, Array.from({ length: 1100 }, () => 'value')]) {
    const result = await client.callTool({ name: 'kb_peek', arguments: { extra } });
    expect(result.isError).toBe(true);
  }
  expect(data(await client.callTool({ name: 'kb_peek', arguments: {} })).noteCount).toBe(0);
});

it('allows ordinary note strings larger than the argument element limit', async () => {
  const { client } = await setup();
  const content = '# A longer note\n' + 'Useful context.\n'.repeat(2000);
  const result = await client.callTool({ name: 'kb_write', arguments: {
    path: 'Long.md', content, expected_hash: '',
  } });
  expect(result.isError).not.toBe(true);
  expect(data(await client.callTool({ name: 'fetch', arguments: { id: 'Long.md' } })).text).toBe(content);
});
