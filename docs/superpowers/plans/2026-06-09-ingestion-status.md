# Ingestion Hardening + Processing Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-document processing status (parse, metadata validation, embedding freshness), surface it via CLI/REST/MCP, and let search flag and lightly penalize incomplete/stale notes.

**Architecture:** Approach A — derived status columns on `documents`, set inline by `scanVault`/`embedPending`, aggregated by a single `computeIndexStatus()` that feeds all read surfaces; search joins the columns to attach a per-result `freshness` block and apply a multiplicative ranking penalty. All fields are derived and rebuilt by `rebuild`.

**Tech Stack:** TypeScript (ESM), pnpm workspaces, Prisma 5 + Postgres (pgvector), Vitest, Zod, Fastify, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-09-ingestion-status-design.md`

---

## Conventions for the executor

- Repo root: `/Users/jzfre/Code/personal/memories`. Postgres must be up: `pnpm db:up`.
- Vitest global setup runs `prisma migrate deploy` against the test DB; after adding a migration, the next `pnpm --filter @memories/memory-gateway test` applies it automatically.
- Relative imports are extensionless; `@modelcontextprotocol/sdk` subpaths keep `.js`.
- Tests stay full-text-only: `tests/helpers/setup.ts` already forces `EMBEDDINGS_ENABLED=0`. Tests that exercise embeddings inject their own embedder.
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: Shared status constants + `freshness` on `SearchResult`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/tests/status.test.ts`

- [ ] **Step 1: Write the failing test `packages/shared/tests/status.test.ts`**

```ts
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
    expect(r.freshness.validation).toBe("incomplete");
    expect(r.freshness.embedding).toBe("current");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memories/shared test status`
Expected: FAIL — exports not found / `freshness` rejected as unknown key.

- [ ] **Step 3: Add constants to `packages/shared/src/types.ts`** (append at end)

```ts
export const PARSE_STATUS_VALUES = ["parsed", "error"] as const;
export type ParseStatus = (typeof PARSE_STATUS_VALUES)[number];

export const VALIDATION_STATUS_VALUES = ["valid", "incomplete", "invalid"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUS_VALUES)[number];

export const EMBEDDING_STATUS_VALUES = ["disabled", "pending", "current", "stale", "error"] as const;
export type EmbeddingStatus = (typeof EMBEDDING_STATUS_VALUES)[number];

export const VALIDATION_CODE_VALUES = [
  "missing_namespace",
  "missing_sensitivity",
  "frontmatter_parse_error",
] as const;
export type ValidationCode = (typeof VALIDATION_CODE_VALUES)[number];

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
}
```

- [ ] **Step 4: Add the `Freshness` schema and field in `packages/shared/src/schemas.ts`**

Add after `SearchResultSource` is defined and before `SearchResult`:

```ts
export const Freshness = z.object({
  validation: z.enum(["valid", "incomplete", "invalid"]),
  embedding: z.enum(["disabled", "pending", "current", "stale", "error"]),
});
export type Freshness = z.infer<typeof Freshness>;
```

Then add `freshness` to the `SearchResult` object (insert the line after `source: SearchResultSource,`):

```ts
  freshness: Freshness,
```

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `pnpm --filter @memories/shared test status && pnpm --filter @memories/shared typecheck`
Expected: tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/schemas.ts packages/shared/tests/status.test.ts
git commit -m "feat(shared): add processing-status constants and SearchResult.freshness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Prisma migration + schema (status columns)

**Files:**
- Create: `apps/memory-gateway/prisma/migrations/20260609030000_processing_status/migration.sql`
- Modify: `apps/memory-gateway/prisma/schema.prisma`

- [ ] **Step 1: Create the migration `apps/memory-gateway/prisma/migrations/20260609030000_processing_status/migration.sql`**

