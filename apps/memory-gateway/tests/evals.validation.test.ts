/**
 * Validation eval runner.
 *
 * Loads evals/validation-cases.yaml from the repo root, then for each case:
 *   - Creates a proposal via createProposal (proposals table truncated in beforeEach)
 *   - Asserts review_state, flags_include (codes), and auto_policy match expectations
 *
 * The fixture vault is seeded once so that the duplicate-title case can find an
 * existing document title ("Use Obsidian as canonical store") in the DB.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { prisma, resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");
const FIXTURE_VAULT = resolve(__dirname, "fixtures/vault");
const EVALS_PATH = resolve(__dirname, "../../../evals/validation-cases.yaml");

interface ValidationCaseInput {
  namespace: string;
  sensitivity: string;
  title: string;
  kind: string;
  content: string;
  source_refs: string[];
}

interface ValidationCaseExpect {
  review_state?: string;
  flags_include?: string[];
  auto_policy?: string;
  blocked?: boolean;
}

interface ValidationCase {
  id: string;
  input: ValidationCaseInput;
  expect: ValidationCaseExpect;
}

interface EvalFile {
  cases: ValidationCase[];
}

const raw = readFileSync(EVALS_PATH, "utf8");
const evalFile = parseYaml(raw) as EvalFile;
const cases = evalFile.cases;

let tmpDir: string;

async function getCreateProposal() {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = tmpDir;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { createProposal } = await import("../src/proposals/index");
  return createProposal;
}

describe("evals: validation", () => {
  beforeAll(async () => {
    // Seed the fixture vault so document titles are in the DB (needed for duplicate detection).
    await resetDb();
    process.env.VAULT_ROOT = FIXTURE_VAULT;
    process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
    const { scanVault } = await import("../src/ingest/indexer");
    await scanVault();
  });

  beforeEach(async () => {
    // Truncate proposal/event/audit tables before each case so each test is isolated.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "proposals","knowledge_events","audit_log" RESTART IDENTITY CASCADE',
    );
    // Create a fresh temp vault dir for this proposal.
    tmpDir = mkdtempSync(join(tmpdir(), "memvault-eval-validation-"));
    mkdirSync(join(tmpDir, "personal"), { recursive: true });
    mkdirSync(join(tmpDir, "work", "client-a"), { recursive: true });
    mkdirSync(join(tmpDir, "00-inbox", "reviewed"), { recursive: true });
  });

  it("eval file has at least 6 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const c of cases) {
    it(`case ${c.id}`, async () => {
      const createProposal = await getCreateProposal();

      const result = await createProposal(
        {
          namespace: c.input.namespace,
          sensitivity: c.input.sensitivity,
          title: c.input.title,
          kind: c.input.kind,
          content: c.input.content,
          source_refs: c.input.source_refs,
        },
        { client: "eval" },
      );

      // Fetch the full proposal row to inspect validation fields
      const proposal = await prisma.proposal.findUnique({
        where: { id: result.proposal_id },
      });
      expect(proposal, `Proposal row must exist for case "${c.id}"`).not.toBeNull();

      const storedFlags = (proposal!.validationFlags ?? []) as Array<{ code: string }>;
      const flagCodes = storedFlags.map((f) => f.code);

      // Assert review_state
      if (c.expect.review_state !== undefined) {
        expect(
          result.review_state,
          `Case "${c.id}": expected review_state "${c.expect.review_state}" but got "${result.review_state}"`,
        ).toBe(c.expect.review_state);
      }

      // Assert flags_include (each listed code must be present)
      if (c.expect.flags_include) {
        for (const expectedCode of c.expect.flags_include) {
          expect(
            flagCodes,
            `Case "${c.id}": expected flag code "${expectedCode}" in [${flagCodes.join(", ")}]`,
          ).toContain(expectedCode);
        }
      }

      // Assert auto_policy
      if (c.expect.auto_policy !== undefined) {
        expect(
          proposal!.autoPolicy,
          `Case "${c.id}": expected auto_policy "${c.expect.auto_policy}" but got "${proposal!.autoPolicy}"`,
        ).toBe(c.expect.auto_policy);
      }

      // Assert blocked (review_state must be "rejected" when blocked=true)
      if (c.expect.blocked === true) {
        expect(
          result.review_state,
          `Case "${c.id}": expected blocked → review_state="rejected"`,
        ).toBe("rejected");
      }

      // Cleanup temp dir
      rmSync(tmpDir, { recursive: true, force: true });
    });
  }
});
