import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { VaultStore } from '../src/vault.js';
import { Maintenance } from '../src/state.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memories-startup-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const entries = ['personal', 'work'].map(id => ({
    id, path: join(dir, id), state: join(dir, `${id}-state`),
    token: `${id}-test-credential-with-at-least-32-bytes`,
  }));
  for (const entry of entries) {
    await mkdir(entry.path);
    await writeFile(join(entry.path, 'Readable.md'), `# Readable ${entry.id}`);
  }
  const config = join(dir, 'vaults.json');
  await writeFile(config, JSON.stringify({ vaults: entries }));
  return { dir, config, entries };
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function start(config: string) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: { ...process.env, MEMORIES_CONFIG: config, MEMORIES_PORT: String(port), MEMORIES_MAINTENANCE_SECONDS: '900' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, stderr: () => stderr, url: `http://127.0.0.1:${port}/mcp` };
}

async function waitFor(child: ChildProcess, condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before the expected event');
    if (Date.now() > deadline) throw new Error('Server did not reach the expected state');
    await delay(10);
  }
}

async function call(url: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as any).result;
}

it.each(['oversized note', 'corrupt report'])('keeps healthy vaults serving when startup maintenance encounters a %s', async fault => {
  const { dir, config, entries } = await fixture();
  const work = entries[1]!;
  const store = new VaultStore(work.path, work.state);
  await new Maintenance(store, work.state).refresh();
  const reportPath = join(work.state, 'maintenance.json');
  if (fault === 'oversized note') await writeFile(join(work.path, 'Too large.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  else await writeFile(reportPath, 'invalid private report body');
  const previousReport = await readFile(reportPath, 'utf8');
  const running = await start(config);
  await waitFor(running.child, () => running.stderr().includes('Maintenance failed for work;'));

  for (const entry of entries) {
    const result = await call(running.url, entry.token, 'fetch', { id: 'Readable.md' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).text).toBe(`# Readable ${entry.id}`);
  }
  expect((await call(running.url, entries[0]!.token, 'kb_maintenance', {})).isError).not.toBe(true);
  expect((await call(running.url, work.token, 'kb_maintenance', {})).isError).toBe(true);
  expect(await readFile(reportPath, 'utf8')).toBe(previousReport);
  expect(running.stderr()).not.toContain(dir);
  expect(running.stderr()).not.toContain('invalid private report body');
  expect(running.stderr()).not.toContain(work.token);
  running.child.kill('SIGTERM');
  expect(await running.exited).toBe(0);
}, 10_000);

it.each(['invalid token', 'overlapping paths'])('rejects %s before listening or refreshing maintenance', async fault => {
  const { config, entries } = await fixture();
  if (fault === 'invalid token') entries[0]!.token = 'short';
  else entries[1]!.path = entries[0]!.path;
  await writeFile(config, JSON.stringify({ vaults: entries }));
  const running = await start(config);
  expect(await running.exited).toBe(1);
  expect(running.stderr()).toContain('Memories startup failed:');
  expect(running.stderr()).not.toContain('Memories listening on');
  for (const entry of entries) await expect(access(join(entry.state, 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 10_000);
