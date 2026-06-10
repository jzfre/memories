/**
 * Tests for memory.context_pack — core buildContextPack + MCP + REST adapters.
 *
 * Uses the real fixture vault (already seeded by the search tests) together with
 * in-memory MCP client and Fastify inject() to prove end-to-end contract shapes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma, resetDb } from "./helpers/db";
import type { ContextPack } from "../src/retrieval/context-pack";

const VAULT = resolve(__dirname, "fixtures/vault");

// ── Helpers ──────────────────────────────────────────────────────────────────

async function clearSideEffects() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log","retrieval_traces","proposals","knowledge_events" RESTART IDENTITY',
  );
}

// ── Setup fixture vault + clients ─────────────────────────────────────────────

let mcpClient: Client;

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
  mcpClient = new Client({ name: "ctx-pack-test", version: "0.0.0" });
  await mcpClient.connect(clientTransport);
});

beforeEach(clearSideEffects);

afterAll(async () => {
  await mcpClient?.close();
});

// ── Core: buildContextPack ────────────────────────────────────────────────────

describe("buildContextPack — core", () => {
  it("returns a ContextPack with sections grouped by source.kind, summary, and safety_note", async () => {
    const { buildContextPack } = await import("../src/retrieval/context-pack");
    const pack = await buildContextPack({ goal: "pgvector" }, { client: "test" });

    // Contract shape
    expect(pack.context_pack_id).toMatch(/^ctx_[0-9a-f-]{36}$/);
    expect(pack.trace_id).toBeTruthy();
    expect(pack.safety_note).toBeTruthy();
    expect(typeof pack.summary).toBe("string");
    expect(pack.summary).toContain("Context pack for: pgvector");
    expect(pack.summary).toContain("sources");
    expect(pack.summary).toContain("kinds");
    expect(Array.isArray(pack.sections)).toBe(true);
    expect(Array.isArray(pack.warnings)).toBe(true);
    expect(Array.isArray(pack.source_document_ids)).toBe(true);

    // Sections are grouped by kind: each section title is capitalised kind + "s"
    for (const section of pack.sections) {
      expect(typeof section.title).toBe("string");
      // title ends with 's' (plural of kind) and starts with uppercase
      expect(section.title[0]).toBe(section.title[0].toUpperCase());
      expect(typeof section.content).toBe("string");
      expect(Array.isArray(section.sources)).toBe(true);
      // sources = unique doc ids (non-empty)
      expect(section.sources.length).toBeGreaterThan(0);
      // content lines have "- **title**: snippet" shape
      const lines = section.content.split("\n").filter(Boolean);
      for (const line of lines) {
        expect(line).toMatch(/^- \*\*.+\*\*:/);
      }
    }

    // Sections cover the kinds present in the fixture corpus (at least "decision")
    const titles = pack.sections.map((s) => s.title);
    expect(titles.some((t) => t.toLowerCase().includes("decision"))).toBe(true);

    // Audit row written
    const audit = await prisma.auditLog.findFirst({ where: { action: "memory.context_pack" } });
    expect(audit).not.toBeNull();
    expect(audit?.approved).toBe(true);
  });

  it("respects max_tokens: with a tiny budget, sections are truncated and a warning is emitted", async () => {
    const { buildContextPack } = await import("../src/retrieval/context-pack");
    // 50 tokens is too small to fit all sections for a pgvector query
    const pack = await buildContextPack({ goal: "pgvector", max_tokens: 50 }, { client: "test" });

    // Should have fewer / truncated sections
    const totalContentTokens = pack.sections.reduce((acc, s) => {
      // approxTokens(content) = ceil(len/4)
      return acc + Math.ceil(s.content.length / 4);
    }, 0);
    expect(totalContentTokens).toBeLessThanOrEqual(50);

    // Warning must mention truncation
    expect(pack.warnings.some((w) => w.includes("Context truncated to"))).toBe(true);
  });

  it("scoping holds: full-allowlist call never contains client-b text / canary 'must never leak'", async () => {
    const { buildContextPack } = await import("../src/retrieval/context-pack");
    // Use a term that exists in client-b fixture but must never surface
    const pack = await buildContextPack({ goal: "pgvector" }, { client: "test" });

    const serialized = JSON.stringify(pack).toLowerCase();
    expect(serialized).not.toContain("client-b");
    expect(serialized).not.toContain("must never leak");

    // Sections sources should not reference client-b doc ids
    for (const section of pack.sections) {
      for (const sourceId of section.sources) {
        expect(sourceId).not.toContain("client-b");
      }
    }
  });

  it("empty results (no-match query) returns empty sections + a warning, never throws", async () => {
    const { buildContextPack } = await import("../src/retrieval/context-pack");
    const pack = await buildContextPack({ goal: "zzzznomatchgoalxyz" }, { client: "test" });

    expect(Array.isArray(pack.sections)).toBe(true);
    expect(pack.sections).toHaveLength(0);
    expect(pack.warnings.length).toBeGreaterThan(0);
    expect(pack.warnings.some((w) => w.toLowerCase().includes("no"))).toBe(true);
    expect(pack.source_document_ids).toHaveLength(0);
  });
});

// ── MCP adapter ───────────────────────────────────────────────────────────────

describe("memory_context_pack (MCP)", () => {
  it("tool is listed with description and inputSchema", async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    // Now 7 tools
    expect(names).toContain("memory_context_pack");
    const tool = tools.find((t) => t.name === "memory_context_pack");
    expect(tool?.description?.length).toBeGreaterThan(0);
    expect(tool?.inputSchema).toBeTruthy();
  });

  it("returns ContextPack contract shape via MCP (goal required, namespaces optional)", async () => {
    const res: any = await mcpClient.callTool({
      name: "memory_context_pack",
      arguments: { goal: "pgvector" },
    });
    expect(res.isError).toBeFalsy();
    const pack: ContextPack = JSON.parse(res.content[0].text);

    expect(pack.context_pack_id).toMatch(/^ctx_/);
    expect(pack.trace_id).toBeTruthy();
    expect(pack.safety_note).toBeTruthy();
    expect(typeof pack.summary).toBe("string");
    expect(Array.isArray(pack.sections)).toBe(true);
    expect(Array.isArray(pack.warnings)).toBe(true);
    expect(Array.isArray(pack.source_document_ids)).toBe(true);
  });
});

// ── REST adapter ──────────────────────────────────────────────────────────────

describe("POST /memory/context-pack (REST)", () => {
  it("returns ContextPack contract shape for a valid request", async () => {
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { buildApp } = await import("../src/api/app");
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/memory/context-pack",
      payload: { goal: "pgvector" },
    });

    expect(res.statusCode).toBe(200);
    const pack: ContextPack = res.json();
    expect(pack.context_pack_id).toMatch(/^ctx_/);
    expect(pack.trace_id).toBeTruthy();
    expect(pack.safety_note).toBeTruthy();
    expect(typeof pack.summary).toBe("string");
    expect(Array.isArray(pack.sections)).toBe(true);
    expect(Array.isArray(pack.warnings)).toBe(true);

    await app.close();
  });

  it("returns 400 for missing goal", async () => {
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { buildApp } = await import("../src/api/app");
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/memory/context-pack",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
