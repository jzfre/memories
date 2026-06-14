import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.connectors.test.yaml");

async function load() {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  return import("../src/connectors/profile");
}

describe("resolveProfile", () => {
  it("falls back to full-trust stdio for an undefined claude-code profile", async () => {
    process.env.MEMORIES_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { resolveProfile } = await import("../src/connectors/profile");
    const p = resolveProfile("claude-code");
    expect(p.transport).toBe("stdio");
    expect(p.capabilities).toEqual({ read: true, propose: true, review: true });
    expect(p.clientLabel).toBe("mcp");
    expect(p.scope.namespaces.length).toBeGreaterThan(0);
  });

  it("resolves a chatgpt http profile: no review, scope '*' expands to config allowlist", async () => {
    const { resolveProfile } = await load();
    const p = resolveProfile("chatgpt");
    expect(p.transport).toBe("http");
    expect(p.capabilities).toEqual({ read: true, propose: true, review: false });
    expect(p.clientLabel).toBe("mcp:chatgpt");
    expect(p.scope.namespaces).toEqual(["personal", "work/client-a"]);
    expect(p.scope.sensitivities).toEqual(["public", "internal", "private", "client-confidential"]);
  });

  it("never widens scope beyond the config allowlist", async () => {
    const { resolveProfile } = await load();
    const p = resolveProfile("narrow");
    expect(p.scope.namespaces).toEqual(["personal"]); // 'forbidden' dropped
  });
});
