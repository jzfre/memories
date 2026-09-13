# Filesystem Memories

## Requested outcome
- Serve the owner’s Markdown knowledge base through one authenticated MCP, with official Obsidian Sync between Mac and Rocinante. The AI client researches and maintains useful notes.
- Remove all superseded code, configuration, commands, fixtures and documentation. Check the remaining security boundaries before the owner tests. Existing Git history preserves prior implementations.

## Current design
- `apps/memory-server`: eight MCP tools, current-file keyword search, ordinary Markdown edits, private recoverable history, and deterministic maintenance every 15 minutes.
- Codex connects through authenticated HTTPS and Cloudflare Tunnel to Rocinante. Optional stdio runs under the local OS account. The separate web ChatGPT connection is still pending login and client verification.
- The Mac uses Obsidian desktop Sync; Rocinante uses official Headless Sync with a persistent user service and login linger. Markdown and credentials live outside this repository.
- Runtime state stays outside Sync. On-host writers share its lock; external editors/Sync are not part of that transaction. Full-file hashes detect observed conflicts.
- Path containment, no symlinks/hidden files, size limits, private state modes, token authentication, loopback HTTP and systemd restrictions remain required.

## Cleanup and security verification — 2026-09-13
- Kept only the current runtime, its fixture-based tests, client skill, service templates and concise operating guides. Reduced the workspace and lockfile to current dependencies.
- Independent source review found one availability issue: overlapping Markdown regexes could stall the shared event loop on an allowed-size note. Replaced link, fence and heading extraction with forward-only parsing. Child-process regressions reproduced the old stalls and now complete within the enforced four-second limit; valid metadata and code exclusion are covered.
- Updated compatible runtime dependencies and moved to patched Vitest 4.1.11 with its explicit Vite 6.4.3 peer. Production dependency advisories fell from 28 to zero; the full audit fell from 40 to zero. External Cloudflare/Obsidian implementations were outside the source audit.
- Fresh frozen installs, all 53 tests, typecheck, build and compiled create/edit/restart/restore smoke passed on Mac Node 24.16.0 and Rocinante Node 22.22.1. The server's adversarial fixture test completed in 546 ms.
- Deployed a fresh build on Rocinante, retaining the previous application privately for rollback. All 72 visible Markdown hashes, existing history and credential-file contents were unchanged by deployment. Both MCP and Headless Sync remain active/enabled.
- Live public HTTPS checks passed authentication rejection (401), browser-origin rejection (403), method restriction (405), exact eight-tool discovery, keyword retrieval and full-note fetch. HTTP remains bound only to loopback.
- Encrypted independent vault backups were previously decrypted and compared with their Rocinante copies. Backup files, audit artifacts and credentials remain outside the repository.
