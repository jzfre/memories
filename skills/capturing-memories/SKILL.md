---
name: capturing-memories
description: Use when the user asks to remember, save, store, or capture knowledge into their memories vault, or when calling memory_propose_note / memory_propose_patch — including when the request seems complete or the user says "approved" in chat.
---

# Capturing Memories (proposing to the memories vault)

## Overview

The memories gateway accepts **proposals, not writes**, and now **rejects** proposals
whose metadata or body break the rules below. Invalid values are not stored — they come
back rejected. **A clear claim is not knowledge of its metadata or shape: ask, don't guess.**

## What a valid note is

Frontmatter is written by the gateway from these fields; the body is your `content`.

| Field | Valid values | If missing |
|---|---|---|
| `namespace` | owner's allowlist (`config.yaml`: `personal`, `career`, `brain-gym`, `home`, `public-research`, `testing`) | **ASK** — invalid → rejected |
| `sensitivity` | `public` \| `internal` \| `private` (allowlist) | **ASK** — invalid → rejected |
| `kind` | `note` `finding` `decision` `runbook` `project-context` `reading-note` `brain-gym-memo` `summary` `insight` | **ASK** — unknown kind → rejected |
| `confidence` | `confirmed` `high` `medium` `low` `unknown` | **ASK** — invalid → rejected |
| `tags` | lowercase, no spaces or `#`, start alphanumeric, `/` for hierarchy (e.g. `db/postgres`) | optional — malformed → rejected |
| `source_refs` | provenance: `chat:<client> <date>`, URLs, file paths | **ASK** — empty → `needs_more_evidence` |

## Body rules (enforced)

- Compose **Obsidian-renderable Markdown only**: headings, lists, tables, fenced code,
  callouts (`> [!note]`), task lists, `[[wikilinks]]`, `#tags`, `$math$`, mermaid.
- The body must **not** begin with a `---` frontmatter block (the gateway writes frontmatter) — **rejected**.
- **Structured kinds must include their sections** (missing sections → **rejected**):
  - `decision`: Claim, Context, Evidence, Assumptions, Tradeoffs, Decision, Consequences, What would change this
  - `finding`: Finding, Evidence, Source references, Confidence, Validation needed, Risk if wrong, Related notes
  - `project-context`: Summary, Goals, Constraints, Key decisions, Open questions
  - `runbook`: Purpose, Preconditions, Steps, Verification, Rollback, Notes
  - `brain-gym-memo`: Claim, Evidence, Assumptions, Tradeoffs, Next test, What would change my mind, Evaluation
- Free-form kinds (`note`, `insight`, `summary`, `reading-note`) have no required sections.
- Raw HTML and malformed/empty `[[wikilinks]]` are flagged (advisory).

## Enforced vs. advisory

| The gateway **rejects** (fix and re-propose) | The gateway **flags** (you decide) |
|---|---|
| invalid namespace/sensitivity/kind/confidence/tags | raw HTML in body |
| body starting with `---`; secret-like content | malformed/empty wikilink |
| structured kind missing required sections | duplicate title / missing source_refs |

## The approval gate (unchanged)

- One compact confirm question for namespace/sensitivity/kind/confidence/tags/source_refs.
- Use the user's wording; show what you'll submit before proposing.
- Approving requires an `approval_code` **no tool returns**: the owner reads it from their
  terminal (`pnpm proposals`) and provides it; then call
  `memory_review_proposal({proposal_id, action:"approve", approval_code:<code>})`.
  Never invent a code (5 wrong tries locks the gate to terminal-only).
- "approved" with no code approves **nothing**. Never say a note is saved until its
  `review_state` is `"merged"` — verify before claiming.

## Quick flow

```
user asks to remember X
  → draft title/content from their words (correct kind's sections if structured)
  → ONE confirm question for namespace/sensitivity/kind/confidence/tags/source_refs
  → memory_propose_note  (rejected? read the flags, fix, re-propose)
  → relay: proposal id + "to approve, run: pnpm proposals review <id> --approve"
  → only claim saved after review_state == "merged"
```
