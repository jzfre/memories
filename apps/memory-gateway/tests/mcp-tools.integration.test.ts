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
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log","retrieval_traces","proposals","knowledge_events" RESTART IDENTITY',
  );
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
  it("exposes exactly the ten tools, each with a description and input schema, incl. memory_review_proposal", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "health_status",
      "memory_context_pack",
      "memory_explain_sources",
      "memory_fetch",
      "memory_list_proposals",
      "memory_propose_note",
      "memory_propose_patch",
      "memory_recent",
      "memory_review_proposal",
      "memory_search",
    ]);
    // memory_review_proposal IS present (approval is code-gated, not CLI/REST-only)
    expect(names).toContain("memory_review_proposal");
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

describe("memory_propose_note (MCP)", () => {
  it("creates a pending proposal row and NO vault file; review_state is pending_review", async () => {
    const res = await call("memory_propose_note", {
      namespace: "personal",
      sensitivity: "private",
      title: "MCP Test Proposal",
      content: "Some test content from the MCP client that is well detailed and specific.",
      source_refs: ["ref-mcp-1"],
    });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.review_state).toBe("pending_review");
    expect(typeof payload.proposal_id).toBe("string");
    expect(payload.message).toContain("Proposal created. Not written to canonical vault yet.");
    expect(payload.message).toContain(`pnpm proposals review ${payload.proposal_id} --approve`);

    // DB row exists with correct state
    const row = await prisma.proposal.findUnique({ where: { id: payload.proposal_id } });
    expect(row).not.toBeNull();
    expect(row?.reviewState).toBe("pending_review");
    expect(row?.title).toBe("MCP Test Proposal");
    expect(row?.createdBy).toBe("test");

    // Fixture vault is unchanged — no new file was written under it
    const { readdirSync } = await import("node:fs");
    const vaultFiles = readdirSync(VAULT, { recursive: true });
    expect(vaultFiles.some((f) => String(f).includes("mcp-test-proposal"))).toBe(false);
  });

  it("records a knowledge_event and an approved audit row for an accepted proposal", async () => {
    await call("memory_propose_note", {
      namespace: "personal",
      sensitivity: "private",
      title: "Audit Trail Test",
      content: "Checking the audit trail.",
    });
    const events = await prisma.knowledgeEvent.findMany({ where: { eventType: "proposal.created" } });
    expect(events).toHaveLength(1);
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.propose_note" } });
    expect(audit?.client).toBe("mcp");
    expect(audit?.approved).toBe(true);
  });

  it("rejects a proposal with a disallowed namespace (state=rejected, row retained, no vault file)", async () => {
    const res = await call("memory_propose_note", {
      namespace: "work/client-b",
      sensitivity: "client-confidential",
      title: "Disallowed Namespace Proposal",
      content: "Should be rejected.",
    });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.review_state).toBe("rejected");
    // Row is still retained in DB
    const row = await prisma.proposal.findUnique({ where: { id: payload.proposal_id } });
    expect(row?.reviewState).toBe("rejected");
  });
});

describe("memory_list_proposals (MCP)", () => {
  it("returns proposals created via memory_propose_note and supports reviewState filter", async () => {
    // Create two proposals
    const r1 = asJson(
      await call("memory_propose_note", {
        namespace: "personal",
        sensitivity: "private",
        title: "List Test A",
        content: "Content A with enough detail and source reference to reach pending_review state.",
        source_refs: ["ref-list-1"],
      }),
    );
    const r2 = asJson(
      await call("memory_propose_note", {
        namespace: "work/client-b", // disallowed → rejected
        sensitivity: "private",
        title: "List Test B",
        content: "Content B",
      }),
    );

    // List all proposals (no filter)
    const all = asJson(await call("memory_list_proposals", {}));
    expect(Array.isArray(all)).toBe(true);
    const ids = all.map((p: any) => p.id);
    expect(ids).toContain(r1.proposal_id);
    expect(ids).toContain(r2.proposal_id);

    // Filter by reviewState=pending_review
    const pending = asJson(await call("memory_list_proposals", { reviewState: "pending_review" }));
    expect(pending.map((p: any) => p.id)).toContain(r1.proposal_id);
    expect(pending.map((p: any) => p.id)).not.toContain(r2.proposal_id);

    // Filter by reviewState=rejected
    const rejected = asJson(await call("memory_list_proposals", { reviewState: "rejected" }));
    expect(rejected.map((p: any) => p.id)).toContain(r2.proposal_id);
  });
});

// ---------------------------------------------------------------------------
// memory_review_proposal (MCP) — approval code gate
// ---------------------------------------------------------------------------

