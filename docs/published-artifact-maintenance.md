# Published Artifact Maintenance

Use the server-side maintenance CLI to audit, quarantine, restore, and purge
published Worksheet and RolePlayScene ZIP artifacts. Drafts and attempts are
outside this tool's scope.

The CLI uses the same `DATABASE_URL` and `STORAGE_ROOT` configuration as the API
and migration runner. Run migrations before using it:

```bash
npm run migrate
```

Do not pass database passwords on the command line. On a VPS, provide the API
environment through the service account, a root-owned environment file, or a
systemd `EnvironmentFile`.

Examples in this guide use placeholders such as `<service-account>`,
`<app-directory>`, and `<env-file>`. Do not add real credentials, database
URLs, or environment-file contents to documentation, shell history, issue
reports, or Git.

## Start a Manual Maintenance Shell

For occasional interactive maintenance, switch to the same operating-system
account that runs the API and owns the artifact storage:

```bash
sudo -u <service-account> -H bash
```

From that shell, export the API environment and enter the application
directory:

```bash
set -a
source <env-file>
set +a
cd <app-directory>
```

For example, `<env-file>` might be a root-managed file under `/etc`, while
`<app-directory>` might be an installation under `/opt`. Use the actual values
for the deployment; do not copy the environment file into the repository.

Verify that required variables exist without printing their sensitive values:

```bash
test -n "$DATABASE_URL" && echo "DATABASE_URL loaded"
test -n "$STORAGE_ROOT" && echo "STORAGE_ROOT loaded"
```

Run migrations after deploying a branch that includes a new migration:

```bash
npm run migrate
```

Exit the service-account shell when maintenance is complete:

```bash
exit
```

### npm argument forwarding

The separator between the npm script name and the maintenance command is
required:

```bash
npm run artifacts:maintain -- audit
```

The `--` tells npm to pass `audit` and later arguments to the Node CLI. These
forms are incorrect:

```bash
# Missing npm separator
npm run artifacts:maintain audit

# "audit" is a command, not an option
npm run artifacts:maintain --audit
```

For multiline commands, end every continued line with `\` as its final
character:

```bash
npm run artifacts:maintain -- quarantine worksheet \
  <publishedPackageId> \
  --reason "Administrative test"
```

## Audit

Audit is read-only:

```bash
npm run artifacts:maintain -- audit
npm run artifacts:maintain -- audit --json
```

It compares active rows in `published_packages` and
`roleplayscene_published_scenes` with ZIP files under:

- `published/`
- `roleplayscene/published/`

It reports:

- healthy rows with an existing file;
- active rows whose file is missing;
- unreferenced files at least 72 hours old;
- younger unreferenced files that are not yet eligible for quarantine; and
- active quarantine records.

An audit exits with code `2` when an active published row has a missing file.
This makes the command suitable for monitoring without automatically changing
data.

### JSON output and jq

Use `--json` for machine-readable output. When piping it to another command,
use npm's `--silent` option so npm headings do not appear before the JSON:

```bash
npm run --silent artifacts:maintain -- audit --json
```

[`jq`](https://jqlang.github.io/jq/) is an optional command-line JSON filter.
Check whether it is installed:

```bash
jq --version
```

On Debian or Ubuntu, an administrator can install it with:

```bash
sudo apt update
sudo apt install jq
```

List active quarantine records:

```bash
npm run --silent artifacts:maintain -- audit --json |
  jq '.quarantined'
```

Display a compact tab-separated list:

```bash
npm run --silent artifacts:maintain -- audit --json |
  jq -r '.quarantined[] |
    [.quarantine_id, .artifact_kind, .status, .original_artifact_path] |
    @tsv'
```

Find a forgotten quarantine ID using the original published UUID:

```bash
PUBLISHED_ID="<publishedId>"

npm run --silent artifacts:maintain -- audit --json |
  jq -r --arg id "$PUBLISHED_ID" '
    .quarantined[]
    | select(.original_artifact_path | contains($id))
    | .quarantine_id
  '
```

`--json` produces the data; `jq` performs the filtering. Without `jq`, inspect
the raw JSON output and search for `quarantine_id`.

## Quarantine a Publication

Use the exact published ID:

```bash
npm run artifacts:maintain -- quarantine worksheet <publishedPackageId> \
  --reason "Obsolete publication"

npm run artifacts:maintain -- quarantine roleplayscene <publishedSceneId> \
  --reason "Administrative removal"
```

The command displays the publication metadata and prompts:

```text
Type QUARANTINE to confirm:
```

Quarantine removes the active published row and moves the ZIP under
`quarantine/`. Existing browse results no longer include it and direct links
use the existing not-found behavior. The source draft and its historical
publish markers are not changed.

For controlled non-interactive operation, add `--yes`. Its use is recorded:

```bash
npm run artifacts:maintain -- quarantine worksheet <publishedPackageId> \
  --reason "Approved administrative removal" \
  --yes
