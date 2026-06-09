import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

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