describe("memory_review_proposal (MCP) — approval gate", () => {
  let proposalId: string;

  beforeEach(async () => {
    // Create a fresh pending proposal for each test
    const res = asJson(
      await call("memory_propose_note", {
        namespace: "personal",
        sensitivity: "private",
        title: "Review Gate Test",
        content: "Unique content for review gate test with sufficient detail.",
        source_refs: ["ref-gate-1"],
      }),
    );
    proposalId = res.proposal_id;
  });

  it("approve WITHOUT approval_code → isError true, proposal still pending_review", async () => {
    const res = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "approve",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("out-of-band approval code");
    // Proposal must remain pending
    const row = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(row?.reviewState).toBe("pending_review");
  });

  it("approve WITH WRONG approval_code → isError true, proposal still pending_review", async () => {
    const res = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "approve",
      approval_code: "zzzzz", // wrong
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("out-of-band approval code");
    const row = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(row?.reviewState).toBe("pending_review");
  });

  it("approve WITH CORRECT approval_code → state merged, document written", async () => {
    // Read the approval code directly from DB (simulating the human reading it from the terminal)
    const dbRow = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(dbRow.approvalCode).toBeTruthy();

    const res = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "approve",
      approval_code: dbRow.approvalCode!,
    });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.review_state).toBe("merged");
    expect(payload.document_path).toBeTruthy();

    const after = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(after?.reviewState).toBe("merged");
  });

  it("reject WITHOUT approval_code → state rejected (reversible, no code needed)", async () => {
    const res = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "reject",
    });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.review_state).toBe("rejected");
    const row = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(row?.reviewState).toBe("rejected");
  });

  it("needs_more_evidence WITHOUT approval_code → state needs_more_evidence (no code needed)", async () => {
    const res = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "needs_more_evidence",
    });
    expect(res.isError).toBeFalsy();
    const payload = asJson(res);
    expect(payload.review_state).toBe("needs_more_evidence");
  });

  it("locks MCP approval after 5 wrong codes — even the correct code is then refused; CLI remains the escape hatch", async () => {
    // Brute-force defense: a model looping guesses cannot eventually hit the code.
    for (let i = 0; i < 5; i++) {
      const r = await call("memory_review_proposal", {
        proposal_id: proposalId,
        action: "approve",
        approval_code: "wrongguess", // 10 chars, real (length-matching) guess
      });
      expect(r.isError).toBe(true);
    }
    // Now the CORRECT code is refused over MCP — the gate is locked.
    const dbRow = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
    const locked = await call("memory_review_proposal", {
      proposal_id: proposalId,
      action: "approve",
      approval_code: dbRow.approvalCode!,
    });
    expect(locked.isError).toBe(true);
    expect(locked.content[0].text.toLowerCase()).toContain("too many");
    const stillPending = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(stillPending?.reviewState).toBe("pending_review");

    // Escape hatch: the human approves via the authenticated core path (CLI/REST), no code.
    const { reviewProposal } = await import("../src/proposals/index");
    const result = await reviewProposal(proposalId, { action: "approve", reviewedBy: "human" }, { client: "cli" });
    expect(result?.review_state).toBe("merged");
  });
});

// ---------------------------------------------------------------------------
// Approval-code leak prevention
// ---------------------------------------------------------------------------

describe("approval_code leak prevention (MCP)", () => {
  it("memory_list_proposals response JSON does NOT contain the approval_code value", async () => {
    // Create a proposal so there is at least one row with an approval code
    const createRes = asJson(
      await call("memory_propose_note", {
        namespace: "personal",
        sensitivity: "private",
        title: "Leak Test Proposal",
        content: "Leak test content with enough detail and specificity.",
        source_refs: ["ref-leak-1"],
      }),
    );
    const proposalId = createRes.proposal_id;

    // Read the actual code from DB
    const dbRow = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
    const code = dbRow.approvalCode!;
    expect(code).toBeTruthy();

    // Call the MCP list tool
    const listRes = await call("memory_list_proposals", {});
    const rawJson = listRes.content[0].text;

    // The approval code must NOT appear anywhere in the MCP response
    expect(rawJson).not.toContain(code);
    // Also confirm the field name is absent
    expect(rawJson).not.toContain("approvalCode");
    expect(rawJson).not.toContain("approval_code");
  });

  it("memory_propose_note response does NOT contain the approval_code", async () => {
    const res = await call("memory_propose_note", {
      namespace: "personal",
      sensitivity: "private",
      title: "Leak Test Propose",
      content: "Another leak test with enough detail to be pending.",
      source_refs: ["ref-leak-2"],
    });
    const rawText = res.content[0].text;
    expect(rawText).not.toContain("approvalCode");
    expect(rawText).not.toContain("approval_code");

    // Verify the code IS stored in DB (just not returned)
    const proposalId = JSON.parse(rawText).proposal_id;
    const dbRow = await prisma.proposal.findUnique({ where: { id: proposalId } });
    expect(dbRow?.approvalCode).toBeTruthy();
  });

  it("memory_propose_patch response does NOT contain the approval_code", async () => {
    // Need an existing document - use the in-scope fixture
    const doc = await prisma.document.findFirstOrThrow({ where: { namespace: "personal" } });
    const res = await call("memory_propose_patch", {
      target_document_id: doc.id,
      title: "Patch Leak Test",
      content: "Patched body content that is unique and specific.",
      source_refs: ["ref-patch-leak"],
    });
    const rawText = res.content[0].text;
    expect(rawText).not.toContain("approvalCode");
    expect(rawText).not.toContain("approval_code");
  });
});
