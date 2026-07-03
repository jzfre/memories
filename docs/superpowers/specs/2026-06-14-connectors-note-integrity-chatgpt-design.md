# Design: Connector profiles, note integrity, and a ChatGPT connector

- **Date:** 2026-06-14
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Owner:** jr
- **Affects:** `apps/memory-gateway`, `packages/shared`, `skills/capturing-memories`, `config.yaml`, docs

## 1. Context

The memories system stores knowledge as Markdown notes in an Obsidian vault (canonical, source of truth) with a Postgres-derived index (rebuildable) and a gateway exposing retrieval + a propose→approve write path. Today there are two ways to reach it:

- **VSCode/Obsidian** — opened directly on the vault folder; edits `.md` files **directly**. No MCP, no HTTP. The gateway only sees these changes at scan time.
- **Claude Code** — connects to the gateway over **stdio MCP** (`pnpm mcp`), entirely local.

Two gaps motivate this iteration:

1. **Note rules are stated but not enforced.** `skills/capturing-memories/SKILL.md` declares fixed vocabularies and body conventions ("Iron Rules"), but the gateway validator (`src/proposals/validate.ts`) only hard-blocks `secret_detected` / `namespace_invalid` / `sensitivity_invalid` (plus `frontmatter_injection` for patches). `kind` is only *scored*; `confidence` / `status` / `tags` are not validated at all (and not even passed into the validator); body Markdown safety and per-kind structure are unchecked for new notes. Testing surfaced that invalid/ill-formed notes can be created despite the prose rules.

2. **ChatGPT cannot connect.** The gateway is **stdio-MCP only**. ChatGPT (web or desktop) runs in OpenAI's cloud and can only attach to a **remote HTTPS MCP endpoint** (Streamable HTTP / SSE). There is no such transport today.

## 2. Goals

- Make "a valid note" a single, enforced definition shared by every write path.
- Hard-**reject** invalid attributes and malformed bodies at the gateway (proposal-time); **flag** non-conforming direct edits (scan-time).
- Let **ChatGPT** read and **propose** to the memories vault via a remote MCP connector, without weakening the human-only approval gate.
- Make "connectors" a first-class concept with per-connector **transport + auth + scope + capabilities**, formalizing the existing "different connector = different access; different folder = no access" intuition.

## 3. Non-goals

- Full OAuth 2.1 authorization server (PKCE, DCR/CIMD, discovery endpoints). Documented as the **follow-up** to the token-auth MVP.
- A ChatGPT Apps SDK app with a custom UI component (overkill for personal use).
- Validating/auto-resolving `[[wikilink]]` targets against existing notes (kept advisory at most; targets may be created later).
- Rewriting existing vault notes to conform. New rules apply going forward; legacy non-conforming notes are *flagged*, not mutated.
- Changing the canonical/derived model (vault stays source of truth; Postgres stays rebuildable).

## 4. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Note-rule approach | **A1** — single source of truth in `packages/shared`, enforced |
| D2 | Enforcement strength | **Reject at gateway** (proposal-time block); **flag** at scan-time |
| D3 | Structured-kind required sections | **Reject until complete** (configurable per kind) |
| D4 | ChatGPT capability | **Read + propose** (no `review` capability) |
| D5 | ChatGPT read scope | **All namespaces, all sensitivities** (incl. `private`) — owner accepts informed egress to OpenAI |
| D6 | Transport / exposure | Streamable-HTTP MCP on existing gateway, **ngrok** tunnel |
| D7 | Auth MVP | **Capability-URL token** now; OAuth 2.1 follow-up |
| D8 | Packaging | One spec: connector-profiles foundation + two workstreams |

> **D5 security note (on the record):** ChatGPT runs in OpenAI's cloud, so any note the connector returns is transmitted to OpenAI. The owner has chosen to allow `private` notes through this path, accepting the egress, mitigated by the Business/Enterprise/Edu terms (no training on customer data by default; configurable retention). This is a one-line config change to reverse at any time (`connectors.chatgpt.scope.sensitivities`).

