import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "./helpers/db";
import { resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function getModules(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const proposals = await import("../src/proposals/index");
  return proposals;
}

describe("reviewProposal", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-review-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Test 1: approve note → file created, has frontmatter + title, indexed, state merged, document_path returned
  it("approve note → writes file under 00-inbox/reviewed/, document indexed, state merged", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "My Indexed Note",
        content: "This note has a uniquekeyword9847 in its body.",
        source_refs: ["ref-1"],
        confidence: "high",
      },
      { client: "test" },
    );

    expect(created.review_state).toBe("pending_review");

    const result = await reviewProposal(
      created.proposal_id,
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );

    expect(result).not.toBeNull();
    expect(result!.proposal_id).toBe(created.proposal_id);
    expect(result!.review_state).toBe("merged");
    expect(result!.document_path).toBeTruthy();
    expect(result!.document_path).toMatch(/^00-inbox\/reviewed\/.+\.md$/);

    // File must exist in the vault
    const fullPath = join(dir, result!.document_path!);
    expect(existsSync(fullPath)).toBe(true);

    const fileContent = readFileSync(fullPath, "utf8");

    // Frontmatter block must be present
    expect(fileContent).toContain("---");
    expect(fileContent).toContain("kind:");
    expect(fileContent).toContain("namespace: personal");
    expect(fileContent).toContain("sensitivity: private");
    expect(fileContent).toContain("status: active");
    expect(fileContent).toContain("confidence: high");
    expect(fileContent).toContain("source_type: proposal");
    expect(fileContent).toContain("tags: []");

    // Title heading must be present
    expect(fileContent).toContain("# My Indexed Note");

    // Body must contain the unique keyword
    expect(fileContent).toContain("uniquekeyword9847");

    // Proposal state must be merged in DB
    const proposal = await prisma.proposal.findUnique({ where: { id: created.proposal_id } });
    expect(proposal!.reviewState).toBe("merged");
    expect(proposal!.reviewedBy).toBe("reviewer-1");
    expect(proposal!.reviewedAt).toBeTruthy();

    // Document must be indexed (searchable)
    const docs = await prisma.document.findMany({ where: { bodyText: { contains: "uniquekeyword9847" } } });
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  // Test 2: reject → no file, state rejected, row retained, reviewerNotes stored
  it("reject → no vault file written, state rejected, row retained, reviewer notes stored", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Note To Reject",
        content: "Body content here.",
      },
      { client: "test" },
    );

    const result = await reviewProposal(
      created.proposal_id,
      { action: "reject", reviewedBy: "reviewer-1", reviewerNotes: "Not accurate enough." },
      { client: "test" },
    );

    expect(result).not.toBeNull();
    expect(result!.review_state).toBe("rejected");
    expect(result!.document_path).toBeUndefined();

    // No file written
    const inboxDir = join(dir, "00-inbox");
    expect(existsSync(inboxDir)).toBe(false);

    // Row retained
    const proposal = await prisma.proposal.findUnique({ where: { id: created.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.reviewState).toBe("rejected");
    expect(proposal!.reviewerNotes).toBe("Not accurate enough.");
    expect(proposal!.reviewedBy).toBe("reviewer-1");
  });

  // Test 3: approve patch → target file body replaced, original frontmatter preserved, reindexed
  it("approve patch → target body replaced, frontmatter preserved, document reindexed", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    // Create a vault file with frontmatter
    const noteDir = join(dir, "personal");
    const notePath = join(noteDir, "existing-doc.md");
    const originalContent = `---
kind: note
namespace: personal
sensitivity: private
status: active
confidence: medium
---

# Existing Doc

Original body with oldbodymarker555.
`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(notePath, originalContent);

    // Scan vault to index the file
    const { scanVault } = await import("../src/ingest/indexer");
    await scanVault();

    // Get the indexed doc
    const doc = await prisma.document.findFirst({ where: { path: "personal/existing-doc.md" } });
    expect(doc).not.toBeNull();

    // Create a patch proposal for this doc (source_refs required for pending_review state)
    const patchCreated = await createProposal(
      {
        proposal_type: "patch" as const,
        target_document_id: doc!.id,
        title: "Patch existing doc",
        content: "Replaced body with newbodymarker777.",
        source_refs: ["ref-1"],
      },
      { client: "test" },
    );

    expect(patchCreated.review_state).toBe("pending_review");

    const result = await reviewProposal(
      patchCreated.proposal_id,
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );

    expect(result).not.toBeNull();
    expect(result!.review_state).toBe("merged");
    expect(result!.document_path).toBeFalsy(); // patch doesn't add a new doc_path return typically, but let's check the file

    // The vault file should have the frontmatter preserved but body replaced
    const updatedContent = readFileSync(notePath, "utf8");
    expect(updatedContent).toContain("kind: note");
    expect(updatedContent).toContain("namespace: personal");
    expect(updatedContent).toContain("sensitivity: private");
    expect(updatedContent).not.toContain("oldbodymarker555");
    expect(updatedContent).toContain("newbodymarker777");

    // Document should be reindexed with new body
    const reindexed = await prisma.document.findFirst({ where: { id: doc!.id } });
    expect(reindexed!.bodyText).toContain("newbodymarker777");
    expect(reindexed!.bodyText).not.toContain("oldbodymarker555");
  });

  // Test 4: needs_more_evidence sets state
  it("needs_more_evidence → sets state to needs_more_evidence, no file written", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Needs Evidence Note",
        content: "I claim something without evidence.",
      },
      { client: "test" },
    );

    const result = await reviewProposal(
      created.proposal_id,
      { action: "needs_more_evidence", reviewedBy: "reviewer-1", reviewerNotes: "Add citations." },
      { client: "test" },
    );

    expect(result).not.toBeNull();
    expect(result!.review_state).toBe("needs_more_evidence");
    expect(result!.document_path).toBeUndefined();

    const proposal = await prisma.proposal.findUnique({ where: { id: created.proposal_id } });
    expect(proposal!.reviewState).toBe("needs_more_evidence");
    expect(proposal!.reviewerNotes).toBe("Add citations.");
  });

  // Test 5: audit rows written for every review action
  it("audit rows written for every review action", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const p1 = await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Audit Note 1", content: "Body 1." },
      { client: "test" },
    );
    const p2 = await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Audit Note 2", content: "Body 2." },
      { client: "test" },
    );
    const p3 = await createProposal(
      { namespace: "personal", sensitivity: "private", title: "Audit Note 3", content: "Body 3." },
      { client: "test" },
    );

    await reviewProposal(p1.proposal_id, { action: "approve", reviewedBy: "r" }, { client: "test" });
    await reviewProposal(p2.proposal_id, { action: "reject", reviewedBy: "r" }, { client: "test" });
    await reviewProposal(p3.proposal_id, { action: "needs_more_evidence", reviewedBy: "r" }, { client: "test" });

    const reviewAudits = await prisma.auditLog.findMany({ where: { action: "proposal.review" } });
    expect(reviewAudits.length).toBe(3);

    const approveAudit = reviewAudits.find((a) => {
      // We look at returnedDocumentIds to distinguish approve from others
      return a.approved === true;
    });
    expect(approveAudit).toBeTruthy();

    const rejectAudit = reviewAudits.find((a) => a.approved === false);
    expect(rejectAudit).toBeTruthy();
  });

  // Test 6: approving an already-merged proposal refuses with error
  it("approving an already-merged proposal refuses and does not write a second file", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const created = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Idempotency Test Note",
        content: "Body for idempotency test.",
      },
      { client: "test" },
    );

    // First approval
    await reviewProposal(
      created.proposal_id,
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );

    // Second approval must throw or return an error
    await expect(
      reviewProposal(
        created.proposal_id,
        { action: "approve", reviewedBy: "reviewer-1" },
        { client: "test" },
      ),
    ).rejects.toThrow();

    // Only one file should exist under 00-inbox/reviewed
    const { readdirSync } = await import("node:fs");
    const reviewedDir = join(dir, "00-inbox", "reviewed");
    const files = readdirSync(reviewedDir);
    expect(files.filter((f) => f.includes("idempotency-test-note"))).toHaveLength(1);
  });

  // Test 7: filename collision → second approval of same-title proposal gets -2 suffix
  it("filename collision → second note with same title gets -2 suffix", async () => {
    const { createProposal, reviewProposal } = await getModules(dir);

    const p1 = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Collision Title",
        content: "First collision body.",
      },
      { client: "test" },
    );
    const p2 = await createProposal(
      {
        namespace: "personal",
        sensitivity: "private",
        title: "Collision Title",
        content: "Second collision body.",
      },
      { client: "test" },
    );

    const r1 = await reviewProposal(
      p1.proposal_id,
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );
    const r2 = await reviewProposal(
      p2.proposal_id,
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.document_path).not.toBe(r2!.document_path);
    expect(r2!.document_path).toMatch(/-2\.md$/);

    // Both files must exist
    expect(existsSync(join(dir, r1!.document_path!))).toBe(true);
    expect(existsSync(join(dir, r2!.document_path!))).toBe(true);
  });

  // Test 8: unknown proposal id → returns null (or throws clearly)
  it("unknown proposal id → returns null", async () => {
    const { reviewProposal } = await getModules(dir);

    const result = await reviewProposal(
      "non-existent-proposal-id",
      { action: "approve", reviewedBy: "reviewer-1" },
      { client: "test" },
    );

    expect(result).toBeNull();
  });
});
