import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("scanVault ignores sync/tool artifacts", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memscan-"));
    // real note
    writeFileSync(join(dir, "real.md"), `---\nsensitivity: internal\n---\n# Real\n\nknowledge`);
    // Syncthing version history — deleted/old copies must NOT be knowledge
    mkdirSync(join(dir, ".stversions", "old"), { recursive: true });
    writeFileSync(join(dir, ".stversions", "old", "ghost~20260101-000000.md"), "# Ghost\n\nstale");
    // Syncthing conflict copy — duplicate, not knowledge
    writeFileSync(join(dir, "real.sync-conflict-20260101-000000-ABCDEFG.md"), "# Conflict\n\ndupe");
    // SilverBullet space config at root — tool config, not knowledge
    writeFileSync(join(dir, "CONFIG.md"), "```space-lua\nconfig.set{}\n```");
    // dotfile note
    writeFileSync(join(dir, ".hidden.md"), "# Hidden");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("indexes only the real note", async () => {
    process.env.VAULT_ROOT = dir;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { scanVault } = await import("../src/ingest/indexer");
    await scanVault();
    const docs = await prisma.document.findMany({ where: { status: { not: "archived" } }, select: { path: true } });
    expect(docs.map((d) => d.path)).toEqual(["real.md"]);
  });
});
