# Readable notes and a small template vocabulary

The KB should explain a person's context to both that person and an agent.
Headings, concise prose, explicit uncertainty and useful links matter more than
a large metadata schema. A note should be understandable without knowing how
Memories works.

This is an optional editorial convention, not a server schema or access policy.
It has been reconciled with the authorized KB's protocol and template workflow.
The server continues to accept ordinary Markdown and existing frontmatter;
archived exports retain their original metadata.

## Kinds and templates

Use one active template for each kind, with an explicit one-to-one mapping.
Human-readable template filenames can differ from kind values. A kind describes the
shape and purpose of a note; tags describe its topics. Do not add a kind for each
project, hobby, source format or temporary workflow.

| Kind and template | Use when | Main content |
|---|---|---|
| `note` | Capturing a lasting fact, reference, observation or useful context | What is known, why it matters, sources and related notes |
| `project-description` | Explaining an ongoing or completed project | Purpose, current state, constraints, next steps and related decisions |
| `decision` | Recording a consequential choice with useful rationale | Decision, context, alternatives, consequences and review conditions |

Keep `decision` available without forcing ordinary observations into it. Create
a decision note when the rationale is worth remembering. Record a project's
current state in its description and link to decisions for historical reasoning.

The template supplies `kind`; there is no separate `template` property to keep in
sync. A title heading is enough unless a frontmatter title helps an existing
workflow. Add tags, aliases, dates or status only when they serve retrieval or a
real workflow. Preserve existing IDs, dates and unknown properties during cleanup.

### Note template

```markdown
---
kind: note
---
# Descriptive title

The useful fact or context, with uncertainty stated plainly.

## Sources and related notes

Links and dates that help verify or understand this note.
```

### Project description template

```markdown
---
kind: project-description
---
# Project title

What this project is for and why it matters.

## Current state

What works, what is in progress, and when this was last verified.

## Constraints and next steps

The important limits and the next useful action.

## Related notes

Links to decisions, references and supporting context.
```

### Decision template

```markdown
---
kind: decision
---
# Decision title

## Decision

What was decided, by whom if relevant, and when.

## Context and alternatives

The problem, constraints and meaningful alternatives considered.

## Consequences and review

Benefits, costs, open questions, and what would justify revisiting the choice.

## Sources and related notes

Links to supporting evidence and affected projects.
```

Remove empty sections when they add no value. Put current facts before historical
detail and retain meaningful history in a clearly labeled section or linked note.
Do not turn every note into a report with a fixed number of headings.

## Compatible cleanup

1. Read the current protocol, templates and representative notes in the authorized
   vault. Inventory kinds and template links before choosing a final mapping.
2. Reconcile these three kinds with established workflows. Update the
   protocol and active templates together, including any Obsidian template settings.
3. Retire unused templates from active selection while keeping recoverable copies
   outside the synced vault. Retiring a template does not justify deleting notes
   created from it.
4. Map a legacy specialized kind to `note` only after checking that it is ordinary
   reference/context. Preserve specialized content, links, tags and provenance.
   Ambiguous notes keep their original kind until reviewed.
5. Apply focused, hash-checked edits with history. Avoid path changes unless needed;
   links and external references can depend on paths. Verify affected links and
   representative rendered notes afterward.

No runtime whitelist is introduced. Older kinds and notes without frontmatter
remain readable, searchable and editable. An optional lint report could later
flag unknown kinds or template mismatches without blocking a write.

## Sensitivity and agent authorization

Today, `sensitivity` is descriptive metadata. Every HTTP credential grants all
tools over one vault, including complete note text, search snippets, recent-note
metadata, maintenance reports and history. A sensitivity value does not hide any
of those surfaces. The server does not authenticate an agent's claimed name.

The existing enforceable boundary is the vault selected by the credential.
Separate vaults and credentials can restrict which collection an agent reaches
through MCP. That only works when the agent cannot obtain another credential or
read the underlying vault, private history or backups through filesystem access.
Local stdio inherits the local account's permissions.

For finer access within a vault, add distinct credential identities and a policy
stored outside editable notes. Enforce that policy before every read, write,
remove, restore and metadata response. Filter search, overview, folder counts,
links and maintenance reports as well as full-note reads; otherwise they reveal
restricted context. Restrict history and restore according to the same policy.
An agent with ordinary note-write permission must not be able to change its own
access by editing `sensitivity`.

A practical first extension would be credentials with read-only or read/write
scope for one vault, followed by optional path scopes if the need is demonstrated.
Default-deny rules, explicit revocation and negative integration tests belong in
that implementation. Prompt instructions and MCP tool annotations help clients
behave but do not enforce authorization. Keep this as a separate, reviewable
change rather than silently turning existing descriptive labels into permissions.

## Other software improvements to consider

The current implementation favors a small, inspectable system: current Markdown
files, lexical search, optimistic hash checks, private recovery history and
deterministic maintenance. It already fits a human-readable extended-context KB.

| Improvement | Reason and compatibility constraint |
|---|---|
| Read-only credentials | Give retrieval agents less authority while preserving existing full-access credentials |
| Optional metadata linting | Find inconsistent kinds/templates without rejecting old notes or rewriting them automatically |
| Rename/move tool | Preserve history and report affected links; keep this separate from removal |
| Bounded history listing and retention policy | Large histories need paging and explicit retention; never silently discard recovery data |
| Search scaling based on measurement | Search currently scans notes; retain immediate freshness if adding an index |
| Deployment verification record | Distinguish tested checkout behavior from the version actually running and verified Sync behavior |

External editors and Sync do not share the MCP write lock. Hash checks catch
observed changes, but the final filesystem operation cannot guarantee a shared
transaction with those writers. Independent backups and tested recovery remain
necessary even with private MCP history.
