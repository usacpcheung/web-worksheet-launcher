# Implemented database and artifact schema

Reviewed against main `7bb19de` on 2026-10-06. The executable schema authority is the SQL under `server/api/db/migrations/`, applied by `server/api/db/migrate.js`. This reference describes those files; it does not assert which migrations a deployment has run.

## Tables

| Table | Identity / provenance | Stored data |
| --- | --- | --- |
| `schema_migrations` | `version` primary key | Applied filename/version and timestamp. |
| `uploaded_drafts` | `uploaded_draft_id` UUID; `owner_sub` | Worksheet title/subject, optional owner email/name, ZIP path/SHA-256/size, timestamps and historical publish hash/time. |
| `published_packages` | `published_package_id` UUID; nullable `source_uploaded_draft_id` | Immutable worksheet artifact metadata, owner/listing metadata and publish time. Source deletion sets the foreign key to NULL. |
| `uploaded_attempts` | `uploaded_attempt_id` UUID; `owner_sub` | Private attempt ZIP metadata, title/subject, status/submitted/checked timestamps. Owner email/name are nullable after migration 010. |
| `roleplayscene_uploaded_drafts` | `roleplayscene_uploaded_draft_id` UUID; `owner_sub` | Title/description, package version, artifact metadata, scene/media/missing-media/warning counts and historical publish hash/time. |
| `roleplayscene_published_scenes` | `roleplayscene_published_scene_id` UUID; nullable `source_roleplayscene_uploaded_draft_id` | Published story listing and artifact/count metadata. Source deletion sets the foreign key to NULL. |
| `published_artifact_quarantine` | `quarantine_id` UUID; original published ID/path | Publication/orphan kind, saved row metadata, move/restore/purge state, operator/reason, timestamps, retention and last error. |

Ownership is the OIDC subject `owner_sub`; email/name are display metadata, not ownership keys. Content, media and learner answers live in ZIP artifacts, not relational JSONB worksheet/attempt content columns. Quarantine uses saved row JSON metadata for restoration, not a replacement content store.

## Migration inventory

| Migration | Effect |
| --- | --- |
| 001 | `pgcrypto`, worksheet draft/published tables and migration tracking. |
| 002 | `pg_trgm` title/subject search indexes. |
| 003 | Initial unique source-draft publication index; superseded by 006. |
| 004 | Published owner email/name search indexes. |
| 005 | Unique normalized worksheet owner/title/subject upload identity; detects existing conflicts before index creation. |
| 006 | Uploaded-draft publish markers; drops 003's one-publication-per-draft constraint. |
| 007 | Backfills missing markers from publication history. |
| 008 | Published source-draft lookup index. |
| 009 | Private uploaded attempt table and owner/title/subject identity index. |
| 010 | Makes attempt owner email/name nullable. |
| 011 | RolePlayScene uploaded drafts, counts and normalized owner/title uniqueness. |
| 012 | RolePlayScene uploaded-draft publish markers. |
| 013 | RolePlayScene publications, source lookup and normalized owner/title uniqueness. |
| 014 | Administrative publication/orphan quarantine and state/retention indexes. |

Use `npm run migrate` with the deployment's configured environment to apply pending migrations. Never apply the SQL in [the archived target schema](../past/plans/worksheet_launcher_db_schema.md) as an installation recipe.

## Publish and conflict behavior

Services serialize owner operations with advisory transaction locks. Draft and attempt limits default to three in `config.js`; lists return the limits for UI use. Worksheet conflicts use normalized owner/title/subject; RolePlayScene uses owner/title. The browser offers explicit replace/copy recovery rather than silently replacing content.

A successful publish receives a new UUID and artifact copy. Draft markers prevent publishing the same current uploaded artifact again. Deleting or quarantining a publication does not clear those markers or automatically unlock republishing. A changed draft artifact can produce another publication, subject to active listing conflicts. Owner deletion of a source draft preserves an existing published artifact through the nullable foreign key.

Worksheet replacement with no live linked publication creates a fresh draft row with empty markers; replacement with a live publication preserves the existing draft identity/history. See `PackageService.uploadDraft` and `publishFromDraft`, and the separate RolePlayScene draft service for its flow.

## Filesystem buckets

`PackageArtifactStore.storeArtifact` sanitizes the owner path segment by replacing characters outside `[a-zA-Z0-9_-]` with `_`, writes exclusively, and records ZIP byte size and SHA-256.

| Kind | Relative path under `STORAGE_ROOT` |
| --- | --- |
| Worksheet draft | `drafts/<safe-owner>/<uuid>.zip` |
| Worksheet publication | `published/<safe-owner>/<uuid>.zip` |
| Uploaded attempt | `attempts/<safe-owner>/<uuid>.zip` |
| RolePlayScene draft | `roleplayscene/drafts/<safe-owner>/<uuid>.zip` |
| RolePlayScene publication | `roleplayscene/published/<safe-owner>/<uuid>.zip` |
| Administrative quarantine | `quarantine/` managed by the maintenance service |

Ordinary owner deletes and test-data cleanup are immediate deletion flows. Administrative maintenance is a separate quarantine/restore/delayed-purge flow. See [artifact maintenance](../operations/published-artifact-maintenance.md).
