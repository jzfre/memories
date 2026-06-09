import { pathToFileURL } from "node:url";
import { scanVault, embedPending, rebuildIndex, type ScanReport } from "../ingest/indexer";
import { computeIndexStatus, type IndexStatus } from "../status/index";

export async function runScan(opts: { dryRun: boolean }): Promise<ScanReport> {
  return scanVault({ ...opts, client: "cli" });
}

export async function runStatus(): Promise<IndexStatus> {
  return computeIndexStatus();
}

export async function runRebuild(): Promise<ScanReport> {
  return rebuildIndex({ client: "cli" });
}

function isEntrypoint(): boolean {
  // True only when this file is the process entrypoint; false when imported by tests.
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
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
  console.error("Usage: memories <scan [--dry-run] | reembed | rebuild | status>");
  process.exit(1);
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
