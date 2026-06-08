import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "./helpers/db";
import { writeAudit, writeTrace } from "../src/audit/index";

describe("audit", () => {
  beforeEach(resetDb);

  it("writes an audit row with a hashed inputs field", async () => {
    await writeAudit({
      actor: "test",
      client: "rest",
      action: "memory.search",
      namespace: "personal",
      sensitivityRequested: "private",
      inputs: { query: "hi" },
      returnedDocumentIds: ["d1"],
      approved: true,
    });
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("memory.search");
    expect(rows[0].inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].returnedDocumentIds).toEqual(["d1"]);
  });

  it("writes a retrieval trace and returns its id", async () => {
    const id = await writeTrace({
      actor: "test",
      query: "hi",
      namespaceFilter: ["personal"],
      selectedChunkIds: ["c1"],
      selectedDocumentIds: ["d1"],
    });
    expect(id).toBeTruthy();
    const rows = await prisma.retrievalTrace.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].selectedDocumentIds).toEqual(["d1"]);
  });
});
