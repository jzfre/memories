import { pathToFileURL } from "node:url";
import { scanVault, embedPending, rebuildIndex, type ScanReport } from "../ingest/indexer";
import { computeIndexStatus, type IndexStatus } from "../status/index";
import { searchAudit, type AuditSearchFilter, type AuditRow } from "../audit/search";

export async function runScan(opts: { dryRun: boolean }): Promise<ScanReport> {
  return scanVault({ ...opts, client: "cli" });
}

export async function runStatus(): Promise<IndexStatus> {
  return computeIndexStatus();
}

export async function runRebuild(): Promise<ScanReport> {
  return rebuildIndex({ client: "cli" });
}

export async function runAuditSearch(filter: AuditSearchFilter): Promise<AuditRow[]> {
  return searchAudit(filter);
}

function isEntrypoint(): boolean {
  // True only when this file is the process entrypoint; false when imported by tests.
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

function printAuditTable(rows: AuditRow[]): void {
  if (rows.length === 0) {
    console.log("(no audit records)");
    return;
  }
  const header = [
    "created_at".padEnd(24),
    "action".padEnd(30),
    "client".padEnd(15),
    "approved".padEnd(9),
    "namespace",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length + 8));
  for (const r of rows) {
    console.log(
      [
        r.createdAt.toISOString().padEnd(24),
        r.action.padEnd(30),
        r.client.padEnd(15),
        String(r.approved ?? "null").padEnd(9),
        r.namespace,
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
    if (s.stale_documents.length) {
      console.log(`\nneeds review (stale):`);
      for (const d of s.stale_documents) {
        console.log(`  ${d.path} · ${d.kind} · ${d.updatedAt.toISOString().slice(0, 10)}`);
      }
    }
    process.exit(0);
  }
  if (cmd === "rebuild") {
    const report = await runRebuild();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  if (cmd === "audit") {
    const actionIdx = args.indexOf("--action");
    const actionFilter = actionIdx !== -1 ? args[actionIdx + 1] : undefined;
    const clientIdx = args.indexOf("--client");
    const clientFilter = clientIdx !== -1 ? args[clientIdx + 1] : undefined;
    const approvedIdx = args.indexOf("--approved");
    const approvedRaw = approvedIdx !== -1 ? args[approvedIdx + 1] : undefined;
    let approvedFilter: boolean | undefined;
    if (approvedRaw === "true") approvedFilter = true;
    else if (approvedRaw === "false") approvedFilter = false;
    const limitIdx = args.indexOf("--limit");
    const limitRaw = limitIdx !== -1 ? args[limitIdx + 1] : undefined;
    const limitFilter = limitRaw !== undefined ? parseInt(limitRaw, 10) : undefined;

    const rows = await runAuditSearch({
      action: actionFilter,
      client: clientFilter,
      approved: approvedFilter,
      limit: Number.isFinite(limitFilter) ? limitFilter : undefined,
    });
    printAuditTable(rows);
    process.exit(0);
  }
  console.error("Usage: memories <scan [--dry-run] | reembed | rebuild | status | audit [--action x] [--client y] [--approved true|false] [--limit n]>");
  process.exit(1);
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
