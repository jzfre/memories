# Filesystem Memories design record

## Product direction

Serve readable Markdown knowledge bases through authenticated MCP, with Obsidian
Sync connecting authorized devices. The connected AI client supplies research,
reasoning and note maintenance. Keep source, tests and documentation generic;
store actual deployment and client status in the authorized vault.

## Current design

- `apps/memory-server` provides nine MCP tools, current-file keyword search,
  ordinary Markdown edits, recoverable removal, private history and deterministic
  maintenance. See the [operating guide](../../filesystem-memories.md).
- HTTP clients authenticate to one configured vault through an HTTPS endpoint
  forwarded to the loopback listener. Optional stdio inherits the local account's
  permissions.
- Desktop Sync and official Headless Sync operate separately from MCP. Runtime
  state stays outside Sync. Writers on one host share a private state lock;
  external editors and Sync do not participate in that transaction.
- Last-read hashes detect observed conflicts. Removal requires a fetched hash;
  restoration accepts a hash and can recreate a missing note without replacing
  one that appeared in the meantime.
- Path containment, symlink/hidden-file rejection, size limits, private state,
  authentication and service restrictions protect the intended boundaries.

## Security and compatibility work

Markdown metadata extraction uses forward-moving parsing to avoid repeated scans
of malformed input. Regression tests cover pathological inputs, fenced code,
CRLF handling and titles containing literal trailing hashes. Note bytes,
including UTF-8 BOMs, remain intact for hashes and recoverable history.

Maintenance validates its private state before I/O, bounds report sizes and
rejects unsafe artifacts. Derived-report failures are isolated by vault at HTTP
startup. Storage and transport tests cover stale hashes, history corruption,
backup failures, vault isolation and recoverable removal.

The portable client skill describes short keyword retrieval, exact fetch paths,
literal edits, conflict reconciliation and authorized note maintenance. Clients
may load that skill or equivalent instructions; connecting MCP alone does not
install a local skill or schedule background reasoning.

## Verification procedure

Run the test suite, typecheck, build and compiled transport smoke checks against
temporary vaults. Audit dependencies and review the diff. Prepare a self-contained
release outside the checkout, verify its manifest and links, relocate it and test
its actual entry point. Current source verification is recorded in the
[review TODO](../../../TODO.md).

Live activation requires a separate authorized deployment step, private rollback
material and verification of authentication, scope, retrieval, disposable-note
recovery and synchronization. Keep actual host paths, vault counts, backup
locations, account connection state and deployment observations outside Git.
