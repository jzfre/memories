import { describe, it, expect } from "vitest";
import {
  KIND_VALUES,
  validateNoteFields,
  validateNoteBody,
  validateNote,
  hasBlocking,
  STRUCTURED_KINDS,
  BODY_TEMPLATES,
} from "../src/note-schema";

const okFields = { kind: "note", tags: ["work", "db/postgres"] };

describe("validateNoteFields", () => {
  it("accepts valid fields with no issues", () => {
    expect(validateNoteFields(okFields)).toEqual([]);
  });

  it("flags an unknown kind", () => {
    const issues = validateNoteFields({ ...okFields, kind: "memo" });
    expect(issues.map((i) => i.code)).toContain("invalid_kind");
    expect(issues.find((i) => i.code === "invalid_kind")!.severity).toBe("flag");
  });

  it("flags malformed tags (spaces, '#', uppercase)", () => {
    const issues = validateNoteFields({ ...okFields, tags: ["Has Space", "#hash", "ok"] });
    const tagIssue = issues.find((i) => i.code === "invalid_tags")!;
    expect(tagIssue.severity).toBe("flag");
    expect(tagIssue.message).toContain("Has Space");
  });

  it("honors a severity override (flag -> block)", () => {
    const issues = validateNoteFields({ ...okFields, kind: "memo" }, { invalid_kind: "block" });
    expect(issues.find((i) => i.code === "invalid_kind")!.severity).toBe("block");
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

  it("flags a structured kind missing required sections", () => {
    const issues = validateNoteBody("# Title\n\n## Claim\n\nx", "decision");
    const miss = issues.find((i) => i.code === "missing_required_section")!;
    expect(miss.severity).toBe("flag");
    expect(miss.message).toContain("Evidence");
  });

  it("accepts a structured kind with all required sections", () => {
    const body = [
      "## Claim", "a", "## Context", "b", "## Evidence", "c", "## Assumptions", "d",
      "## Tradeoffs", "e", "## Decision", "f", "## Consequences", "g", "## What would change this", "h",
    ].join("\n");
    expect(validateNoteBody(body, "decision")).toEqual([]);
  });

  it("flags a finding missing required sections (multi-word section names)", () => {
    const issues = validateNoteBody("## Finding\nstuff", "finding");
    const miss = issues.find((i) => i.code === "missing_required_section")!;
    expect(miss.message).toContain("Source references");
  });

  it("accepts a runbook with all required sections", () => {
    const body = ["## Purpose", "a", "## Preconditions", "b", "## Steps", "c", "## Verification", "d", "## Rollback", "e", "## Notes", "f"].join("\n");
    expect(validateNoteBody(body, "runbook")).toEqual([]);
  });

  it("a heading that extends a required section name still satisfies it (startsWith)", () => {
    const body = ["## Claim here", "a", "## Contextual background", "b", "## Evidence summary", "c", "## Assumptions made", "d", "## Tradeoffs analysis", "e", "## Decision outcome", "f", "## Consequences noted", "g", "## What would change this in future", "h"].join("\n");
    expect(validateNoteBody(body, "decision")).toEqual([]);
  });

  it("a heading that is only a prefix/typo of a required section does NOT satisfy it", () => {
    const body = ["## Claim", "a", "## Contex", "b", "## Evidence", "c", "## Assumptions", "d", "## Tradeoffs", "e", "## Decision", "f", "## Consequences", "g", "## What would change this", "h"].join("\n");
    const miss = validateNoteBody(body, "decision").find((i) => i.code === "missing_required_section")!;
    expect(miss.message).toContain("Context");
  });

  it("honors a severity override in body validation (block -> flag)", () => {
    const issues = validateNoteBody("---\nx\n---\nbody", "note", { body_frontmatter_injection: "flag" });
    expect(issues.find((i) => i.code === "body_frontmatter_injection")!.severity).toBe("flag");
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

  it("hasBlocking is false for empty or all-flag issues", () => {
    expect(hasBlocking([])).toBe(false);
    expect(hasBlocking([{ code: "body_raw_html", message: "x", severity: "flag" }])).toBe(false);
  });

  it("STRUCTURED_KINDS matches BODY_TEMPLATES keys exactly (no silent divergence)", () => {
    expect([...STRUCTURED_KINDS].sort()).toEqual(Object.keys(BODY_TEMPLATES).sort());
  });
});
