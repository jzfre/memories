import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

async function scanFor(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("validation status", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memval-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "clean.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Clean\n\nbody`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No metadata\n\njust text`);
    writeFileSync(join(dir, "personal", "bad.md"), `---\na: b: c\n---\n# Bad\n\nbody`);
    writeFileSync(join(dir, "personal", "halfdecision.md"), `---\nnamespace: personal\nsensitivity: private\nkind: decision\n---\n# Half\n\n## Claim\n\nonly a claim`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies a clean note as valid with no issues", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/clean.md" } });
    expect(d.validationStatus).toBe("valid");
    expect(d.validationIssues).toEqual([]);
  });

  it("classifies a note missing namespace/sensitivity as incomplete with codes", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/nometa.md" } });
    expect(d.validationStatus).toBe("incomplete");
    const codes = (d.validationIssues as { code: string }[]).map((i) => i.code).sort();
    expect(codes).toEqual(["missing_namespace", "missing_sensitivity"]);
  });

  it("classifies malformed frontmatter as invalid", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/bad.md" } });
    expect(d.parseStatus).toBe("error");
    expect(d.validationStatus).toBe("invalid");
  });

  it("flags a structured note missing required sections as incomplete with missing_required_section (flag, not block, by default)", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/halfdecision.md" } });
    expect(d.validationStatus).toBe("incomplete");
    const codes = (d.validationIssues as { code: string }[]).map((i) => i.code);
    expect(codes).toContain("missing_required_section");
  });

  it("counts incomplete/invalid in the scan report", async () => {
    const scanVault = await scanFor(dir);
    const r = await scanVault();
    expect(r.incomplete).toBeGreaterThanOrEqual(1);
    expect(r.invalid).toBeGreaterThanOrEqual(1);
  });
});