## 5. Architecture

```
 CONNECTOR          TRANSPORT                 GATEWAY CORE                 CANONICAL
 ─────────          ─────────                 ────────────                 ─────────
 VSCode/Obsidian    (none — direct edits) ──────────────────────────────► Vault (.md)  ◄─ source of truth
                                                  │  scan-time validate         │
 Claude Code   ───  stdio MCP ──┐                 ▼ (FLAG)                       ▼
                    profile:    ├─► buildMcpServer(profile) ─► retrieval ─────► Postgres (derived)
                    claude-code │            │                  proposals ─► proposal-time validate (REJECT)
 ChatGPT (web) ───  HTTP MCP ───┘            │
   via ngrok        StreamableHTTP           profile = scope + capabilities + auth
                    profile: chatgpt
                    capability-URL token
```

Three connectors, three trust levels, **one core**. The only new long-lived surface is the HTTP MCP transport. Scope + capabilities + validation are all reuse of existing primitives.

Key reuse facts that make this cheap:

- `validateProposal` already drives rejection via `blocked=true` → `createProposal` writes `reviewState:"rejected"`; there is already approve-time defense-in-depth (`blockingCodes` in `reviewProposal`). We extend the *checks*, not the mechanism.
- `intersectScope(requested, allowedNs, allowedSens)` in `src/policy/index.ts` is already pure. Per-connector scope = feed it the **profile's** allowlist instead of the global `config.policy` one.
- `buildMcpServer()` is transport-agnostic; the SDK (`@modelcontextprotocol/sdk@^1.12.0`) ships `StreamableHTTPServerTransport`.
- Scan-time validation already persists `validationStatus` (`valid`/`incomplete`/`invalid`) + `validationIssues`, and search already down-ranks non-valid docs via `freshnessPenalty`.

---

## 6. Part 0 — Connector profiles (foundation)

### 6.1 Config schema

Add an optional `connectors:` block to `config.yaml`:

```yaml
connectors:
  claude-code:                       # local, fully trusted
    transport: stdio
    auth: none
    capabilities: [read, propose, review]
    scope: { namespaces: "*", sensitivities: "*" }   # "*" = all config-allowed
  chatgpt:                           # remote, OpenAI cloud
    transport: http
    auth: token
    capabilities: [read, propose]    # NO "review" — approval stays terminal-only
    scope: { namespaces: "*", sensitivities: "*" }   # D5: all, incl. private
```

- `transport`: `stdio` | `http`.
- `auth`: `none` | `token` | `oauth` (only `none` and `token` implemented now).
- `capabilities`: subset of `read` | `propose` | `review`.
- `scope.namespaces` / `scope.sensitivities`: array, or `"*"` meaning "all entries currently allowed by `config.policy`". A profile scope is a **hard ceiling**, always intersected with `config.policy.allowed_*` — a connector can never widen beyond the deployment.

### 6.2 Profile resolution + scope threading

