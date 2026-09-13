import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultStore } from '../src/vault.js';

let base: string;
let root: string;
let state: string;
let store: VaultStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'memories-vault-'));
  root = join(base, 'vault');
  state = join(base, 'state');
  await mkdir(root);
  store = new VaultStore(root, state);
});

afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe('live Markdown access', () => {
  it('reads complete content and metadata without rewriting the note', async () => {
    const content = '---\ntitle: Život\ntags: [rodina, domov]\naliases: [Môj život]\n---\n# Notes\nSee [[Family#People|rodina]] and [plans](Plans.md).\n';
    await writeFile(join(root, 'Life.md'), content);
    const note = await store.read('Life.md');
    expect(note).toMatchObject({ path: 'Life.md', title: 'Život', content,
      tags: ['rodina', 'domov'], aliases: ['Môj život'], links: ['Family', 'Plans.md'] });
    expect(note.hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(note.modifiedAt).toBeGreaterThan(0);
    expect(await readFile(join(root, 'Life.md'), 'utf8')).toBe(content);
  });

  it('sees external changes immediately and lists only Markdown notes', async () => {
    await mkdir(join(root, 'Folder'));
    await mkdir(join(root, '.obsidian'));
    await writeFile(join(root, 'Folder', 'First.md'), '# First\nold');
    await writeFile(join(root, 'image.png'), 'not a note');
    await writeFile(join(root, '.obsidian', 'Private.md'), 'hidden');
    expect((await store.list()).map(n => n.path)).toEqual(['Folder/First.md']);
    const old = await store.read('Folder/First.md');
    await writeFile(join(root, 'Folder', 'First.md'), '# Updated\nnew');
    const current = await store.read('Folder/First.md');
    expect(current.content).toBe('# Updated\nnew');
    expect(current.hash).not.toBe(old.hash);
    expect((await store.list())[0].title).toBe('Updated');
  });

  it('reads malformed frontmatter as content without executing language directives', async () => {
    const content = '---js\nthrow new Error("must not execute")\n---\n# Plain';
    await writeFile(join(root, 'Plain.md'), content);
    expect((await store.read('Plain.md')).content).toBe(content);
    await writeFile(join(root, 'Plain.md'), '---\naliases: [broken\n---\n# Fallback');
    expect((await store.read('Plain.md')).title).toBe('Fallback');
  });

  it('ranks Slovak titles and aliases above body-only matches and limits snippets', async () => {
    await writeFile(join(root, 'Name.md'), '---\ntitle: Štefan Repáň\n---\nFamily');
    await writeFile(join(root, 'Alias.md'), '---\naliases: [Štefan Repáň]\n---\nFamily');
    await writeFile(join(root, 'Body.md'), '# Other\n' + 'context '.repeat(100) + 'Štefan Repáň lives here.');
    await writeFile(join(root, 'Unrelated.md'), '# Other person');
    const hits = await store.search('stefan repan', 2);
    expect(hits.map(n => n.path)).toEqual(['Name.md', 'Alias.md']);
    expect(hits.every(n => !('content' in n) && n.snippet.length <= 360)).toBe(true);
    expect(await store.search('no-such-word', 5)).toEqual([]);
    expect(await store.search(' ', 5)).toEqual([]);
  });
});

describe('containment and bounds', () => {
  it.each(['../escape.md', 'a/../escape.md', '/absolute.md', '.obsidian/note.md', 'dir/.secret.md', 'a\\b.md', 'C:/file.md', 'a\u0000.md', 'note.txt'])('rejects unsafe path %j for reads and writes', async path => {
    await expect(store.read(path)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(store.write(path, 'content')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('never follows symlink files or folders during reads, writes, or traversal', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'Secret.md'), 'outside');
    await symlink(join(outside, 'Secret.md'), join(root, 'Link.md'));
    await symlink(outside, join(root, 'LinkFolder'));
    await expect(store.read('Link.md')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(store.write('Link.md', 'changed')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(store.write('LinkFolder/New.md', 'changed')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await store.list()).toEqual([]);
    expect(await readFile(join(outside, 'Secret.md'), 'utf8')).toBe('outside');
    expect(await readdir(outside)).toEqual(['Secret.md']);
  });

  it('rejects state inside the vault, including a symlink alias into it', async () => {
    await expect(new VaultStore(root, join(root, 'history')).list()).rejects.toMatchObject({ code: 'INVALID_STATE_DIR' });
    await symlink(root, join(base, 'alias'));
    await expect(new VaultStore(root, join(base, 'alias', 'history')).list()).rejects.toMatchObject({ code: 'INVALID_STATE_DIR' });
  });

  it('rejects oversized notes before mutation or indexing', async () => {
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
    await expect(store.write('Large.md', oversized)).rejects.toMatchObject({ code: 'NOTE_TOO_LARGE' });
    expect(await readdir(root)).toEqual([]);
    await writeFile(join(root, 'Large.md'), oversized);
    await expect(store.read('Large.md')).rejects.toMatchObject({ code: 'NOTE_TOO_LARGE' });
  });
});

describe('recoverable writes', () => {
  it('creates parents and uses normalized vault-relative paths', async () => {
    const note = await store.write('Family//New.md', '# New\ncontent', '');
    expect(note.path).toBe('Family/New.md');
    expect(await readFile(join(root, 'Family', 'New.md'), 'utf8')).toBe('# New\ncontent');
    expect(await store.history(note.path)).toEqual([]);
    await expect(store.write(note.path, 'collision', '')).rejects.toMatchObject({ code: 'STALE_WRITE' });
  });

  it('keeps history outside the vault and restores after removal across restart', async () => {
    const original = await store.write('Life.md', '# Before');
    await store.write('Life.md', '# After', original.hash);
    const versions = await store.history('Life.md');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ hash: original.hash });
    expect(versions[0].createdAt).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual(['Life.md']);
    await store.remove('Life.md');
    await expect(store.read('Life.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restarted = new VaultStore(root, state);
    const restored = await restarted.restore('Life.md', versions[0].version);
    expect(restored.content).toBe('# Before');
    expect(await restarted.history('Life.md')).toHaveLength(2);
    await restarted.restore('Life.md', versions[0].version);
    expect(await restarted.history('Life.md')).toHaveLength(3);
    await expect(restarted.restore('Other.md', versions[0].version)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(restarted.restore('Life.md', '../escape')).rejects.toMatchObject({ code: 'INVALID_VERSION' });
  });

  it('rejects stale writes and removals without creating history or losing content', async () => {
    const original = await store.write('Life.md', '# Before');
    await writeFile(join(root, 'Life.md'), '# Human edit');
    await expect(store.write('Life.md', '# Agent edit', original.hash)).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(store.remove('Life.md', original.hash)).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect((await store.read('Life.md')).content).toBe('# Human edit');
    expect(await store.history('Life.md')).toEqual([]);
  });

  it('serializes competing conditional updates and continues after a rejected update', async () => {
    const original = await store.write('Life.md', '# Before');
    const outcomes = await Promise.allSettled([
      store.write('Life.md', '# First', original.hash),
      store.write('Life.md', '# Second', original.hash),
    ]);
    expect(outcomes.filter(n => n.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(n => n.status === 'rejected')).toHaveLength(1);
    expect(await store.history('Life.md')).toHaveLength(1);
    await store.write('Life.md', '# Next');
    expect((await store.read('Life.md')).content).toBe('# Next');
    expect(await readdir(root)).toEqual(['Life.md']);
  });

  it('allows exactly one conditional update across separate store instances', async () => {
    const original = await store.write('Life.md', '# Before');
    const other = new VaultStore(root, state);
    const outcomes = await Promise.allSettled([
      store.write('Life.md', '# First', original.hash),
      other.write('Life.md', '# Second', original.hash),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' && rejected.reason).toMatchObject({ code: 'STALE_WRITE' });
    expect(await store.history('Life.md')).toHaveLength(1);
  });

  it('coordinates writes from separate Node processes using the same state directory', async () => {
    const original = await store.write('Life.md', '# Before');
    const run = promisify(execFile);
    const source = new URL('../src/vault.ts', import.meta.url).href;
    const command = `
      import { VaultStore } from ${JSON.stringify(source)};
      const store = new VaultStore(process.env.TEST_VAULT, process.env.TEST_STATE);
      try {
        await store.write('Life.md', process.env.TEST_CONTENT, process.env.TEST_HASH);
        process.stdout.write('written');
      } catch (error) { process.stdout.write(error.code ?? 'error'); }
    `;
    const results = await Promise.all(['# First process', '# Second process'].map(content =>
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', command], {
        env: { ...process.env, TEST_VAULT: root, TEST_STATE: state, TEST_CONTENT: content, TEST_HASH: original.hash },
      })));
    expect(results.map(r => r.stdout).sort()).toEqual(['STALE_WRITE', 'written']);
    expect(await store.history('Life.md')).toHaveLength(1);
  });

  it('recovers an abandoned lock only after its owning process has exited', async () => {
    await store.write('Life.md', '# Before');
    const run = promisify(execFile);
    await run(process.execPath, ['--input-type=module', '-e', `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const dir = join(process.env.TEST_STATE, 'write.lock');
      await mkdir(dir);
      await writeFile(join(dir, process.pid + '-00000000-0000-0000-0000-000000000000.owner'), '');
    `], { env: { ...process.env, TEST_STATE: state } });
    await store.write('Life.md', '# Recovered');
    expect((await store.read('Life.md')).content).toBe('# Recovered');
  });

  it('waits for a live owner without removing its lock', async () => {
    await store.write('Life.md', '# Before');
    const lock = join(state, 'write.lock');
    await mkdir(lock);
    const marker = `${process.pid}-00000000-0000-0000-0000-000000000000.owner`;
    await writeFile(join(lock, marker), '');
    const pending = store.write('Life.md', '# After');
    await delay(75);
    expect((await store.read('Life.md')).content).toBe('# Before');
    expect(await readdir(lock)).toEqual([marker]);
    await rm(lock, { recursive: true });
    await pending;
    expect((await store.read('Life.md')).content).toBe('# After');
  });
});
