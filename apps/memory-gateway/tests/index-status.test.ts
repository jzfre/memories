import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./helpers/db";
import { deriveEmbeddingFreshness } from "../src/status/index";

async function scanFor(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("deriveEmbeddingFreshness", () => {
  it("reports stale when content changed after embedding", () => {
    expect(
      deriveEmbeddingFreshness({
        embeddingStatus: "current",
        embeddedAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-02-01"),
      }),
    ).toBe("stale");
  });
  it("passes through the stored status otherwise", () => {
    expect(
      deriveEmbeddingFreshness({ embeddingStatus: "current", embeddedAt: new Date("2026-02-01"), updatedAt: new Date("2026-01-01") }),
    ).toBe("current");
    expect(deriveEmbeddingFreshness({ embeddingStatus: "disabled", embeddedAt: null, updatedAt: new Date() })).toBe("disabled");
  });
});

describe("computeIndexStatus", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memstatus-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "ok.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Ok\n\nbody`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No meta\n\nbody`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("aggregates totals, validation counts, and an issues list", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const { computeIndexStatus } = await import("../src/status/index");
    const s = await computeIndexStatus();
    expect(s.totals.documents).toBe(2);
    expect(s.validation.valid).toBe(1);
    expect(s.validation.incomplete).toBe(1);
    expect(s.issues.some((i) => i.path === "personal/nometa.md")).toBe(true);
    expect(s.embedding.disabled).toBe(2); // embeddings off in tests
  });
});
