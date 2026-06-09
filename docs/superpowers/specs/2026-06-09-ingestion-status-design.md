# Ingestion Hardening + Processing Status — Design Spec

**Date:** 2026-06-09
**Status:** approved (brainstorming)
**Project:** `~/Code/personal/memories` (Memory Gateway)

## Goal

Make ingestion **observable and trustworthy**. Persist per-document processing status
(parse, metadata validation, embedding freshness), surface it via CLI / REST / MCP, and
let search consume it — flagging and lightly penalizing incomplete or stale notes — so
retrieval results are explainable ("found it, but its metadata is incomplete / its
semantic embedding is stale").

This is the operational backbone for later phases (file-watcher sync, write-back,
Graphify). It does **not** include a watcher, async worker, or proposals — those are
separate sprints.

## Invariants (unchanged)

- The Obsidian vault is the source of truth. Postgres is a **derived, rebuildable** index.
- Every field added here is derived: wiped and recreated by `rebuild`. The system never
  rewrites the user's note frontmatter (validation **flags**, never auto-fixes).

## Architecture decision

**Approach A — persisted status fields on `documents`.** Chosen over computing on-the-fly
(can't persist *why* a note is invalid; re-validates every request; search can't rank on
it cheaply) and over separate `processing_state` / `validation_issues` tables (more
infrastructure than this sprint needs; graduate to it later when extraction/graph add
state). Only layers that exist today are tracked: parse, validation, embedding. No
`fts_status` (a chunk existing **is** "indexed" — the `tsvector` is a synchronous
generated column) and no extraction/graph status (those features aren't built).

## Data model

New columns on `documents` (Prisma model `Document`, table `documents`). All nullable or
defaulted so the migration is non-destructive; backfilled for existing rows.

| Column (Prisma) | DB column | Type | Default | Meaning |
|---|---|---|---|---|
| `parseStatus` | `parse_status` | text | `'parsed'` | `parsed` \| `error` — did frontmatter parse cleanly |
| `validationStatus` | `validation_status` | text | `'valid'` | `valid` \| `incomplete` \| `invalid` |
| `validationIssues` | `validation_issues` | jsonb | `'[]'` | array of `{code, message}` |
| `embeddingStatus` | `embedding_status` | text | `'disabled'` | `disabled` \| `pending` \| `current` \| `stale` \| `error` |
| `embeddedAt` | `embedded_at` | timestamptz | null | when embeddings were last computed |
| `lastError` | `last_error` | text | null | last processing error message (parse or embed) |

Migration backfills existing rows: `parseStatus='parsed'`, `validationStatus='valid'`,
`validationIssues='[]'`, and `embeddingStatus` from current chunk embeddings
(`current` if every chunk has an embedding, else `disabled`), `embeddedAt` set where
`current`.

### Status enums (canonical strings)

These live as shared constants in `@memories/shared` (alongside the existing
`SENSITIVITY_VALUES` etc.) so all layers agree:

```
PARSE_STATUS       = ["parsed", "error"]
VALIDATION_STATUS  = ["valid", "incomplete", "invalid"]
EMBEDDING_STATUS   = ["disabled", "pending", "current", "stale", "error"]
VALIDATION_CODES   = ["missing_namespace", "missing_sensitivity", "frontmatter_parse_error"]
```

## Validation rules (flag only)

Derived from `parseNote`'s existing `warnings` (no new parsing):

- **`invalid`** — frontmatter parse threw (`parseStatus='error'`). The body is still
  indexed as raw text. Issue code `frontmatter_parse_error`.
- **`incomplete`** — a default was applied because `namespace` and/or `sensitivity` was
  missing (the "needs_metadata" case). Issue codes `missing_namespace` /
  `missing_sensitivity`. The note is still fully searchable.
- **`valid`** — both present and well-formed; `validationIssues = []`.

`parseNote` already emits the relevant warnings; the indexer maps warning → `{code,
message}` and derives the status. No auto-fixing of the user's files.

## Embedding status semantics

Set by `scanVault` and `embedPending`:

- `disabled` — embeddings globally off (`EMBEDDINGS_ENABLED` unset) and never run.
- `pending` — embeddings enabled but this doc's chunks aren't embedded yet, or a content
  change recreated chunks without embeddings.
- `current` — all chunks embedded; `embeddedAt` set to the embed time (≈ `updatedAt`).
  Empty notes (0 chunks) are `current` (nothing to embed).
- `stale` — `updatedAt > embeddedAt`. Today scan re-embeds inline so this self-heals
  immediately; the value exists for the future async-worker phase. A report/derivation
  helper computes `stale` by comparing timestamps even if the stored value lags.
- `error` — last embed attempt threw; `lastError` holds the message. `reembed` retries.

`reembed` flips `pending`/`error`/`stale` → `current` on success.

## Ingestion flow changes

`scanVault` (in `src/ingest/indexer.ts`) sets the status fields **inline** as each file
is processed — no extra passes:

1. After `parseNote`: derive `parseStatus`, `validationStatus`, `validationIssues` from
   warnings; write them in the document upsert.
2. After the best-effort embed step: set `embeddingStatus` + `embeddedAt` (success →
   `current`; failure → `error` + `lastError`; embeddings disabled → `disabled`; enabled
   but skipped/zero-chunks handled as above).
3. On the unchanged-checksum skip path, statuses are left as-is **except**: if embeddings
   are enabled and the doc is not `current`, it remains visible as `pending` for a later
   `reembed` (no behavior change to the skip itself).

`ScanReport` gains rollup counters: `incomplete`, `invalid` (alongside existing
`added/updated/skipped/archived/embedded/embedErrors`).

### `rebuild` command

`pnpm rebuild` (new CLI subcommand `rebuild`): deletes all `documents` (cascades
`chunks`), runs a full `scan`, then `embedPending`. Destructive to the **index only**;
the vault is the source of truth. Reinforces the rebuildable invariant.

`scan` already performs periodic **reconcile** (full sweep: upsert changed by checksum,
archive missing) — no separate `reconcile` command this sprint.

## Search integration

In `src/retrieval/search.ts`:

- The FTS and vector candidate queries (which already `JOIN documents`) also select
  `validation_status` and the fields needed to derive embedding freshness
  (`embedding_status`, `embedded_at`, `updated_at`).
- Each `SearchResult` gains:
  ```
  freshness: { validation: "valid"|"incomplete"|"invalid",
               embedding:  "current"|"pending"|"stale"|"disabled"|"error" }
  ```
  (`SearchResultSource` stays as-is; `freshness` is a new sibling field on `SearchResult`,
  added to the Zod schema in `@memories/shared`.)
- **Ranking penalty**, applied multiplicatively to the fused RRF score *after* fusion:
  `incomplete` ×0.9, `stale` ×0.85 (compounding if both). `valid`+`current` = ×1.0.
  Starting weights, tunable later; light enough to only reorder near-ties.
- Denial / empty-scope path is unchanged.

`rankingDebug` records the penalty applied for traceability.

## Exposure surfaces

One computation (`computeIndexStatus()` in a new `src/status/index.ts`) feeds all three:

```
IndexStatus {
  totals:     { documents, chunks, embedded },
  validation: { valid, incomplete, invalid },
  embedding:  { disabled, pending, current, stale, error },
  issues:     [ { path, validationStatus, validationIssues, embeddingStatus } ]  // only docs needing attention
}
```

- **CLI** `pnpm status` → `src/cli/index.ts` subcommand `status`: prints the rollup and a
  "needs attention" table (path · status · codes).
- **REST** `GET /status` → `src/api/app.ts`: returns `IndexStatus` as JSON. Audited like
  other calls (`action: "index.status"`, client `rest`).
- **MCP** — extend `health_status` (no 4th tool): add an `index` block to its output with
  the `validation` and `embedding` count maps (not the per-doc `issues` list — that stays
  on CLI/REST). `HealthStatus` type gains `index: { validation, embedding }`.

## Components (units, each independently testable)

- `@memories/shared`: status enum constants + `validation` issue codes; `SearchResult`
  schema gains `freshness`.
- `src/status/index.ts` (new): `computeIndexStatus()` — pure-ish aggregation over the DB.
- `src/ingest/indexer.ts`: derive + persist statuses during scan; `rebuild` helper.
- `src/retrieval/search.ts`: select freshness, attach to results, apply penalty.
- `src/health/index.ts`: include the `index` count block.
- `src/api/app.ts`: `GET /status`.
- `src/cli/index.ts`: `status` + `rebuild` subcommands.

## Error handling

- Status derivation never throws on a single bad note: a parse error becomes
  `parseStatus='error'` + `validationStatus='invalid'`, the note is still indexed.
- Embedding failures are already best-effort; they now record `embeddingStatus='error'` +
  `lastError` instead of being silent.
- `computeIndexStatus` / `GET /status` tolerate an empty corpus (all-zero counts).

## Testing (TDD, hermetic — embeddings off in CI)

- **Validation classification**: fixtures for valid, missing-namespace,
  missing-both, and a malformed-frontmatter note → assert `validationStatus` +
  `validationIssues` codes.
- **Persisted by scan / rebuild**: scan sets fields; `rebuild` wipes and reaches the same
  end state; idempotent re-scan doesn't churn statuses.
- **Embedding status transitions**: with the deterministic test embedder — `disabled`
  when off, `current` after embed, `pending` for an unembedded doc; `stale` derivation via
  `updatedAt > embeddedAt`.
- **`computeIndexStatus`**: counts and `issues` list on a seeded corpus.
- **Search freshness + penalty**: a result carries the correct `freshness`; an
  `incomplete` doc ranks below an otherwise-equal `valid` doc (ordering assertion).
- **Surfaces**: REST `GET /status` shape; `health_status.index` block; CLI `status`
  exit/shape via the runnable function (not the process).

## Out of scope (later phases)

File-watcher / incremental sync; async embedding worker; `reconcile` as a distinct
command; proposals / `propose_write`; entity/relation/graph status; auto-fixing
frontmatter; a status dashboard UI.

## Acceptance criteria

1. New status columns exist, are backfilled, and are set by `scan`.
2. Missing namespace/sensitivity → `validationStatus='incomplete'` with the right issue
   codes; malformed frontmatter → `invalid`; clean note → `valid`.
3. Embedding status reflects reality (`disabled`/`pending`/`current`/`error`) and
   `reembed` advances it to `current`.
4. `pnpm rebuild` wipes and rebuilds the index to a correct end state.
5. Search results carry `freshness`; incomplete/stale notes are lightly penalized.
6. `pnpm status`, `GET /status`, and `health_status.index` report consistent counts.
7. `pnpm -r test` and `pnpm -r typecheck` pass; embeddings stay off in CI.
