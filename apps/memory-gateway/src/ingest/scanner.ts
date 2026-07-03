import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE_DIRS = new Set(["node_modules", "_plug"]);
/** Syncthing conflict copies are duplicates awaiting the owner's cleanup, not knowledge. */
const SYNC_CONFLICT_RE = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+/;

export interface VaultFile {
  relPath: string;
  content: string;
}

export function scanVaultFiles(root: string): VaultFile[] {
  const out: VaultFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip ALL dot-entries: .obsidian, .git, .trash, .stversions/.stfolder (Syncthing
      // version history), .silverbullet.*, .DS_Store — tool state, never knowledge.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (SYNC_CONFLICT_RE.test(entry.name)) continue;
        const abs = join(dir, entry.name);
        const relPath = relative(root, abs).split(sep).join("/");
        // SilverBullet's space config at the vault root is tool config, not knowledge.
        if (relPath === "CONFIG.md") continue;
        out.push({ relPath, content: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}
