import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';

export type Note = {
  path: string;
  title: string;
  content: string;
  hash: string;
  modifiedAt: number;
  tags: string[];
  aliases: string[];
  links: string[];
};
export type SearchHit = Omit<Note, 'content'> & { snippet: string; score: number };
export type HistoryEntry = { version: string; hash: string; createdAt: number };
type SavedVersion = HistoryEntry & { path: string; content: string };

export class VaultError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = MAX_NOTE_BYTES * 6 + 1024;
const VERSION_PATTERN = /^\d+-[a-f0-9-]{36}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

function notePath(input: string): string {
  if (!input || isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.includes('\\') || CONTROL.test(input)) {
    throw new VaultError('INVALID_PATH', 'Use a vault-relative Markdown path.');
  }
  const segments = input.split('/').filter(Boolean);
  if (segments.some(part => part.startsWith('.')) || !/\.md$/i.test(segments.at(-1) ?? '')) {
    throw new VaultError('INVALID_PATH', 'Only visible Markdown files inside the vault are accessible.');
  }
  return segments.join('/');
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

// Resolve existing parents before creating anything: a state-directory alias may point into the vault.
async function prospectiveRealPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return join(await prospectiveRealPath(dirname(path)), basename(path));
  }
}

async function checkedPath(base: string, path: string, createParents = false, directory = false): Promise<string> {
  try {
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
      throw new VaultError('UNSAFE_PATH', 'The root path is not a regular directory.');
    }
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  const parts = path.split('/');
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const needsDirectory = i < parts.length - 1 || directory;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (needsDirectory ? !info.isDirectory() : !info.isFile())) {
        throw new VaultError('UNSAFE_PATH', 'Symlinks and non-regular files are not accessible.');
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      if (createParents && needsDirectory) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (mkdirError) { if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError; }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new VaultError('UNSAFE_PATH', 'The parent path is not a regular directory.');
        }
      }
    }
  }
  return current;
}

async function readBounded(path: string, limit: number): Promise<{ content: string; modifiedAt: number }> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new VaultError('NOT_FOUND', 'The note or version does not exist.');
    if (hasCode(error, 'ELOOP')) throw new VaultError('UNSAFE_PATH', 'Symlinks are not accessible.');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new VaultError('UNSAFE_PATH', 'Only regular files are accessible.');
    if (info.size > limit) throw new VaultError('NOTE_TOO_LARGE', 'The note exceeds the size limit.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new VaultError('NOTE_TOO_LARGE', 'The note exceeds the size limit.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { content, modifiedAt: info.mtimeMs };
  } finally { await handle.close(); }
}

function strings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
}

function noteFrom(path: string, content: string, modifiedAt: number): Note {
  let data: Record<string, unknown> = {};
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (header) {
    try {
      const parsed: unknown = parseYaml(header[1]!, { maxAliasCount: 50 });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch { /* Keep malformed frontmatter readable and preserve its exact bytes on writes. */ }
  }
  const body = header ? content.slice(header[0].length) : content;
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim() : /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? basename(path, '.md');
  const links = new Set<string>();
  const addLink = (raw: string): void => {
    let target = raw.split('|')[0]!.split('#')[0]!.trim();
    if (!target || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) return;
    try { target = decodeURIComponent(target); } catch { /* A literal percent is legal in a filename. */ }
    if (/\.[a-z0-9]+$/i.test(target) && !/\.md$/i.test(target)) return;
    links.add(target);
  };
  // Code samples are not links in the vault's knowledge graph.
  const prose = body.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) addLink(match[1]!);
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) addLink(match[1] ?? match[2]!);
  return { path, title, content, hash: hash(content), modifiedAt,
    tags: strings(data.tags ?? data.tag), aliases: strings(data.aliases ?? data.alias), links: [...links] };
}

export class VaultStore {
  public readonly root: string;
  public readonly stateDir: string;
  private roots?: Promise<{ vault: string; state: string }>;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(root: string, stateDir: string) {
    this.root = resolve(root);
    this.stateDir = resolve(stateDir);
  }

