/**
 * The KB protocol lives IN the vault (0x09 Meta/Protocol.md) and is served to every
 * MCP client: as server `instructions` at initialize, and via the memory_protocol
 * tool for mid-session re-reads. No client-side copies to drift.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function setup(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
}

const PROTO_BODY = "# KB Protocol\n\nAllowed kinds: note, decision. Route career notes to 0x03 Career.";
const PROTO_WITH_FM = `---\nnamespace: personal\nsensitivity: internal\nkind: note\ntags: [meta]\n---\n\n${PROTO_BODY}`;

describe("loadProtocol (pure-ish)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memproto-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the protocol body (frontmatter stripped) when the note exists", async () => {
    mkdirSync(join(dir, "0x09 Meta"), { recursive: true });
    writeFileSync(join(dir, "0x09 Meta", "Protocol.md"), PROTO_WITH_FM);
    await setup(dir);
    const { loadProtocol } = await import("../src/protocol/index");
    const p = loadProtocol();
    expect(p).toContain("Allowed kinds");
    expect(p).not.toContain("sensitivity: internal"); // frontmatter stripped
  });

  it("returns undefined when the note is absent", async () => {
    await setup(dir);
    const { loadProtocol } = await import("../src/protocol/index");
    expect(loadProtocol()).toBeUndefined();
  });

  it("truncates an oversized protocol with a marker", async () => {
    mkdirSync(join(dir, "0x09 Meta"), { recursive: true });
    writeFileSync(join(dir, "0x09 Meta", "Protocol.md"), "x".repeat(30000));
    await setup(dir);
    const { loadProtocol } = await import("../src/protocol/index");
    const p = loadProtocol()!;
    expect(p.length).toBeLessThanOrEqual(16500);
    expect(p).toContain("[truncated");
  });
});

describe("MCP: instructions at initialize + memory_protocol tool", () => {
  let dir: string;
  let client: Client;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memproto-mcp-"));
  });
  afterEach(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect() {
    const { buildMcpServer } = await import("../src/mcp/build");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(st);
    client = new Client({ name: "proto-test", version: "0.0.0" });
    await client.connect(ct);
  }

  it("serves the protocol as server instructions and via memory_protocol", async () => {
    mkdirSync(join(dir, "0x09 Meta"), { recursive: true });
    writeFileSync(join(dir, "0x09 Meta", "Protocol.md"), PROTO_WITH_FM);
    await setup(dir);
    await connect();
    expect(client.getInstructions()).toContain("Allowed kinds");
    const res: any = await client.callTool({ name: "memory_protocol", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Route career notes");
  });

  it("initializes cleanly with no protocol note; tool explains it's missing", async () => {
    await setup(dir);
    await connect();
    expect(client.getInstructions() ?? "").not.toContain("Allowed kinds");
    const res: any = await client.callTool({ name: "memory_protocol", arguments: {} });
    expect(res.content[0].text).toContain("0x09 Meta/Protocol.md");
  });
});
