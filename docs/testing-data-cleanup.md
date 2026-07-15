# Testing Data Cleanup Script

Use `scripts/cleanup-test-data.sh` to remove old test data from both PostgreSQL and artifact storage.

For administrative quarantine, restore, purge, orphan audit, environment
loading, and storage-permission guidance, see
[`docs/published-artifact-maintenance.md`](published-artifact-maintenance.md).

## What it cleans

- `uploaded_drafts` rows for test users.
- `uploaded_attempts` rows for test users.
- `published_packages` rows for test users.
- Artifact files referenced by those rows under `STORAGE_ROOT`.

Default filter:

- `owner_sub LIKE 'test-%'`
- older than 7 days.

## Dry run first (recommended)

Run the script as the API service account after loading the same environment
used by the API. Do not print or pass the database password on the command
line:

```bash
sudo -u <service-account> -H bash
set -a
source <env-file>
set +a
cd <app-directory>
```

Then perform the dry run:

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

# Use a different test-owner prefix and retention period
scripts/cleanup-test-data.sh --apply \
  --owner-prefix integration-test- \
  --older-than-days 14
```

Prefer the loaded environment over `--database-url` so credentials are not
exposed in the process command line or shell history.

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