  private ready(): Promise<{ vault: string; state: string }> {
    return this.roots ??= (async () => {
      const rootInfo = await lstat(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new VaultError('UNSAFE_PATH', 'The vault root must be a regular directory.');
      }
      const vault = await realpath(this.root);
      const state = await prospectiveRealPath(this.stateDir);
      if (inside(this.root, this.stateDir) || inside(vault, state)) {
        throw new VaultError('INVALID_STATE_DIR', 'History and runtime state must be outside the synced vault.');
      }
      await mkdir(state, { recursive: true, mode: 0o700 });
      return { vault, state };
    })();
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(async () => {
      const release = await this.acquireWriteLock();
      try { return await action(); }
      finally { await release(); }
    });
    this.mutations = next.catch(() => undefined);
    return next;
  }

  // All MCP processes must share stateDir. A PID-owned directory lock serializes their
  // read/check/backup/rename transaction; an instance-local queue alone cannot do that.
  private async acquireWriteLock(): Promise<() => Promise<void>> {
    const { state } = await this.ready();
    await checkedPath(state, '', false, true);
    const dir = join(state, 'write.lock');
    const owner = `${process.pid}-${randomUUID()}.owner`;
    const marker = join(dir, owner);
    const deadline = Date.now() + 15_000;
    const clear = async (): Promise<void> => {
      await unlink(marker).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
      await rmdir(dir).catch(error => {
        if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
      });
    };
    while (Date.now() < deadline) {
      let acquired = false;
      try { await mkdir(dir, { mode: 0o700 }); acquired = true; }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      if (acquired) {
        try {
          const before = await lstat(dir);
          if (!before.isDirectory() || before.isSymbolicLink()) throw new VaultError('UNSAFE_PATH', 'Unsafe write lock.');
          const handle = await open(marker, 'wx', 0o600);
          await handle.close();
          const after = await lstat(dir);
          const owners = await readdir(dir);
          // A dead-owner cleanup may remove an empty lock during the claim window.
          // Never enter if our directory was replaced or another claimant is present.
          if (before.dev === after.dev && before.ino === after.ino && owners.length === 1 && owners[0] === owner) return clear;
          await clear();
        } catch (error) {
          await clear();
          if (!hasCode(error, 'ENOENT') && !hasCode(error, 'EEXIST')) throw error;
        }
      } else {
        try {
          await checkedPath(state, 'write.lock', false, true);
          const owners = await readdir(dir);
          const match = owners.length === 1 ? /^([1-9]\d*)-[a-f0-9-]{36}\.owner$/.exec(owners[0]!) : null;
          if (match) {
            let dead = false;
            try { process.kill(Number(match[1]), 0); }
            catch (error) { dead = hasCode(error, 'ESRCH'); }
            if (dead) {
              // The unique filename prevents one reaper from deleting a new owner's
              // marker. Non-recursive rmdir cannot remove an already-owned new lock.
              await unlink(join(dir, owners[0]!)).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
              await rmdir(dir).catch(error => {
                if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
              });
            }
          }
          // Ownerless or unrecognizable locks fail closed after the bounded wait:
          // they may belong to a live process paused before writing its marker.
        } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      }
      await delay(25);
    }
    throw new VaultError('VAULT_BUSY', 'Another process owns the vault write lock. Retry after it finishes; an ownerless lock requires operator inspection.');
  }

