import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VaultStore } from '../src/vault.js';
import { startHttp, type HttpOptions } from '../src/http.js';
import { Maintenance } from '../src/state.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
const token = 'a-secure-test-token-with-at-least-32-characters';
async function setup(options: Partial<Pick<HttpOptions, 'capabilityUrl' | 'token' | 'host'>> = {}) {
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
  it('refuses weak credentials and a publicly bound listener before startup', async () => {
    await expect(setup({ token: '' })).rejects.toThrow('at least 32 bytes');
    await expect(setup({ token: 'short' })).rejects.toThrow('at least 32 bytes');
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
    expect((await fetch(running.url, { method: 'POST', headers, body: 'x'.repeat(3 * 1024 * 1024) })).status).toBe(413);
    expect((await fetch(running.url, { headers })).status).toBe(405);
  });

  it('reads fresh files, edits directly, rejects stale writes and restores history after restarting', async () => {
    const { store, running, dir } = await setup();
    await store.write('Infra/Rocinante.md', '# Rocinante\n\nHeadless Ubuntu server.');
    const client = await connect(running.url);
    const tools = (await client.listTools()).tools.map(t => t.name);
    expect(tools).toContain('kb_peek');
    expect(tools).not.toContain('memory_protocol');
    const peek = data(await client.callTool({ name: 'kb_peek', arguments: { topic: 'Rocinante' } }));
    expect(peek.relevant[0].path).toBe('Infra/Rocinante.md');
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

  it('requires exactly one replacement target', async () => {
    const { running, store } = await setup();
    await store.write('Repeat.md', '# Repeat\nword word');
    const client = await connect(running.url);
    expect((await client.callTool({ name: 'kb_edit', arguments: { path: 'Repeat.md', find: 'word', replace: 'new' } })).isError).toBe(true);
    expect((await store.read('Repeat.md')).content).toContain('word word');
  });
});
