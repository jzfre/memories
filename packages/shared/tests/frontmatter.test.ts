import { describe, it, expect } from "vitest";
import { parseNote } from "../src/index";

const defaults = { namespace: "personal", sensitivity: "private" };

describe("parseNote", () => {
  it("reads frontmatter and body", () => {
    const raw = `---\nnamespace: career\nsensitivity: internal\nkind: decision\ntags: [a, b]\n---\n# Title Here\n\nBody text.`;
    const r = parseNote(raw, "x.md", defaults);
    expect(r.frontmatter.namespace).toBe("career");
    expect(r.frontmatter.sensitivity).toBe("internal");
    expect(r.frontmatter.kind).toBe("decision");
    expect(r.frontmatter.tags).toEqual(["a", "b"]);
    expect(r.title).toBe("Title Here");
    expect(r.body).toContain("Body text.");
    expect(r.warnings).toHaveLength(0);
  });

  it("applies defaults and warns when namespace/sensitivity missing", () => {
    const r = parseNote(`Just text, no frontmatter.`, "notes/Welcome.md", defaults);
    expect(r.frontmatter.namespace).toBe("personal");
    expect(r.frontmatter.sensitivity).toBe("private");
    expect(r.frontmatter.kind).toBe("note");
    expect(r.title).toBe("Welcome");
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("handles an empty file without throwing", () => {
    const r = parseNote("", "2026-06-07.md", defaults);
    expect(r.frontmatter.namespace).toBe("personal");
    expect(r.title).toBe("2026-06-07");
    expect(r.body).toBe("");
  });
});
