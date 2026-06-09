import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";
import { DisabledEmbedder, type Embedder } from "../src/embed/index";

// Trivial deterministic embedder: every text -> a fixed unit vector.
class FixedEmbedder implements Embedder {
  readonly dim = 768;
  private vec() {
    const v = new Array(768).fill(0);
    v[0] = 1;
    return v;
  }
  async available() { return true; }
  async embedDocuments(texts: string[]) { return texts.map(() => this.vec()); }
  async embedQuery() { return this.vec(); }
}

// Available, but every embed call fails — exercises the best-effort error path.
class FailingEmbedder implements Embedder {
  readonly dim = 768;
  async available() { return true; }
  async embedDocuments(): Promise<number[][]> { throw new Error("embed boom"); }
  async embedQuery(): Promise<number[]> { throw new Error("embed boom"); }
}

async function scanFor(vaultRoot: string, deps: { embedder?: Embedder }) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return (extra: { dryRun?: boolean } = {}) => scanVault(extra, deps);
}

describe("embedding status", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memembs-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "a.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# A\n\napple body`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is 'disabled' when no embedder is available", async () => {
    const scan = await scanFor(dir, { embedder: new DisabledEmbedder() });
    await scan();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/a.md" } });
    expect(d.embeddingStatus).toBe("disabled");
    expect(d.embeddedAt).toBeNull();
  });

  it("is 'current' with embeddedAt set after a successful embed", async () => {
    const scan = await scanFor(dir, { embedder: new FixedEmbedder() });
    await scan();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/a.md" } });
    expect(d.embeddingStatus).toBe("current");
    expect(d.embeddedAt).not.toBeNull();
  });

  it("records 'error' + lastError and counts embedErrors when embedding throws", async () => {
    const scan = await scanFor(dir, { embedder: new FailingEmbedder() });
    const report = await scan();
    expect(report.embedErrors).toBeGreaterThanOrEqual(1);
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/a.md" } });
    expect(d.embeddingStatus).toBe("error");
    expect(d.lastError).toContain("embed boom");
  });

  it("embedPending advances a pending document to current", async () => {
    // Index without embeddings -> chunks have null embedding.
    const scanDisabled = await scanFor(dir, { embedder: new DisabledEmbedder() });
    await scanDisabled();
    // Mark it pending to simulate "embeddings just enabled".
    await prisma.document.updateMany({ data: { embeddingStatus: "pending" } });
    const { embedPending } = await import("../src/ingest/indexer");
    const res = await embedPending({ embedder: new FixedEmbedder() });
    expect(res.embedded).toBeGreaterThan(0);
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/a.md" } });
    expect(d.embeddingStatus).toBe("current");
  });
});
