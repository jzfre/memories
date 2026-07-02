import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { resetDb, prisma } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");

async function buildAndSeed() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { buildApp } = await import("../src/api/app");
  return buildApp();
}

describe("REST API", () => {
  beforeEach(resetDb);

  it("GET /health returns counts", async () => {
    const app = await buildAndSeed();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    const audited = await prisma.auditLog.findFirst({ where: { action: "health.status", client: "rest" } });
    expect(audited).not.toBeNull();
    await app.close();
  });

  it("POST /memory/search returns scoped results", async () => {
    const app = await buildAndSeed();
    const res = await app.inject({ method: "POST", url: "/memory/search", payload: { query: "pgvector" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r: any) => !r.document_id.includes("client-b"))).toBe(true);
    await app.close();
  });

  it("POST /memory/search rejects invalid input with 400", async () => {
    const app = await buildAndSeed();
    const res = await app.inject({ method: "POST", url: "/memory/search", payload: { query: "" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /memory/documents/:id returns 200 in-scope, 404 out-of-scope", async () => {
    const app = await buildAndSeed();
    const ok = await prisma.document.findFirstOrThrow({ where: { path: "personal/decision-canonical.md" } });
    const okRes = await app.inject({ method: "GET", url: `/memory/documents/${encodeURIComponent(ok.id)}` });
    expect(okRes.statusCode).toBe(200);
    const hidden = await prisma.document.findFirstOrThrow({ where: { namespace: "work/client-b" } });
    const hiddenRes = await app.inject({ method: "GET", url: `/memory/documents/${encodeURIComponent(hidden.id)}` });
    expect(hiddenRes.statusCode).toBe(404);
    await app.close();
  });

  it("POST /ingest/scan runs a scan", async () => {
    const app = await buildAndSeed();
    const res = await app.inject({ method: "POST", url: "/ingest/scan", payload: { dry_run: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("skipped");
    const audited = await prisma.auditLog.findFirst({ where: { action: "ingest.scan", client: "rest" } });
    expect(audited).not.toBeNull();
    await app.close();
  });

  it("GET /status returns the index breakdown and audits the call", async () => {
    const app = await buildAndSeed();
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.documents).toBeGreaterThan(0);
    expect(body.validation).toHaveProperty("valid");
    expect(Array.isArray(body.issues)).toBe(true);
    const audited = await prisma.auditLog.findFirst({ where: { action: "index.status", client: "rest" } });
    expect(audited).not.toBeNull();
    await app.close();
  });
});

describe("REST API — audit search endpoint", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
  });

  it("GET /audit?action=memory.search returns only that action", async () => {
    const app = await buildAndSeed();

    // Trigger a search so an audit row exists
    await app.inject({
      method: "POST",
      url: "/memory/search",
      payload: { query: "pgvector" },
    });

    // Also trigger a different action
    await app.inject({ method: "GET", url: "/status" });

    const res = await app.inject({ method: "GET", url: "/audit?action=memory.search" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((r: { action: string }) => r.action === "memory.search")).toBe(true);

    await app.close();
  });
});
