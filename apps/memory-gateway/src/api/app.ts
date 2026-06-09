import Fastify, { type FastifyInstance } from "fastify";
import { SearchInput } from "@memories/shared";
import { search } from "../retrieval/search";
import { fetchDocument } from "../retrieval/fetch";
import { healthStatus } from "../health/index";
import { scanVault } from "../ingest/indexer";
import { computeIndexStatus } from "../status/index";
import { writeAudit } from "../audit/index";
import { loadConfig } from "../config/index";

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

  return app;
}
