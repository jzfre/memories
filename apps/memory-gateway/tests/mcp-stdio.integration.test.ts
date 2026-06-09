/**
 * Integration smoke tests over the REAL stdio transport: a thin SDK client spawns
 * the MCP server as a child process (exactly how LM Studio launches it) and drives
 * it programmatically — no LLM. This proves the actual process/stdio framing path,
 * complementing the in-memory matrix in mcp-tools.integration.test.ts.
 *
 * The child is pointed at the test database and fixture config via env. dotenv does
 * not override already-set vars, so these win over apps/memory-gateway/.env.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resetDb } from "./helpers/db";

const PKG_ROOT = resolve(__dirname, "..");
const VAULT = resolve(__dirname, "fixtures/vault");
const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");
const TSX = resolve(PKG_ROOT, "node_modules/.bin/tsx");

let client: Client;
let transport: StdioClientTransport;

async function searchIds(query: string, args: Record<string, unknown> = {}): Promise<string[]> {
  const res: any = await client.callTool({ name: "memory_search", arguments: { query, ...args } });
  return JSON.parse(res.content[0].text).results.map((r: any) => r.document_id);
}

beforeAll(async () => {
  // Seed the test DB in-process; the spawned server reads the same DB.
  await resetDb();
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();

  transport = new StdioClientTransport({
    command: TSX,
    args: ["src/mcp/index.ts"],
    cwd: PKG_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      MEMORIES_CONFIG: FIXTURE_CONFIG,
      VAULT_ROOT: VAULT,
      EMBEDDINGS_ENABLED: "0", // keep the spawned server full-text-only (no LLM dependency)
    },
  });
  client = new Client({ name: "stdio-itest", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

describe("MCP over real stdio transport", () => {
  it("lists the three tools across a real process boundary", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["health_status", "memory_fetch", "memory_search"]);
  });

  it("memory_search returns the title-only match (the LM Studio query) over stdio", async () => {
    expect(await searchIds("obsidian canonical decision")).toContain("personal.decision-canonical");
  });

  it("memory_search enforces scoping over stdio (no client-b, no secret)", async () => {
    const ids = await searchIds("pgvector");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => id.includes("client-b"))).toBe(false);
    expect(ids.some((id) => id.includes("secret"))).toBe(false);
  });

  it("memory_fetch blocks an out-of-scope document over stdio (isError + not found)", async () => {
    const res: any = await client.callTool({ name: "memory_fetch", arguments: { document_id: "client-b.finding" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("not found");
  });

  it("health_status reports ok over stdio", async () => {
    const res: any = await client.callTool({ name: "health_status", arguments: {} });
    expect(JSON.parse(res.content[0].text).status).toBe("ok");
  });
});
