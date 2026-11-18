# Configurable vault isolation

## Intended behavior

- One assigned vault per project, with `personal` as the unconfigured default.
- No cross-vault search, reads, edits, removal or restoration through an MCP
  credential.
- Generic source, tests, examples and documentation. Example vaults are
  `personal`, `work` and `family`; IDs remain configurable and private project
  mappings stay outside Git.

## Implementation

- A private JSON registry supplies IDs, vault/state paths and distinct tokens.
- HTTP authentication selects one `VaultStore` before constructing its MCP
  server. All nine tools and the overview resource remain within that scope.
- `kb_peek` and server instructions identify the authorized vault.
- Legacy environment configuration remains personal. Unknown explicit local
  scope fails instead of falling back. Overlapping physical paths and duplicate
  credentials are rejected.
- Project clients replace the global connection and exclude independent
  connectors that expose another vault. Client instructions prohibit bypasses;
  operating-system permissions must separately restrict direct file access.
- Deployment examples cover separate Sync services and history directories.

## Migration and verification checklist

1. Back up source notes, history and private configuration before migration.
2. Configure independent remote vaults and verify downloaded content before
   removing source notes. Transfer associated history so restoration cannot
   recreate migrated content through the old scope.
3. Verify project-specific client configuration in every intended environment,
   including new repositories, worktrees and VM/container guests.
4. Run isolation tests for all tools, resources, same-path histories, conflicting
   credentials, invalid registries and denied cross-vault operations.
5. Test compiled scope selection, legacy defaults and rejection of unknown IDs.
6. Verify live identity, authentication and retrieval separately from source
   tests. Keep credential values, actual mappings and client results private.

## Repository privacy

Use generic fixtures and examples. Keep actual project names, host identities,
deployment domains, private client mappings and operational records outside this
repository. Use an external, ad hoc privacy scan; never encode prohibited values
in regression fixtures or cleanup notes.
