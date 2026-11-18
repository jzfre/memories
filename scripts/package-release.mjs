import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/memory-server');
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const digest = value => createHash('sha256').update(value).digest('hex');

if (process.argv.length !== 3) throw new Error('Usage: pnpm release /absolute/new/release-directory');
const requested = resolve(process.argv[2]);
// Resolve the parent before checking containment, including aliases into the checkout.
const destination = join(await realpath(dirname(requested)), basename(requested));
if (inside(await realpath(root), destination)) throw new Error('Release destination must be outside the repository.');
await mkdir(destination); // Fail rather than overwrite an existing release.
let completed = false;
try {
  execFileSync('pnpm', ['--filter', '@memories/memory-server', 'deploy', '--prod', '--offline', '--frozen-lockfile', destination], { cwd: root, stdio: 'inherit' });
  // pnpm 9 includes a workspace self-reference to the original checkout. Retarget
  // that one known link, then reject every other external or broken symlink.
  const self = join(destination, 'node_modules/.pnpm/node_modules/@memories/memory-server');
  try {
    if (!(await lstat(self)).isSymbolicLink() || await realpath(self) !== await realpath(app)) {
      throw new Error('Unexpected workspace self-reference in release.');
    }
    await unlink(self);
    await symlink(relative(dirname(self), destination), self);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const allowed = new Set(['dist', 'node_modules', 'package.json']);
  if ((await readdir(destination)).some(name => !allowed.has(name))) throw new Error('Unexpected application files in release.');
  const files = [];
  const links = [];
  const walk = async directory => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      const local = relative(destination, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !inside(destination, await realpath(path))) throw new Error('External or broken release symlink.');
        links.push({ path: local, target });
      } else if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push({ path: local, sha256: digest(await readFile(path)) });
      else throw new Error('Non-regular release artifact.');
    }
  };
  await walk(destination);
  if (!files.some(file => file.path === 'dist/main.js')) throw new Error('Compiled entry point missing from release.');
  const pkg = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  const manifest = JSON.stringify({ format: 1, name: pkg.name, version: pkg.version, node: pkg.engines.node, files, symlinks: links }, null, 2) + '\n';
  await writeFile(join(destination, 'release-manifest.json'), manifest, { flag: 'wx' });
  const sha256 = digest(manifest);
  await writeFile(join(destination, 'release-manifest.sha256'), `${sha256}  release-manifest.json\n`, { flag: 'wx' });
  completed = true;
  process.stdout.write(`Release prepared: ${destination}\nManifest SHA-256: ${sha256}\n${files.length} files; ${links.length} internal symlinks.\n`);
} finally {
  // This process created destination exclusively; an incomplete artifact is not a release.
  if (!completed) await rm(destination, { recursive: true, force: true });
}