- `src/config/index.ts`: parse and validate `connectors`. Expose `getConnectorProfile(name)`. If `connectors` is absent, synthesize a default `claude-code` full-trust profile (= today's behavior) for backward compatibility.
- `src/policy/index.ts`: add an allowlist-bearing form so scope can come from a profile rather than global config:
  - `resolveScope(requested, allow?: { namespaces: string[]; sensitivities: string[] })` — defaults to `config.policy` when `allow` is omitted (current behavior preserved).
  - Resolve `"*"` against `config.policy.allowed_*` when building a profile's effective allowlist.
- **Threading:** every core function already takes `ctx: { client: string }`. Extend to `ctx: { client: string; scope?: ResolvedAllow }`. The transport entrypoint resolves its profile once at startup and passes `scope` (and a descriptive `client` label, e.g. `"mcp:chatgpt"`) into each handler. `search`/`fetchDocument`/`recentDocuments`/`buildContextPack`/`explainSources`/`createProposal` honor `ctx.scope` when present.

### 6.3 Profile-aware tool registration

`buildMcpServer(profile: ConnectorProfile)`:

- Always register read tools: `memory_search`, `memory_fetch`, `memory_recent`, `memory_context_pack`, `memory_explain_sources`, `health_status`.
- Register `memory_propose_note` / `memory_propose_patch` / `memory_list_proposals` only if `capabilities` includes `propose`.
- Register `memory_review_proposal` **only if** `capabilities` includes `review`.
- For `transport: http` (or a `flavor: chatgpt` marker), also register ChatGPT-canonical `search` / `fetch` (see §8.3).
- Each handler closes over the profile and builds `ctx` with the profile's scope.

Result: the ChatGPT connector **has no approve tool at all** — the approval-code gate is reinforced by absence of surface, on top of the code gate itself.

### 6.4 Backward compatibility

- No `connectors:` block → stdio server uses the synthesized full-trust `claude-code` profile = current behavior, unchanged.
- `src/mcp/index.ts` (stdio) loads the `claude-code` profile; new `src/mcp/http.ts` loads the `chatgpt` profile.

---

## 7. Part 1 — Note integrity (single source of truth, enforced)

### 7.1 The schema module

New `packages/shared/src/note-schema.ts` (single source of truth):

- `KIND_VALUES` — **new canonical constant** (today only duplicated as a local `KNOWN_KINDS` set in `validate.ts` and as prose in the skill): `note`, `finding`, `decision`, `runbook`, `project-context`, `reading-note`, `brain-gym-memo`, `summary`, `insight`.
- Re-export `CONFIDENCE_VALUES`, `STATUS_VALUES`, `SENSITIVITY_VALUES` (currently in `types.ts`) so all vocab is reachable from one module.
- `STRUCTURED_KINDS` and `BODY_TEMPLATES`: per-kind **required section headings**, derived from `vault-templates/*.md`:
  - `decision`: Claim, Context, Evidence, Assumptions, Tradeoffs, Decision, Consequences, What would change this
  - `finding`: Finding, Evidence, Source references, Confidence, Validation needed, Risk if wrong, Related notes
  - `project-context`: Summary, Goals, Constraints, Key decisions, Open questions
  - `runbook`: Purpose, Preconditions, Steps, Verification, Rollback, Notes
  - `brain-gym-memo`: Claim, Evidence, Assumptions, Tradeoffs, Next test, What would change my mind, Evaluation
  - Free-form (`note`, `insight`, `summary`, `reading-note`): no required sections.
- Pure validators returning typed issues with a **severity**:
  - `validateNoteFields(fields, allow)` → checks `kind ∈ KIND_VALUES`, `confidence ∈ CONFIDENCE_VALUES`, `status ∈ STATUS_VALUES`, `tags` are well-formed strings (no spaces/`#`, length bound), `namespace`/`sensitivity` ∈ allowlist.
  - `validateNoteBody(body, kind)` → unsafe-Markdown checks (body must not begin with a `---` frontmatter block; flag raw block-level HTML), and **required-section presence** for structured kinds (D3).
- `NoteIssue { code, message, severity: "block" | "flag" }`. Default severities:
  - **block**: invalid `kind`/`confidence`/`status`/`tags`, frontmatter injection in body, missing structured-kind sections.
  - **flag**: raw HTML present, malformed/empty `[[wikilink]]`.
- Per-rule severity is **config-overridable** (so D3 can be relaxed to `flag` later without code change): `config.note_rules.<code>.severity`.

### 7.2 Proposal-time enforcement (REJECT) — `validate.ts` + `createProposal`

- Pass the full field set into validation: extend `validateProposal` input with `confidence`, `status` (defaulted to `active` when the gateway sets it), and `tags`; call `validateNoteFields` + `validateNoteBody`.
- Map any `severity:"block"` issue to a blocking flag → existing `blocked=true` path → `reviewState:"rejected"` with a clear `reviewerNotes` message (reuse current plumbing in `createProposal`).
- Replace the local `KNOWN_KINDS` set with `KIND_VALUES` import.
- Add the new blocking codes to the approve-time `blockingCodes` list in `reviewProposal` (defense-in-depth).
- `memory_propose_note` input schema (`src/mcp/build.ts`): accept optional **`tags: string[]`** (validated); write them into frontmatter in `buildNoteFrontmatter` instead of the hard-coded `tags: []`. (`status` remains gateway-set to `active` on creation; it becomes user-settable only via direct edit, governed by scan-time validation.)

### 7.3 Scan-time enforcement (FLAG) — `indexer.ts` / `frontmatter.ts`

- Extend the scan path so direct VSCode/Obsidian edits are validated against the **same** `note-schema`:
  - In `parseNote` (or a new step in `scanVault`), run `validateNoteFields`/`validateNoteBody` and emit warnings/issues.
  - `deriveValidation` maps new issues → `validationStatus:"invalid"` (or `"incomplete"`) + `validationIssues`. Already down-ranked in search via `freshnessPenalty` (0.8 invalid / 0.9 incomplete); surfaced by `status`/`health`.
- Extend `VALIDATION_CODE_VALUES` (in `packages/shared/src/types.ts`) with: `invalid_kind`, `invalid_confidence`, `invalid_status`, `invalid_tags`, `body_frontmatter_injection`, `body_raw_html`, `missing_required_section`.
- **Quarantine (optional):** add `config.note_rules.quarantine_invalid` (default `false`). When `true`, `invalid` docs are excluded from search results entirely (not just down-ranked). Default keeps the human's own vault fully visible.
- Direct edits are **never hard-rejected** (it's the owner's vault); enforcement there is visibility + ranking, matching D2's "flag at scan time".

### 7.4 Skill rewrite — `skills/capturing-memories/SKILL.md`

Rewrite so every stated rule maps to an enforced check, and the language reflects that the gateway now **rejects** (not just guides):

- Expand the **note definition**: each field, its vocabulary, and the **body shape per kind** (the required sections), citing that structured kinds are rejected if sections are missing.
- Update the Iron Rules table to include `confidence`, `status`, `tags`, and "body is rejected if it begins with `---` or omits required sections for its kind".
- Keep the existing approval-gate guidance (out-of-band code, never claim saved before `merged`).
- Add a short "what the gateway enforces vs. what you must get right" table so the model knows which mistakes are auto-rejected (fix-and-retry) vs. advisory.

---

## 8. Part 2 — ChatGPT connector

### 8.1 HTTP transport entrypoint

- New `src/mcp/http.ts` + script `"mcp:http": "tsx src/mcp/http.ts"`.
- Builds `buildMcpServer(chatgptProfile)` and serves the MCP **Streamable HTTP** transport (`@modelcontextprotocol/sdk/server/streamableHttp.js`) at `POST/GET/DELETE /<SECRET>/mcp`.
- Session handling: session-managed via the SDK (`mcp-session-id` header), with an in-memory session→transport map; stateless fallback acceptable for a single-user deployment.
- Listens on `MCP_HTTP_PORT` (localhost); **ngrok** provides the public HTTPS URL.

### 8.2 Auth MVP — capability-URL token (D7)

- The unguessable path segment `<SECRET>` **is** the bearer token (a capability URL). This is the token form ChatGPT's connector UI can carry (it just stores the URL). Also accept `Authorization: Bearer <SECRET>` for clients that send headers.
- `<SECRET>` = `MCP_HTTP_TOKEN` env (≥ 32 chars, high entropy). Constant-time compare; **401** otherwise, before the request reaches the transport.
- **Security guidance (documented):** given D5 (private notes egress), treat the URL as a secret credential — keep the tunnel **off when not in use**, rotate `MCP_HTTP_TOKEN` if leaked, and prefer the OAuth follow-up before leaving the endpoint always-on. The no-`review` capability + approval-code gate still bound write blast-radius regardless.

### 8.3 ChatGPT-canonical `search` / `fetch` tools

Add two tools with ChatGPT's **exact** response contract (both `structuredContent` **and** a `content` text item holding the JSON-encoded same object):

- `search(query: string)` → `{ results: [{ id, title, url }] }`. Wraps `search()`; scoped by the chatgpt profile.
- `fetch(id: string)` → `{ id, title, text, url, metadata }`. Wraps `fetchDocument()`; scoped.
- `url` (for ChatGPT citations) from config `connectors.chatgpt.public_base_url` (env override `MCP_HTTP_PUBLIC_BASE_URL`), e.g. `https://…/<SECRET>/memory/documents/<id>`, falling back to `memory://<id>`.

These make the connector valid as a **developer-mode full MCP connector** (read+propose, D4) and additionally usable as a read-only Deep Research source (ChatGPT models are tuned to call tools named `search`/`fetch`).

### 8.4 Write path from ChatGPT

- ChatGPT may call `memory_propose_note` / `memory_propose_patch` (scoped, validated per Part 1). It cannot approve (no `review` tool; no tool returns the approval code). Worst case: a queued proposal the owner reviews/rejects from the terminal.

### 8.5 Connect runbook (docs)

New short doc: start gateway (db + `mcp:http`) → `ngrok http $MCP_HTTP_PORT` → copy `https://<ngrok-host>/<SECRET>/mcp` → ChatGPT **Settings → Apps & Connectors → Advanced → Developer mode** → add connector with that URL, auth = none (token is in the URL) → enable tools per conversation. **Prerequisite:** workspace admin has enabled developer mode / custom connectors (see §11 risk).

---

## 9. Cross-cutting

### 9.1 Tests (deterministic, per project discipline)

- `note-schema`: each field valid/invalid; body templates per structured kind; unsafe body (leading `---`, raw HTML); free-form kinds exempt from sections.
- `validateProposal`: rejects each new violation (invalid kind/confidence/status/tags, missing section, body injection); happy path passes; severity config override flips block↔flag.
- Scan-time: a vault file with an invalid kind → `validationStatus:"invalid"`, issue recorded, down-ranked; `quarantine_invalid` excludes it.
- Scope/profiles: chatgpt profile honors scope; `claude-code` default unchanged; `"*"` resolves against config allowlist; profile can't widen beyond config.
- Tool registration: chatgpt profile exposes no `memory_review_proposal`; stdio profile does.
- HTTP transport (integration): 401 without/with wrong token; valid token reaches transport; `search`/`fetch` return both `structuredContent` and JSON-encoded `content` text; propose works, approve tool absent.

### 9.2 Error handling

- HTTP: 401 on bad/missing token; non-`/mcp` paths 404; JSON-RPC errors via the transport; scope denial **fails closed** (empty intersection → `[]`, already implemented).
- Proposal-time: blocking issues → `rejected` with explanatory `reviewerNotes`.
- Scan-time: per-file parse/validate is non-fatal; one bad file never aborts the scan.

### 9.3 Config / env additions

- `config.yaml`: `connectors:` block (§6.1); optional `note_rules:` (`<code>.severity`, `quarantine_invalid`).
- Env: `MCP_HTTP_PORT`, `MCP_HTTP_TOKEN`, optional `MCP_HTTP_PUBLIC_BASE_URL` (overrides `connectors.chatgpt.public_base_url`). Add to `.env.example`.

## 10. File-by-file change list

**Create**

- `packages/shared/src/note-schema.ts` — vocab + `BODY_TEMPLATES` + `validateNoteFields`/`validateNoteBody` + severities.
- `apps/memory-gateway/src/mcp/http.ts` — Streamable-HTTP entrypoint + token auth.
- `apps/memory-gateway/src/mcp/chatgpt-tools.ts` — `search`/`fetch` ChatGPT-shaped tools (or inline in `build.ts`).
- `docs/chatgpt-connector.md` — connect runbook.
- Tests under `apps/memory-gateway/tests/` and `packages/shared/`.

**Modify**

- `packages/shared/src/types.ts` — `KIND_VALUES` (or via note-schema); extend `VALIDATION_CODE_VALUES`.
- `packages/shared/src/index.ts` — export note-schema.
- `apps/memory-gateway/src/proposals/validate.ts` — consume note-schema; new blocking flags; replace `KNOWN_KINDS`.
- `apps/memory-gateway/src/proposals/index.ts` — pass confidence/status/tags; extend `blockingCodes`; write `tags` in `buildNoteFrontmatter`.
- `apps/memory-gateway/src/mcp/build.ts` — `buildMcpServer(profile)`; profile-gated registration; ChatGPT tools; ctx scope.
- `apps/memory-gateway/src/mcp/index.ts` — load `claude-code` profile.
- `apps/memory-gateway/src/policy/index.ts` — allowlist-bearing `resolveScope`; `"*"` resolution.
- `apps/memory-gateway/src/config/index.ts` — parse/validate `connectors` + `note_rules`; `getConnectorProfile`.
- `apps/memory-gateway/src/retrieval/*.ts`, `src/health/index.ts` — accept `ctx.scope`.
- `apps/memory-gateway/src/ingest/indexer.ts` (+ `frontmatter.ts`) — scan-time validation via note-schema; `deriveValidation` mapping; quarantine.
- `apps/memory-gateway/package.json` — `mcp:http` script.
- `config.yaml`, `.env.example` — new config/env.
- `skills/capturing-memories/SKILL.md` — rewrite to mirror enforced rules.

## 11. Risks & open items

- **Workspace admin dependency (external):** ChatGPT developer mode / custom connectors are subject to org permissions on Business/Enterprise/Edu. If IT hasn't enabled them, the read+propose path is blocked until they do. *Confirm before/early in implementation.* Fallback: personal Plus/Pro account, or read-only Deep Research.
- **Private-note egress (D5):** accepted by owner; documented; reversible via config.
- **ngrok free URL rotation:** URL changes per restart → re-paste into ChatGPT. A paid ngrok static domain or Cloudflare Tunnel removes this; not blocking.
- **OAuth follow-up:** token-URL is the MVP; OAuth 2.1 is the recommended hardening before an always-on endpoint.
- **Stricter validation rejects previously-accepted shapes:** intended (D2/D3); legacy vault notes are only flagged, never mutated.

## 12. Acceptance criteria

1. A proposal with an invalid `kind`/`confidence`/`status`/`tag`, an injected `---` body, or a structured kind missing required sections is **rejected** (`reviewState:"rejected"`) with a clear reason — via both `memory_propose_note` (stdio and HTTP).
2. A direct vault edit with the same defects is indexed as `validationStatus:"invalid"` with the corresponding issue codes and is down-ranked (or excluded if `quarantine_invalid`).
3. The note definition, vocabularies, and per-kind body shape live in one `note-schema` module consumed by both proposal-time and scan-time paths; `SKILL.md` matches it.
4. ChatGPT (developer mode) connects to `https://<ngrok>/<SECRET>/mcp`, can `search`/`fetch` (correct response shape) across all namespaces/sensitivities, and can `memory_propose_note`/`propose_patch`; it has **no** approve capability and cannot obtain the approval code.
5. Requests without the token get **401**; the `claude-code` stdio path is unchanged with no `connectors:` block present.
6. New behavior is covered by deterministic tests (§9.1) and `pnpm typecheck` + `pnpm test` pass.
