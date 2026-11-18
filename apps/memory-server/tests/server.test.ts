import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VaultStore } from '../src/vault.js';
import { startHttp } from '../src/http.js';
import { Maintenance } from '../src/state.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
const token = 'a-secure-test-token-with-at-least-32-characters';
async function setup(options: { capabilityUrl?: boolean; token?: string; host?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'memories-http-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'vault'));
  const store = new VaultStore(join(dir, 'vault'), join(dir, 'state'));
  const maintenance = new Maintenance(store, join(dir, 'state'));
  const running = await startHttp({ store, maintenance, token, port: 0, ...options });
  cleanup.push(() => running.close());
  return { store, maintenance, running, dir };
}
async function connect(url: string) {
  const client = new Client({ name: 'integration-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  cleanup.push(() => client.close());
  return client;
}
function data(result: any) { return JSON.parse(result.content[0].text); }

describe('real HTTP MCP', () => {
  it('preserves public required fields, limits and default behavior across validator upgrades', async () => {
    const { running, store } = await setup();
    const client = await connect(running.url);
    const schemas = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.inputSchema]));
    expect(schemas.kb_write.required).toEqual(['path', 'content']);
    expect(schemas.kb_write.properties?.expected_hash).toMatchObject({ type: 'string' });
    expect(schemas.kb_edit.required).toEqual(['path', 'find', 'replace']);
    expect(schemas.kb_remove.required).toEqual(['path', 'expected_hash']);
    expect(schemas.kb_restore.required).toEqual(['path', 'version']);
    expect(schemas.kb_restore.properties?.expected_hash).toMatchObject({ type: 'string' });
    expect(schemas.search.required).toEqual(['query']);
    expect(schemas.search.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50, default: 10 });
    expect(schemas.kb_peek.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, default: 6 });
    for (let i = 0; i < 12; i++) await store.write(`Note-${i}.md`, '# Searchable');
    expect(data(await client.callTool({ name: 'search', arguments: { query: 'Searchable' } })).results).toHaveLength(10);
    expect(data(await client.callTool({ name: 'kb_peek', arguments: {} })).recent).toHaveLength(6);
    for (const limit of [0, 51, 1.5, '2']) {
      expect((await client.callTool({ name: 'search', arguments: { query: 'Searchable', limit } })).isError).toBe(true);
    }
    expect((await client.callTool({ name: 'kb_write', arguments: { path: 'Missing.md' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'kb_write', arguments: { content: 'Missing path' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'kb_write', arguments: { path: 'Optional.md', content: '# Optional hash' } })).isError).not.toBe(true);
  });

  it('refuses weak credentials and a publicly bound listener before startup', async () => {
    await expect(setup({ token: '' })).rejects.toThrow('at least 32 bytes');
    await expect(setup({ token: 'short' })).rejects.toThrow('at least 32 bytes');
    for (const character of ['\u0000', '\u007f', 'é', '<', '"']) {
      await expect(setup({ token: `${token}${character}` })).rejects.toThrow('URL-safe');
    }
    await expect(setup({ host: '0.0.0.0' })).rejects.toThrow('bind loopback');
  });

  it('supports a capability URL without bearer headers only when explicitly enabled', async () => {
    const { running } = await setup({ capabilityUrl: true });
    const origin = new URL(running.url).origin;
    const capability = `${origin}/${token}/mcp`;
    const client = new Client({ name: 'capability-client', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(capability)));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('kb_peek');
    expect(data(await client.callTool({ name: 'kb_peek', arguments: {} })).noteCount).toBe(0);

    for (const invalid of [
      `${origin}/wrong-token/mcp`,
      `${origin}/prefix/${token}/mcp`,
      `${capability}/extra`,
      `${capability}/`,
      `${running.url}?token=${token}`,
    ]) expect((await fetch(invalid)).status).toBe(401);
    expect((await fetch(capability, { headers: { origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(running.url, { headers: { authorization: 'Bearer wrong-token' } })).status).toBe(401);

    const disabled = await setup();
    expect((await fetch(`${new URL(disabled.running.url).origin}/${token}/mcp`)).status).toBe(401);
  });

  it('fails closed and rejects browser origins, wrong paths, malformed and oversized bodies', async () => {
    const { running } = await setup();
    expect((await fetch(running.url)).status).toBe(401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await fetch(running.url, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: '{}' })).status).toBe(403);
    expect((await fetch(running.url + '/other', { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await fetch(running.url, { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch(running.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/jsonp' }, body: '{}' })).status).toBe(415);
    expect((await fetch(running.url, { method: 'POST', headers, body: 'x'.repeat(3 * 1024 * 1024) })).status).toBe(413);
    expect((await fetch(running.url, { headers })).status).toBe(405);
  });

  it('returns a bounded error for oversized chunked uploads and does not cache successful notes', async () => {
    const { running } = await setup();
    const upload = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const response = await fetch(running.url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: upload, duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    const success = await fetch(running.url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kb_peek', arguments: {} } }),
    });
    expect(success.status).toBe(200);
    expect(success.headers.get('cache-control')).toBe('no-store');
    expect((await success.json() as any).result.isError).not.toBe(true);
  });

  it('reads fresh files, edits directly, rejects stale writes and restores history after restarting', async () => {
    const { store, running, dir } = await setup();
    await store.write('Infra/Server.md', '# Server\n\nHeadless Ubuntu server.');
    const client = await connect(running.url);
    const tools = (await client.listTools()).tools.map(t => t.name);
    expect(tools.sort()).toEqual([
      'fetch', 'kb_edit', 'kb_history', 'kb_maintenance', 'kb_peek', 'kb_remove', 'kb_restore', 'kb_write', 'search',
    ]);
    const peek = data(await client.callTool({ name: 'kb_peek', arguments: { topic: 'server' } }));
    expect(peek.relevant[0].path).toBe('Infra/Server.md');
    const overview = await client.readResource({ uri: 'memories://overview' });
    const resource = overview.contents[0]!;
    if (!('text' in resource)) throw new Error('Expected text overview');
    expect(resource.text).toContain('Memories overview');
    expect(resource.text).not.toContain('Headless Ubuntu server.');
    const created = data(await client.callTool({ name: 'kb_write', arguments: { path: 'Inbox/Test.md', content: '# Test\nAlpha', expected_hash: '' } }));
    const edited = await client.callTool({ name: 'kb_edit', arguments: { path: 'Inbox/Test.md', find: 'Alpha', replace: 'Beta', expected_hash: created.hash } });
    expect(edited.isError).not.toBe(true);
    expect((await client.callTool({ name: 'kb_write', arguments: { path: 'Inbox/Test.md', content: 'stale', expected_hash: created.hash } })).isError).toBe(true);
    expect(data(await client.callTool({ name: 'fetch', arguments: { id: 'Inbox/Test.md' } })).text).toContain('Beta');
    const found = data(await client.callTool({ name: 'search', arguments: { query: 'Beta' } }));
    expect(found.results[0].id).toBe('Inbox/Test.md');
    const history = data(await client.callTool({ name: 'kb_history', arguments: { path: 'Inbox/Test.md' } }));
    expect(history).toHaveLength(1);
    await client.close();
    await running.close();
    const nextStore = new VaultStore(join(dir, 'vault'), join(dir, 'state'));
    const next = await startHttp({ store: nextStore, maintenance: new Maintenance(nextStore, join(dir, 'state')), token, port: 0 });
    cleanup.push(() => next.close());
    const nextClient = await connect(next.url);
    await nextClient.callTool({ name: 'kb_restore', arguments: { path: 'Inbox/Test.md', version: history[0].version } });
    expect((await nextStore.read('Inbox/Test.md')).content).toContain('Alpha');
    const attempt = await nextClient.callTool({ name: 'fetch', arguments: { id: '../private.md' } });
    expect(attempt.isError).toBe(true);
    expect(JSON.stringify(attempt)).not.toContain(dir);
  });

  it('removes only a freshly read note and recovers its exact content from history', async () => {
    const { running, store } = await setup();
    const client = await connect(running.url);
    const original = await store.write('Removable.md', '# Removable\nOriginal body');
    expect((await client.callTool({ name: 'kb_remove', arguments: { path: original.path } })).isError).toBe(true);
    expect((await client.callTool({ name: 'kb_remove', arguments: { path: original.path, expected_hash: '0'.repeat(64) } })).isError).toBe(true);
    expect((await store.read(original.path)).content).toBe(original.content);
    expect((await client.callTool({ name: 'kb_remove', arguments: { path: original.path, expected_hash: original.hash } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'fetch', arguments: { id: original.path } })).isError).toBe(true);
    expect(data(await client.callTool({ name: 'search', arguments: { query: 'Removable' } })).results).toEqual([]);
    const history = data(await client.callTool({ name: 'kb_history', arguments: { path: original.path } }));
    expect(history).toHaveLength(1);
    expect((await client.callTool({ name: 'kb_restore', arguments: { path: original.path, version: history[0].version, expected_hash: '' } })).isError).not.toBe(true);
    expect((await store.read(original.path)).content).toBe(original.content);
  });

  it('requires exactly one replacement target', async () => {
    const { running, store } = await setup();
    await store.write('Repeat.md', '# Repeat\nword word');
    const client = await connect(running.url);
    expect((await client.callTool({ name: 'kb_edit', arguments: { path: 'Repeat.md', find: 'word', replace: 'new' } })).isError).toBe(true);
    expect((await store.read('Repeat.md')).content).toContain('word word');
  });
});
