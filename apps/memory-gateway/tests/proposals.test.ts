import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function getProposalFns(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const mod = await import("../src/proposals/index");
  return mod;
}

describe("proposals core", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-proposals-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("createProposal (note) inserts proposal row, knowledge_event row, and audit row", async () => {
    const { createProposal } = await getProposalFns(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "My test note",
        content: "Some content here",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(result.proposal_id).toBeTruthy();
    expect(result.review_state).toBe("pending_review");
    expect(result.message).toBe("Proposal created. Not written to canonical vault yet.");

    // Check proposal row exists
    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.proposalType).toBe("note");
    expect(proposal!.namespace).toBe("personal");
    expect(proposal!.reviewState).toBe("pending_review");

    // Check knowledge_event row
    const events = await prisma.knowledgeEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("proposal.created");

    // Check audit row
    const audits = await prisma.auditLog.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("memory.propose_note");
    expect(audits[0].approved).toBe(true);
  });

  it("createProposal rejects disallowed namespace — stored as rejected, audit approved=false, retained", async () => {
    const { createProposal } = await getProposalFns(dir);

    const result = await createProposal(
      {
        namespace: "forbidden-ns",
        sensitivity: "public",
        title: "Sneaky note",
        content: "Content",
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("rejected");
    expect(result.message).toBeTruthy();
    expect(result.message).not.toBe("Proposal created. Not written to canonical vault yet.");

    // Row is retained (not deleted)
    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.reviewState).toBe("rejected");

    // Audit shows denied
    const audits = await prisma.auditLog.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].approved).toBe(false);
  });

  it("createProposal rejects disallowed sensitivity — stored as rejected, retained", async () => {
    const { createProposal } = await getProposalFns(dir);

    const result = await createProposal(
      {
        namespace: "personal",
        sensitivity: "ultra-secret-not-allowed",
        title: "Sensitive note",
        content: "Content",
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("rejected");
    expect(result.message).toBeTruthy();

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.reviewState).toBe("rejected");
  });

  it("createProposal (patch) rejects unknown targetDocumentId — stored as rejected", async () => {
    const { createProposal } = await getProposalFns(dir);

    const result = await createProposal(
      {
        proposal_type: "patch" as const,
        target_document_id: "non-existent-doc-id",
        title: "Patch title",
        content: "Updated content",
      },
      { client: "test" },
    );

    expect(result.review_state).toBe("rejected");
    expect(result.message).toMatch(/unknown target document/i);

    const proposal = await prisma.proposal.findUnique({ where: { id: result.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.reviewState).toBe("rejected");
    expect(proposal!.proposalType).toBe("patch");

    // Audit approved=false for rejected patch
    const audits = await prisma.auditLog.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("memory.propose_patch");
    expect(audits[0].approved).toBe(false);
  });

  it("listProposals filters by reviewState", async () => {
    const { createProposal, listProposals } = await getProposalFns(dir);

    // Create two proposals: one valid (pending_review) and one invalid (rejected namespace)
    await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Note A", content: "Content A" },
      { client: "test" },
    );
    await createProposal(
      { namespace: "forbidden-ns", sensitivity: "public", title: "Note B", content: "Content B" },
      { client: "test" },
    );

    const pending = await listProposals({ reviewState: "pending_review" }, { client: "test" });
    const rejected = await listProposals({ reviewState: "rejected" }, { client: "test" });

    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("Note A");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].title).toBe("Note B");
  });

  it("listProposals filters by namespace", async () => {
    const { createProposal, listProposals } = await getProposalFns(dir);

    await createProposal(
      { namespace: "personal", sensitivity: "public", title: "Personal note", content: "Content" },
      { client: "test" },
    );
    await createProposal(
      { namespace: "work/client-a", sensitivity: "internal", title: "Work note", content: "Content" },
      { client: "test" },
    );

    const personalOnly = await listProposals({ namespace: "personal" }, { client: "test" });
    expect(personalOnly).toHaveLength(1);
    expect(personalOnly[0].namespace).toBe("personal");

    // listProposals itself should write an audit row
    const audits = await prisma.auditLog.findMany({ where: { action: "memory.list_proposals" } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("vault directory is untouched after createProposal", async () => {
    const { createProposal } = await getProposalFns(dir);
    const { readdirSync } = await import("node:fs");

    await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Vault test", content: "Body" },
      { client: "test" },
    );

    // Only the "personal" dir we created in beforeEach should exist (no new files written)
    const topLevel = readdirSync(dir);
    expect(topLevel).toEqual(["personal"]);
    const personalContents = readdirSync(join(dir, "personal"));
    expect(personalContents).toHaveLength(0);
  });

  it("getProposal returns the proposal by id, null for unknown", async () => {
    const { createProposal, getProposal } = await getProposalFns(dir);

    const result = await createProposal(
      { namespace: "personal", sensitivity: "internal", title: "Get test", content: "Body" },
      { client: "test" },
    );

    const found = await getProposal(result.proposal_id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(result.proposal_id);
    expect(found!.title).toBe("Get test");

    const missing = await getProposal("no-such-id");
    expect(missing).toBeNull();
  });
});
