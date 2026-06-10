import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

async function connectClient() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { buildMcpServer } = await import("../src/mcp/build");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP server", () => {
  beforeEach(resetDb);

  it("exposes the ten tools", async () => {
    const client = await connectClient();
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
    await client.close();
  });

  it("memory_search returns scoped JSON text", async () => {
    const client = await connectClient();
    const res: any = await client.callTool({ name: "memory_search", arguments: { query: "pgvector" } });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results.every((r: any) => !r.document_id.includes("client-b"))).toBe(true);
    await client.close();
  });

  it("health_status reports ok", async () => {
    const client = await connectClient();
    const res: any = await client.callTool({ name: "health_status", arguments: {} });
    expect(JSON.parse(res.content[0].text).status).toBe("ok");
    await client.close();
  });
});
