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