```sql
ALTER TABLE "documents"
  ADD COLUMN "parse_status" TEXT NOT NULL DEFAULT 'parsed',
  ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'valid',
  ADD COLUMN "validation_issues" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "embedding_status" TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN "embedded_at" TIMESTAMPTZ,
  ADD COLUMN "last_error" TEXT;

-- Backfill embedding_status='current' for docs whose chunks are all embedded (incl. 0-chunk docs).
UPDATE "documents" d
SET "embedding_status" = 'current', "embedded_at" = now()
WHERE NOT EXISTS (
  SELECT 1 FROM "chunks" c WHERE c.document_id = d.id AND c.embedding IS NULL
);
```

- [ ] **Step 2: Add the fields to the `Document` model in `apps/memory-gateway/prisma/schema.prisma`**

Insert these lines after `indexedAt   DateTime? @map("indexed_at") @db.Timestamptz()`:

```prisma
  parseStatus      String    @default("parsed") @map("parse_status")
  validationStatus String    @default("valid") @map("validation_status")
  validationIssues Json      @default("[]") @map("validation_issues")
  embeddingStatus  String    @default("disabled") @map("embedding_status")
  embeddedAt       DateTime? @map("embedded_at") @db.Timestamptz()
  lastError        String?   @map("last_error")
```

- [ ] **Step 3: Generate the client and apply to the dev DB**

Run: `pnpm generate && pnpm db:up && pnpm migrate`
Expected: "Generated Prisma Client"; migration `20260609030000_processing_status` applied.

- [ ] **Step 4: Verify the columns exist**

Run: `docker exec memories-db psql -U memories -d memories -c "\d documents"`
Expected: rows for `parse_status`, `validation_status`, `validation_issues`, `embedding_status`, `embedded_at`, `last_error`.

- [ ] **Step 5: Commit**

```bash
git add apps/memory-gateway/prisma/migrations apps/memory-gateway/prisma/schema.prisma
git commit -m "feat(gateway): add processing-status columns to documents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Indexer — derive & persist parse/validation status

**Files:**
- Modify: `apps/memory-gateway/src/ingest/indexer.ts`
- Test: `apps/memory-gateway/tests/validation-status.test.ts`

- [ ] **Step 1: Write the failing test `apps/memory-gateway/tests/validation-status.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

