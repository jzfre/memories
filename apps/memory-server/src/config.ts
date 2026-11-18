import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { VaultStore } from './vault.js';
import { Maintenance } from './state.js';

export interface VaultBinding { id: string; token: string; store: VaultStore; maintenance: Maintenance }
const id = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const absolute = z.string().refine(isAbsolute);
const schema = z.object({ vaults: z.array(z.object({ id, path: absolute, state: absolute, token: z.string().optional() }).strict()).min(1) }).strict();

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), relative(parent, path));
  }
}
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

export async function validateVaults(vaults: VaultBinding[]) {
  if (!vaults.length || new Set(vaults.map(v => v.id)).size !== vaults.length || vaults.some(v => !id.safeParse(v.id).success)) throw new Error('Invalid or duplicate vault IDs');
  const tokens = vaults.map(v => v.token).filter(Boolean);
  if (new Set(tokens).size !== tokens.length) throw new Error('Each vault must have a distinct credential');
  const paths: string[] = [];
  for (const v of vaults) {
    if (v.maintenance.store !== v.store || resolve(v.maintenance.stateDir) !== resolve(v.store.stateDir)) throw new Error('Maintenance must use its bound vault and state directory');
    paths.push(await realpath(v.store.root), await canonical(v.store.stateDir));
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!)) throw new Error('Vault and state directories must not overlap');
    }
  }
}

export async function loadVaults(env: NodeJS.ProcessEnv): Promise<VaultBinding[]> {
  let entries: z.infer<typeof schema>['vaults'];
  if (env.MEMORIES_CONFIG) {
    let parsed;
    try { parsed = schema.safeParse(JSON.parse(await readFile(env.MEMORIES_CONFIG, 'utf8'))); }
    catch { throw new Error('Cannot read Memories vault configuration'); }
    if (!parsed.success) throw new Error('Invalid Memories vault configuration');
    entries = parsed.data.vaults;
    if (!entries.some(v => v.id === 'personal')) throw new Error('Configure the default personal vault');
  } else {
    if (!env.MEMORIES_VAULT) throw new Error('Set MEMORIES_CONFIG or MEMORIES_VAULT');
    entries = [{ id: 'personal', path: resolve(env.MEMORIES_VAULT), state: resolve(env.MEMORIES_STATE ?? join(homedir(), '.local/state/memories')), token: env.MEMORIES_TOKEN }];
  }
  const vaults = entries.map(v => {
    const store = new VaultStore(v.path, v.state);
    return { id: v.id, token: v.token ?? '', store, maintenance: new Maintenance(store, v.state) };
  });
  await validateVaults(vaults);
  return vaults;
}

export function selectVault(vaults: VaultBinding[], id = 'personal'): VaultBinding {
  const vault = vaults.find(v => v.id === id);
  if (!vault) throw new Error('Unknown vault; refusing to fall back to personal');
  return vault;
}
