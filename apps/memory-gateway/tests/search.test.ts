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
