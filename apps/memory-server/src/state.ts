import { open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkedPath, readBounded, VaultError, VaultStore } from './vault.js';
import { analyzeNotes, renderOverview } from './maintenance.js';

const reportSchema = z.object({
  hashes: z.record(z.string(), z.string()),
  changed: z.array(z.string()),
  deleted: z.array(z.string()),
  duplicates: z.array(z.array(z.string())),
  brokenLinks: z.array(z.object({ source: z.string(), target: z.string() })),
  ambiguousLinks: z.array(z.object({ source: z.string(), target: z.string(), candidates: z.array(z.string()) })),
  orphans: z.array(z.string()),
  checkedAt: z.string(),
  noteCount: z.number().int().nonnegative(),
}).passthrough();
// Runtime reports contain metadata for the whole vault, rather than a single note.
const MAX_STATE_BYTES = 64 * 1024 * 1024;

export class Maintenance {
  private pending?: Promise<Awaited<ReturnType<Maintenance['run']>>>;
  constructor(readonly store: VaultStore, readonly stateDir: string) {
    if (resolve(stateDir) !== store.stateDir) {
      throw new VaultError('INVALID_STATE_DIR', 'Maintenance and history must use the same private state directory.');
    }
  }

  refresh() {
    if (!this.pending) this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readReport() {
    const state = await this.store.runtimeDirectory();
    const target = await checkedPath(state, 'maintenance.json');
    let content: string;
    try { content = (await readBounded(target, MAX_STATE_BYTES)).content; }
    catch (error) {
      if (error instanceof VaultError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
    try { return reportSchema.parse(JSON.parse(content.replace(/^\uFEFF/, ''))); }
    catch { throw new Error('Cannot read maintenance state'); }
  }

  private async save(name: string, content: string) {
    const state = await this.store.runtimeDirectory();
    const target = await checkedPath(state, name);
    const temporary = join(state, `.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await checkedPath(state, name);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  private async run() {
    const previous = (await this.readReport())?.hashes ?? {};
    const notes = await this.store.list();
    const report = { ...analyzeNotes(notes, previous), checkedAt: new Date().toISOString(), noteCount: notes.length };
    // Validate both artifacts before replacing either last-good snapshot.
    const overview = renderOverview(notes, report);
    const json = JSON.stringify(report, null, 2);
    if ([overview, json].some(content => Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES)) {
      throw new VaultError('STATE_TOO_LARGE', 'The maintenance report exceeds 64 MiB.');
    }
    // The derived overview stays outside the synced notes and is exposed through MCP.
    await this.save('overview.md', overview);
    await this.save('maintenance.json', json);
    return report;
  }

  async status() {
    return (await this.readReport()) ?? this.refresh();
  }

  async overview() {
    await this.status();
    const state = await this.store.runtimeDirectory();
    const target = await checkedPath(state, 'overview.md');
    try { return (await readBounded(target, MAX_STATE_BYTES)).content; }
    catch (error) {
      if (!(error instanceof VaultError) || error.code !== 'NOT_FOUND') throw error;
      // A lost derived overview can be rebuilt without editing any source notes.
      await this.refresh();
      return (await readBounded(await checkedPath(state, 'overview.md'), MAX_STATE_BYTES)).content;
    }
  }
}
