import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { resetDb } from "./helpers/db";
import {
  lmStudioReachable,
  runToolConversation,
  type ToolDef,
  type ToolHandler,
  type ToolInvocation,
  LMSTUDIO_MODEL,
} from "./helpers/lmstudio";

const VAULT = resolve(__dirname, "fixtures/vault");
const SYSTEM =
  "You are a helpful assistant with access to the user's personal memory. " +
  "Whenever the user asks about their notes, decisions, or memory, you MUST call " +
  "the memory_search tool to look it up before answering. Answer only from tool results.";

// LM Studio is an external dependency; skip the whole suite when it is not running
// so the rest of the test suite (and CI) stays green without it.
const reachable = await lmStudioReachable();

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search the user's canonical memory by keyword. Returns scoped results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords to search for" },
          namespaces: { type: "array", items: { type: "string" } },
          sensitivity_allowed: { type: "array", items: { type: "string" } },
          top_k: { type: "integer" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_fetch",
      description: "Fetch one memory document by its id.",
      parameters: {
        type: "object",
        properties: { document_id: { type: "string" } },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health_status",
      description: "Report gateway/index health.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** Collect every document_id returned across all memory_search invocations. */
function returnedIds(invocations: ToolInvocation[]): string[] {
  const ids: string[] = [];
  for (const inv of invocations) {
    if (inv.name !== "memory_search") continue;
    const results = (inv.result as { results?: { document_id: string }[] }).results ?? [];
    for (const r of results) ids.push(r.document_id);
  }
  return ids;
}

describe.skipIf(!reachable)(`LM Studio integration (${LMSTUDIO_MODEL})`, () => {
  let handlers: Record<string, ToolHandler>;

  beforeAll(async () => {
    await resetDb();
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { scanVault } = await import("../src/ingest/indexer");
    await scanVault();
    const { search } = await import("../src/retrieval/search");
    const { fetchDocument } = await import("../src/retrieval/fetch");
    const { healthStatus } = await import("../src/health/index");
    handlers = {
      memory_search: (a) =>
        search(
          { query: a.query, namespaces: a.namespaces, sensitivity_allowed: a.sensitivity_allowed, top_k: a.top_k },
          { client: "lmstudio-test" },
        ),
      memory_fetch: (a) => fetchDocument(a.document_id, { client: "lmstudio-test" }),
      health_status: () => healthStatus({ client: "lmstudio-test" }),
    };
  });

  it("finds the obsidian canonical decision (the original failing query)", async () => {
    const convo = await runToolConversation({
      system: SYSTEM,
      user: 'Search my memory for the obsidian canonical decision.',
      tools: TOOLS,
      handlers,
    });

    // The model actually called the tool...
    const searched = convo.invocations.some((i) => i.name === "memory_search");
    expect(searched).toBe(true);
    // ...and retrieval returned the decision note (this is what failed before).
    const ids = returnedIds(convo.invocations);
    expect(ids.some((id) => id.includes("decision-canonical"))).toBe(true);
    // ...and the model did not claim it found nothing.
    expect(convo.finalText.toLowerCase()).not.toMatch(/(didn't|did not|couldn't|could not|no (matching|results|notes))/);
  });

  it("never leaks out-of-scope namespaces or sensitivities to the model", async () => {
    const convo = await runToolConversation({
      system: SYSTEM,
      user: "Search my memory for everything mentioning pgvector and summarize what you find.",
      tools: TOOLS,
      handlers,
    });

    const ids = returnedIds(convo.invocations);
    expect(ids.length).toBeGreaterThan(0); // in-scope pgvector docs exist
    expect(ids.some((id) => id.includes("client-b"))).toBe(false); // out-of-scope namespace
    expect(ids.some((id) => id.includes("secret"))).toBe(false); // out-of-scope sensitivity
    // The out-of-scope canary text must never reach the model's answer.
    expect(convo.finalText.toLowerCase()).not.toContain("must never leak");
  });
});
