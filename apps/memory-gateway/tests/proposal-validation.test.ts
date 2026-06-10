import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function getModules(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const proposals = await import("../src/proposals/index");
  const validate = await import("../src/proposals/validate");
  return { ...proposals, ...validate };
}

describe("validateProposal (pure)", async () => {
  const { validateProposal } = await import("../src/proposals/validate");

  const env = {
    allowedNamespaces: ["personal", "work/client-a"],
    allowedSensitivities: ["public", "internal", "private", "client-confidential"],
    existingTitles: ["Existing Doc Title", "Old Finding"],
  };

  it("flags secret_detected for content containing a password pattern", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Clean Title",
        content: "password=supersecret123",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "secret_detected")).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("does NOT flag secret_ref: op://… as a secret", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Vault reference note",
        content: "Use secret_ref: op://client-a/uat-db-readonly/password for the DB.",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "secret_detected")).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("flags namespace_invalid and blocks for disallowed namespace", () => {
    const result = validateProposal(
      {
        namespace: "forbidden-ns",
        sensitivity: "public",
        title: "Some title",
        content: "Some content with enough chars to be clear",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "namespace_invalid")).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("flags sensitivity_invalid and blocks for disallowed sensitivity", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "ultra-secret",
        title: "Some title",
        content: "Some content with enough chars to be clear",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "sensitivity_invalid")).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("flags duplicate_candidate when title matches existing title (not blocked)", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Existing Doc Title",
        content: "Body content that is long enough to be clear and specific",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "duplicate_candidate")).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("flags contradiction_candidate for decision/finding kind when title matches existing", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Old Finding",
        content: "This contradicts the previous finding with new evidence here and more text.",
        source_refs: ["ref-1"],
        kind: "finding",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "duplicate_candidate")).toBe(true);
    expect(result.flags.some((f) => f.code === "contradiction_candidate")).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("flags missing_source when source_refs is empty", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Well Written Title",
        content: "Body content that is long enough to be clear and descriptive and specific",
        source_refs: [],
        kind: "note",
      },
      env,
    );
    expect(result.flags.some((f) => f.code === "missing_source")).toBe(true);
  });

  it("clean well-sourced public note gets score >= 10 and quick_approve_eligible", () => {
    const result = validateProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Well Sourced Note",
        content:
          "This is a well-written note body with more than 80 characters and specific claims.",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.autoPolicy).toBe("quick_approve_eligible");
    expect(result.blocked).toBe(false);
  });

  it("client-confidential sensitivity gets human_review_required regardless of score", () => {
    const result = validateProposal(
      {
        namespace: "work/client-a",
        sensitivity: "client-confidential",
        title: "Client Confidential Note",
        content:
          "This is a well-written note body with more than 80 characters and specific claims about client.",
        source_refs: ["ref-1"],
        kind: "note",
      },
      env,
    );
    expect(result.autoPolicy).toBe("human_review_required");
    expect(result.blocked).toBe(false);
  });
});

describe("validateProposal wired into createProposal", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-bvalidation-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("secret content → proposal stored as rejected with secret_detected flag", async () => {
    const { createProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Secret Proposal",
        content: "The password=hunter2 is the dev password",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("rejected");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal).not.toBeNull();
    const flags = proposal!.validationFlags as Array<{ code: string }>;
    expect(flags.some((f) => f.code === "secret_detected")).toBe(true);
  });

  it("secret_ref: op://… body is NOT flagged as secret and stays pending_review", async () => {
    const { createProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Vault Ref Note",
        content:
          "Use secret_ref: op://client-a/uat-db-readonly/password to connect. This is safe reference notation.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("pending_review");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    const flags = proposal!.validationFlags as Array<{ code: string }>;
    expect(flags.some((f) => f.code === "secret_detected")).toBe(false);
  });

  it("wrong namespace → proposal rejected with namespace_invalid flag persisted", async () => {
    const { createProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "forbidden-ns",
        sensitivity: "public",
        title: "Forbidden Namespace Note",
        content: "Content here",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("rejected");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    const flags = proposal!.validationFlags as Array<{ code: string }>;
    expect(flags.some((f) => f.code === "namespace_invalid")).toBe(true);
  });

  it("no sources → proposal stored as needs_more_evidence", async () => {
    const { createProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Unsourced Note",
        content:
          "This is a very detailed note with lots of content but no sources provided to back it up.",
        source_refs: [],
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("needs_more_evidence");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    const flags = proposal!.validationFlags as Array<{ code: string }>;
    expect(flags.some((f) => f.code === "missing_source")).toBe(true);
  });

  it("duplicate title → duplicate_candidate flagged but proposal still pending_review", async () => {
    const { createProposal } = await getModules(dir);

    // Create initial proposal
    await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Duplicate Title Note",
        content: "First body content that is long and descriptive with enough characters.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    // Create second proposal with same title
    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Duplicate Title Note",
        content: "Second body content that is long and descriptive with enough characters too.",
        source_refs: ["ref-2"],
      },
      { client: "test" },
    );

    // Should be pending_review (not rejected) since duplicate is not blocking
    expect(result.review_state).toBe("pending_review");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    const flags = proposal!.validationFlags as Array<{ code: string }>;
    expect(flags.some((f) => f.code === "duplicate_candidate")).toBe(true);
  });

  it("client-confidential → proposal pending_review with human_review_required autoPolicy", async () => {
    const { createProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "work/client-a",
        sensitivity: "client-confidential",
        title: "Client Secret Strategy",
        content:
          "This is a well-written note body with more than 80 characters of client-specific detail.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    // client-confidential is in allowlist so it should NOT be rejected
    expect(result.review_state).toBe("pending_review");

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal!.autoPolicy).toBe("human_review_required");
  });

  it("approve on a blocked (secret_detected) proposal refuses with an error", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "public",
        title: "Secret Note Approve Attempt",
        content: "password=supersecretvalue stored in config",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    // Manually move it to pending_review state to simulate edge case (defense in depth)
    await prisma.proposal.update({
      where: { id: result.proposal_id },
      data: { reviewState: "pending_review" },
    });

    await expect(
      reviewProposal(
        result.proposal_id,
        { action: "approve", reviewedBy: "attacker" },
        { client: "test" },
      ),
    ).rejects.toThrow();
  });
});
