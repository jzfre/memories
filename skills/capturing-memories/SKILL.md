---
name: capturing-memories
description: Use when the user asks to remember, save, store, or capture knowledge into their memories vault, or when calling memory_propose_note / memory_propose_patch — including when the request seems complete or the user says "approved" in chat.
---

# Capturing Memories (proposing to the memories vault)

## Overview

The memories gateway accepts **proposals**, not writes. Metadata fields are validated
against fixed vocabularies — invented values are rejected. **A clear claim is not
knowledge of its metadata: ask, don't guess.**

## The Iron Rules

1. **Never invent field values.** Only these exist:

| Field | Valid values | If missing |
|---|---|---|
| `namespace` | one of the owner's allowlist — check `config.yaml` or existing notes (`personal`, `career`, `brain-gym`, `home`, `public-research`, `testing`) | **ASK** |
| `sensitivity` | exactly `public` \| `internal` \| `private` (allowlisted today; "normal", "secret" etc. do not exist → rejected) | **ASK** |
| `kind` | `note` `finding` `decision` `runbook` `project-context` `reading-note` `brain-gym-memo` `summary` `insight` | **ASK** (suggest one) |
| `confidence` | `confirmed` `high` `medium` `low` `unknown` | **ASK** (suggest) |
| `source_refs` | honest provenance: `chat:<client> <date>`, URLs, file paths the user named | **ASK** — empty = proposal stuck in `needs_more_evidence` |

2. **One compact question, not an interrogation.** Propose defaults and let the user
   confirm/correct in one reply:
   > "Before I propose this: namespace `personal`? sensitivity `private`? kind
   > `decision`? confidence `high` (your own decision)? source: `chat:claude-code
   > 2026-06-10` — OK or adjust?"

3. **Use the user's wording.** Draft title/content from their words; show what you will
   submit. Don't silently rewrite their claim.

4. **Compose Obsidian-renderable Markdown only.** The note becomes a `.md` file in an
   Obsidian vault. Use: headings, lists, tables, fenced code, blockquotes & callouts
   (`> [!note]`), task lists (`- [ ]`), `[[wikilinks]]`, `#tags`, `$math$`, mermaid.
   **Avoid** raw HTML, custom/unsupported syntax, and frontmatter inside the body — the
   gateway writes the frontmatter, your `content` is body only (a patch body starting
   with `---` is rejected).

5. **Approval is the owner's, gated by a code you cannot get.** A `memory_review_proposal`
   tool exists, but approving requires an `approval_code` that **no tool returns**.
   - To approve: the **owner reads the code from their terminal** (`pnpm proposals`
     shows a `code` column) and gives it to you; then call
     `memory_review_proposal({proposal_id, action:"approve", approval_code:<that code>})`.
   - **Never invent or guess a code** — the gate locks after 5 wrong tries, after which
     only the terminal can approve (`pnpm proposals review <id> --approve`).
   - "approved" with no code approves **nothing** — ask the user for the code, or tell
     them to run `pnpm proposals review <id> --approve`.
   - Never say the note is saved/registered/queued. It is saved only when the proposal's
     `review_state` is `"merged"` — verify before claiming.

## Red Flags — STOP, you are rationalizing

| Thought | Reality |
|---|---|
| "The request was unambiguous" | The *claim* was clear; the *metadata* was not stated. Ask. |
| "Defaults are fine" | Guessed values like `sensitivity: "normal"` are rejected by validation. |
| "Empty source_refs is fine" | It lands the proposal in `needs_more_evidence`. Ask for provenance. |
| "I'll just guess the approval code" | No tool returns it; 5 wrong tries locks the gate. Ask the owner to read it from `pnpm proposals`. |
| "The user said approved, so it's saved" | Not until `review_state` is `merged`. A bare "approved" with no code does nothing. |
| "Asking is annoying" | One batched confirm question. Wrong metadata mis-scopes knowledge permanently. |

## Quick flow

```
user asks to remember X
  → draft title/content from their words
  → ONE confirm question for namespace/sensitivity/kind/confidence/source_refs
  → memory_propose_note
  → relay: proposal id + "to approve, run: pnpm proposals review <id> --approve"
  → only claim saved after review_state == "merged"
```
