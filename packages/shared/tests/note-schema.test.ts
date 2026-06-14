import { describe, it, expect } from "vitest";
import {
  KIND_VALUES,
  validateNoteFields,
  validateNoteBody,
  validateNote,
  hasBlocking,
} from "../src/note-schema";

const okFields = { kind: "note", confidence: "high", status: "active", tags: ["work", "db/postgres"] };

describe("validateNoteFields", () => {
  it("accepts valid fields with no issues", () => {
    expect(validateNoteFields(okFields)).toEqual([]);
  });

  it("blocks an unknown kind", () => {
    const issues = validateNoteFields({ ...okFields, kind: "memo" });
    expect(issues.map((i) => i.code)).toContain("invalid_kind");
    expect(issues.find((i) => i.code === "invalid_kind")!.severity).toBe("block");
  });

  it("blocks an unknown confidence and status", () => {
    const issues = validateNoteFields({ ...okFields, confidence: "maybe", status: "open" });
    expect(issues.map((i) => i.code).sort()).toEqual(["invalid_confidence", "invalid_status"]);
  });

  it("blocks malformed tags (spaces, '#', uppercase)", () => {
    const issues = validateNoteFields({ ...okFields, tags: ["Has Space", "#hash", "ok"] });
    const tagIssue = issues.find((i) => i.code === "invalid_tags")!;
    expect(tagIssue.severity).toBe("block");
    expect(tagIssue.message).toContain("Has Space");
  });

  it("honors a severity override (block -> flag)", () => {
    const issues = validateNoteFields({ ...okFields, kind: "memo" }, { invalid_kind: "flag" });
    expect(issues.find((i) => i.code === "invalid_kind")!.severity).toBe("flag");
  });
});

describe("validateNoteBody", () => {
  it("free-form kinds need no sections", () => {
    expect(validateNoteBody("just a paragraph", "note")).toEqual([]);
  });

  it("blocks a body that begins with a frontmatter block", () => {
    const issues = validateNoteBody("---\nnamespace: x\n---\nbody", "note");
    expect(issues.map((i) => i.code)).toContain("body_frontmatter_injection");
    expect(issues.find((i) => i.code === "body_frontmatter_injection")!.severity).toBe("block");
  });

  it("flags raw HTML", () => {
    const issues = validateNoteBody("text <div>x</div>", "note");
    expect(issues.find((i) => i.code === "body_raw_html")!.severity).toBe("flag");
  });

  it("flags a malformed/empty wikilink", () => {
    expect(validateNoteBody("see [[ ]]", "note").map((i) => i.code)).toContain("body_malformed_wikilink");
    expect(validateNoteBody("see [[open", "note").map((i) => i.code)).toContain("body_malformed_wikilink");
  });

  it("blocks a structured kind missing required sections", () => {
    const issues = validateNoteBody("# Title\n\n## Claim\n\nx", "decision");
    const miss = issues.find((i) => i.code === "missing_required_section")!;
    expect(miss.severity).toBe("block");
    expect(miss.message).toContain("Evidence");
  });

  it("accepts a structured kind with all required sections", () => {
    const body = [
      "## Claim", "a", "## Context", "b", "## Evidence", "c", "## Assumptions", "d",
      "## Tradeoffs", "e", "## Decision", "f", "## Consequences", "g", "## What would change this", "h",
    ].join("\n");
    expect(validateNoteBody(body, "decision")).toEqual([]);
  });
});

describe("validateNote + hasBlocking", () => {
  it("aggregates field + body issues and detects blocking", () => {
    const issues = validateNote({ ...okFields, kind: "memo" }, "---\nx\n---\nbody");
    expect(issues.map((i) => i.code).sort()).toEqual(["body_frontmatter_injection", "invalid_kind"]);
    expect(hasBlocking(issues)).toBe(true);
  });
  it("KIND_VALUES is the canonical 9-kind list", () => {
    expect(KIND_VALUES).toContain("decision");
    expect(KIND_VALUES.length).toBe(9);
  });
});
