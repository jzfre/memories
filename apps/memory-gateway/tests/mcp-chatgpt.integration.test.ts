import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.connectors.test.yaml");
const VAULT = resolve(__dirname, "fixtures/vault");
let client: Client;

beforeAll(async () => {
  await resetDb();
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { buildMcpServer } = await import("../src/mcp/build");
  const { resolveProfile } = await import("../src/connectors/profile");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(resolveProfile("chatgpt"));
  await server.connect(st);
  client = new Client({ name: "chatgpt-itest", version: "0.0.0" });
  await client.connect(ct);
});
afterAll(async () => { await client.close(); });

describe("chatgpt profile tool registry", () => {
  it("registers search + fetch and propose tools, but NOT memory_review_proposal", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("fetch");
    expect(names).toContain("memory_propose_note");
    expect(names).not.toContain("memory_review_proposal");
  });
});

describe("chatgpt search/fetch response shape", () => {
  it("search returns structuredContent.results[] AND a JSON-encoded text item", async () => {
    const res: any = await client.callTool({ name: "search", arguments: { query: "pgvector" } });
    expect(res.structuredContent).toBeTruthy();
    expect(Array.isArray(res.structuredContent.results)).toBe(true);
    expect(res.structuredContent.results.length).toBeGreaterThan(0);
    for (const r of res.structuredContent.results) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.url).toBe("string");
    }
    const echoed = JSON.parse(res.content[0].text);
    expect(echoed).toEqual(res.structuredContent);
  });

  it("fetch returns id/title/text/url with structuredContent + JSON text", async () => {
    const first: any = await client.callTool({ name: "search", arguments: { query: "pgvector" } });
    const id = first.structuredContent.results[0].id;
    const res: any = await client.callTool({ name: "fetch", arguments: { id } });
    expect(res.structuredContent.id).toBe(id);
    expect(typeof res.structuredContent.text).toBe("string");
    expect(typeof res.structuredContent.url).toBe("string");
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
  });
});