```

The administrator identity is taken from `SUDO_USER`, then `USER`, then
`USERNAME`.

## Quarantine Orphan Files

First review the audit. Then explicitly quarantine every currently eligible
orphan:

```bash
npm run artifacts:maintain -- quarantine-orphans --all \
  --reason "Confirmed by storage audit"
```

The command displays the fresh candidate count and total size before asking for
`QUARANTINE`. Files newer than 72 hours are excluded. Rerunning the command also
resumes orphan moves that were interrupted after their database intent was
recorded.

## Restore

Use the quarantine ID printed by the quarantine command:

```bash
npm run artifacts:maintain -- restore <quarantineId>
```

The command prompts for `RESTORE`. A publication restore keeps its original
published ID and artifact path. It fails without changing active data if that
ID, owner/title identity, or destination path is already in use. If the source
draft was deleted while the publication was quarantined, the restored source
reference is set to `NULL`, matching the published table's normal
`ON DELETE SET NULL` behavior. Restore is rejected once the 30-day
`purge_after` timestamp is reached, even if the purge job has not run yet.
Restoring an orphan moves only its file because no publication row existed.

After restoration, verify that the original published link works and that the
publication appears in the normal browse result again.

## Purge

Quarantine records become purgeable after 30 days. Preview is read-only:

```bash
npm run artifacts:maintain -- purge-expired
```

Apply permanent deletion only after reviewing the preview:

```bash
npm run artifacts:maintain -- purge-expired --apply
```

The apply form prompts for `PURGE`. Use `--yes` only for a protected scheduled
job. Purged audit records remain in PostgreSQL after their ZIP files are
removed.

## VPS Operation

Prefer a protected systemd one-shot service so credentials never appear in
command arguments. For example:

```ini
[Unit]
Description=Worksheet published artifact audit

[Service]
Type=oneshot
User=worksheet-api
WorkingDirectory=/srv/web-worksheet-launcher
EnvironmentFile=/etc/web-worksheet-launcher/api.env
ExecStart=/usr/bin/npm run artifacts:maintain -- audit
```

Keep `/etc/web-worksheet-launcher/api.env` readable only by root and the service
account. An administrator can run the protected unit with:

```bash
sudo systemctl start worksheet-artifact-audit.service
sudo journalctl -u worksheet-artifact-audit.service
```

For interactive quarantine and restore commands, use a root-owned wrapper that
loads the same environment file and then drops privileges to the API service
account. Do not add `DATABASE_URL` to the wrapper command line.

Start scheduling with `audit` only. After manual quarantine and purge recovery
have been exercised, a systemd timer or cron job may run:

```bash
npm run artifacts:maintain -- purge-expired --apply --yes
```

Automatic orphan quarantine is intentionally not provided. It always requires
the explicit `quarantine-orphans --all` operation.

## Test Data Cleanup

Published artifact maintenance is different from test-data cleanup:

- this CLI manages individual published artifacts and storage orphans through
  quarantine;
- `scripts/cleanup-test-data.sh` removes old rows and files selected by a test
  owner prefix and age.

Use the cleanup script only for known test identities. Follow the dry-run,
permissions, and apply procedure in
[`docs/testing-data-cleanup.md`](testing-data-cleanup.md).

## Troubleshooting

### Missing `DATABASE_URL`

The environment file was not sourced, or its variables were not exported.
Repeat:

```bash
set -a
source <env-file>
set +a
```

Do not print `DATABASE_URL`; it may contain a password.

### `EACCES` while scanning storage

Run the command as the API service account, which should already have the
required access to `STORAGE_ROOT`:

```bash
sudo -u <service-account> -H bash
```

Inspect every directory component when diagnosing permissions:

```bash
namei -l <storage-root>/published
```

Do not make artifact storage world-readable or run npm as root merely to bypass
permissions.

### `A maintenance command is required`

Use the npm separator and command:

```bash
npm run artifacts:maintain -- audit
```

### UUID reported as `command not found`

A newline ended the command before the UUID. Put the command on one line, or
add a trailing `\` to every continued line.

### `jq` parse error

Suppress npm's heading before piping JSON:

```bash
npm run --silent artifacts:maintain -- audit --json | jq
```

### Restore rejected

Restore can fail when:

- the quarantine record has reached `purge_after`;
- its original published ID is already active;
- the owner/title identity conflicts with an active publication; or
- the destination artifact path is already occupied.

Deleting the source draft is not an error. Restore sets the missing source
reference to `NULL`.

## Recovery

The database records each operation before or alongside its filesystem step.
If the process stops during a move or delete:

- rerun publication quarantine with the same published ID;
- rerun `quarantine-orphans --all` for pending orphan moves;
- rerun restore with the same quarantine ID; or
- rerun `purge-expired --apply`.

The storage operations recognize already-moved or already-deleted files and
complete the pending database state where possible. Inspect `last_error` in
`published_artifact_quarantine` if a rerun still fails.
