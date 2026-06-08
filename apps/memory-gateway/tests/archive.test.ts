import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

const FM = `---\nnamespace: personal\nsensitivity: private\n---\n`;

async function scanFor(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("update / archive / restore", () => {
  let dir: string;

  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memvault-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "a.md"), `${FM}# A\n\napple keyword`);
    writeFileSync(join(dir, "personal", "b.md"), `${FM}# B\n\nbanana keyword`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("updates a changed file on re-scan", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    writeFileSync(join(dir, "personal", "a.md"), `${FM}# A\n\napple cherry keyword`);
    const r = await scanVault();
    expect(r.updated).toBeGreaterThanOrEqual(1);
    const doc = await prisma.document.findFirstOrThrow({ where: { path: "personal/a.md" } });
    expect(doc.bodyText).toContain("cherry");
  });

  it("archives a removed file, then un-archives it when restored unchanged", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();

    rmSync(join(dir, "personal", "b.md"));
    const archived = await scanVault();
    expect(archived.archived).toBeGreaterThanOrEqual(1);
    const gone = await prisma.document.findFirstOrThrow({ where: { path: "personal/b.md" } });
    expect(gone.status).toBe("archived");

    // Restore identical content (same checksum) — must NOT stay archived.
    writeFileSync(join(dir, "personal", "b.md"), `${FM}# B\n\nbanana keyword`);
    await scanVault();
    const restored = await prisma.document.findFirstOrThrow({ where: { path: "personal/b.md" } });
    expect(restored.status).not.toBe("archived");
  });
});
