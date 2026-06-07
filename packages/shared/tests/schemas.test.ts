import { describe, it, expect } from "vitest";
import { ConfigSchema, SearchInput } from "../src/index";

describe("ConfigSchema", () => {
  it("applies defaults and requires allowlists", () => {
    const cfg = ConfigSchema.parse({
      vault: { root: "/x" },
      policy: { allowed_namespaces: ["personal"], allowed_sensitivity: ["private"] },
    });
    expect(cfg.policy.default_namespace).toBe("personal");
    expect(cfg.actor).toBe("local");
  });

  it("rejects empty allowlists", () => {
    expect(() =>
      ConfigSchema.parse({
        vault: { root: "/x" },
        policy: { allowed_namespaces: [], allowed_sensitivity: ["private"] },
      }),
    ).toThrow();
  });
});

describe("SearchInput", () => {
  it("defaults top_k to 10", () => {
    const parsed = SearchInput.parse({ query: "hi" });
    expect(parsed.top_k).toBe(10);
  });
});
