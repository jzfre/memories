import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { prisma, resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

async function seedAndImport() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { search } = await import("../src/retrieval/search");
  return search;
}

describe("search", () => {
  beforeEach(resetDb);

  it("returns scoped results with snippets and writes a trace", async () => {
    const search = await seedAndImport();
    const res = await search({ query: "pgvector" }, { client: "rest" });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.trace_id).toBeTruthy();
    for (const r of res.results) {
      expect(r.snippet).toContain("pgvector");
      expect(typeof r.score).toBe("number");
    }
    expect(res.safety_note).toBeTruthy();
    const traces = await prisma.retrievalTrace.count();
    expect(traces).toBe(1);
  });

  it("never returns out-of-allowlist namespaces (client-b) or sensitivities (secret-adjacent)", async () => {
    const search = await seedAndImport();
    const res = await search({ query: "pgvector" }, { client: "rest" });
    const ids = res.results.map((r) => r.document_id);
    expect(ids.some((id) => id.includes("client-b"))).toBe(false);
    expect(ids.some((id) => id.includes("secret"))).toBe(false);
    // client-a IS allowed by the test config
    expect(ids.some((id) => id.includes("client-a"))).toBe(true);
  });

  it("returns empty + audits denial when only disallowed namespaces are requested", async () => {
    const search = await seedAndImport();
    const res = await search({ query: "pgvector", namespaces: ["work/client-b"] }, { client: "rest" });
    expect(res.results).toEqual([]);
    const denied = await prisma.auditLog.findFirst({ where: { approved: false } });
    expect(denied).not.toBeNull();
  });

  it("writes an approved audit row for a successful search", async () => {
    const search = await seedAndImport();
    await search({ query: "pgvector" }, { client: "mcp" });
    const approved = await prisma.auditLog.findFirst({ where: { approved: true, client: "mcp" } });
    expect(approved?.action).toBe("memory.search");
  });
});

describe("search quality (title/heading indexing + OR fallback)", () => {
  beforeEach(resetDb);

  it("finds a document by words in its TITLE that are absent from the body", async () => {
    // The fixture decision note's body has no 'obsidian'/'canonical' — those words
    // live only in its H1 title "Use Obsidian as canonical store". This is the exact
    // class of query that returned nothing in LM Studio.
    const search = await seedAndImport();
    const res = await search({ query: "obsidian canonical decision" }, { client: "rest" });
    const ids = res.results.map((r) => r.document_id);
    expect(ids.some((id) => id.includes("decision-canonical"))).toBe(true);
  });

  it("falls back to OR semantics when not every term matches (recall)", async () => {
    // 'pgvector' is in the bodies; 'zqxbogusterm' is nowhere. Strict AND would return
    // zero; OR-fallback must still surface the pgvector documents.
    const search = await seedAndImport();
    const res = await search({ query: "pgvector zqxbogusterm" }, { client: "rest" });
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("finds a document by a word present only in its metadata (tag/namespace/kind)", async () => {
    // The fixture 'tagged' note has tag 'roadmap' but the word appears nowhere in its
    // title or body. This is the class of miss that hid the brain-gym note (searching
    // 'brain gym' could not reach a note whose only signal was its namespace/folder).
    const search = await seedAndImport();
    const res = await search({ query: "roadmap" }, { client: "rest" });
    expect(res.results.some((r) => r.document_id.includes("tagged"))).toBe(true);
  });
});
