import { describe, it, expect } from "vitest";
import { checksum, documentIdFromPath, chunkId } from "../src/index";

describe("ids", () => {
  it("checksum is stable and content-sensitive", () => {
    expect(checksum("a")).toBe(checksum("a"));
    expect(checksum("a")).not.toBe(checksum("b"));
    expect(checksum("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives a document id from a vault-relative path", () => {
    expect(documentIdFromPath("40-clients/Client A/findings/UAT note.md")).toBe(
      "40-clients.client-a.findings.uat-note",
    );
  });

  it("builds chunk ids", () => {
    expect(chunkId("doc.x", 3)).toBe("doc.x#3");
  });
});
