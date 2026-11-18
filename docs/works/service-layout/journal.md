# Source and deployment layout

Keep source under a code directory and deployment configuration, release
artifacts and operational records under a separate service directory. The
[deployment guide](../../../deploy/README.md) uses a generic example layout.
Actual host paths, migration records, backups and service status belong in
private configuration or the authorized vault.

## Migration procedure

1. Inspect both source and deployment copies, including uncommitted changes,
   branches and stashes. Preserve existing work before selecting a canonical copy.
2. Back up the application, dependencies, units and private configuration outside
   the repository. Restrict the backup to the service operator.
3. Prepare a reviewed, self-contained release and test its actual entry point
   after relocation. Keep a rollback release available.
4. Update the deployed service unit deliberately, preserving private environment
   values, vault paths, state paths, credentials and synchronization settings.
5. Validate unit syntax, reload the appropriate service manager and activate the
   selected release through an authorized administration route.
6. Verify authentication, tool discovery, vault identity and read-only retrieval.
   Test write/recovery operations only on disposable notes within authorized scope.
7. Record actual deployed versions, verification results and outstanding service
   issues privately. A passing source test does not prove a successful deployment.

Changes to source layout and changes to synchronization are separate operations.
Diagnose existing Sync problems before attributing them to a source migration.
