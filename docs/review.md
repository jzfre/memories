# Review of the current checkout

Reviewed on 2026-11-17. This records changes to the working checkout, including
review of the existing uncommitted multi-vault work. It is not a deployment or
live-vault verification record.

## Findings addressed

| Area | Finding and change |
|---|---|
| Maintenance state | State access did not consistently share history's path checks. Validate the same non-overlapping private state root before I/O, reject symlink/non-regular artifacts, bound reads and writes, validate report structure, and recover a missing derived overview. |
| Recovery | Restore now accepts an optional last-read hash and rejects oversized or malformed saved versions before replacing current content. Existing callers can still omit the hash. |
| Removal | Storage already supported recoverable removal. Expose it as `kb_remove` with a required fetched SHA-256. Preserve history; deletion is not permanent erasure. |
| MCP correctness | Reject overlapping exact-edit matches, correctly count folders named like Object prototype properties, and sanitize overview failures. |
| MCP input safety | Update the SDK and enable its 1,000-element tool-input bound on both transports. Long Markdown strings remain supported up to the existing note limit. |
| HTTP | Reject misleading JSON content types, return a usable 413 for oversized chunked uploads, mark successful responses `no-store`, and handle transport cleanup failures. |
| Configuration | Reject mismatched store/maintenance bindings and maintenance intervals that would overflow Node's timer into a rapid scan loop. |
| Dependencies | Update the SDK and compatible dependencies; upgrade the internal Zod validator to the supported patched 4.x line. Verify tool schema requirements, defaults, validation, HTTP, and compiled stdio behavior. |

Tests use temporary vaults and exercise stale hashes, backup failures, symlinks,
corrupt history/state, cross-vault denials, removal recovery, and subprocess
restart recovery. The initial suite contained 56 tests. See the completed
verification record in [TODO](../TODO.md) for final results.

The Zod upgrade preserves required/optional fields, types, limits and defaults.
The SDK's Zod 4 converter no longer advertises `additionalProperties: false`;
unknown tool arguments continue to be ignored and cannot select another vault.

The dependency audit reported no known vulnerabilities after the updates. The
SDK mitigation is documented in its [security advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453);
the Zod update follows the upstream [validation fix](https://github.com/colinhacks/zod/pull/6652)
and [migration guide](https://zod.dev/v4/changelog). An advisory scan is not a
complete security assessment.

## Assessment and next changes

The architecture fits a small, human-readable knowledge base well: Markdown is
the source of truth, search is immediately fresh, and history lives outside Sync.
Keep that simplicity. There is no need to require a database or rigid note schema
for the current workflow.

Prioritize distinct read-only credentials if agents should have different
capabilities. Current credentials grant full access to one vault; `sensitivity`
is descriptive only. Per-note access would require policy enforcement across
search results, counts, links, resources, history and writes, plus isolation from
independent filesystem access. Editable frontmatter must not grant permissions.
See the [note model and authorization proposal](note-model.md).

Use a small set of kinds with one matching template per kind. The reconciled editorial model is
`note`, `project-description`, and `decision`; specialized headings and existing
content remain intact, and archive metadata is preserved. Retiring unused templates must preserve the
notes, facts and links created with them. Runtime reads and writes remain tolerant
of legacy metadata and ordinary Markdown.

Later work can add optional metadata linting, history pagination and explicit
retention, a history-aware rename operation, and measured search improvements.
History remains unbounded, and search currently reads the collection on each
request. An unreadable or oversized note can fail a whole scan; any future
partial-results mode should report skipped notes explicitly, not imply complete
retrieval. Local filesystem checks do not isolate a malicious process with the
same OS permissions. External editors and Sync also do not share the MCP lock;
hash checks reduce conflicts but cannot make the final operation transactional
with those applications.

## KB completion and deployment boundary

The authorized protocol, active templates, and Memories entries were reconciled
through hash-checked MCP edits. Metadata cleanup preserves note bodies and paths;
legacy template references and archive metadata remain compatible. Read-back
checks verified updated content and recoverable original versions. Private vault
content and deployment details remain outside this repository.

No running service, production credential, or Sync configuration was changed.
The KB distinguishes the reviewed source from the running service. Deployment
and synchronization behavior must be checked when a reviewed build is
deliberately activated.

## Independent follow-up review

An independent code review and a separate release review reproduced further
issues, now corrected:

- UTF-8 BOM bytes were lost during decoding, changing full-file hashes and
  recoverable content. Note reads and history now preserve them exactly while
  metadata and JSON parsing use their own BOM-free views.
- Heading extraction stripped literal trailing hashes such as `C#` and treated
  headings inside fenced code as note titles. Fence handling also missed CRLF
  closing lines when extracting links. Parsing now handles these cases without
  rewriting note content.
- A failed startup scan in one vault could prevent the HTTP listener for every
  vault. Configuration and authentication still fail closed, while derived-report
  failures are isolated to their vault after startup.
- A standard workspace deployment could retain a dependency link to the source
  checkout. The release helper creates a fresh runtime-only package, repairs that
  self-reference, validates all links stay inside the release, and records a
  file/hash manifest. Smoke tests can target the actual relocated artifact.

The follow-up deployment checklist is tracked in [TODO](../TODO.md). A prepared
artifact is not evidence of a deployed service; live verification requires an
authorized host administration route.

Follow-up validation passed: 97 tests across seven suites, typecheck, build,
compiled stdio/HTTP smoke checks and a dependency audit with no known
vulnerabilities reported. The final archive was extracted to a different path;
all manifest hashes and internal symlinks verified, and the relocated runtime
passed the transport/recovery checks. Deployment remains distinct from these
local checks.
