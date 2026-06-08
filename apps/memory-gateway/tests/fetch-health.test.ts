import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { prisma, resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

async function seedAndImport() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { fetchDocument } = await import("../src/retrieval/fetch");
  const { healthStatus } = await import("../src/health/index");
  return { fetchDocument, healthStatus };
}

describe("fetch + health", () => {
  beforeEach(resetDb);

  it("fetches an in-scope document (with a safety annotation)", async () => {
    const { fetchDocument } = await seedAndImport();
    const doc = await prisma.document.findFirstOrThrow({ where: { path: "personal/decision-canonical.md" } });
    const got = await fetchDocument(doc.id, { client: "rest" });
    expect(got?.document_id).toBe(doc.id);
    expect(got?.body).toContain("pgvector");
    expect(got?.safety_note).toBeTruthy();
  });

  it("returns null for an out-of-scope document (and never reveals it)", async () => {
    const { fetchDocument } = await seedAndImport();
    const clientB = await prisma.document.findFirstOrThrow({ where: { namespace: "work/client-b" } });
    expect(await fetchDocument(clientB.id, { client: "rest" })).toBeNull();
    const secret = await prisma.document.findFirstOrThrow({ where: { sensitivity: "secret-adjacent" } });
    expect(await fetchDocument(secret.id, { client: "rest" })).toBeNull();
  });

  it("audits every fetch (approved and denied)", async () => {
    const { fetchDocument } = await seedAndImport();
    const clientB = await prisma.document.findFirstOrThrow({ where: { namespace: "work/client-b" } });
    await fetchDocument(clientB.id, { client: "rest" });
    const denied = await prisma.auditLog.findFirst({ where: { action: "memory.fetch", approved: false } });
    expect(denied).not.toBeNull();
  });

  it("reports health with counts and audits the call", async () => {
    const { healthStatus } = await seedAndImport();
    const h = await healthStatus({ client: "rest" });
    expect(h.status).toBe("ok");
    expect(h.documents).toBeGreaterThan(0);
    expect(h.chunks).toBeGreaterThan(0);
    const audited = await prisma.auditLog.findFirst({ where: { action: "health.status" } });
    expect(audited).not.toBeNull();
  });
});
