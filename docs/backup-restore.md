# Backup and restore

## What is canonical vs. derived

The **Obsidian vault + Git** is the canonical source of truth.  The Postgres database
is a derived, rebuildable index.  You do not need a Postgres backup to recover from
data loss — restoring the vault and rebuilding is sufficient for all documents,
chunks, embeddings, and most metadata.

The only Postgres data that cannot be rebuilt from the vault are:

- `audit_log` — record of every retrieval and write action
- `retrieval_traces` — query/ranking debug data for past searches

(The `proposals` / `knowledge_events` tables still exist but are dormant under the
peer-work model — notes are written straight to the vault, so they hold no live data.)

If audit history matters to you, also take a periodic `pg_dump`.

---

## Backing up

### Vault (canonical)

```bash
cd /path/to/your/obsidian-vault
git add -A && git commit -m "checkpoint"
git push origin main          # push to your private remote
```

Push frequency is the key variable.  Daily automated push via a cron job or
Obsidian Git plugin is recommended.  The vault remote must be **private**.

### Postgres (optional, for audit history)

```bash
pg_dump -h localhost -U memories -d memories > memories_$(date +%Y%m%d).sql
```

Store alongside vault backups.  A weekly snapshot is sufficient for most setups.

---

## Restoring

### Full restore (vault + DB)

1. **Restore vault** — clone or pull your private vault remote to the correct path.

2. **Start Postgres:**

   ```bash
   pnpm db:up
   ```

3. **Regenerate Prisma client + apply migrations:**

   ```bash
   pnpm generate
   pnpm migrate
   ```

4. **Rebuild the index from the vault:**

   ```bash
   pnpm rebuild
   ```

   `rebuild` archives all existing documents and re-scans the vault from scratch
   (equivalent to wiping the index and re-running `scan`).

5. **Recompute embeddings** (only if `EMBEDDINGS_ENABLED=1`):

   ```bash
   pnpm reembed
   ```

### Restoring audit history from pg_dump

If you have a `pg_dump` snapshot and want to preserve audit history:

```bash
psql -h localhost -U memories -d memories < memories_20260610.sql
# Then rebuild documents on top of the restored DB:
pnpm rebuild
```

The `rebuild` step is still needed to sync document/chunk rows with the current vault.

---

## Verification

After any restore:

```bash
pnpm status                   # shows document/chunk/embedding counts + validation
```

```bash
# REST smoke test (start API first: pnpm api)
curl -s -X POST http://localhost:8787/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"obsidian canonical"}' | jq '.results[0].title'
```

Expected: at least one result; no database error in the terminal.

---

## What is NOT stored (by design)

No secret values are ever written to the vault, the database, or any log.  The write
path actively rejects notes containing detected secrets (private keys, AWS credentials,
GitHub tokens, bearer tokens, etc.).  Only **references** to secrets
(e.g. `secret_ref: op://vault/item/field`) are permitted in documents, and they are
not treated as findings.

---

## Summary

| Layer                     | Backup method          | Rebuild command               |
|---------------------------|------------------------|-------------------------------|
| Vault (documents)         | `git push` (private)   | n/a — canonical               |
| Postgres index            | Optional `pg_dump`     | `pnpm rebuild`                |
| Postgres embeddings       | Optional `pg_dump`     | `pnpm reembed`                |
| Audit log / traces        | `pg_dump` recommended  | Not rebuildable from vault    |