async function scanFor(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("validation status", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memval-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "clean.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Clean\n\nbody`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No metadata\n\njust text`);
    writeFileSync(join(dir, "personal", "bad.md"), `---\na: b: c\n---\n# Bad\n\nbody`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies a clean note as valid with no issues", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/clean.md" } });
    expect(d.validationStatus).toBe("valid");
    expect(d.validationIssues).toEqual([]);
  });

  it("classifies a note missing namespace/sensitivity as incomplete with codes", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/nometa.md" } });
    expect(d.validationStatus).toBe("incomplete");
    const codes = (d.validationIssues as { code: string }[]).map((i) => i.code).sort();
    expect(codes).toEqual(["missing_namespace", "missing_sensitivity"]);
  });

  it("classifies malformed frontmatter as invalid", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const d = await prisma.document.findFirstOrThrow({ where: { path: "personal/bad.md" } });
    expect(d.parseStatus).toBe("error");
    expect(d.validationStatus).toBe("invalid");
  });

  it("counts incomplete/invalid in the scan report", async () => {
    const scanVault = await scanFor(dir);
    const r = await scanVault();
    expect(r.incomplete).toBeGreaterThanOrEqual(1);
    expect(r.invalid).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test validation-status`
Expected: FAIL — `validationStatus` undefined / `r.incomplete` undefined. (If the `bad.md` test errors instead of asserting, confirm `a: b: c` triggers a parse warning by checking `parseNote`; it is invalid YAML and gray-matter throws, which `parseNote` catches into a `frontmatter parse error` warning.)

- [ ] **Step 3: Add a validation helper + counters in `apps/memory-gateway/src/ingest/indexer.ts`**

Add to the imports at the top:

```ts
import type { ValidationIssue, ParseStatus, ValidationStatus } from "@memories/shared";
```

Add this helper above `scanVault`:

```ts
function deriveValidation(warnings: string[]): {
  parseStatus: ParseStatus;
  validationStatus: ValidationStatus;
  issues: ValidationIssue[];
} {
  const parseErr = warnings.find((w) => w.startsWith("frontmatter parse error"));
  if (parseErr) {
    return {
      parseStatus: "error",
      validationStatus: "invalid",
      issues: [{ code: "frontmatter_parse_error", message: parseErr }],
    };
  }
  const issues: ValidationIssue[] = [];
  for (const w of warnings) {
    if (w.includes("missing 'namespace'")) issues.push({ code: "missing_namespace", message: w });
    if (w.includes("missing 'sensitivity'")) issues.push({ code: "missing_sensitivity", message: w });
  }
  return { parseStatus: "parsed", validationStatus: issues.length ? "incomplete" : "valid", issues };
}
```

Extend the `ScanReport` interface (add the two fields):

```ts
  incomplete: number;
  invalid: number;
```

Update the report initializer to include them (find the `const report: ScanReport = { ... }` line):

```ts
  const report: ScanReport = { added: 0, updated: 0, skipped: 0, archived: 0, embedded: 0, embedErrors: 0, incomplete: 0, invalid: 0, warnings: [] };
```

- [ ] **Step 4: Persist validation in the upsert and count it**

In the per-file loop, immediately after the `parseNote` destructuring line, add:

```ts
    const validation = deriveValidation(warnings);
```

Add these three properties to BOTH the `create:` and `update:` objects of `tx.document.upsert` (place them after `frontmatter: frontmatter.raw as Prisma.InputJsonValue,`):

```ts
          parseStatus: validation.parseStatus,
          validationStatus: validation.validationStatus,
          validationIssues: validation.issues as unknown as Prisma.InputJsonValue,
```

After the `existing ? report.updated++ : report.added++;` line, add:

```ts
    if (validation.validationStatus === "incomplete") report.incomplete++;
    if (validation.validationStatus === "invalid") report.invalid++;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test validation-status`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/memory-gateway/src/ingest/indexer.ts apps/memory-gateway/tests/validation-status.test.ts
git commit -m "feat(gateway): derive and persist parse/validation status on scan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Indexer — embedding status + embeddedAt + lastError

**Files:**
- Modify: `apps/memory-gateway/src/ingest/indexer.ts`
- Test: `apps/memory-gateway/tests/embedding-status.test.ts`

- [ ] **Step 1: Write the failing test `apps/memory-gateway/tests/embedding-status.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test embedding-status`
Expected: FAIL — `embeddingStatus` is the column default (`disabled`) and never advances to `current`.

- [ ] **Step 3: Set initial embedding status in the upsert**

In `apps/memory-gateway/src/ingest/indexer.ts`, add these to BOTH `create:` and `update:` objects of the upsert (after the validation lines from Task 3):

```ts
          embeddingStatus: canEmbed ? "pending" : "disabled",
          embeddedAt: null,
          lastError: null,
```

- [ ] **Step 4: Advance status in the embed step**

Replace the existing best-effort embed block (the `if (canEmbed && chunks.length) { ... }`) with:

```ts
    if (canEmbed && chunks.length) {
      try {
        const vectors = await embedder.embedDocuments(
          chunks.map((c) => chunkEmbedText(title, c.headingPath, c.content)),
        );
        await Promise.all(
          chunks.map((c, i) =>
            prisma.$executeRaw`UPDATE chunks SET embedding = ${toVectorLiteral(vectors[i])}::vector WHERE id = ${chunkId(id, c.chunkIndex)}`,
          ),
        );
        await prisma.document.update({ where: { id }, data: { embeddingStatus: "current", embeddedAt: now } });
        report.embedded += chunks.length;
      } catch (e) {
        await prisma.document.update({
          where: { id },
          data: { embeddingStatus: "error", lastError: (e as Error).message },
        });
        report.embedErrors += 1;
      }
    } else if (canEmbed && chunks.length === 0) {
      // Empty note: nothing to embed, but it is not "pending".
      await prisma.document.update({ where: { id }, data: { embeddingStatus: "current", embeddedAt: now } });
    }
```

- [ ] **Step 5: Mark documents current at the end of `embedPending`**

In `embedPending`, immediately before `return { embedded };`, add:

```ts
  await prisma.$executeRawUnsafe(
    `UPDATE documents d SET embedding_status='current', embedded_at=now()
     WHERE d.embedding_status IN ('pending','error','disabled')
       AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id=d.id AND c.embedding IS NULL)`,
  );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test embedding-status`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/memory-gateway/src/ingest/indexer.ts apps/memory-gateway/tests/embedding-status.test.ts
git commit -m "feat(gateway): track embedding status (disabled/pending/current/error)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `rebuild` — wipe and rebuild the derived index

**Files:**
- Modify: `apps/memory-gateway/src/ingest/indexer.ts`
- Test: `apps/memory-gateway/tests/rebuild.test.ts`

- [ ] **Step 1: Write the failing test `apps/memory-gateway/tests/rebuild.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, resetDb } from "./helpers/db";

async function ctx(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  return import("../src/ingest/indexer");
}

describe("rebuildIndex", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memrebuild-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "a.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# A\n\napple`);
    writeFileSync(join(dir, "personal", "b.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# B\n\nbanana`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wipes and rebuilds documents+chunks to the same end state", async () => {
    const { scanVault, rebuildIndex } = await ctx(dir);
    await scanVault();
    const before = await prisma.document.count();
    expect(before).toBe(2);

    const report = await rebuildIndex();
    expect(report.added).toBe(2);
    expect(await prisma.document.count()).toBe(2);
    expect(await prisma.chunk.count()).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test rebuild`
Expected: FAIL — `rebuildIndex` not exported.

- [ ] **Step 3: Add `rebuildIndex` to `apps/memory-gateway/src/ingest/indexer.ts`** (append after `embedPending`)

```ts
/**
 * Drop all derived rows and rebuild them from the vault. Destructive to the INDEX only
 * (cascades chunks); the Obsidian vault is the source of truth. Re-scans, then backfills
 * any embeddings that weren't computed inline.
 */
export async function rebuildIndex(
  opts: { client?: string } = {},
  deps: IngestDeps = {},
): Promise<ScanReport> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "chunks","documents" RESTART IDENTITY CASCADE');
  const report = await scanVault({ client: opts.client ?? "cli" }, deps);
  await embedPending(deps);
  return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test rebuild`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/memory-gateway/src/ingest/indexer.ts apps/memory-gateway/tests/rebuild.test.ts
git commit -m "feat(gateway): add rebuildIndex (wipe + rebuild derived index)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `computeIndexStatus` + embedding-freshness derivation

**Files:**
- Create: `apps/memory-gateway/src/status/index.ts`
- Test: `apps/memory-gateway/tests/index-status.test.ts`

- [ ] **Step 1: Write the failing test `apps/memory-gateway/tests/index-status.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./helpers/db";
import { deriveEmbeddingFreshness } from "../src/status/index";

async function scanFor(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  return scanVault;
}

describe("deriveEmbeddingFreshness", () => {
  it("reports stale when content changed after embedding", () => {
    expect(
      deriveEmbeddingFreshness({
        embeddingStatus: "current",
        embeddedAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-02-01"),
      }),
    ).toBe("stale");
  });
  it("passes through the stored status otherwise", () => {
    expect(
      deriveEmbeddingFreshness({ embeddingStatus: "current", embeddedAt: new Date("2026-02-01"), updatedAt: new Date("2026-01-01") }),
    ).toBe("current");
    expect(deriveEmbeddingFreshness({ embeddingStatus: "disabled", embeddedAt: null, updatedAt: new Date() })).toBe("disabled");
  });
});

describe("computeIndexStatus", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memstatus-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    writeFileSync(join(dir, "personal", "ok.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Ok\n\nbody`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No meta\n\nbody`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("aggregates totals, validation counts, and an issues list", async () => {
    const scanVault = await scanFor(dir);
    await scanVault();
    const { computeIndexStatus } = await import("../src/status/index");
    const s = await computeIndexStatus();
    expect(s.totals.documents).toBe(2);
    expect(s.validation.valid).toBe(1);
    expect(s.validation.incomplete).toBe(1);
    expect(s.issues.some((i) => i.path === "personal/nometa.md")).toBe(true);
    expect(s.embedding.disabled).toBe(2); // embeddings off in tests
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test index-status`
Expected: FAIL — `../src/status/index` not found.

- [ ] **Step 3: Create `apps/memory-gateway/src/status/index.ts`**

```ts
import type { EmbeddingStatus, ValidationStatus } from "@memories/shared";
import { prisma } from "../db/client";

/** A stored 'current' embedding is 'stale' once its document changed after embeddedAt. */
export function deriveEmbeddingFreshness(doc: {
  embeddingStatus: string;
  embeddedAt: Date | null;
  updatedAt: Date;
}): EmbeddingStatus {
  if (doc.embeddingStatus === "current" && doc.embeddedAt && doc.updatedAt > doc.embeddedAt) {
    return "stale";
  }
  return doc.embeddingStatus as EmbeddingStatus;
}

export interface IndexStatusIssue {
  path: string;
  validationStatus: ValidationStatus;
  validationIssues: unknown;
  embeddingStatus: EmbeddingStatus;
}

export interface IndexStatus {
  totals: { documents: number; chunks: number; embedded: number };
  validation: Record<ValidationStatus, number>;
  embedding: Record<EmbeddingStatus, number>;
  issues: IndexStatusIssue[];
}

export async function computeIndexStatus(): Promise<IndexStatus> {
  const docs = await prisma.document.findMany({
    where: { status: { not: "archived" } },
    select: {
      path: true,
      validationStatus: true,
      validationIssues: true,
      embeddingStatus: true,
      embeddedAt: true,
      updatedAt: true,
    },
  });
  const chunks = await prisma.chunk.count();
  const embeddedRows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM chunks WHERE embedding IS NOT NULL`;

  const validation: Record<ValidationStatus, number> = { valid: 0, incomplete: 0, invalid: 0 };
  const embedding: Record<EmbeddingStatus, number> = { disabled: 0, pending: 0, current: 0, stale: 0, error: 0 };
  const issues: IndexStatusIssue[] = [];

  for (const d of docs) {
    validation[d.validationStatus as ValidationStatus]++;
    const ef = deriveEmbeddingFreshness(d);
    embedding[ef]++;
    if (d.validationStatus !== "valid" || ef === "stale" || ef === "pending" || ef === "error") {
      issues.push({
        path: d.path,
        validationStatus: d.validationStatus as ValidationStatus,
        validationIssues: d.validationIssues,
        embeddingStatus: ef,
      });
    }
  }

  return {
    totals: { documents: docs.length, chunks, embedded: embeddedRows[0].count },
    validation,
    embedding,
    issues,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test index-status`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/memory-gateway/src/status apps/memory-gateway/tests/index-status.test.ts
git commit -m "feat(gateway): add computeIndexStatus + embedding-freshness derivation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Search — attach `freshness` + apply ranking penalty

**Files:**
- Modify: `apps/memory-gateway/src/retrieval/search.ts`
- Test: `apps/memory-gateway/tests/search-freshness.test.ts`

- [ ] **Step 1: Write the failing test `apps/memory-gateway/tests/search-freshness.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./helpers/db";

async function seed(vaultRoot: string) {
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { search } = await import("../src/retrieval/search");
  return search;
}

describe("search freshness + penalty", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memfresh-"));
    mkdirSync(join(dir, "personal"), { recursive: true });
    // Same keyword in both. 'valid.md' has full metadata; 'nometa.md' is incomplete.
    writeFileSync(join(dir, "personal", "valid.md"), `---\nnamespace: personal\nsensitivity: private\n---\n# Valid\n\nzimbabwe keyword body`);
    writeFileSync(join(dir, "personal", "nometa.md"), `# No meta\n\nzimbabwe keyword body`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("attaches a freshness block to each result", async () => {
    const search = await seed(dir);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.freshness.validation).toBeDefined();
      expect(r.freshness.embedding).toBeDefined();
    }
  });

  it("ranks an otherwise-equal valid note above an incomplete one", async () => {
    const search = await seed(dir);
    const res = await search({ query: "zimbabwe" }, { client: "test" });
    const ids = res.results.map((r) => r.document_id);
    expect(ids.indexOf("personal.valid")).toBeLessThan(ids.indexOf("personal.nometa"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test search-freshness`
Expected: FAIL — `r.freshness` undefined.

- [ ] **Step 3: Select status fields and derive freshness in `apps/memory-gateway/src/retrieval/search.ts`**

Add the import:

```ts
import { deriveEmbeddingFreshness } from "../status/index";
```

Extend the `Row` interface with the status columns:

```ts
  validation_status: string;
  embedding_status: string;
  embedded_at: Date | null;
  updated_at: Date;
```

In BOTH SQL `SELECT` lists (the FTS `ftsQuery` and the vector query), add these columns after `d.frontmatter->>'review_state' AS review_state,`:

```sql
        d.validation_status AS validation_status,
        d.embedding_status AS embedding_status,
        d.embedded_at AS embedded_at,
        d.updated_at AS updated_at,
```

- [ ] **Step 4: Apply the freshness penalty during fusion and attach `freshness`**

Add this helper above `search`:

```ts
function freshnessOf(row: Row): { validation: "valid" | "incomplete" | "invalid"; embedding: ReturnType<typeof deriveEmbeddingFreshness> } {
  return {
    validation: row.validation_status as "valid" | "incomplete" | "invalid",
    embedding: deriveEmbeddingFreshness({
      embeddingStatus: row.embedding_status,
      embeddedAt: row.embedded_at,
      updatedAt: row.updated_at,
    }),
  };
}

function freshnessPenalty(f: { validation: string; embedding: string }): number {
  const v = f.validation === "incomplete" ? 0.9 : f.validation === "invalid" ? 0.8 : 1;
  const e = f.embedding === "stale" ? 0.85 : 1;
  return v * e;
}
```

Replace the ranking block (`const ranked = [...fused.values()].sort(...).slice(0, topK);`) and the `results` map with:

```ts
  const ranked = [...fused.values()]
    .map(({ row, score }) => ({ row, score: score * freshnessPenalty(freshnessOf(row)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const results = ranked.map(({ row, score }) => ({
    document_id: row.document_id,
    chunk_id: row.chunk_id,
    title: row.title,
    snippet: row.snippet,
    score,
    source: {
      path: row.path,
      kind: row.kind,
      confidence: row.confidence,
      status: row.status,
      review_state: row.review_state,
    },
    freshness: freshnessOf(row),
  }));
```

In the `writeTrace` `rankingDebug`, add `penalty: true` to record that the penalty pass ran (append to the existing object):

```ts
      penalty: true,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test search-freshness`
Expected: 2 tests pass.

- [ ] **Step 6: Run the existing search + MCP suites to confirm no regression**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test "search.test" mcp-tools.integration hybrid-search`
Expected: all green (results now also carry `freshness`).

- [ ] **Step 7: Commit**

```bash
git add apps/memory-gateway/src/retrieval/search.ts apps/memory-gateway/tests/search-freshness.test.ts
git commit -m "feat(gateway): attach freshness to results and penalize incomplete/stale

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `health_status` — add the `index` count block

**Files:**
- Modify: `apps/memory-gateway/src/health/index.ts`
- Test: `apps/memory-gateway/tests/fetch-health.test.ts` (extend)

- [ ] **Step 1: Add the failing test to `apps/memory-gateway/tests/fetch-health.test.ts`**

Inside the existing `describe("fetch + health", ...)` block, add:

```ts
  it("health includes index validation+embedding counts", async () => {
    const { healthStatus } = await seedAndImport();
    const h = await healthStatus({ client: "rest" });
    expect(h.index.validation.valid).toBeGreaterThanOrEqual(0);
    expect(h.index.embedding).toHaveProperty("current");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test fetch-health`
Expected: FAIL — `h.index` undefined.

- [ ] **Step 3: Add the `index` block in `apps/memory-gateway/src/health/index.ts`**

Add the import:

```ts
import { computeIndexStatus } from "../status/index";
```

Add `index` to the `HealthStatus` interface:

```ts
  index: { validation: Record<string, number>; embedding: Record<string, number> };
```

In `healthStatus`, after computing `documents`/`chunks`, compute the index block (tolerate DB-down):

```ts
  let index = { validation: {}, embedding: {} } as HealthStatus["index"];
  if (db === "ok") {
    const s = await computeIndexStatus();
    index = { validation: s.validation, embedding: s.embedding };
  }
```

Add `index,` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test fetch-health`
Expected: all fetch-health tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/memory-gateway/src/health/index.ts apps/memory-gateway/tests/fetch-health.test.ts
git commit -m "feat(gateway): include index validation/embedding counts in health_status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: REST `GET /status`

**Files:**
- Modify: `apps/memory-gateway/src/api/app.ts`
- Test: `apps/memory-gateway/tests/api.test.ts` (extend)

- [ ] **Step 1: Add the failing test to `apps/memory-gateway/tests/api.test.ts`**

Inside `describe("REST API", ...)`, add:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test "api.test"`
Expected: FAIL — 404 / no `totals`.

- [ ] **Step 3: Add the route in `apps/memory-gateway/src/api/app.ts`**

Add the imports:

```ts
import { computeIndexStatus } from "../status/index";
import { writeAudit } from "../audit/index";
import { loadConfig } from "../config/index";
```

Add the route inside `buildApp` (after the `/health` route):

```ts
  app.get("/status", async () => {
    const status = await computeIndexStatus();
    const { actor } = loadConfig();
    await writeAudit({
      actor,
      client: "rest",
      action: "index.status",
      namespace: "n/a",
      sensitivityRequested: null,
      inputs: {},
      returnedDocumentIds: [],
      approved: true,
    });
    return status;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test "api.test"`
Expected: all API tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/memory-gateway/src/api/app.ts apps/memory-gateway/tests/api.test.ts
git commit -m "feat(gateway): add GET /status REST endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: CLI `status` + `rebuild` subcommands

**Files:**
- Modify: `apps/memory-gateway/src/cli/index.ts`
- Modify: `apps/memory-gateway/package.json`
- Modify: `package.json`
- Test: `apps/memory-gateway/tests/cli.test.ts` (extend)

- [ ] **Step 1: Add the failing test to `apps/memory-gateway/tests/cli.test.ts`**

Inside `describe("cli runScan", ...)` (or a new describe in the same file), add:

```ts
  it("runStatus returns the index breakdown", async () => {
    process.env.VAULT_ROOT = VAULT;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { runScan } = await import("../src/cli/index");
    await runScan({ dryRun: false });
    const { runStatus } = await import("../src/cli/index");
    const s = await runStatus();
    expect(s.totals.documents).toBeGreaterThan(0);
    expect(s.validation).toHaveProperty("valid");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test cli`
Expected: FAIL — `runStatus` not exported.

- [ ] **Step 3: Add `runStatus`/`runRebuild` + subcommands in `apps/memory-gateway/src/cli/index.ts`**

Update the imports:

```ts
import { scanVault, embedPending, rebuildIndex, type ScanReport } from "../ingest/indexer";
import { computeIndexStatus, type IndexStatus } from "../status/index";
```

Add the runnable functions (after `runScan`):

```ts
export async function runStatus(): Promise<IndexStatus> {
  return computeIndexStatus();
}

export async function runRebuild(): Promise<ScanReport> {
  return rebuildIndex({ client: "cli" });
}
```

In `main`, add these branches before the final usage error (keep the existing `scan` and `reembed` branches):

```ts
  if (cmd === "status") {
    const s = await runStatus();
    console.log(`documents: ${s.totals.documents}   chunks: ${s.totals.chunks}   embedded: ${s.totals.embedded}/${s.totals.chunks}`);
    console.log(`validation: ${s.validation.valid} valid · ${s.validation.incomplete} incomplete · ${s.validation.invalid} invalid`);
    console.log(
      `embedding:  ${s.embedding.current} current · ${s.embedding.pending} pending · ${s.embedding.stale} stale · ${s.embedding.disabled} disabled · ${s.embedding.error} error`,
    );
    if (s.issues.length) {
      console.log(`\nneeds attention:`);
      for (const i of s.issues) {
        const codes = Array.isArray(i.validationIssues) ? (i.validationIssues as { code: string }[]).map((c) => c.code).join(", ") : "";
        console.log(`  ${i.path}\t${i.validationStatus}\t${i.embeddingStatus}\t${codes}`);
      }
    }
    process.exit(0);
  }
  if (cmd === "rebuild") {
    const report = await runRebuild();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
```

Update the usage line:

```ts
  console.error("Usage: memories <scan [--dry-run] | reembed | rebuild | status>");
```

- [ ] **Step 4: Add the npm scripts**

In `apps/memory-gateway/package.json` `scripts`, add after `"reembed"`:

```json
    "rebuild": "tsx src/cli/index.ts rebuild",
    "status": "tsx src/cli/index.ts status",
```

In root `package.json` `scripts`, add after `"reembed"`:

```json
    "rebuild": "pnpm --filter @memories/memory-gateway rebuild",
    "status": "pnpm --filter @memories/memory-gateway status",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm db:up && pnpm --filter @memories/memory-gateway test cli`
Expected: all CLI tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/memory-gateway/src/cli/index.ts apps/memory-gateway/package.json package.json apps/memory-gateway/tests/cli.test.ts
git commit -m "feat(gateway): add status and rebuild CLI commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full suite + typecheck**

Run: `pnpm db:up && pnpm -r test && pnpm -r typecheck`
Expected: all packages green; no type errors. (Embeddings stay off in CI.)

- [ ] **Step 2: Live smoke against the dev DB**

Run: `pnpm migrate && pnpm rebuild && pnpm status`
Expected: `rebuild` reports the seeded docs; `status` prints totals + validation/embedding rollups, listing any frontmatter-less notes (e.g. a daily note) under "needs attention".

- [ ] **Step 3: Confirm freshness reaches a client**

Run (REST in another shell via `pnpm api`):
`curl -s -X POST http://127.0.0.1:8787/memory/search -H 'content-type: application/json' -d '{"query":"obsidian"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['results'][0]['freshness'])"`
Expected: a `{validation, embedding}` block on the result.

- [ ] **Step 4: Commit any remaining changes** (if Step 2/3 surfaced fixes).

---

## Acceptance criteria (from the spec)

1. Status columns exist, backfilled, set by `scan`. — Tasks 2, 3, 4
2. Missing namespace/sensitivity → `incomplete` w/ codes; malformed → `invalid`; clean → `valid`. — Task 3
3. Embedding status reflects reality; `reembed` advances to `current`. — Task 4
4. `pnpm rebuild` wipes and rebuilds correctly. — Task 5
5. Results carry `freshness`; incomplete/stale lightly penalized. — Tasks 1, 7
6. `pnpm status`, `GET /status`, `health_status.index` report consistent counts. — Tasks 6, 8, 9, 10
7. `pnpm -r test` + `pnpm -r typecheck` pass. — Task 11
