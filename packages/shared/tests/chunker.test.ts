import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/index";

describe("chunkMarkdown", () => {
  it("splits by headings and tracks heading paths", () => {
    const md = `# A\n\nalpha text\n\n## B\n\nbeta text`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headingPath).toBe("A");
    expect(chunks[0].content).toContain("alpha text");
    expect(chunks[1].headingPath).toBe("A > B");
    expect(chunks[1].content).toContain("beta text");
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it("captures pre-heading content with a null heading path", () => {
    const md = `intro line\n\n# H1\n\nunder h1`;
    const chunks = chunkMarkdown(md);
    expect(chunks[0].headingPath).toBeNull();
    expect(chunks[0].content).toContain("intro line");
  });

  it("returns no chunks for empty/whitespace body", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });

  it("splits oversized sections into multiple chunks", () => {
    const big = Array.from({ length: 40 }, (_, i) => `para ${i} ${"x".repeat(60)}`).join("\n\n");
    const chunks = chunkMarkdown(`# Big\n\n${big}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1600);
  });
});
