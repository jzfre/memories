import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { prisma } from "../db/client";
import { loadConfig } from "../config/index";
import { writeAudit } from "../audit/index";
import { scanVault } from "../ingest/indexer";
import { documentIdFromPath } from "@memories/shared";
import type { Proposal } from "@prisma/client";

export type { Proposal };

export interface ProposeNoteInput {
  namespace: string;
  sensitivity: string;
  title: string;
  kind?: string;
  content: string;
  source_refs?: string[];
  confidence?: string;
}

export interface ProposePatchInput {
  proposal_type: "patch";
  target_document_id: string;
  title: string;
  content: string;
  source_refs?: string[];
  confidence?: string;
}

export type CreateProposalInput = ProposeNoteInput | ProposePatchInput;

export interface CreateProposalResult {
  proposal_id: string;
  review_state: string;
  message: string;
}

function isPatch(input: CreateProposalInput): input is ProposePatchInput {
  return (input as ProposePatchInput).proposal_type === "patch";
}

export async function createProposal(
  input: CreateProposalInput,
  ctx: { client: string },
): Promise<CreateProposalResult> {
  const config = loadConfig();
  const { policy, actor } = config;

  const isPatchProposal = isPatch(input);
  const action = isPatchProposal ? "memory.propose_patch" : "memory.propose_note";

  // Derive namespace/sensitivity for notes; for patches derive from target doc if found
  let namespace: string;
  let sensitivity: string;
  let title: string;
  let kind: string;
  let proposedContent: string;
  let targetDocumentId: string | undefined;
  let sourceRefs: string[];
  let confidence: string;

  if (isPatchProposal) {
    // For patches, we need to look up the target document
    const targetDoc = await prisma.document.findUnique({ where: { id: input.target_document_id } });
    if (!targetDoc) {
      // Reject: unknown target document — still store the row
      const id = randomUUID();
      await prisma.knowledgeEvent.create({
        data: {
          id: randomUUID(),
          eventType: "proposal.created",
          sourceType: "patch",
          namespace: "unknown",
          sensitivity: "unknown",
          payload: input as object,
          createdBy: actor,
        },
      });
      await prisma.proposal.create({
        data: {
          id,
          proposalType: "patch",
          namespace: "unknown",
          sensitivity: "unknown",
          title: input.title,
          kind: "note",
          proposedContent: input.content,
          targetDocumentId: input.target_document_id,
          sourceRefs: input.source_refs ?? [],
          confidence: input.confidence ?? "unknown",
          reviewState: "rejected",
          reviewerNotes: "Unknown target document",
          createdBy: actor,
        },
      });
      await writeAudit({
        actor,
        client: ctx.client,
        action,
        namespace: "unknown",
        sensitivityRequested: "unknown",
        inputs: input,
        returnedDocumentIds: [],
        approved: false,
      });
      return {
        proposal_id: id,
        review_state: "rejected",
        message: "Unknown target document",
      };
    }
    namespace = targetDoc.namespace;
    sensitivity = targetDoc.sensitivity;
    title = input.title;
    kind = targetDoc.kind;
    proposedContent = input.content;
    targetDocumentId = input.target_document_id;
    sourceRefs = input.source_refs ?? [];
    confidence = input.confidence ?? "unknown";
  } else {
    namespace = input.namespace;
    sensitivity = input.sensitivity;
    title = input.title;
    kind = input.kind ?? "note";
    proposedContent = input.content;
    targetDocumentId = undefined;
    sourceRefs = input.source_refs ?? [];
    confidence = input.confidence ?? "unknown";
  }

  // Validate namespace and sensitivity against allowlists
  const namespaceAllowed = policy.allowed_namespaces.includes(namespace);
  const sensitivityAllowed = policy.allowed_sensitivity.includes(sensitivity);

  const rejectionReasons: string[] = [];
  if (!namespaceAllowed) rejectionReasons.push(`Namespace "${namespace}" is not in the allowed list`);
  if (!sensitivityAllowed) rejectionReasons.push(`Sensitivity "${sensitivity}" is not in the allowed list`);

  const isRejected = rejectionReasons.length > 0;
  const reviewState = isRejected ? "rejected" : "pending_review";
  const reviewerNotes = isRejected ? rejectionReasons.join("; ") : undefined;

  const id = randomUUID();

  // Always insert knowledge_event and proposal row (retained even if rejected)
  await prisma.knowledgeEvent.create({
    data: {
      id: randomUUID(),
      eventType: "proposal.created",
      sourceType: isPatchProposal ? "patch" : "note",
      namespace,
      sensitivity,
      payload: input as object,
      createdBy: actor,
    },
  });

  await prisma.proposal.create({
    data: {
      id,
      proposalType: isPatchProposal ? "patch" : "note",
      namespace,
      sensitivity,
      title,
      kind,
      proposedContent,
      targetDocumentId: targetDocumentId ?? null,
      sourceRefs,
      confidence,
      reviewState,
      reviewerNotes: reviewerNotes ?? null,
      createdBy: actor,
    },
  });

  await writeAudit({
    actor,
    client: ctx.client,
    action,
    namespace,
    sensitivityRequested: sensitivity,
    inputs: input,
    returnedDocumentIds: [id],
    approved: !isRejected,
  });

  const message = isRejected
    ? rejectionReasons.join("; ")
    : "Proposal created. Not written to canonical vault yet.";

  return { proposal_id: id, review_state: reviewState, message };
}

