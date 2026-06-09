import { describe, it, expect } from "vitest";
import {
  VALIDATION_STATUS_VALUES,
  EMBEDDING_STATUS_VALUES,
  VALIDATION_CODE_VALUES,
  SearchResult,
} from "../src/index";

describe("status constants", () => {
  it("exposes the canonical status string sets", () => {
    expect(VALIDATION_STATUS_VALUES).toEqual(["valid", "incomplete", "invalid"]);
    expect(EMBEDDING_STATUS_VALUES).toEqual(["disabled", "pending", "current", "stale", "error"]);
    expect(VALIDATION_CODE_VALUES).toContain("missing_namespace");
  });
});

describe("SearchResult.freshness", () => {
  it("parses a result carrying a freshness block", () => {
    const r = SearchResult.parse({
      document_id: "d",
      chunk_id: "d#0",
      title: "t",
      snippet: "s",
      score: 0.5,
      source: { path: "p", kind: "note", confidence: null, status: "active", review_state: null },
      freshness: { validation: "incomplete", embedding: "current" },
    });
    expect(r.freshness?.validation).toBe("incomplete");
    expect(r.freshness?.embedding).toBe("current");
  });
});
