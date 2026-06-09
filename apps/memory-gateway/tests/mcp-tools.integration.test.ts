/**
 * Integration tests for every MCP tool, driven by a real @modelcontextprotocol/sdk
 * Client talking to the real McpServer over an in-memory transport. No LLM is
 * involved: this exercises the full protocol -> handler -> core -> policy -> DB ->
 * audit path deterministically. (The actual stdio process boundary is covered
 * separately in mcp-stdio.integration.test.ts.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma, resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

// Fixture ids under the test config (allowed ns: personal, work/client-a;
// allowed sens: public, internal, private, client-confidential).
const IN_SCOPE_DECISION = "personal.decision-canonical"; // personal/private, "pgvector" in body
const IN_SCOPE_CLIENT_A = "client-a.finding"; // work/client-a / client-confidential
const IN_SCOPE_EMPTY = "empty"; // personal/private, 0 chunks
const OUT_NS_CLIENT_B = "client-b.finding"; // work/client-b -> blocked by namespace
const OUT_SENS_SECRET = "personal.secret-note"; // secret-adjacent -> blocked by sensitivity

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return client.callTool({ name, arguments: args });
}
function asJson(res: any): any {
  return JSON.parse(res.content[0].text);
}
async function clearSideEffects(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_log","retrieval_traces" RESTART IDENTITY');
}

beforeAll(async () => {
  await resetDb();
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { buildMcpServer } = await import("../src/mcp/build");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);
  client = new Client({ name: "itest", version: "0.0.0" });
  await client.connect(clientTransport);
});

// Keep the seeded corpus; only reset the side-effect tables so per-call audit/
// trace assertions start from a clean slate.
beforeEach(clearSideEffects);
afterAll(async () => {
  await client.close();
});

describe("MCP server / tool registry", () => {
  it("exposes exactly the three tools, each with a description and input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["health_status", "memory_fetch", "memory_search"]);
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
  });
});

describe("memory_search (MCP)", () => {
  it("returns scoped results with full result shape, a trace_id, and a safety note", async () => {
    const res = await call("memory_search", { query: "pgvector" });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.trace_id).toBeTruthy();
    expect(payload.safety_note).toBeTruthy();
    for (const r of payload.results) {
      expect(typeof r.document_id).toBe("string");
      expect(typeof r.chunk_id).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(r.source).toMatchObject({ path: expect.any(String), kind: expect.any(String), status: expect.any(String) });
    }
  });

  it("writes exactly one audit row (approved) and one retrieval trace per search", async () => {
    await call("memory_search", { query: "pgvector" });
    const audits = await prisma.auditLog.findMany({ where: { action: "memory.search" } });
    const traces = await prisma.retrievalTrace.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].client).toBe("mcp");
    expect(audits[0].approved).toBe(true);
    expect(traces).toHaveLength(1);
  });

  it("matches a document by words found only in its title/heading (regression for LM Studio)", async () => {
    const payload = asJson(await call("memory_search", { query: "obsidian canonical decision" }));
    expect(payload.results.map((r: any) => r.document_id)).toContain(IN_SCOPE_DECISION);
  });

  it("falls back from AND to OR when not every term matches", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector zqxbogusterm" }));
    expect(payload.results.length).toBeGreaterThan(0);
  });

  it("highlights matched terms in the snippet", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector" }));
    expect(payload.results.some((r: any) => r.snippet.includes("**pgvector**"))).toBe(true);
  });

  it("honours top_k", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector", top_k: 1 }));
    expect(payload.results).toHaveLength(1);
  });

  it("never returns out-of-allowlist namespaces or sensitivities, but does return in-scope ones", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector" }));
    const ids = payload.results.map((r: any) => r.document_id);
    expect(ids).toContain(IN_SCOPE_DECISION);
    expect(ids).toContain(IN_SCOPE_CLIENT_A);
    // Scope must hold on the leakable BYTES, not just the id: scan every result's
    // id, path, title and snippet, plus the whole serialized payload.
    const blob = JSON.stringify(payload).toLowerCase();
    expect(blob).not.toContain("client-b");
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("must never leak");
    for (const r of payload.results) {
      expect(r.source.path).not.toContain("client-b");
      expect(r.source.path).not.toContain("secret");
    }
  });

  it("source.confidence carries the stored document confidence (a string, never hard-coded null)", async () => {
    const r = asJson(await call("memory_search", { query: "obsidian canonical decision" })).results.find(
      (x: any) => x.document_id === IN_SCOPE_DECISION,
    );
    expect(typeof r.source.confidence).toBe("string");
    expect(r.source.confidence).toBe("unknown"); // fixture has no confidence -> parser default
  });

  it("structurally proves the NAMESPACE filter: a term unique to the out-of-scope client-b note returns nothing", async () => {
    // 'leak' appears only in client-b.finding's body. If the namespace filter were
    // ever dropped, this would surface that note. It must stay empty.
    const payload = asJson(await call("memory_search", { query: "leak" }));
    expect(payload.results).toEqual([]);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("must never leak");
  });

  it("structurally proves the SENSITIVITY filter: a term unique to the secret-adjacent note returns nothing", async () => {
    // 'filtered' appears only in personal.secret-note (allowed namespace, disallowed
    // sensitivity). Its namespace is in scope, so only the sensitivity filter keeps it out.
    const payload = asJson(await call("memory_search", { query: "filtered" }));
    expect(payload.results).toEqual([]);
  });

  it("narrows on the SENSITIVITY axis: requesting private+secret drops client-confidential (client-a) and secret", async () => {
    const ids = asJson(
      await call("memory_search", { query: "pgvector", sensitivity_allowed: ["private", "secret-adjacent"] }),
    ).results.map((r: any) => r.document_id);
    expect(ids).toContain(IN_SCOPE_DECISION); // private -> kept
    expect(ids.some((id: string) => id.includes("client-a"))).toBe(false); // client-confidential -> dropped
    expect(ids.some((id: string) => id.includes("secret"))).toBe(false); // secret-adjacent -> not allowed
  });

  it("treats an empty namespaces[] / sensitivity_allowed[] as 'use the full allowlist', not a denial", async () => {
    const a = asJson(await call("memory_search", { query: "pgvector", namespaces: [] }));
    const b = asJson(await call("memory_search", { query: "pgvector", sensitivity_allowed: [] }));
    expect(a.results.length).toBeGreaterThan(0);
    expect(b.results.length).toBeGreaterThan(0);
  });

  it("dedups documents in audit/trace: a multi-chunk match returns N chunks but one document id", async () => {
    const payload = asJson(await call("memory_search", { query: "multichunktoken" }));
    expect(payload.results.length).toBe(2); // two chunks
    expect(new Set(payload.results.map((r: any) => r.document_id)).size).toBe(1);
    const trace = await prisma.retrievalTrace.findFirstOrThrow();
    expect(trace.selectedChunkIds).toHaveLength(2);
    expect(trace.selectedDocumentIds).toHaveLength(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "memory.search" } });
    expect(audit.returnedDocumentIds).toHaveLength(1);
  });

  it("does not throw on tsquery special characters (input is sanitized, not injected)", async () => {
    const res = await call("memory_search", { query: "pgvector & ! | ( ) : *" });
    expect(res.isError).toBeFalsy();
    expect(Array.isArray(asJson(res).results)).toBe(true);
  });

  it("narrows (never widens) when given an explicit namespace subset", async () => {
    const ids = asJson(await call("memory_search", { query: "pgvector", namespaces: ["personal"] })).results.map(
      (r: any) => r.document_id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id: string) => id.includes("client-a"))).toBe(false);
  });

  it("drops a disallowed namespace from a mixed request (allowed survives, disallowed excluded)", async () => {
    const ids = asJson(
      await call("memory_search", { query: "pgvector", namespaces: ["personal", "work/client-b"] }),
    ).results.map((r: any) => r.document_id);
    expect(ids).toContain(IN_SCOPE_DECISION);
    expect(ids.some((id: string) => id.includes("client-b"))).toBe(false);
  });

  it("returns empty and audits a denial (recording the RAW requested namespace) when only disallowed namespaces are requested", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector", namespaces: ["work/client-b"] }));
    expect(payload.results).toEqual([]);
    const denied = await prisma.auditLog.findFirstOrThrow({ where: { action: "memory.search", approved: false } });
    expect(denied.namespace).toBe("work/client-b"); // raw requested value is logged, not the (empty) intersection
    // The denial short-circuits before any corpus query, yet still writes a trace.
    expect(await prisma.retrievalTrace.count()).toBe(1);
  });

  it("returns empty when only a disallowed sensitivity is requested (fail closed)", async () => {
    const payload = asJson(await call("memory_search", { query: "pgvector", sensitivity_allowed: ["secret-adjacent"] }));
    expect(payload.results).toEqual([]);
    const denied = await prisma.auditLog.findFirst({ where: { action: "memory.search", approved: false } });
    expect(denied).not.toBeNull();
  });

  it("returns empty results but still approves+traces a query that simply has no matches", async () => {
    const payload = asJson(await call("memory_search", { query: "zzzznomatchword" }));
    expect(payload.results).toEqual([]);
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.search" } });
    expect(audit?.approved).toBe(true);
    expect(await prisma.retrievalTrace.count()).toBe(1);
  });

  it("never surfaces the out-of-scope canary text, even when searching for its term", async () => {
    const payload = asJson(await call("memory_search", { query: "leak" }));
    expect(payload.results.some((r: any) => r.document_id.includes("client-b"))).toBe(false);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("must never leak");
  });
});

describe("memory_fetch (MCP)", () => {
  it("fetches an in-scope document with body, frontmatter, and a safety note; isError is false", async () => {
    const res = await call("memory_fetch", { document_id: IN_SCOPE_DECISION });
    expect(res.isError).toBeFalsy();
    const doc = asJson(res);
    expect(doc.document_id).toBe(IN_SCOPE_DECISION);
    expect(doc.namespace).toBe("personal");
    expect(doc.body).toContain("pgvector");
    expect(doc.safety_note).toBeTruthy();
  });

  it("audits an approved fetch with the returned document id", async () => {
    await call("memory_fetch", { document_id: IN_SCOPE_DECISION });
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.fetch" } });
    expect(audit?.approved).toBe(true);
    expect(audit?.client).toBe("mcp");
    expect(audit?.returnedDocumentIds).toEqual([IN_SCOPE_DECISION]);
  });

  it("returns not-found + isError for a document blocked by namespace, and audits the denial", async () => {
    const res = await call("memory_fetch", { document_id: OUT_NS_CLIENT_B });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("not found");
    const denied = await prisma.auditLog.findFirst({ where: { action: "memory.fetch", approved: false } });
    expect(denied).not.toBeNull();
  });

  it("returns not-found for a document blocked by sensitivity", async () => {
    const res = await call("memory_fetch", { document_id: OUT_SENS_SECRET });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("not found");
  });

  it("returns not-found for a nonexistent id", async () => {
    const res = await call("memory_fetch", { document_id: "no.such.document" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("not found");
  });

  it("is non-distinguishable: out-of-scope and nonexistent return identical responses (no oracle)", async () => {
    const blocked = await call("memory_fetch", { document_id: OUT_NS_CLIENT_B });
    const missing = await call("memory_fetch", { document_id: "no.such.document" });
    expect(blocked.content[0].text).toBe(missing.content[0].text);
    expect(blocked.isError).toBe(missing.isError);
  });

  it("the denial payload contains zero bytes of the blocked document's content/title/path", async () => {
    const res = await call("memory_fetch", { document_id: OUT_NS_CLIENT_B });
    const blob = JSON.stringify(res).toLowerCase();
    expect(blob).not.toContain("must never leak"); // client-b body canary
    expect(blob).not.toContain("client b finding"); // client-b title
    expect(blob).not.toContain("client-b/finding"); // client-b path
    expect(blob).not.toContain("pgvector"); // any body content
  });

  it("ignores caller-supplied scope args: extra namespaces cannot widen fetch authorization", async () => {
    // fetch's schema is {document_id} only and it calls resolveScope({}) internally,
    // so smuggling namespaces:["work/client-b"] must not unlock the out-of-scope doc.
    const res = await call("memory_fetch", { document_id: OUT_NS_CLIENT_B, namespaces: ["work/client-b"] });
    expect(JSON.stringify(res).toLowerCase()).not.toContain("must never leak");
  });

  it("fetches an in-scope but empty document (no chunks) with an empty body", async () => {
    const res = await call("memory_fetch", { document_id: IN_SCOPE_EMPTY });
    expect(res.isError).toBeFalsy();
    expect(asJson(res).body).toBe("");
  });
});

describe("health_status (MCP)", () => {
  it("reports ok with db connectivity and corpus counts, and audits the call", async () => {
    const h = asJson(await call("health_status", {}));
    expect(h.status).toBe("ok");
    expect(h.db).toBe("ok");
    expect(h.documents).toBe(await prisma.document.count()); // reflects the seeded fixture corpus
    expect(h.documents).toBeGreaterThan(0);
    expect(h.chunks).toBeGreaterThan(0);
    expect(h.last_indexed_at).toBeTruthy();
    const audit = await prisma.auditLog.findFirst({ where: { action: "health.status" } });
    expect(audit?.client).toBe("mcp");
  });
});

// Archived documents need a mutated corpus, so this block re-seeds and archives an
// in-scope note in its own beforeEach (runs last; isolated from the shared corpus).
describe("archived documents (MCP)", () => {
  beforeEach(async () => {
    await resetDb();
    const { scanVault } = await import("../src/ingest/indexer");
    await scanVault();
    await prisma.document.update({ where: { id: "welcome" }, data: { status: "archived" } });
  });

  it("memory_fetch returns not-found for an archived (but in-scope) document", async () => {
    const res = await call("memory_fetch", { document_id: "welcome" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("not found");
  });

  it("archived not-found is byte-identical to a nonexistent fetch (no oracle, incl. archived)", async () => {
    const archived = await call("memory_fetch", { document_id: "welcome" });
    const missing = await call("memory_fetch", { document_id: "no.such.document" });
    expect(archived.content[0].text).toBe(missing.content[0].text);
    expect(archived.isError).toBe(missing.isError);
  });

  it("memory_search excludes archived documents", async () => {
    const ids = asJson(await call("memory_search", { query: "pgvector" })).results.map((r: any) => r.document_id);
    expect(ids).not.toContain("welcome");
    expect(ids).toContain(IN_SCOPE_DECISION); // a non-archived in-scope doc still returns
  });
});
