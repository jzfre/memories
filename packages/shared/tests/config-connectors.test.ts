import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/schemas";

const base = {
  vault: { root: "/tmp/v" },
  policy: { allowed_namespaces: ["personal"], allowed_sensitivity: ["public", "private"] },
};

describe("ConfigSchema connectors + note_rules", () => {
  it("defaults connectors to {} and note_rules to safe defaults", () => {
    const c = ConfigSchema.parse(base);
    expect(c.connectors).toEqual({});
    expect(c.note_rules.quarantine_invalid).toBe(false);
    expect(c.note_rules.severities).toEqual({});
  });

  it("parses a chatgpt connector profile with scope and capabilities", () => {
    const c = ConfigSchema.parse({
      ...base,
      connectors: {
        chatgpt: {
          transport: "http",
          auth: "token",
          capabilities: ["read", "propose"],
          scope: { namespaces: "*", sensitivities: "*" },
          public_base_url: "https://x/y/mcp",
        },
      },
    });
    expect(c.connectors.chatgpt.transport).toBe("http");
    expect(c.connectors.chatgpt.capabilities).toEqual(["read", "propose"]);
    expect(c.connectors.chatgpt.scope.namespaces).toBe("*");
  });

  it("accepts per-code severity overrides", () => {
    const c = ConfigSchema.parse({ ...base, note_rules: { severities: { missing_required_section: "flag" } } });
    expect(c.note_rules.severities.missing_required_section).toBe("flag");
  });
});
