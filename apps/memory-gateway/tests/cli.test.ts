import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");
const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

describe("cli runScan", () => {
  beforeEach(resetDb);

  it("runs a scan and returns a report", async () => {
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { runScan } = await import("../src/cli/index");
    const report = await runScan({ dryRun: false });
    expect(report.added).toBeGreaterThan(0);
  });

  it("runStatus returns the index breakdown", async () => {
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { runScan } = await import("../src/cli/index");
    await runScan({ dryRun: false });
    const { runStatus } = await import("../src/cli/index");
    const s = await runStatus();
    expect(s.totals.documents).toBeGreaterThan(0);
    expect(s.validation).toHaveProperty("valid");
  });
});

describe("cli runAuditSearch", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-cli-audit-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
    process.env.VAULT_ROOT = dir;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runAuditSearch returns rows filtered by action after performing a search", async () => {
    // Trigger a search so an audit row with action "memory.search" is created
    const { search } = await import("../src/retrieval/search");
    await search({ query: "pgvector", namespaces: ["personal"] }, { client: "test" });

    const { runAuditSearch } = await import("../src/cli/index");

    // Filter by the exact action — should return at least one row
    const rows = await runAuditSearch({ action: "memory.search" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.action === "memory.search")).toBe(true);

    // Filter by a different action — should return zero rows
    const none = await runAuditSearch({ action: "some.other.action" });
    expect(none.length).toBe(0);
  });
});
