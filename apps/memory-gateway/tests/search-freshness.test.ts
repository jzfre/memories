import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./helpers/db";

async function seed(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { search } = await import("../src/retrieval/search");
  return search;
}

describe("search freshness + penalty", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memfresh-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    // Same keyword in both. 'valid.md' has full metadata; 'nometa.md' is incomplete.
    writeFileSync(join(dir, "personal", "valid.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Valid\n\nzimbabwe keyword body`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No meta\n\nzimbabwe keyword body`);
    // Malformed frontmatter -> validationStatus 'invalid'; namespace defaults to personal (in scope).
    writeFileSync(join(dir, "personal", "bad.md"), `---\na: b: c\n---\n# Bad\n\nzimbabwe keyword body`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("attaches a freshness block to each result", async () => {
    const search = await seed(dir);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.freshness.validation).toBeDefined();
      expect(r.freshness.embedding).toBeDefined();
    }
  });

  it("ranks an otherwise-equal valid note above an incomplete one", async () => {
    const search = await seed(dir);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    const ids = res.results.map((r) => r.document_id);
    expect(ids.indexOf("personal.valid")).toBeLessThan(ids.indexOf("personal.nometa"));
  });

  it("ranks an otherwise-equal valid note above an invalid (malformed-frontmatter) one", async () => {
    const search = await seed(dir);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    const bad = res.results.find((r) => r.document_id === "personal.bad");
    expect(bad?.freshness.validation).toBe("invalid");
    const ids = res.results.map((r) => r.document_id);
    expect(ids.indexOf("personal.valid")).toBeLessThan(ids.indexOf("personal.bad"));
  });
});
