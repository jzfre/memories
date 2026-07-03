import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function seed(vaultRoot: string, quarantine: boolean) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  process.env.NOTE_RULES_QUARANTINE = quarantine ? "1" : "0";
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { search } = await import("../src/retrieval/search");
  return search;
}

describe("quarantine_invalid", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memquar-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    // A genuinely invalid note (malformed frontmatter -> parse error, always "invalid"
    // regardless of note_rules severity config) that still matches the query.
    writeFileSync(join(dir, "personal", "half.md"), `---\na: b: c\n---\n# Half\n\nzimbabwe keyword only`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NOTE_RULES_QUARANTINE;
  });

  it("returns an invalid note when quarantine is OFF", async () => {
    const search = await seed(dir, false);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    expect(res.results.some((r) => r.document_id === "personal.half")).toBe(true);
  });

  it("excludes an invalid note when quarantine is ON", async () => {
    const search = await seed(dir, true);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    expect(res.results.some((r) => r.document_id === "personal.half")).toBe(false);
  });
});
