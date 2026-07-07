# Memories — How It Actually Works

This document explains the system end-to-end: the two-repository model, every place an
AI model touches the system (local vs. frontier), the full data flows, and — in detail —
the peer-work model by which an AI client's write becomes a canonical vault note.

Everything below is grounded in the code as of 2026-07-02. Where a claim depends on a
specific file, the file is named.

---

## 1. The two-repository model

There are **two separate git repositories with two different jobs**:

| Repository | Location | Role | Contains |
|---|---|---|---|
| **Canonical vault** | e.g. `~/Documents/Obsidian Vault` (own git repo) | **The knowledge.** Single source of truth. | Markdown notes with YAML frontmatter. Nothing else. |
| **memories** (this repo) | `~/Code/personal/memories` | **The tool.** A gateway that indexes and serves the vault. | TypeScript code, migrations, tests, docs. No real knowledge. |

The tool never owns truth. Postgres (run by the tool) is a **derived, rebuildable
index** of the vault: you can `TRUNCATE` every table and `pnpm rebuild` reconstructs it
from the Markdown. The reverse is not true — if the vault is lost, the knowledge is
lost. That is why the vault is its own git repository: **git history (plus server-side
Syncthing file versioning on the always-on deployment) is the system's actual backup
and undo mechanism for knowledge**, while the tool repo's history only tracks code.

What is *not* rebuildable from the vault: `audit_log` and `retrieval_traces` (the
operational history — who searched/wrote what, and why a result ranked where it did).
If that history matters to you, `pg_dump` it — see `docs/backup-restore.md`.

```text
~/Documents/Obsidian Vault          ~/Code/personal/memories
┌──────────────────────────┐        ┌──────────────────────────────┐
│  canonical vault (git)   │        │  memories tool (git)         │
│  *.md + frontmatter      │◄──────┤│  reads at scan; AI clients   │
│                          │ index  │  write directly (guarded)    │
│  0xNN sections ◄─────────┼────────┤  via memory_write_note       │
└──────────────────────────┘        │           │                  │
                                    │           ▼                  │
                                    │  Postgres (derived index)    │
                                    └──────────────────────────────┘
```

---

## 2. Where AI is used — the complete inventory

### 2.1 Inside the gateway: ONE local model, nothing else

The gateway source contains exactly **one** outbound network client
(`apps/memory-gateway/src/embed/index.ts`): an OpenAI-*compatible* embeddings client
pointed at **LM Studio on `http://localhost:1234`**, running
`text-embedding-nomic-embed-text-v1.5` (768-dim) **on your machine**.

- Used at **ingest** (each chunk is embedded when scanned) and at **query time** (your
  search query is embedded to run vector similarity).
- It is **best-effort**: if LM Studio is down, search silently degrades to full-text
  only. Nothing queues for the cloud; nothing fails.
- Controlled by `EMBEDDINGS_ENABLED` / `EMBEDDINGS_URL` / `EMBEDDINGS_MODEL` /
  `EMBEDDINGS_DIM` in `apps/memory-gateway/.env`. Tests force it off.

**The gateway never calls Anthropic, OpenAI, or any cloud AI for reasoning.** There is
no LLM call anywhere in the gateway's own code — ranking is Postgres `ts_rank` +
cosine similarity + reciprocal-rank fusion; the only checks on a write are two
deterministic guards (Section 4). No summarization, extraction, or scoring step exists.

### 2.2 Outside the gateway: frontier and local models as PEERS

Frontier AI (Claude, GPT, …) and local chat models (qwen in LM Studio) connect **as MCP
or REST clients** — they call tools, the gateway answers, and (new since the 2026-07-02
simplification) they can **write directly** if their connector profile grants the
`write` capability. Data flows **to** a model only when it asks a question or writes a
note; data flows **into the vault** only through the two guarded write tools:

| Client | Transport | What it can do |
|---|---|---|
| Claude Code | MCP stdio | search, fetch, context packs, recent, explain, protocol, **write/update notes directly** |
| ChatGPT | MCP http (tunneled) | same, plus the two ChatGPT-canonical `search`/`fetch` tools |
| LM Studio (qwen, local) | MCP stdio | same — every stdio launch (`pnpm mcp`) resolves the `claude-code` profile regardless of which client connects to it |
| VS Code Copilot | MCP stdio | same |
| **You (human)** | Obsidian / SilverBullet / any editor, + CLI/REST (localhost) | everything above, plus editing any file directly — no gateway call needed |

