import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb, prisma } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");
const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function buildAndSeed() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { buildApp } = await import("../src/api/app");
  return buildApp();
}

async function buildWithTempVault(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { buildApp } = await import("../src/api/app");
  return buildApp();
}

async function resetProposalTables() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "proposals","knowledge_events" RESTART IDENTITY CASCADE',
  );
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

describe("REST API — proposals endpoints", () => {
  let dir: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log","chunks","documents","retrieval_traces" RESTART IDENTITY CASCADE',
    );
    dir = mkdtempSync(join(tmpdir(), "memvault-api-proposals-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST /proposals creates a note proposal → 200 + proposal_id + pending_review", async () => {
    const app = await buildWithTempVault(dir);

    const res = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: {
        namespace: "personal",
        sensitivity: "private",
        title: "API test note",
        content: "Some content for the API test.",
        source_refs: ["ref-1"],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposal_id).toBeTruthy();
    expect(body.review_state).toBe("pending_review");

    // Verify row was created in DB
    const proposal = await prisma.proposal.findUnique({ where: { id: body.proposal_id } });
    expect(proposal).not.toBeNull();
    expect(proposal!.reviewState).toBe("pending_review");

    await app.close();
  });

  it("POST /proposals with invalid body → 400", async () => {
    const app = await buildWithTempVault(dir);

    // Missing required fields: namespace, sensitivity, title, content
    const res = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { type: "note" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeTruthy();

    await app.close();
  });

  it("GET /proposals returns list of proposals", async () => {
    const app = await buildWithTempVault(dir);

    // Create a proposal first
    await app.inject({
      method: "POST",
      url: "/proposals",
      payload: {
        namespace: "personal",
        sensitivity: "private",
        title: "List test note",
        content: "Content for list test.",
      },
    });

    const res = await app.inject({ method: "GET", url: "/proposals" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    await app.close();
  });

  it("POST /proposals/:id/review approve → 200 + state merged + file created under temp vault 00-inbox/reviewed", async () => {
    const app = await buildWithTempVault(dir);

    // Create the proposal
    const createRes = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: {
        namespace: "personal",
        sensitivity: "private",
        title: "Approval API Test",
        content: "Body with apiapprovalmarker1234.",
        source_refs: ["ref-api"],
      },
    });

    expect(createRes.statusCode).toBe(200);
    const { proposal_id } = createRes.json();

    // Approve it
    const reviewRes = await app.inject({
      method: "POST",
      url: `/proposals/${encodeURIComponent(proposal_id)}/review`,
      payload: { action: "approve" },
    });

    expect(reviewRes.statusCode).toBe(200);
    const reviewBody = reviewRes.json();
    expect(reviewBody.review_state).toBe("merged");
    expect(reviewBody.document_path).toBeTruthy();
    expect(reviewBody.document_path).toMatch(/^00-inbox\/reviewed\/.+\.md$/);

    // File must exist in temp vault
    const filePath = join(dir, reviewBody.document_path);
    expect(existsSync(filePath)).toBe(true);

    await app.close();
  });

  it("POST /proposals/:id/review with unknown id → 404", async () => {
    const app = await buildWithTempVault(dir);

    const res = await app.inject({
      method: "POST",
      url: "/proposals/non-existent-id-xyz/review",
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("POST /proposals/:id/review already reviewed → 409", async () => {
    const app = await buildWithTempVault(dir);

    const createRes = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: {
        namespace: "personal",
        sensitivity: "private",
        title: "Double Review Test",
        content: "Body for double review.",
      },
    });
    const { proposal_id } = createRes.json();

    // First review (approve)
    await app.inject({
      method: "POST",
      url: `/proposals/${encodeURIComponent(proposal_id)}/review`,
      payload: { action: "approve" },
    });

    // Second review attempt → 409
    const res = await app.inject({
      method: "POST",
      url: `/proposals/${encodeURIComponent(proposal_id)}/review`,
      payload: { action: "reject" },
    });

    expect(res.statusCode).toBe(409);

    await app.close();
  });
});
