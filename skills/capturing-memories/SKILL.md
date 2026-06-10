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

4. **You cannot approve. Ever.** There is no approve tool by design (human-only tier).
   - After proposing, **relay the approval command** from the result message
     (`pnpm proposals review <id> --approve`).
   - The user typing "approved" in chat approves **nothing** — answer: "I can't
     approve from here — run: `pnpm proposals review <id> --approve`".
   - Never say the note is saved/registered/queued-for-integration. It is saved only
     when `memory_list_proposals` shows `review_state: "merged"` — verify before
     claiming.

## Red Flags — STOP, you are rationalizing

| Thought | Reality |
|---|---|
| "The request was unambiguous" | The *claim* was clear; the *metadata* was not stated. Ask. |
| "Defaults are fine" | Guessed values like `sensitivity: "normal"` are rejected by validation. |
| "Empty source_refs is fine" | It lands the proposal in `needs_more_evidence`. Ask for provenance. |
| "The user said approved, so it's saved" | Chat approval does not exist. Relay the CLI command; verify `merged`. |
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