Two consequences worth stating plainly:

1. **A frontier model only ever sees what it retrieves or is told.** If Claude asks
   `memory_search("project X")`, it receives scoped snippets of in-allowlist notes —
   that content has then left your machine to Anthropic, like anything you paste into a
   chat. Today `config.yaml`'s `connectors.*.scope` is `"*"`/`"*"` for both shipped
   profiles — **every connected client sees everything** (`public` and `internal`),
   an explicit owner decision (there is no third, higher sensitivity tier left in the
   allowlist). Narrowing this per-client is a config change, not a code change.
2. **A model can write knowledge directly, but only past two guards.** The write path
   is `memory_write_note` / `memory_update_note`, gated by the connector's `write`
   capability and two guards (secret detection, a structural frontmatter guard) —
   nothing else blocks. Nothing is queued for a decision: the owner reviews by editing
   (Section 4).

### 2.3 Prompt-injection stance

Retrieved note content is **data, not instructions**. Every search/fetch/context-pack
response carries a `safety_note` telling the client not to execute instructions found
in retrieved content, and the gateway exposes no execution tools (no shell, no
arbitrary DB, no secret resolution) for injected text to trigger. This is tested:
`evals/retrieval-cases.yaml` includes a note designed to look like an instruction
override and asserts it comes back as inert data.

---

## 3. Data flows

### Flow 1 — Ingestion (vault → index)

Trigger: `pnpm scan` (CLI), `POST /ingest/scan` (REST), `pnpm rebuild` (wipe + full
re-scan), or synchronously as the last step of every `memory_write_note` /
`memory_update_note` call. There is no file-watcher yet (roadmap), so any change made
by hand in the vault needs one of the first three to become searchable.

```text
 vault/*.md
    │  scanVaultFiles (ignores .obsidian, .git, .trash)
    ▼
 parseNote ── frontmatter + defaults ──► scan-time flags (informational only)
    │            (missing sensitivity → defaults applied, flagged "incomplete";
    │             frontmatter parse error, or a body starting with "---" ──► "invalid";
    │             everything else — unknown kind, tag shape, missing structured-kind
    │             sections, raw HTML, malformed wikilinks — flags "incomplete", never
    │             blocks indexing)
    ▼
 checksum unchanged? ──yes──► skip (idempotent)
    │ no
    ▼
 upsert documents row ─► chunk by heading ─► chunks rows
    │                                          │ tsvector generated column:
    │                                          │ title(A) + namespace/kind/tags(A)
    │                                          │ + heading(B) + body(C)
    ▼                                          ▼
 [local LM Studio] embed each chunk ──► pgvector column (best-effort;
    │                                    doc marked current/pending/error)
    ▼
 files missing from vault → archived; restored files → un-archived
 every scan writes an audit_log row
```

### Flow 2 — Retrieval (client → answer)

Trigger: `memory_search` / `memory_fetch` / `memory_context_pack` / `memory_recent`
(MCP), or the REST equivalents.

```text
 client query
    │
    ▼
 POLICY (src/policy): requested namespaces/sensitivities ∩ connector scope ∩ config.yaml allowlists
    │   empty intersection → fail closed: [] + audit(approved=false). Nothing queried.
    ▼
 hybrid candidates, BOTH scope-filtered in SQL:
    ├─ full-text: websearch AND-first, OR-fallback (ts_rank)
    └─ vector:    query embedded LOCALLY → cosine over pgvector
    ▼
 reciprocal-rank fusion ─► freshness penalty (incomplete ×0.9, invalid ×0.8, stale-embedding ×0.85)
    ▼
 results: snippets + source(path/kind) + freshness(validation/embedding status) + score
          + safety_note + trace_id
    │
    ├─► retrieval_traces row (query, selected ids, ranking debug — see
    │    memory_explain_sources to read it back)
    └─► audit_log row (who, what, approved)
```

A **context pack** (`memory_context_pack`) is the same flow plus: group results by note
kind, build a token-budgeted brief with per-section source ids, and attach warnings
(truncation, stale/incomplete notices).

### Flow 3 — Knowledge write-back (AI writes directly → vault file → indexed)

This is the only path by which anything an AI produces becomes a vault file, and it
requires no human step. Full detail in Section 4.

