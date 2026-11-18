# Memories architecture

`apps/memory-server` serves current Markdown files through nine MCP tools and
an overview resource. Each vault has a separate root, recoverable history, lock,
and maintenance state. Keep vaults, credentials, deployed units, and operational
records outside the source checkout. Example Linux layouts are in the
[deployment guide](../../deploy/README.md).

## Vault isolation

`src/config.ts` loads legacy personal-only environment configuration or a private
`MEMORIES_CONFIG` JSON registry. A registry binding contains an ID, absolute vault
and state paths, and a distinct HTTP credential. Examples use `personal`, `work`,
and `family`; IDs are configurable, with `personal` as the required default.

`src/http.ts` authenticates and selects exactly one binding before constructing
its MCP server. All tools and resources stay within that binding; the client
cannot select another vault through tool arguments. `kb_peek.vault` and server
initialization instructions identify the authorized scope. Reject overlapping
physical roots/state, duplicate IDs/tokens, and conflicting URL/header credentials.
Local stdio and maintenance use `MEMORIES_VAULT_ID`, defaulting to `personal`;
an unknown explicit ID fails instead of falling back.

Credentials currently grant all tools over their selected vault. A note's
`sensitivity` property is descriptive and does not restrict reads, writes,
history, search snippets or maintenance reports. Agent-specific access within a
vault needs a server-enforced policy and distinct credentials; see the
[note and authorization design](../note-model.md). Client instructions alone
cannot enforce it.

## Note changes and recovery

`kb_remove` requires the note's fetched SHA-256, saves its content in private
history and removes only that file. `kb_restore` can recreate the removed note;
pass an empty `expected_hash` to avoid replacing a note recreated in the meantime.
Restoring an existing note accepts its current hash and preserves its current
content in history. Omitting the restore precondition remains supported for
older clients. Ordinary Markdown and existing frontmatter remain supported;
templates are editorial conventions rather than a storage schema.

## Clients and synchronization

Global client configuration uses personal. A project replaces the same `memories`
connection with its assigned credential and disables any independent connector
that exposes another vault. Verify the returned vault before memory use. New
repositories/worktrees need their own configuration; a parent outside a Git root
is not a reliable source of inherited settings. MCP authorization does not limit
an agent's independent OS permissions.

Each vault connects to a separate Obsidian remote vault and Headless Sync service.
Desktop Sync and Headless Sync must not write the same local vault. MCP state is
outside Sync. For migration, back up source notes/history/configuration, verify
independent remote downloads before removing originals, and transfer associated
history so restoration cannot expose migrated notes through the old vault.

## Repository privacy

Use generic fixtures and examples only. Actual project names, directory mappings,
host identities, deployment domains, credentials, and vault contents belong in
private configuration or the authorized owner vault, never repository files.
