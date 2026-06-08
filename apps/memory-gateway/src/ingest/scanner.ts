import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules"]);
const IGNORE_FILES = new Set([".DS_Store"]);

export interface VaultFile {
  relPath: string;
  content: string;
}

export function scanVaultFiles(root: string): VaultFile[] {
  const out: VaultFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md") && !IGNORE_FILES.has(entry.name)) {
        const abs = join(dir, entry.name);
        out.push({
          relPath: relative(root, abs).split(sep).join("/"),
          content: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}
