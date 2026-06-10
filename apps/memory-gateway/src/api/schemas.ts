import { z } from "zod";

// ---------------------------------------------------------------------------
// Proposal create schemas
// ---------------------------------------------------------------------------

export const ProposeNoteBodySchema = z.object({
  type: z.literal("note").optional(),
  namespace: z.string().min(1),
  sensitivity: z.string().min(1),
  title: z.string().min(1),
  kind: z.string().optional(),
  content: z.string().min(1),
  source_refs: z.array(z.string()).optional(),
  confidence: z.string().optional(),
});

export const ProposePatchBodySchema = z.object({
  type: z.literal("patch"),
  target_document_id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  source_refs: z.array(z.string()).optional(),
  confidence: z.string().optional(),
});

export const ProposalCreateBodySchema = z.union([ProposePatchBodySchema, ProposeNoteBodySchema]);

export type ProposalCreateBody = z.infer<typeof ProposalCreateBodySchema>;

// ---------------------------------------------------------------------------
// Proposal review schema
// ---------------------------------------------------------------------------

export const ProposalReviewBodySchema = z.object({
  action: z.enum(["approve", "reject", "needs_more_evidence"]),
  reviewer_notes: z.string().optional(),
});

export type ProposalReviewBody = z.infer<typeof ProposalReviewBodySchema>;

// ---------------------------------------------------------------------------
// Context pack schema
// ---------------------------------------------------------------------------

export const ContextPackBodySchema = z.object({
  goal: z.string().min(1),
  namespaces: z.array(z.string()).optional(),
  sensitivity_allowed: z.array(z.string()).optional(),
  max_tokens: z.number().int().positive().optional(),
});

export type ContextPackBody = z.infer<typeof ContextPackBodySchema>;
