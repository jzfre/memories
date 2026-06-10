/**
 * Tests for memory_recent (recentDocuments) and memory_explain_sources (explainSources).
 * Uses the standard fixture vault (same as search.test.ts) — seed via scanVault.
 *
 * Scope for the fixture config:
 *   allowed_namespaces:  [personal, work/client-a]
 *   allowed_sensitivity: [public, internal, private, client-confidential]
 *   → work/client-b (OUT namespace) and secret-adjacent (OUT sensitivity) must NEVER appear.
 */
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
  const { recentDocuments, explainSources } = await import("../src/retrieval/recent");
  const { search } = await import("../src/retrieval/search");
  return { recentDocuments, explainSources, search };
}

describe("recentDocuments", () => {
  beforeEach(resetDb);

  it("returns in-scope documents ordered by indexedAt desc, default limit 10", async () => {
    const { recentDocuments } = await seedAndImport();
    const results = await recentDocuments({}, { client: "test" });
    expect(results.length).toBeGreaterThan(0);

    // All returned docs must have the required shape
    for (const r of results) {
      expect(typeof r.document_id).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.path).toBe("string");
      expect(typeof r.kind).toBe("string");
      expect(typeof r.namespace).toBe("string");
      expect(r.indexed_at === null || r.indexed_at instanceof Date).toBe(true);
    }

    // Ordered by indexedAt desc: each item's indexed_at >= next (nulls last)
    for (let i = 0; i < results.length - 1; i++) {
      const a = results[i].indexed_at;
      const b = results[i + 1].indexed_at;
      if (a !== null && b !== null) {
        expect(new Date(a).getTime()).toBeGreaterThanOrEqual(new Date(b).getTime());
      }
    }
  });

  it("NEVER returns out-of-scope documents (client-b namespace, secret-adjacent sensitivity)", async () => {
    const { recentDocuments } = await seedAndImport();
    const results = await recentDocuments({ limit: 50 }, { client: "test" });

    const ids = results.map((r) => r.document_id);
    const namespaces = results.map((r) => r.namespace);

    // client-b is out of namespace allowlist
    expect(ids.some((id) => id.includes("client-b"))).toBe(false);
    expect(namespaces.some((ns) => ns.includes("client-b"))).toBe(false);

    // secret-adjacent sensitivity is not in the allowlist — filter by sensitivity, not by
    // id substring (the id check was fragile and would catch unrelated fixture ids that
    // happen to contain "secret" as part of a legitimate allowed note).
    const secretDocs = await prisma.document.findMany({ where: { sensitivity: "secret-adjacent" } });
    expect(secretDocs.length).toBeGreaterThan(0); // Fixture IS seeded
    for (const secretDoc of secretDocs) {
      expect(ids, `secret-adjacent doc "${secretDoc.id}" must not appear in recent results`).not.toContain(secretDoc.id);
    }
  });

  it("honours the limit parameter (capped at 50)", async () => {
    const { recentDocuments } = await seedAndImport();
    const limited = await recentDocuments({ limit: 2 }, { client: "test" });
    expect(limited.length).toBeLessThanOrEqual(2);

    // limit > 50 should be capped at 50
    const capped = await recentDocuments({ limit: 100 }, { client: "test" });
    expect(capped.length).toBeLessThanOrEqual(50);
  });

  it("writes an approved audit row with returned document ids", async () => {
    const { recentDocuments } = await seedAndImport();
    await prisma.auditLog.deleteMany(); // ensure clean slate for this check
    const results = await recentDocuments({}, { client: "test" });
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.recent" } });
    expect(audit).not.toBeNull();
    expect(audit!.approved).toBe(true);
    expect(audit!.client).toBe("test");
    const returnedIds: string[] = audit!.returnedDocumentIds as string[];
    for (const r of results) {
      expect(returnedIds).toContain(r.document_id);
    }
  });
});

describe("explainSources", () => {
  beforeEach(resetDb);

  it("returns the trace written by a prior search (trace_id round-trip)", async () => {
    const { explainSources, search } = await seedAndImport();

    // Run a search to generate a trace
    const searchRes = await search({ query: "pgvector" }, { client: "test" });
    expect(searchRes.trace_id).toBeTruthy();

    const explained = await explainSources(searchRes.trace_id, { client: "test" });
    expect(explained).not.toBeNull();
    expect(explained!.trace_id).toBe(searchRes.trace_id);
    expect(explained!.query).toBe("pgvector");
    expect(Array.isArray(explained!.namespace_filter)).toBe(true);
    expect(Array.isArray(explained!.selected_document_ids)).toBe(true);
    expect(Array.isArray(explained!.selected_chunk_ids)).toBe(true);
    expect(explained!.ranking_debug).toBeTruthy();
    expect(explained!.created_at instanceof Date || typeof explained!.created_at === "string").toBe(true);
  });

  it("returns null for an unknown trace_id and writes an audit row with approved=false", async () => {
    const { explainSources } = await seedAndImport();
    await prisma.auditLog.deleteMany();

    const result = await explainSources("00000000-0000-0000-0000-000000000000", { client: "test" });
    expect(result).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.explain_sources" } });
    expect(audit).not.toBeNull();
    expect(audit!.approved).toBe(false);
  });

  it("writes an approved audit row when the trace is found", async () => {
    const { explainSources, search } = await seedAndImport();
    const searchRes = await search({ query: "pgvector" }, { client: "test" });
    await prisma.auditLog.deleteMany();

    await explainSources(searchRes.trace_id, { client: "test" });
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.explain_sources" } });
    expect(audit).not.toBeNull();
    expect(audit!.approved).toBe(true);
  });
});
