import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Maintenance } from '../src/state.js';
import { VaultStore } from '../src/vault.js';

let base: string;
let vault: string;
let state: string;
let store: VaultStore;
let maintenance: Maintenance;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'memories-maintenance-'));
  vault = join(base, 'vault');
  state = join(base, 'state');
  await mkdir(vault);
  store = new VaultStore(vault, state);
  maintenance = new Maintenance(store, state);
});

afterEach(async () => { await rm(base, { recursive: true, force: true }); });

async function savedReport() {
  return JSON.parse(await readFile(join(state, 'maintenance.json'), 'utf8'));
}

test('initial status scans real notes and saves a complete report', async () => {
  await writeFile(join(vault, 'Home.md'), '# Home\nSee [[Family]].');
  await writeFile(join(vault, 'Family.md'), '# Family\nPeople at home.');

  const report = await maintenance.status();

  expect(report.changed).toEqual(['Family.md', 'Home.md']);
  expect(report.deleted).toEqual([]);
  expect(report.noteCount).toBe(2);
  expect(report.brokenLinks).toEqual([]);
  expect(report.hashes['Home.md']).toBe((await store.read('Home.md')).hash);
  expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  expect(await savedReport()).toEqual(report);
});

test('unchanged refresh does not repeatedly mark notes as new or changed', async () => {
  await writeFile(join(vault, 'Life.md'), '# Life\nCurrent context.');
  const initial = await maintenance.refresh();

  const next = await maintenance.refresh();

  expect(initial.changed).toEqual(['Life.md']);
  expect(next.changed).toEqual([]);
  expect(next.deleted).toEqual([]);
  expect(next.hashes).toEqual(initial.hashes);
  expect(await savedReport()).toEqual(next);
});

test('refresh observes an external frontmatter edit without rewriting its bytes', async () => {
  const original = '---\naliases: [Home]\n---\n# Life\nSame body.\n';
  const edited = '---\naliases: [Family life]\n---\n# Life\nSame body.\n';
  await writeFile(join(vault, 'Life.md'), original);
  const before = await maintenance.refresh();
  await writeFile(join(vault, 'Life.md'), edited);

  const after = await maintenance.refresh();

  expect(after.changed).toEqual(['Life.md']);
  expect(after.hashes['Life.md']).not.toBe(before.hashes['Life.md']);
  expect(after.hashes['Life.md']).toBe((await store.read('Life.md')).hash);
  expect(await readFile(join(vault, 'Life.md'), 'utf8')).toBe(edited);
});

test('deletion drops the hash and updates broken links only once', async () => {
  await writeFile(join(vault, 'Index.md'), '# Index\n[[Gone]]');
  await writeFile(join(vault, 'Gone.md'), '# Gone\nAn old note.');
  await maintenance.refresh();
  await unlink(join(vault, 'Gone.md'));

  const deleted = await maintenance.refresh();

  expect(deleted.deleted).toEqual(['Gone.md']);
  expect(deleted.changed).toEqual([]);
  expect(deleted.hashes).not.toHaveProperty('Gone.md');
  expect(deleted.noteCount).toBe(1);
  expect(deleted.brokenLinks).toEqual([{ source: 'Index.md', target: 'Gone' }]);
  expect((await maintenance.refresh()).deleted).toEqual([]);
});

test('concurrent refresh calls share the edited snapshot and leave valid persisted state', async () => {
  await writeFile(join(vault, 'Life.md'), '# Life\nBefore.');
  await maintenance.refresh();
  await writeFile(join(vault, 'Life.md'), '# Life\nAfter.');

  const reports = await Promise.all(Array.from({ length: 12 }, () => maintenance.refresh()));

  for (const report of reports) {
    expect(report.changed).toEqual(['Life.md']);
    expect(report.noteCount).toBe(1);
    expect(report.hashes['Life.md']).toBe((await store.read('Life.md')).hash);
  }
  expect(await savedReport()).toEqual(reports[0]);
  expect((await readdir(state)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('restart restores the previous snapshot and detects subsequent edits and additions', async () => {
  await writeFile(join(vault, 'Life.md'), '# Life\nBefore restart.');
  const saved = await maintenance.refresh();
  const restarted = new Maintenance(new VaultStore(vault, state), state);

  expect(await restarted.status()).toEqual(saved);
  expect((await restarted.refresh()).changed).toEqual([]);
  await writeFile(join(vault, 'Life.md'), '# Life\nAfter restart.');
  await writeFile(join(vault, 'New.md'), '# New\nMore context.');
  expect((await restarted.refresh()).changed).toEqual(['Life.md', 'New.md']);
});

test('navigation stays outside the vault and excludes note bodies', async () => {
  const content = '# My life\nPRIVATE_SENTENCE_NOT_FOR_THE_OVERVIEW';
  await writeFile(join(vault, 'Life.md'), content);
  await maintenance.refresh();

  const overview = await readFile(join(state, 'overview.md'), 'utf8');

  expect(overview).toContain('My life');
  expect(overview).toContain('Life.md');
  expect(overview).not.toContain('PRIVATE_SENTENCE_NOT_FOR_THE_OVERVIEW');
  expect(await readdir(vault)).toEqual(['Life.md']);
  expect(await readFile(join(vault, 'Life.md'), 'utf8')).toBe(content);
  expect((await store.list()).map(note => note.path)).toEqual(['Life.md']);
});

test('a failed scan keeps the last good snapshot and does not block a later refresh', async () => {
  await writeFile(join(vault, 'Life.md'), '# Life\nBefore.');
  const previous = await maintenance.refresh();
  const previousOverview = await readFile(join(state, 'overview.md'), 'utf8');
  await writeFile(join(vault, 'Too large.md'), 'x'.repeat(2 * 1024 * 1024 + 1));

  await expect(maintenance.refresh()).rejects.toMatchObject({ code: 'NOTE_TOO_LARGE' });

  expect(await savedReport()).toEqual(previous);
  expect(await readFile(join(state, 'overview.md'), 'utf8')).toBe(previousOverview);
  await unlink(join(vault, 'Too large.md'));
  await writeFile(join(vault, 'Life.md'), '# Life\nRecovered.');
  expect((await maintenance.refresh()).changed).toEqual(['Life.md']);
});

test('corrupt saved JSON is surfaced without replacing the last report', async () => {
  await writeFile(join(vault, 'Life.md'), '# Life');
  await maintenance.refresh();
  await writeFile(join(state, 'maintenance.json'), 'not valid JSON');

  await expect(maintenance.refresh()).rejects.toThrow('Cannot read maintenance state');
  await expect(maintenance.status()).rejects.toThrow('Cannot read maintenance state');
  expect(await readFile(join(state, 'maintenance.json'), 'utf8')).toBe('not valid JSON');

  await unlink(join(state, 'maintenance.json'));
  expect((await maintenance.refresh()).changed).toEqual(['Life.md']);
});
