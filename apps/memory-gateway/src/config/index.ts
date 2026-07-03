import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "@memories/shared";

function findConfigFile(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "config.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("config.yaml not found (searched upward from cwd)");
}

let cached: Config | null = null;

/** Test-only: clears the memoized config so env changes take effect. */
export function __resetConfigCache(): void {
  cached = null;
}

export function loadConfig(): Config {
  if (cached) return cached;
  const file = process.env.MEMORIES_CONFIG ?? findConfigFile();
  const parsed = parseYaml(readFileSync(file, "utf8"));
  const config = ConfigSchema.parse(parsed);
  if (process.env.VAULT_ROOT) config.vault.root = process.env.VAULT_ROOT;
  if (process.env.NOTE_RULES_QUARANTINE === "1") config.note_rules.quarantine_invalid = true;
  if (process.env.NOTE_RULES_QUARANTINE === "0") config.note_rules.quarantine_invalid = false;
  cached = config;
  return config;
}
