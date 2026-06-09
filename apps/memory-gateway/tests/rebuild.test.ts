import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

async function ctx(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  return import("../src/ingest/indexer");
}

describe("rebuildIndex", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memrebuild-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "a.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# A\n\napple`);
    writeFileSync(join(dir, "personal", "b.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# B\n\nbanana`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wipes and rebuilds documents+chunks to the same end state", async () => {
    const { scanVault, rebuildIndex } = await ctx(dir);
    await scanVault();
    const before = await prisma.document.count();
    expect(before).toBe(2);

    const report = await rebuildIndex();
    expect(report.added).toBe(2);
    expect(await prisma.document.count()).toBe(2);
    expect(await prisma.chunk.count()).toBeGreaterThan(0);
  });
});