```text
 AI client                          GATEWAY                          RESULT
────────────                ────────────────────────         ─────────────────────────
memory_write_note ─────────► guard: secret scan ──── hit ────► refused (Error; nothing written)
 (or memory_update_note)     guard: body starts with "---" ── hit ────► refused
                                      │ both pass
                                      ▼
                             build frontmatter (kind/sensitivity/tags/
                               source_refs?/created) from the tool arguments
                                      ▼
                             atomic write: temp file + rename, SAME directory
                               (SilverBullet can safely read mid-write)
                               to <folder>/<Title>.md (collision → " 2", " 3", …)
                                      ▼
                             synchronous rescan — searchable before the tool call returns
                                      ▼
                             audit_log row (memory.write_note / memory.update_note)
                                      ▼
                             returns { document_id, path } to the calling client

 Meanwhile, the owner reviews by editing the file directly (Obsidian / SilverBullet).
 Server-side Syncthing versioning (.stversions on the always-on deployment) is the undo —
 there is no accept/reject state machine and no queue to work through.
```

### Flow 4 — What leaves your machine, summarized

| Data | Leaves the machine? |
|---|---|
| Vault contents at rest | Never (unless you push the vault repo to a remote you choose) |
| Chunks/embeddings/audit in Postgres | Never (local Docker volume) |
| Embedding computation | Never — localhost LM Studio only |
| Search results / context packs | **Only** to the client that asked. Local client (LM Studio/qwen) ⇒ stays local. Cloud client (Claude, GPT) ⇒ that retrieved content goes to that provider — both shipped connector profiles currently allow `public` + `internal` (everything in the allowlist) |
| Notes written by AI clients | Written straight to a local vault file; the writing client only gets back `{document_id, path}` — the gateway never uploads the note anywhere itself |
| Secrets | Not stored anywhere by design — only `secret_ref: op://…` pointers are allowed; literal credentials are detected and the write is refused |

---

## 4. The write model, in depth

### 4.1 Why it exists

Owner-dictated simplification (`docs/superpowers/specs/2026-07-02-simplification-peer-model-design.md`)
replaced an earlier propose→approve pipeline: AI clients are treated as peers who write
directly, the same way you'd let a trusted colleague edit a shared doc — review happens
*after the fact*, by reading the diff (or the file) and changing what's wrong, not by
gating every write behind an approval queue. The only invariant that survives is
narrower: **no secret ever lands in the vault, and nothing can corrupt a note's
frontmatter** (Section 4.3). Everything else about what's a "good" note is guidance
(the protocol note, Section 4.6), not enforcement.

### 4.2 Who can do what

| Action | MCP (AI clients whose connector profile has `write`) | REST | You |
|---|---|---|---|
| write a new note | ✅ `memory_write_note` | — (no REST route) | edit/create the file directly |
| update a note's body | ✅ `memory_update_note` | — (no REST route) | edit the file directly |
| read (search/fetch/recent/context-pack/explain/protocol) | ✅ | ✅ (search/fetch/context-pack) | REST, or just open the vault |

There is no REST write route by design — REST is currently read/operate-only
(`apps/memory-gateway/src/api/app.ts`); writing is MCP-tool-only. There is also no
separate CLI gating command — the CLI (`apps/memory-gateway/src/cli/index.ts`) only has
`scan`, `reembed`, `rebuild`, `status`, and `audit`.

### 4.3 The two content guards

Both guards run in `apps/memory-gateway/src/notes/write.ts` on every
`memory_write_note` and `memory_update_note` call, and are the *entire* blocking
content-safety surface:

| Guard | What it catches | Bypassable? |
|---|---|---|
| **Secret detection** (`detectSecrets`) | Private key headers, AWS `AKIA…`, GitHub `gh[pousr]_…`, `password[:=]…`, `Bearer …` tokens, long hex/base64 secrets. A `secret_ref: op://…` reference is explicitly stripped before scanning, so pointers are never flagged. | No — throws, nothing is written |
| **Body frontmatter guard** (`assertNoFrontmatterInjection`) | A body whose first non-blank line is a bare `---` — the gateway composes frontmatter itself; a body-supplied `---` block could corrupt the file or re-scope the note. | No — throws, nothing is written |