  async list(): Promise<Note[]> {
    const { vault } = await this.ready();
    const notes: Note[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const folder = await checkedPath(vault, prefix, false, true);
      const entries = await readdir(folder, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || CONTROL.test(entry.name) || entry.isSymbolicLink()) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          try { notes.push(await this.read(path)); }
          catch (error) { if (!hasCode(error, 'NOT_FOUND')) throw error; }
        }
      }
    };
    await walk('');
    return notes;
  }

  async read(input: string): Promise<Note> {
    const path = notePath(input);
    const { vault } = await this.ready();
    const file = await checkedPath(vault, path);
    const { content, modifiedAt } = await readBounded(file, MAX_NOTE_BYTES);
    return noteFrom(path, content, modifiedAt);
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const terms = [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (!terms.length || !Number.isFinite(limit) || limit < 1) return [];
    const hits: SearchHit[] = [];
    for (const note of await this.list()) {
      const fields: [string, number][] = [[fold(note.title), 10], [fold(note.aliases.join(' ')), 8],
        [fold(note.path), 6], [fold(note.tags.join(' ')), 4], [fold(note.content), 1]];
      if (!terms.every(term => fields.some(([text]) => text.includes(term)))) continue;
      const score = terms.reduce((sum, term) => sum + fields.reduce((n, [text, weight]) => n + (text.includes(term) ? weight : 0), 0), 0);
      const first = Math.min(...terms.map(term => fold(note.content).indexOf(term)).filter(n => n >= 0));
      const start = Number.isFinite(first) ? Math.max(0, first - 80) : 0;
      const snippet = `${start ? '…' : ''}${note.content.slice(start, start + 340)}${note.content.length > start + 340 ? '…' : ''}`;
      const { content: _content, ...metadata } = note;
      hits.push({ ...metadata, snippet, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(100, Math.floor(limit)));
  }

  async write(input: string, content: string, expectedHash?: string): Promise<Note> {
    const path = notePath(input);
    if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new VaultError('NOTE_TOO_LARGE', 'The note exceeds 2 MiB.');
    return this.serialized(() => this.writeUnlocked(path, content, expectedHash));
  }

  private async current(path: string): Promise<Note | undefined> {
    try { return await this.read(path); }
    catch (error) { if (hasCode(error, 'NOT_FOUND')) return undefined; throw error; }
  }

  private checkExpected(current: Note | undefined, expectedHash?: string): void {
    if (expectedHash !== undefined && (current?.hash ?? '') !== expectedHash) {
      throw new VaultError('STALE_WRITE', 'The note changed since it was read. Read it again before writing.');
    }
  }

  private async writeUnlocked(path: string, content: string, expectedHash?: string): Promise<Note> {
    const old = await this.current(path);
    this.checkExpected(old, expectedHash);
    const { vault } = await this.ready();
    const file = await checkedPath(vault, path, true);
    if (old) await this.backup(old);
    const temp = join(dirname(file), `.memories-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await checkedPath(vault, path);
      // Also catch external writes while the backup and temporary file were being saved.
      this.checkExpected(await this.current(path), old?.hash ?? '');
      await rename(temp, file);
    } finally { await unlink(temp).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; }); }
    return this.read(path);
  }

  async remove(input: string, expectedHash?: string): Promise<void> {
    const path = notePath(input);
    return this.serialized(async () => {
      const old = await this.read(path);
      this.checkExpected(old, expectedHash);
      await this.backup(old);
      const { vault } = await this.ready();
      const file = await checkedPath(vault, path);
      this.checkExpected(await this.current(path), old.hash);
      await unlink(file);
    });
  }

  private async historyDirectory(path: string, create = false): Promise<string> {
    const { state } = await this.ready();
    return checkedPath(state, `history/${hash(path)}`, create, true);
  }

  private async backup(note: Note): Promise<void> {
    const dir = await this.historyDirectory(note.path, true);
    const createdAt = Date.now();
    const version = `${createdAt}-${randomUUID()}`;
    const saved: SavedVersion = { path: note.path, content: note.content, hash: note.hash, version, createdAt };
    const temp = join(dir, `.${version}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(saved), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, join(dir, `${version}.json`));
    }
    finally { await unlink(temp).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; }); }
  }

  private async loadVersion(path: string, version: string): Promise<SavedVersion> {
    if (!VERSION_PATTERN.test(version)) throw new VaultError('INVALID_VERSION', 'Invalid history version.');
    const dir = await this.historyDirectory(path);
    const file = await checkedPath(dir, `${version}.json`);
    const saved: unknown = JSON.parse((await readBounded(file, MAX_HISTORY_BYTES)).content);
    if (!saved || typeof saved !== 'object' || !('path' in saved) || saved.path !== path ||
      !('version' in saved) || saved.version !== version || !('content' in saved) || typeof saved.content !== 'string' ||
      !('hash' in saved) || saved.hash !== hash(saved.content) || !('createdAt' in saved) || typeof saved.createdAt !== 'number') {
      throw new VaultError('INVALID_VERSION', 'The saved version is invalid or its content hash differs.');
    }
    return saved as SavedVersion;
  }

  async history(input: string): Promise<HistoryEntry[]> {
    const path = notePath(input);
    const dir = await this.historyDirectory(path);
    let files: string[];
    try { files = await readdir(dir); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const versions: HistoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || !VERSION_PATTERN.test(file.slice(0, -5))) continue;
      const { version, hash: contentHash, createdAt } = await this.loadVersion(path, file.slice(0, -5));
      versions.push({ version, hash: contentHash, createdAt });
    }
    return versions.sort((a, b) => b.createdAt - a.createdAt || b.version.localeCompare(a.version));
  }

  async restore(input: string, version: string): Promise<Note> {
    const path = notePath(input);
    return this.serialized(async () => {
      const saved = await this.loadVersion(path, version);
      return this.writeUnlocked(path, saved.content);
    });
  }
}
