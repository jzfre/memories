# Design: Simplification — peer-work model (no approvals, direct writes)

- **Date:** 2026-07-02
- **Status:** Owner-dictated simplification; approved verbally ("strip all that bullshit", "I don't want to validate")
- **Supersedes:** the propose→approve model of `2026-06-14-connectors-note-integrity-chatgpt-design.md`

## Owner's decisions (verbatim intent)

| # | Decision |
|---|---|
| D1 | Remove `status` from note frontmatter/protocol (the index keeps its internal archived-tombstone; never user-facing) |
| D2 | Remove `confidence` entirely |
| D3 | Keep `tags` as-is |
| D4 | **Remove the entire propose→approve→validate pipeline.** Peer model: AI writes directly; owner reviews by editing (Syncthing versioning on eternity = the undo) |
| D5 | Sensitivity = `public` \| `internal` only. **Every client (incl. ChatGPT/MCP) sees everything.** No scope restrictions |
| D6 | Keep: Syncthing (Obsidian on Mac), SilverBullet web fallback, ChatGPT via MCP, Claude Code/Codex/VS Code on-host |
| D7 | After simplifying, run a cleansing round over vault + codebase ("I don't want to have it messy") |

**Defaults chosen while owner AFK (easily reversible, flag to owner):**
- **G1 — Secret guard stays** as the single blocking check on AI writes (credentials must not enter an OpenAI-visible store). Plus the structural body-must-not-start-with-`---` guard (prevents file corruption, not policy).
- **G2 — AI writes land in `00-inbox/` by default**; optional `folder` param targets an existing vault folder (validated: resolves inside vault, exists).
- **G3 — `namespace` leaves the user surface**: stripped from protocol, AI writes, and existing notes' frontmatter. Index plumbing keeps the column with a default (`personal`) — dormant, zero user-facing.

## What replaces proposals

Two direct-write MCP tools, gated by a new `write` capability (replaces `propose` + `review`):

- `memory_write_note({title, content, kind?, tags?, sensitivity?, folder?, source_refs?})` → secret-scan (block) → body `---` guard (block) → build frontmatter (kind default `note`, sensitivity default `internal`, created date) → **atomic write** (temp+rename, same dir — SilverBullet reads mid-write safely) to `<folder||00-inbox>/<slug>.md` (collision → `-2` suffix) → rescan → audit. Returns document path + id.
- `memory_update_note({document_id, content})` → same guards → replace body after existing frontmatter (reuse `frontmatterEndOffset` logic) → atomic write → rescan → audit.

Deleted: `memory_propose_note`, `memory_propose_patch`, `memory_list_proposals`, `memory_review_proposal`, approval codes/gating/lockout, the proposal validation engine, proposals CLI + REST routes, validation evals.

Tool roster after: stdio/full = search, fetch, recent, context_pack, explain_sources, protocol, health, write_note, update_note (9). ChatGPT profile adds canonical `search`+`fetch` (11).

## Schema/validation after

- `SENSITIVITY_VALUES = [public, internal]`; configs: `allowed_sensitivity: [public, internal]`, `default_sensitivity: internal`.
- note-schema: drop `invalid_confidence`/`invalid_status`; **nothing blocks at scan time** — all remaining checks (kind vocab, tag shape, structured-kind sections, raw HTML, wikilinks) are informational flags feeding `validationStatus: incomplete` for the cleanliness report. Only parse errors mark `invalid`.
- Write-path blocks: secrets + leading-`---` body. Nothing else.
- Connector config: `capabilities: [read, write]`; both profiles scope `"*"`/`"*"`.
- Scope *machinery* (namespace/sensitivity intersection in retrieval) stays — it's config-driven and now wide open; tests keep exercising the mechanics via fixtures.

## Cleansing round (data + docs)

1. Vault migration (run on eternity; Syncthing propagates): strip `status:`, `confidence:`, `namespace:` lines from all notes' frontmatter; map `private`/`secret-adjacent`/`confidential` → `internal`; delete `999-testing/` from the real vault (test fixtures live in repo `dev-vault/` only). Rebuild index.
2. Rewrite `99-meta/PROTOCOL.md` to the simplified rules (peer model: "write directly, owner reviews by editing; search before asking; link densely").
3. Rewrite `skills/capturing-memories/SKILL.md` to the peer model (no approval language).
4. Update `config.yaml`, `config.eternity.yaml`, `.env.example` docs, `docs/chatgpt-connector.md` (no approval section), README mentions.

## Acceptance

1. `memory_write_note` via public MCP creates a real file in the vault immediately; visible in SilverBullet/Obsidian via sync; indexed ≤1 min.
2. A note containing `password=...` is refused; a body starting `---` is refused; nothing else is.
3. No proposal/approval code, tools, routes, or tests remain; full suites green.
4. Existing vault notes carry only: `sensitivity` (public|internal), `kind`, `tags`, optional `source_refs`/dates. No `status`/`confidence`/`namespace`.
5. ChatGPT sees all notes (incl. former `private` ones — owner's explicit call).