Everything else that used to sit between a draft and a merged note — namespace/
sensitivity allowlist checks, duplicate/contradiction detection, "needs more evidence,"
a 0–12 scoring rubric, `human_review_required` labels — is gone. `sensitivity` is still validated against the
two allowed values (`public`/`internal`) as a plain input-validation check (an invalid
value is a usage error, not a policy gate). `folder` is also required and must point to
an existing vault folder; there is no inbox fallback.

Separately, at **scan time** (not write time), `packages/shared/src/note-schema.ts`
flags a few more things — unrecognized `kind`, malformed tags, missing structured-kind
sections, raw HTML, malformed wikilinks — but these are informational only
(`validationStatus: incomplete`, visible in `pnpm status` and slightly down-ranked in
search). They never block a write and never block indexing.

### 4.4 What `memory_write_note` actually does

`apps/memory-gateway/src/notes/write.ts`:

1. Run the two guards over `title + content`.
2. Validate `sensitivity` (default `internal`) is `public` or `internal`.
3. Resolve the target folder: `folder` is required, must already exist, and must
   resolve inside the vault root — the gateway never creates arbitrary directories on
   your behalf.
4. Turn the title into a human-readable filename; on collision, append ` 2`, ` 3`, ….
5. Compose frontmatter from the arguments: `kind` (sanitized to `[a-z0-9-_]`, default
   `note`), `sensitivity`, `tags` (sanitized), optional `source_refs` (quoted YAML
   strings), and `created` (today's UTC date). Body is `# <title>\n\n<content>`.
6. **Atomic write** — write to a temp file in the *same* directory, then `rename()`
   over the target path, so a concurrent reader (SilverBullet) never sees a partial
   file.
7. Trigger a full `scanVault()` synchronously — the note is searchable before the tool
   call returns.
8. Write an `audit_log` row (`memory.write_note`, `approved: true`).
9. Return `{ document_id, path }`.

`memory_update_note` is the same guard + atomic-write + rescan + audit pattern, but
looks up the target document by id, asserts the resolved path stays inside the vault
root, and replaces everything after the existing frontmatter block (frontmatter is
preserved byte-for-byte via `frontmatterEndOffset`).

### 4.5 Worked example

```text
# Claude Code (or ChatGPT, via the tunneled HTTP profile) calls the tool directly —
# no human step required:
memory_write_note({
  title: "UAT Analytics Finding",
  content: "...",
  kind: "finding",
  tags: ["client-a", "uat"],
  folder: "0x05 Projects/Personal"
})
# → { "document_id": "...", "path": "0x05 Projects/Personal/UAT Analytics Finding.md" }

# The file now exists in the vault, is versioned by Syncthing, and is already
# searchable. The owner reviews it later by opening it in Obsidian/SilverBullet and
# editing directly — there is no separate call to make it official.
```

### 4.6 The protocol note (working rules, not enforcement)

The actual "how to write a good note" guidance — allowed kinds, structured-kind
sections, tag rules, folder routing, link etiquette — lives in a single vault note,
`0x09 Meta/Protocol.md`, not in code. Every MCP client receives its contents as **server
instructions at `initialize`** (`apps/memory-gateway/src/mcp/build.ts`, via
`loadProtocol()`), so there is one copy to keep current instead of one per client
config. It's also re-readable any time via the `memory_protocol` tool. The
`capturing-memories` skill (`skills/capturing-memories/SKILL.md`) is the local,
install-time summary of the same rules for Claude Code specifically.

---

## 5. Frontmatter field reference

Vocabularies live in `packages/shared/src/types.ts` and
`packages/shared/src/note-schema.ts`; the write-time defaults are in
`apps/memory-gateway/src/notes/write.ts`. "Behavior" = what the tool actually does with
the value; everything else is a label for you and your AI clients to reason with.

### On the write surface (what `memory_write_note` accepts)

| Field | Values | Default | Behavior in the tool |
|---|---|---|---|
| `sensitivity` | `public` \| `internal` | `internal` | **Set-membership scope gate.** A note is retrievable iff its label is in `policy.allowed_sensitivity` (`[public, internal]` today) intersected with the requesting connector's scope (`"*"` for both shipped profiles — i.e. wide open). |
| `kind` | `note` `finding` `decision` `runbook` `project-context` `reading-note` `brain-gym-memo` `summary` `insight` | `note` | Groups context-pack sections; sets the staleness review interval (`brain-gym-memo` 30d, `finding`/`project-context` 60d, `runbook`/`reading-note` 90d, `decision` 120d, everything else/default 180d — see `REVIEW_INTERVALS_DAYS`). An unrecognized kind is flagged `incomplete` at the next scan — informational, never blocking. `decision`/`finding`/`project-context`/`runbook`/`brain-gym-memo` additionally expect specific body headings (`BODY_TEMPLATES`); missing ones are flagged the same way. |
| `tags` | lowercase, `.`/`_`/`/`/`-`, starts alphanumeric, ≤50 chars | `[]` | Indexed into full-text search (weight A) — a tag-only word still finds the note. |
| `source_refs` | free-form provenance strings (`chat:<client> <date>`, URLs, file paths) | omitted if none | Written verbatim (quoted) into frontmatter; no retrieval behavior yet. |
| `created` | `YYYY-MM-DD` | write-time UTC date | Metadata only. |
| `id` (any note, not a `memory_write_note` argument) | stable note id | derived from path | Identity across renames: keep `id` in frontmatter and you can move the file without creating a duplicate. |

**Not on the write surface:** `status`, `confidence`, and `namespace` no longer exist
as things an AI client sets. `memory_write_note`/`memory_update_note` never emit them.
They persist only as dormant internal index columns (e.g. `status: archived` is how the
scanner tombstones a file that disappeared from the vault; `namespace` still gates
retrieval scope internally and defaults to `policy.default_namespace`, currently
`personal`, for any note that doesn't set one) — pre-simplification notes may still
carry them in raw frontmatter, and `memory_fetch`/`memory_search` results still surface
the underlying `status`/`confidence` columns for backward compatibility, but neither
field means anything to the write path or the protocol.

Missing `sensitivity` never blocks indexing — the default applies and the note is
flagged `incomplete` (visible in `pnpm status`, slightly down-ranked in search).

---

## 6. Security model in one place

- **Scope = intersection.** Every retrieval intersects the request with the connector's
  configured scope and the `config.yaml` allowlists; requests can only narrow, never
  widen. Empty intersection fails closed (and the denial is audited). Enforced in the
  core, below every adapter — no client can bypass it. Both shipped connector profiles
  currently scope `"*"`/`"*"`, i.e. every client sees everything in the allowlist.
- **Out-of-scope is indistinguishable from non-existent** (`fetch` returns the same
  `null`/"not found" for both — no oracle).
- **Writes are guarded, not reviewed.** `memory_write_note`/`memory_update_note` only
  register when a connector's `capabilities` include `write`; every call still passes
  through the secret detector and the frontmatter guard (Section 4.3) regardless of
  which client is calling. There is no separate gating step to misconfigure or bypass.
- **Everything is audited**: search, fetch, recent, explain, context packs, health,
  scans, note writes/updates — `audit_log` rows with actor/client/action/approved
  (query via `pnpm audit:search` or `GET /audit`).
- **Traceability**: every search writes a `retrieval_traces` row;
  `memory_explain_sources(trace_id)` explains exactly which chunks an answer came from.
- **No secrets**: the write-path detector rejects credential-shaped content before it
  ever reaches disk; only `secret_ref: op://…` pointers are permitted in note bodies;
  there is no secret-resolution tool anywhere in the gateway.
- **Tested adversarially**: `evals/retrieval-cases.yaml` covers cross-namespace/
  sensitivity leakage, secret-ref handling, and prompt-injection-as-data, run on every
  `pnpm test` alongside the unit/integration suites in `apps/memory-gateway/tests/`.

---

## 7. Pointers

- Operational commands, endpoints, MCP tools, connector profiles: `README.md`
- ChatGPT connector setup (public HTTPS MCP endpoint): `docs/chatgpt-connector.md`
- Client setup (Claude Code, VS Code, LM Studio, Hermes, OpenClaw) + local model
  policy: `docs/executors.md`, `docs/mcp-clients.md`
- Backup & restore: `docs/backup-restore.md`
- Restricted/locked-down network deployment: `docs/deploy-restricted.md`
- Full history & roadmap (incl. deferred Graphify/BrainGym phases): note that
  `docs/implementation-plan.md` and `REVIEW_PACK.md` predate the 2026-07-02
  simplification, so any pending-review/sign-off workflow they describe is historical,
  not current behavior — this document and `README.md` are the source of truth for how
  the system works today.
