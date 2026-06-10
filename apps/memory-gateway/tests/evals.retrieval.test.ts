/**
 * Retrieval eval runner.
 *
 * Loads evals/retrieval-cases.yaml from the repo root, seeds the fixture vault
 * once, then runs `search` core per case with the test config's full allowlist.
 * For each case:
 *   - every expected_documents id must appear in result ids
 *   - every forbidden_documents id must NOT appear in result ids
 *   - special assertions per case id (see inline comments)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resetDb } from "./helpers/db";

const VAULT = resolve(__dirname, "fixtures/vault");
const EVALS_PATH = resolve(__dirname, "../../../evals/retrieval-cases.yaml");

interface RetrievalCase {
  id: string;
  query: string;
  expected_documents: string[];
  forbidden_documents: string[];
}

interface EvalFile {
  cases: RetrievalCase[];
}

let searchFn: Awaited<ReturnType<typeof importSearch>>;

async function importSearch() {
  process.env.VAULT_ROOT = VAULT;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { scanVault } = await import("../src/ingest/indexer");
  await scanVault();
  const { search } = await import("../src/retrieval/search");
  return search;
}

describe("evals: retrieval", () => {
  beforeAll(async () => {
    await resetDb();
    searchFn = await importSearch();
  });

  const raw = readFileSync(EVALS_PATH, "utf8");
  const evalFile = parseYaml(raw) as EvalFile;
  const cases = evalFile.cases;

  it("eval file has at least 10 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of cases) {
    it(`case ${c.id}: query="${c.query}"`, async () => {
      const res = await searchFn({ query: c.query }, { client: "eval" });
      const resultIds = res.results.map((r) => r.document_id);

      // safety_note must always be present
      expect(res.safety_note).toBeTruthy();

      // Expected documents must be present (if any)
      for (const expected of c.expected_documents) {
        expect(
          resultIds,
          `Expected "${expected}" in results for case "${c.id}" (query: "${c.query}"). Got: [${resultIds.join(", ")}]`,
        ).toContain(expected);
      }

      // Forbidden documents must be absent
      for (const forbidden of c.forbidden_documents) {
        expect(
          resultIds,
          `Forbidden "${forbidden}" must NOT appear in results for case "${c.id}" (query: "${c.query}"). Got: [${resultIds.join(", ")}]`,
        ).not.toContain(forbidden);
      }

      // ---- Special assertions ----

      // sec-credentialref-allowed: snippet must contain "secret_ref" but must NOT contain
      // a real-looking password assignment (i.e., password=<value>).
      if (c.id === "sec-credentialref-allowed") {
        const credResult = res.results.find((r) =>
          r.document_id === "personal.secret-ref-note",
        );
        expect(credResult, "secret-ref-note must be in results for credentialref case").toBeDefined();
        if (credResult) {
          expect(credResult.snippet).toContain("secret_ref");
          // Must NOT expose a real password value like "password = secret123"
          expect(credResult.snippet).not.toMatch(/password\s*=/);
        }
      }

      // sec-injection-data-only: safety_note must be present (defense note) and
      // the result must only expose plain data fields (no tool execution by construction).
      if (c.id === "sec-injection-data-only") {
        expect(res.safety_note).toBeTruthy();
        const injResult = res.results.find((r) =>
          r.document_id === "personal.injection-note",
        );
        expect(injResult, "injection-note must be in results for injectiontest case").toBeDefined();
        if (injResult) {
          // Assert the result is plain data fields — check that no unexpected keys exist
          const allowedKeys = new Set([
            "document_id",
            "chunk_id",
            "title",
            "snippet",
            "score",
            "source",
            "freshness",
          ]);
          for (const key of Object.keys(injResult)) {
            expect(allowedKeys, `Unexpected key "${key}" on result object`).toContain(key);
          }
        }
      }
    });
  }
});
