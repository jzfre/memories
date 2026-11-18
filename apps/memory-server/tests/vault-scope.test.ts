import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadVaults, selectVault } from '../src/config.js';
import { startHttp } from '../src/http.js';
import { Maintenance } from '../src/state.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
const data = (r: any) => { expect(r.isError).not.toBe(true); return JSON.parse(r.content[0].text); };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memories-scopes-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const entries = ['personal', 'work', 'family'].map(id => ({ id, path: join(dir, id), state: join(dir, `state-${id}`), token: `${id}-test-credential-with-at-least-32-bytes` }));
  for (const e of entries) {
    await mkdir(e.path);
    await writeFile(join(e.path, `${e.id}.md`), `# ${e.id}\nPrivate ${e.id} marker`);
  }
  const config = join(dir, 'vaults.json');
  await writeFile(config, JSON.stringify({ vaults: entries }));
  const vaults = await loadVaults({ MEMORIES_CONFIG: config });
  return { dir, entries, config, vaults };
}

it('defaults local selection to personal and fails closed for an unknown explicit vault', async () => {
  const { vaults } = await fixture();
  expect(selectVault(vaults).id).toBe('personal');
  expect(selectVault(vaults, 'family').id).toBe('family');
  expect(() => selectVault(vaults, 'typo')).toThrow('Unknown vault');
});

it('rejects programmatic bindings whose maintenance exposes another vault or state directory', async () => {
  const { vaults } = await fixture();
  await expect(startHttp({ vaults: [{ ...vaults[0], maintenance: vaults[1].maintenance }], port: 0 })).rejects.toThrow('Maintenance must use its bound vault');
  expect(() => new Maintenance(vaults[0].store, vaults[1].store.stateDir)).toThrow('same private state directory');
});

it('rejects overlapping vault/state paths, symlink aliases, duplicate identities and ambiguous tokens', async () => {
  const { dir, config, entries } = await fixture();
  const invalid = [
    [entries[0], { ...entries[1], id: 'personal' }],
    [entries[0], { ...entries[1], path: entries[0].path }],
    [entries[0], { ...entries[1], state: entries[0].state }],
    [entries[0], { ...entries[1], state: join(entries[0].path, 'history') }],
    [entries[0], { ...entries[1], token: entries[0].token }],
  ];
  await mkdir(join(entries[0].path, 'nested'));
  invalid.push([entries[0], { ...entries[1], path: join(entries[0].path, 'nested') }]);
  await symlink(entries[0].path, join(dir, 'alias'));
  invalid.push([entries[0], { ...entries[1], path: join(dir, 'alias') }]);
  for (const vaults of invalid) {
    await writeFile(config, JSON.stringify({ vaults }));
    await expect(loadVaults({ MEMORIES_CONFIG: config })).rejects.toThrow();
  }
});

it('isolates every MCP operation and resource by credential, including conflicting credentials', async () => {
  const { vaults } = await fixture();
  const running = await startHttp({ vaults, port: 0, capabilityUrl: true });
  cleanup.push(() => running.close());
  const clients = await Promise.all(vaults.map(async v => {
    const client = new Client({ name: 'scope-test', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: `Bearer ${v.token}` } } }));
    expect(client.getInstructions()).toContain(`"${v.id}"`);
    return client;
  }));
  for (const [i, client] of clients.entries()) {
    const own = vaults[i];
    const other = vaults[(i + 1) % vaults.length];
    expect(data(await client.callTool({ name: 'kb_peek', arguments: {} })).vault).toBe(own.id);
    const hits = data(await client.callTool({ name: 'search', arguments: { query: 'Private', vault: other.id } })).results;
    expect(hits.map((h: any) => h.id)).toEqual([`${own.id}.md`]);
    for (const id of [`${other.id}.md`, `../${other.id}/${other.id}.md`]) {
      expect((await client.callTool({ name: 'fetch', arguments: { id } })).isError).toBe(true);
      expect((await client.callTool({ name: 'kb_remove', arguments: { path: id, expected_hash: (await other.store.read(`${other.id}.md`)).hash } })).isError).toBe(true);
    }
    expect((await other.store.read(`${other.id}.md`)).content).toContain(`Private ${other.id} marker`);
    const note = data(await client.callTool({ name: 'kb_write', arguments: { path: 'Same.md', content: `# First ${own.id}`, expected_hash: '', vault: other.id } }));
    data(await client.callTool({ name: 'kb_edit', arguments: { path: 'Same.md', find: 'First', replace: 'Second', expected_hash: note.hash } }));
    expect(data(await client.callTool({ name: 'fetch', arguments: { id: 'Same.md' } })).text).toBe(`# Second ${own.id}`);
    data(await client.callTool({ name: 'kb_maintenance', arguments: {} }));
    const overview = JSON.stringify(await client.readResource({ uri: 'memories://overview' }));
    expect(overview).toContain(`${own.id}.md`);
    expect(overview).not.toContain(`${other.id}.md`);
  }
  for (const [i, client] of clients.entries()) {
    const history = data(await client.callTool({ name: 'kb_history', arguments: { path: 'Same.md' } }));
    expect(history).toHaveLength(1);
    data(await client.callTool({ name: 'kb_restore', arguments: { path: 'Same.md', version: history[0].version } }));
    expect((await vaults[i].store.read('Same.md')).content).toBe(`# First ${vaults[i].id}`);
  }
  const origin = new URL(running.url).origin;
  const capability = new Client({ name: 'capability-scope', version: '1' });
  cleanup.push(() => capability.close());
  await capability.connect(new StreamableHTTPClientTransport(new URL(`${origin}/${vaults[1].token}/mcp`)));
  expect(data(await capability.callTool({ name: 'kb_peek', arguments: {} })).vault).toBe('work');
  expect((await fetch(running.url)).status).toBe(401);
  expect((await fetch(running.url, { headers: { authorization: 'Bearer unknown' } })).status).toBe(401);
  expect((await fetch(`${origin}/${vaults[0].token}/mcp`, { headers: { authorization: `Bearer ${vaults[1].token}` } })).status).toBe(401);
});
