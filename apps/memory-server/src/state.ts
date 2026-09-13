import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultStore } from './vault.js';
import { analyzeNotes, renderOverview } from './maintenance.js';

export class Maintenance {
  private pending?: Promise<Awaited<ReturnType<Maintenance['run']>>>;
  constructor(readonly store: VaultStore, readonly stateDir: string) {}

  refresh() {
    if (!this.pending) this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async run() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let previous: Record<string, string> = {};
    try { previous = JSON.parse(await readFile(join(this.stateDir, 'maintenance.json'), 'utf8')).hashes; }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Cannot read maintenance state'); }
    const notes = await this.store.list();
    const report = { ...analyzeNotes(notes, previous), checkedAt: new Date().toISOString(), noteCount: notes.length };
    // The derived overview stays outside the synced notes and is exposed through MCP.
    for (const [name, content] of [
      ['overview.md', renderOverview(notes, report)],
      ['maintenance.json', JSON.stringify(report, null, 2)],
    ]) {
      const target = join(this.stateDir, name!);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, content!, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    }
    return report;
  }

  async status() {
    try { return JSON.parse(await readFile(join(this.stateDir, 'maintenance.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Cannot read maintenance state'); }
    return this.refresh();
  }

  async overview() {
    await this.status();
    return readFile(join(this.stateDir, 'overview.md'), 'utf8');
  }
}
