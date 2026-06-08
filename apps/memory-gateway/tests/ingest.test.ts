import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { prisma, resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

async function importScan() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("scanVault", () => {
  beforeEach(resetDb);

  it("ingests notes, fills defaults, and reports warnings", async () => {
    const scanVault = await importScan();
    const report = await scanVault();
    // 6 files: 4 with frontmatter, Welcome (no fm), empty (no chunks)
    expect(report.added).toBeGreaterThanOrEqual(5);
    const docs = await prisma.document.findMany();
    const welcome = docs.find((d) => d.path === "Welcome.md");
    expect(welcome?.namespace).toBe("personal");
    expect(welcome?.sensitivity).toBe("private");
    expect(report.warnings.some((w) => w.path === "Welcome.md")).toBe(true);
  });

  it("is idempotent on re-scan (unchanged files are skipped)", async () => {
    const scanVault = await importScan();
    await scanVault();
    const second = await scanVault();
    expect(second.added).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(5);
  });

  it("creates chunks for non-empty notes and none for the empty note", async () => {
    const scanVault = await importScan();
    await scanVault();
    const empty = await prisma.document.findFirst({ where: { path: "empty.md" } });
    expect(empty).not.toBeNull();
    const emptyChunks = await prisma.chunk.count({ where: { documentId: empty!.id } });
    expect(emptyChunks).toBe(0);
    const total = await prisma.chunk.count();
    expect(total).toBeGreaterThan(0);
  });
});
