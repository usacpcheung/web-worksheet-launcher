# Testing Data Cleanup Script

Use `scripts/cleanup-test-data.sh` to remove old test data from both PostgreSQL and artifact storage.

## What it cleans

- `uploaded_drafts` rows for test users.
- `published_packages` rows for test users.
- Artifact files referenced by those rows under `STORAGE_ROOT`.

Default filter:

- `owner_sub LIKE 'test-%'`
- older than 7 days.

## Dry run first (recommended)

```bash
scripts/cleanup-test-data.sh
```

This prints candidate row counts and artifact path totals, but does not delete anything.

## Apply cleanup

```bash
scripts/cleanup-test-data.sh --apply
```

## Common options

```bash
# Clean QA users older than 3 days
scripts/cleanup-test-data.sh --apply --owner-prefix qa- --older-than-days 3

# Explicit connection/runtime paths
scripts/cleanup-test-data.sh --apply \
  --database-url "$DATABASE_URL" \
  --storage-root /var/lib/worksheet-storage
```

## Linux permission issues

If the script reports `failed to delete (permission?)`, fix ownership or write permissions for the service account that runs cleanup.

1. Inspect ownership/mode:

```bash
ls -l /path/to/file.zip
```

2. Set owner to the service user (example: `appsvc`):

```bash
sudo chown appsvc:appsvc /path/to/file.zip
```

3. Grant write access if needed:

```bash
sudo chmod u+w /path/to/file.zip
sudo chmod g+w /path/to/file.zip
```

4. Re-run cleanup:

```bash
scripts/cleanup-test-data.sh --apply
```

If many files are affected, apply changes recursively on a scoped directory (be careful):

```bash
sudo chown -R appsvc:appsvc /var/lib/worksheet-storage/drafts/test_user
```
