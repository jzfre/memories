import { pathToFileURL } from "node:url";
import { scanVault, type ScanReport } from "../ingest/indexer";

export async function runScan(opts: { dryRun: boolean }): Promise<ScanReport> {
  return scanVault({ ...opts, client: "cli" });
}

function isEntrypoint(): boolean {
  // True only when this file is the process entrypoint; false when imported by tests.
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== "scan") {
    console.error("Usage: memories scan [--dry-run]");
    process.exit(1);
  }
  const report = await runScan({ dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(report, null, 2));
  if (report.warnings.length) {
    console.error(`\n${report.warnings.length} file(s) had frontmatter warnings.`);
  }
  process.exit(0);
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
