import { pathToFileURL } from "node:url";
import { scanVault, embedPending, rebuildIndex, type ScanReport } from "../ingest/indexer";
import { computeIndexStatus, type IndexStatus } from "../status/index";
import {
  listProposals,
  reviewProposal,
  type Proposal,
  type ReviewResult,
} from "../proposals/index";
import { loadConfig } from "../config/index";

export async function runScan(opts: { dryRun: boolean }): Promise<ScanReport> {
  return scanVault({ ...opts, client: "cli" });
}

export async function runStatus(): Promise<IndexStatus> {
  return computeIndexStatus();
}

export async function runRebuild(): Promise<ScanReport> {
  return rebuildIndex({ client: "cli" });
}

export async function runListProposals(filter: {
  reviewState?: string;
  namespace?: string;
}): Promise<Proposal[]> {
  return listProposals(filter, { client: "cli" });
}

export async function runReviewProposal(
  id: string,
  action: "approve" | "reject" | "needs_more_evidence",
  notes?: string,
): Promise<ReviewResult | null> {
  const config = loadConfig();
  const reviewedBy = config.actor;
  return reviewProposal(id, { action, reviewerNotes: notes, reviewedBy }, { client: "cli" });
}

function isEntrypoint(): boolean {
  // True only when this file is the process entrypoint; false when imported by tests.
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

function printProposalsTable(proposals: Proposal[]): void {
  if (proposals.length === 0) {
    console.log("(no proposals)");
    return;
  }
  const header = ["id".padEnd(36), "state".padEnd(22), "namespace".padEnd(20), "title"].join("  ");
  console.log(header);
  console.log("-".repeat(header.length + 6));
  for (const p of proposals) {
    console.log(
      [
        p.id.padEnd(36),
        p.reviewState.padEnd(22),
        p.namespace.padEnd(20),
        p.title,
      ].join("  "),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "scan") {
    const report = await runScan({ dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(report, null, 2));
    if (report.warnings.length) {
      console.error(`\n${report.warnings.length} file(s) had frontmatter warnings.`);
    }
    process.exit(0);
  }
  if (cmd === "reembed") {
    // Backfill embeddings for chunks that don't have one yet (requires EMBEDDINGS_ENABLED).
    const res = await embedPending();
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
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
  if (cmd === "proposals") {
    const sub = args[1];
    if (sub === "review") {
      // proposals review <id> --approve|--reject|--needs-evidence [--notes "…"]
      const id = args[2];
      if (!id) {
        console.error("Error: proposal id required");
        process.exit(1);
      }
      const hasApprove = args.includes("--approve");
      const hasReject = args.includes("--reject");
      const hasNeeds = args.includes("--needs-evidence");
      const actionCount = [hasApprove, hasReject, hasNeeds].filter(Boolean).length;
      if (actionCount !== 1) {
        console.error("Error: exactly one of --approve, --reject, --needs-evidence is required");
        process.exit(1);
      }
      const action: "approve" | "reject" | "needs_more_evidence" = hasApprove
        ? "approve"
        : hasReject
          ? "reject"
          : "needs_more_evidence";

      const notesIdx = args.indexOf("--notes");
      const notes = notesIdx !== -1 ? args[notesIdx + 1] : undefined;

      const result = await runReviewProposal(id, action, notes);
      if (!result) {
        console.error(`Error: proposal "${id}" not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    // proposals [--state <state>]
    const stateIdx = args.indexOf("--state");
    const stateFilter = stateIdx !== -1 ? args[stateIdx + 1] : undefined;
    const proposals = await runListProposals({ reviewState: stateFilter });
    printProposalsTable(proposals);
    process.exit(0);
  }
  console.error("Usage: memories <scan [--dry-run] | reembed | rebuild | status | proposals [--state <s>] | proposals review <id> --approve|--reject|--needs-evidence [--notes \"…\"]>");
  process.exit(1);
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
