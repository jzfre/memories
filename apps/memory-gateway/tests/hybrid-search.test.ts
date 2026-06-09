/**
 * Hybrid (full-text + vector) search, tested deterministically with an in-process
 * concept-mapping embedder — no external LLM. The embedder maps known synonyms to the
 * same vector dimension, so a query can match a note by MEANING with zero shared
 * keywords. This is the capability that lets "database" find a note that only says
 * "postgres" (the real-world analogue of "brain gym" -> the BrainGym memo).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";
import { DisabledEmbedder, type Embedder } from "../src/embed/index";

// Concept dimensions: synonyms collapse to the same axis.
const CONCEPTS: Record<string, number> = {
  // concept 0: data storage
  postgres: 0, database: 0, pgvector: 0, sql: 0, storage: 0, store: 0,
  // concept 1: wire protocol
  mcp: 1, protocol: 1, stdio: 1, transport: 1, wire: 1,
};

class ConceptEmbedder implements Embedder {
  readonly dim = 768;
  private vec(text: string): number[] {
    const v = new Array(this.dim).fill(0);
    v[this.dim - 1] = 0.01; // baseline so no chunk is a zero vector (cosine-safe)
    for (const tok of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
      const c = CONCEPTS[tok];
      if (c !== undefined) v[c] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
  async available(): Promise<boolean> {
    return true;
  }
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.vec(text);
  }
}

const embedder = new ConceptEmbedder();

async function scanFor(vaultRoot: string, deps: { embedder?: Embedder }) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  const { search } = await import("../src/retrieval/search");
  await scanVault({}, deps);
  return search;
}

describe("hybrid search (vector + full-text)", () => {
  let dir: string;

  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memhybrid-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    mkdirSync(join(dir, "client-b"), { recursive: true });
    // In scope (personal). "postgres" -> concept 0; never says "database".
    writeFileSync(
      join(dir, "personal", "storage.md"),
      `---\nnamespace: personal\nsensitivity: private\n---\n# Storage layer\n\nWe rely on postgres for durable retrieval.`,
    );
    // In scope, different concept (protocol).
    writeFileSync(
      join(dir, "personal", "protocol.md"),
      `---\nnamespace: personal\nsensitivity: private\n---\n# Wire format\n\nThe transport is stdio based.`,
    );
    // OUT of scope (work/client-b), same concept 0 as the query — must never surface.
    writeFileSync(
      join(dir, "client-b", "secret-db.md"),
      `---\nnamespace: work/client-b\nsensitivity: private\n---\n# Client B store\n\npostgres database canary zebrastore.`,
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a note by MEANING with no shared keyword (vector recall)", async () => {
    const search = await scanFor(dir, { embedder });
    // 'database' is absent from every note's text; storage.md only says 'postgres'.
    const res = await search({ query: "database" }, { client: "test" }, { embedder });
    const ids = res.results.map((r) => r.document_id);
    expect(ids.some((id) => id.includes("storage"))).toBe(true);
  });

  it("returns nothing for that query when embeddings are OFF (proving it was the vector path)", async () => {
    // Index WITH embeddings, but search with embeddings disabled -> pure FTS.
    const search = await scanFor(dir, { embedder });
    const res = await search({ query: "database" }, { client: "test" }, { embedder: new DisabledEmbedder() });
    expect(res.results).toEqual([]);
  });

  it("enforces scope in the vector path: the out-of-scope client-b note never surfaces", async () => {
    const search = await scanFor(dir, { embedder });
    const res = await search({ query: "database" }, { client: "test" }, { embedder });
    const blob = JSON.stringify(res).toLowerCase();
    expect(res.results.some((r) => r.document_id.includes("client-b"))).toBe(false);
    expect(blob).not.toContain("zebrastore"); // out-of-scope canary
  });

  it("stores embeddings on ingest", async () => {
    await scanFor(dir, { embedder });
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*)::int AS count FROM chunks WHERE embedding IS NOT NULL',
    );
    expect(Number(count)).toBeGreaterThan(0);
  });

  it("still answers lexical queries via full-text when the embedder is unavailable", async () => {
    const search = await scanFor(dir, { embedder: new DisabledEmbedder() });
    const res = await search({ query: "postgres" }, { client: "test" }, { embedder: new DisabledEmbedder() });
    expect(res.results.some((r) => r.document_id.includes("storage"))).toBe(true);
  });
});
