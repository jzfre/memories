import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { loadConfig } from "../config/index";
import { writeAudit } from "../audit/index";
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
