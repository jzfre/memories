import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.connectors.test.yaml");
const VAULT = resolve(__dirname, "fixtures/vault");
const TOKEN = "test-token-1234567890";

let server: Server;
let port: number;

beforeAll(async () => {
  await resetDb();
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = VAULT;
  process.env.MCP_HTTP_TOKEN = TOKEN;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { start } = await import("../src/mcp/http");
  server = await start(0); // ephemeral port
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe("isAuthorized (pure)", () => {
  it("accepts the token in the path or bearer header; rejects otherwise", async () => {
    const { isAuthorized } = await import("../src/mcp/http");
    expect(isAuthorized("POST", `/${TOKEN}/mcp`, {}, TOKEN)).toBe(true);
    expect(isAuthorized("POST", `/mcp`, { authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
    expect(isAuthorized("POST", `/wrong/mcp`, {}, TOKEN)).toBe(false);
    expect(isAuthorized("POST", `/${TOKEN}/other`, {}, TOKEN)).toBe(false);
    expect(isAuthorized("POST", `/${TOKEN}/mcp`, {}, "")).toBe(false);
  });
});

describe("HTTP MCP endpoint", () => {
  it("returns 401 for a wrong token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/wrong/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("a real MCP client can connect with the capability URL and list tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/${TOKEN}/mcp`));
    const client = new Client({ name: "http-itest", version: "0.0.0" });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).not.toContain("memory_review_proposal");
    await client.close();
  });
});
