# Memories review TODO

Scope: review the current working checkout, preserve existing changes and client compatibility, and keep private operations out of this repository. Tests use temporary vaults; reviewing code does not deploy it.

- [x] Inventory code, existing tests, documentation, and uncommitted work.
- [x] Review storage, history, maintenance, transport, configuration, and dependencies; fix verified defects with regression coverage.
- [x] Expose recoverable removal through MCP with a required last-read hash; verify stale removal, isolation, history, and restoration.
- [x] Harden MCP editing and error handling without changing existing tool contracts.
- [x] Run the complete tests, typecheck, build, and compiled transport smoke checks.
- [x] Update repository documentation and record bounded analysis and recommendations.
- [x] Read the authorized KB's `META/Protocol`, templates, and Memories entry.
- [x] Reconcile kinds and templates with the protocol; retire unused templates without deleting historical notes or losing content.
- [x] Update the authorized KB Memories entry to distinguish verified source state from deployed state.
- [x] Review the final diff and privacy with an external, ad hoc scan.

The KB work used the configured authorized MCP connection, with last-read hash checks and recoverable history. Private note content and operational details remain outside this repository.

## Verification and deliverables

- 80 tests passed across six suites (initial baseline: 56).
- Typecheck, build, and compiled stdio smoke passed, including restart recovery.
- Dependency audit: no known vulnerabilities reported after updates. This is an advisory snapshot, not proof that no vulnerabilities exist.
- Diff whitespace check and an external ad hoc privacy scan passed; preexisting uncommitted work was preserved.
- [Review findings and recommendations](docs/review.md).
- [Kinds, templates, and authorization design](docs/note-model.md).

The protocol and active templates are reconciled, legacy kind metadata is normalized,
and Memories KB entries distinguish source changes from live behavior. Read-back
checks confirmed exact content and recoverable original versions. Existing note
paths and archived exports are preserved; maintenance found no new broken or
ambiguous links.

The initial review TODOs are complete. No live service was deployed or restarted;
activation of the reviewed build remains a separate deployment action.

## Independent review and deployment follow-up

- [x] Complete independent deep code and release review; fix reproduced findings with regression tests.
- [x] Build a self-contained release and verify its packaged runtime, dependency links, and integrity.
- [ ] Deploy through an authorized host administration route, preserving private configuration and a rollback release.
- [ ] Verify live authentication, vault isolation, nine-tool discovery, and disposable-note remove/recovery; record the deployed state in the KB.

Host deployment access has been requested. The configured MCP connection provides
note operations, not host administration; no host credentials are stored here.

Follow-up verification: 97 tests across seven suites, typecheck, build, compiled
stdio/HTTP smoke, and dependency audit passed. The final release was archived,
extracted to a different location, and verified against its manifest (3,896 files
and 255 internal symlinks); its actual entry point passed the same smoke checks.
Deployment remains pending an authorized administration route; no deployment
is claimed by the local verification results.
