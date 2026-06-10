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

describe("cli proposals commands", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-cli-proposals-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
    process.env.VAULT_ROOT = dir;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runListProposals returns a created proposal", async () => {
    const { createProposal } = await import("../src/proposals/index");
    const { runListProposals } = await import("../src/cli/index");

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "CLI List Test Note",
        content: "Some content for the CLI list test.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(created.review_state).toBe("pending_review");

    const proposals = await runListProposals({});
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const found = proposals.find((p) => p.id === created.proposal_id);
    expect(found).toBeTruthy();
    expect(found!.reviewState).toBe("pending_review");
    expect(found!.namespace).toBe("personal");
    expect(found!.title).toBe("CLI List Test Note");
  });

  it("runReviewProposal approve → state merged, file written to temp vault", async () => {
    const { createProposal } = await import("../src/proposals/index");
    const { runListProposals, runReviewProposal } = await import("../src/cli/index");

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "CLI Approve Test Note",
        content: "Unique body for cli-approve-test cliapproveunique999.",
        source_refs: ["ref-cli-1"],
      },
      { client: "test" },
    );

    // List confirms it is pending
    const before = await runListProposals({ reviewState: "pending_review" });
    expect(before.some((p) => p.id === created.proposal_id)).toBe(true);

    // Approve it
    const result = await runReviewProposal(created.proposal_id, "approve");
    expect(result).not.toBeNull();
    expect(result!.review_state).toBe("merged");
    expect(result!.document_path).toBeTruthy();

    // File should exist in vault
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, result!.document_path!))).toBe(true);

    // Should no longer appear in pending list
    const after = await runListProposals({ reviewState: "pending_review" });
    expect(after.some((p) => p.id === created.proposal_id)).toBe(false);

    // DB state updated
    const row = await prisma.proposal.findUnique({ where: { id: created.proposal_id } });
    expect(row!.reviewState).toBe("merged");
  });

  it("runListProposals filters by reviewState", async () => {
    const { createProposal } = await import("../src/proposals/index");
    const { runListProposals } = await import("../src/cli/index");

    await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Filter Test A",
        content: "Body A with enough detail to be well-sourced and specific.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );
    await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Filter Test B",
        content: "Body B with enough detail to be well-sourced and specific.",
        source_refs: ["ref-2"],
      },
      { client: "test" },
    );

    const all = await runListProposals({});
    expect(all.length).toBe(2);

    const pending = await runListProposals({ reviewState: "pending_review" });
    expect(pending.length).toBe(2);

    const rejected = await runListProposals({ reviewState: "rejected" });
    expect(rejected.length).toBe(0);
  });

  it("runReviewProposal with notes stores reviewerNotes", async () => {
    const { createProposal } = await import("../src/proposals/index");
    const { runReviewProposal } = await import("../src/cli/index");

    const created = await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Notes Test", content: "Some body." },
      { client: "test" },
    );

    const result = await runReviewProposal(created.proposal_id, "reject", "Not enough detail");
    expect(result).not.toBeNull();
    expect(result!.review_state).toBe("rejected");

    const row = await prisma.proposal.findUnique({ where: { id: created.proposal_id } });
    expect(row!.reviewerNotes).toBe("Not enough detail");
  });

  it("runReviewProposal unknown id returns null", async () => {
    const { runReviewProposal } = await import("../src/cli/index");
    const result = await runReviewProposal("non-existent-id-xyz", "approve");
    expect(result).toBeNull();
  });
});