export async function listProposals(
  filter: { reviewState?: string; namespace?: string },
  ctx: { client: string },
): Promise<Proposal[]> {
  const config = loadConfig();
  const { actor } = config;

  const where: { reviewState?: string; namespace?: string } = {};
  if (filter.reviewState) where.reviewState = filter.reviewState;
  if (filter.namespace) where.namespace = filter.namespace;

  const proposals = await prisma.proposal.findMany({ where });

  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.list_proposals",
    namespace: filter.namespace ?? "*",
    inputs: filter,
    returnedDocumentIds: proposals.map((p) => p.id),
    approved: true,
  });

  return proposals;
}

export async function getProposal(id: string): Promise<Proposal | null> {
  return prisma.proposal.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function frontmatterDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildNoteFrontmatter(p: Proposal): string {
  const lines = [
    "---",
    `kind: ${p.kind}`,
    `namespace: ${p.namespace}`,
    `sensitivity: ${p.sensitivity}`,
    `status: active`,
    `confidence: ${p.confidence}`,
    `source_type: proposal`,
    `tags: []`,
    "---",
  ];
  return lines.join("\n");
}

/**
 * Find the end of the frontmatter block (the position of the character after the
 * closing "---\n") and return the character offset.  Returns null if the file
 * has no leading frontmatter block.
 */
function frontmatterEndOffset(content: string): number | null {
  if (!content.startsWith("---")) return null;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return null;
  // Search for the second "---" line
  const rest = content.slice(firstNewline + 1);
  const match = rest.match(/^---[ \t]*$/m);
  if (!match || match.index === undefined) return null;
  const closingStart = firstNewline + 1 + match.index;
  // Skip past "---\n"
  const closingEnd = closingStart + 3; // "---"
  // Consume optional trailing newline(s)
  let off = closingEnd;
  if (content[off] === "\r") off++;
  if (content[off] === "\n") off++;
  return off;
}

// ---------------------------------------------------------------------------
// reviewProposal
// ---------------------------------------------------------------------------

export interface ReviewDecision {
  action: "approve" | "reject" | "needs_more_evidence";
  reviewerNotes?: string;
  reviewedBy: string;
}

export interface ReviewResult {
  proposal_id: string;
  review_state: string;
  document_path?: string;
}

export async function reviewProposal(
  id: string,
  decision: ReviewDecision,
  ctx: { client: string },
): Promise<ReviewResult | null> {
  const config = loadConfig();
  const { actor } = config;

  const proposal = await prisma.proposal.findUnique({ where: { id } });
  if (!proposal) return null;

  const allowedInitialStates = ["pending_review", "needs_more_evidence"];
  if (!allowedInitialStates.includes(proposal.reviewState)) {
    throw new Error(
      `Proposal ${id} is already in state "${proposal.reviewState}" and cannot be reviewed again.`,
    );
  }

  const { action, reviewerNotes, reviewedBy } = decision;
  const reviewedAt = new Date();

  // --- reject / needs_more_evidence ---
  if (action === "reject" || action === "needs_more_evidence") {
    const newState = action === "reject" ? "rejected" : "needs_more_evidence";
    await prisma.proposal.update({
      where: { id },
      data: {
        reviewState: newState,
        reviewerNotes: reviewerNotes ?? null,
        reviewedBy,
        reviewedAt,
      },
    });
    await writeAudit({
      actor,
      client: ctx.client,
      action: "proposal.review",
      namespace: proposal.namespace,
      sensitivityRequested: proposal.sensitivity,
      inputs: { proposalId: id, action },
      returnedDocumentIds: [],
      approved: false,
    });
    return { proposal_id: id, review_state: newState };
  }

  // --- approve ---
  if (proposal.proposalType === "patch") {
    return approvePatched(proposal, { actor, reviewedBy, reviewerNotes, reviewedAt, ctx });
  }
  return approveNote(proposal, { actor, reviewedBy, reviewerNotes, reviewedAt, ctx });
}

async function approveNote(
  proposal: Proposal,
  opts: { actor: string; reviewedBy: string; reviewerNotes?: string; reviewedAt: Date; ctx: { client: string } },
): Promise<ReviewResult> {
  const config = loadConfig();
  const vaultRoot = config.vault.root;

  // Build filename
  const dateStr = frontmatterDate(proposal.createdAt);
  const slug = slugify(proposal.title);
  const baseName = `${dateStr}-${slug}`;
  const reviewedDir = join(vaultRoot, "00-inbox", "reviewed");
  mkdirSync(reviewedDir, { recursive: true });

  // Collision-safe filename
  let fileName = `${baseName}.md`;
  let suffix = 2;
  while (existsSync(join(reviewedDir, fileName))) {
    fileName = `${baseName}-${suffix}.md`;
    suffix++;
  }

  const filePath = join(reviewedDir, fileName);
  const relPath = `00-inbox/reviewed/${fileName}`;

  // Build markdown
  const fm = buildNoteFrontmatter(proposal);
  const md = `${fm}\n\n# ${proposal.title}\n\n${proposal.proposedContent}\n`;
  writeFileSync(filePath, md, "utf8");

  // Re-index vault
  await scanVault({}, {});

  // Derive the document id
  const docId = documentIdFromPath(relPath);

  // Update proposal
  await prisma.proposal.update({
    where: { id: proposal.id },
    data: {
      reviewState: "merged",
      reviewerNotes: opts.reviewerNotes ?? null,
      reviewedBy: opts.reviewedBy,
      reviewedAt: opts.reviewedAt,
    },
  });

  await writeAudit({
    actor: opts.actor,
    client: opts.ctx.client,
    action: "proposal.review",
    namespace: proposal.namespace,
    sensitivityRequested: proposal.sensitivity,
    inputs: { proposalId: proposal.id, action: "approve" },
    returnedDocumentIds: [docId],
    approved: true,
  });

  return { proposal_id: proposal.id, review_state: "merged", document_path: relPath };
}

async function approvePatched(
  proposal: Proposal,
  opts: { actor: string; reviewedBy: string; reviewerNotes?: string; reviewedAt: Date; ctx: { client: string } },
): Promise<ReviewResult> {
  const config = loadConfig();
  const vaultRoot = config.vault.root;

  if (!proposal.targetDocumentId) {
    throw new Error(`Patch proposal ${proposal.id} has no targetDocumentId.`);
  }

  const doc = await prisma.document.findUnique({ where: { id: proposal.targetDocumentId } });
  if (!doc) {
    throw new Error(`Target document ${proposal.targetDocumentId} not found in index.`);
  }

  const filePath = join(vaultRoot, doc.path);
  const originalContent = readFileSync(filePath, "utf8");

  // Replace body after frontmatter, or whole content if no frontmatter
  const fmEnd = frontmatterEndOffset(originalContent);
  let newContent: string;
  if (fmEnd !== null) {
    const fmBlock = originalContent.slice(0, fmEnd);
    newContent = `${fmBlock}\n${proposal.proposedContent}\n`;
  } else {
    newContent = `${proposal.proposedContent}\n`;
  }

  writeFileSync(filePath, newContent, "utf8");

  // Re-index vault
  await scanVault({}, {});

  // Update proposal
  await prisma.proposal.update({
    where: { id: proposal.id },
    data: {
      reviewState: "merged",
      reviewerNotes: opts.reviewerNotes ?? null,
      reviewedBy: opts.reviewedBy,
      reviewedAt: opts.reviewedAt,
    },
  });

  await writeAudit({
    actor: opts.actor,
    client: opts.ctx.client,
    action: "proposal.review",
    namespace: proposal.namespace,
    sensitivityRequested: proposal.sensitivity,
    inputs: { proposalId: proposal.id, action: "approve" },
    returnedDocumentIds: [proposal.targetDocumentId],
    approved: true,
  });

  return { proposal_id: proposal.id, review_state: "merged" };
}
