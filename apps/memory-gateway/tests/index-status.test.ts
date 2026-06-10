import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./helpers/db";
import { deriveEmbeddingFreshness, isDocStale, REVIEW_INTERVALS_DAYS, DEFAULT_REVIEW_INTERVAL_DAYS } from "../src/status/index";
import { prisma } from "../src/db/client";

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

describe("isDocStale", () => {
  const now = new Date("2026-06-10T12:00:00Z");

  it("returns false for a fresh document within its interval", () => {
    // finding interval = 60 days; 30 days ago → not stale
    const updatedAt = new Date("2026-05-11T12:00:00Z");
    expect(isDocStale("finding", updatedAt, now)).toBe(false);
  });

  it("returns true for a document past its interval", () => {
    // finding interval = 60 days; 61 days ago → stale
    const updatedAt = new Date("2026-04-10T12:00:00Z");
    expect(isDocStale("finding", updatedAt, now)).toBe(true);
  });

  it("uses the correct per-kind intervals", () => {
    // brain-gym-memo = 30 days
    const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    expect(isDocStale("brain-gym-memo", thirtyOneDaysAgo, now)).toBe(true);
    // note = 180 days; 90 days ago → not stale
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(isDocStale("note", ninetyDaysAgo, now)).toBe(false);
  });

  it("uses DEFAULT_REVIEW_INTERVAL_DAYS for unknown kinds", () => {
    // default = 180 days; unknown kind with 181 days → stale
    const pastDefault = new Date(now.getTime() - (DEFAULT_REVIEW_INTERVAL_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(isDocStale("unknown-kind", pastDefault, now)).toBe(true);
    // unknown kind with 100 days → not stale
    const withinDefault = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    expect(isDocStale("unknown-kind", withinDefault, now)).toBe(false);
  });

  it("REVIEW_INTERVALS_DAYS contains all expected kinds", () => {
    expect(REVIEW_INTERVALS_DAYS["runbook"]).toBe(90);
    expect(REVIEW_INTERVALS_DAYS["finding"]).toBe(60);
    expect(REVIEW_INTERVALS_DAYS["decision"]).toBe(120);
    expect(REVIEW_INTERVALS_DAYS["project-context"]).toBe(60);
    expect(REVIEW_INTERVALS_DAYS["reading-note"]).toBe(90);
    expect(REVIEW_INTERVALS_DAYS["brain-gym-memo"]).toBe(30);
    expect(REVIEW_INTERVALS_DAYS["note"]).toBe(180);
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

  it("reports stale documents when updated_at is beyond the kind's interval", async () => {
    // Create a note with a specific kind so we can test staleness
    writeFileSync(
      join(dir, "personal", "old-finding.md"),
      `---\nnamespace: personal\nsensitivity: private\nkind: finding\n---\n# Old Finding\n\nbody`
    );
    const scanVault = await scanFor(dir);
    await scanVault();

    // Back-date the finding to 200 days ago (finding interval = 60 days → stale)
    const twoHundredDaysAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.document.updateMany({
      where: { path: "personal/old-finding.md" },
      data: { updatedAt: twoHundredDaysAgo },
    });

    const { computeIndexStatus } = await import("../src/status/index");
    const s = await computeIndexStatus();
    expect(s.stale_documents.some((d) => d.path === "personal/old-finding.md")).toBe(true);
    expect(s.totals.stale_documents).toBeGreaterThanOrEqual(1);
    const entry = s.stale_documents.find((d) => d.path === "personal/old-finding.md");
    expect(entry?.kind).toBe("finding");
    expect(entry?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns empty stale_documents for a fresh corpus", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const { computeIndexStatus } = await import("../src/status/index");
    const s = await computeIndexStatus();
    // Freshly scanned docs have updatedAt = now → well within any interval
    expect(s.stale_documents).toHaveLength(0);
    expect(s.totals.stale_documents).toBe(0);
  });
});
