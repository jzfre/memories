import Fastify, { type FastifyInstance } from "fastify";
import { SearchInput } from "@memories/shared";
import { search } from "../retrieval/search";
import { fetchDocument } from "../retrieval/fetch";
import { healthStatus } from "../health/index";
import { scanVault } from "../ingest/indexer";
import { computeIndexStatus } from "../status/index";
import { writeAudit } from "../audit/index";
import { searchAudit } from "../audit/search";
import { loadConfig } from "../config/index";
import { createProposal, listProposals, reviewProposal } from "../proposals/index";
import {
  ProposalCreateBodySchema,
  ProposalReviewBodySchema,
  ContextPackBodySchema,
} from "./schemas";
import { buildContextPack } from "../retrieval/context-pack";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => healthStatus({ client: "rest" }));

  app.get("/status", async () => {
    const status = await computeIndexStatus();
    const { actor } = loadConfig();
    await writeAudit({
      actor,
      client: "rest",
      action: "index.status",
      namespace: "n/a",
      sensitivityRequested: null,
      inputs: {},
      returnedDocumentIds: [],
      approved: true,
    });
    return status;
  });

  app.post("/ingest/scan", async (req) => {
    const body = (req.body ?? {}) as { dry_run?: boolean };
    return scanVault({ dryRun: body.dry_run ?? false, client: "rest" });
  });

  app.post("/memory/search", async (req, reply) => {
    const parsed = SearchInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", details: parsed.error.flatten() });
    }
    return search(parsed.data, { client: "rest" });
  });

  app.get("/memory/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = await fetchDocument(id, { client: "rest" });
    if (!doc) return reply.code(404).send({ error: "not found" });
    return doc;
  });

  // ---------------------------------------------------------------------------
  // Proposals endpoints
  // ---------------------------------------------------------------------------

  app.post("/proposals", async (req, reply) => {
    const parsed = ProposalCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", details: parsed.error.flatten() });
    }

    const body = parsed.data;
    let input;
    if (body.type === "patch") {
      input = {
        proposal_type: "patch" as const,
        target_document_id: body.target_document_id,
        title: body.title,
        content: body.content,
        source_refs: body.source_refs,
        confidence: body.confidence,
      };
    } else {
      input = {
        namespace: (body as { namespace: string }).namespace,
        sensitivity: (body as { sensitivity: string }).sensitivity,
        title: body.title,
        kind: (body as { kind?: string }).kind,
        content: body.content,
        source_refs: body.source_refs,
        confidence: body.confidence,
      };
    }

    return createProposal(input, { client: "rest" });
  });

  app.get("/proposals", async (req) => {
    const query = (req.query ?? {}) as { state?: string; namespace?: string };
    return listProposals(
      { reviewState: query.state, namespace: query.namespace },
      { client: "rest" },
    );
  });

  app.post("/proposals/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposalReviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", details: parsed.error.flatten() });
    }

    const { action, reviewer_notes } = parsed.data;
    const { actor } = loadConfig();

    let result;
    try {
      result = await reviewProposal(
        id,
        { action, reviewerNotes: reviewer_notes, reviewedBy: actor },
        { client: "rest" },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: message });
    }

    if (!result) {
      return reply.code(404).send({ error: "proposal not found" });
    }
    return result;
  });

  // ---------------------------------------------------------------------------
  // Audit search endpoint — NOT itself audited (avoid recursion noise)
  // ---------------------------------------------------------------------------

  app.get("/audit", async (req) => {
    const query = (req.query ?? {}) as {
      action?: string;
      client?: string;
      approved?: string;
      limit?: string;
    };

    let approved: boolean | undefined;
    if (query.approved === "true") approved = true;
    else if (query.approved === "false") approved = false;

    const rawLimit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;

    return searchAudit({
      action: query.action,
      client: query.client,
      approved,
      limit,
    });
  });

  // ---------------------------------------------------------------------------
  // Context pack endpoint
  // ---------------------------------------------------------------------------

  app.post("/memory/context-pack", async (req, reply) => {
    const parsed = ContextPackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", details: parsed.error.flatten() });
    }
    return buildContextPack(parsed.data, { client: "rest" });
  });

  return app;
}
