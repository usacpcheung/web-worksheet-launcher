# Phase D Server-Backed Worksheet Foundation

This document defines the first server/database foundation added in Phase D.

## Scope

Implemented in this phase:

- Upload draft ZIP for later edit (owner private, max 3 per owner).
- Publish immutable package from uploaded draft.
- Load published package metadata by `publishedPackageId`.
- Download published package ZIP artifact by `publishedPackageId`.
- Basic authenticated browse/search of published packages.

Out of scope (still deferred):

- App-side OIDC login/session flow.
- Attempt upload/sync.
- Advanced search/indexing.
- Full UI wiring for slot management and publish browser.

## Runtime and auth assumptions

- App runs behind Apache on Ubuntu VPS.
- Apache performs OIDC and forwards trusted identity headers.
- Protected API endpoints require `X-OIDC-Sub` (default header key configured via `AUTH_HEADER_SUB`).
- Optional metadata headers:
  - `X-OIDC-Email`
  - `X-OIDC-Name`
- Ownership key in database is `owner_sub` (OIDC `sub`).

If required identity headers are missing, protected endpoints return:

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Missing required header: X-OIDC-Sub"
  }
}
```

## Config/env foundation

A single config path is used in `server/api/config.js`.

Required environment variables:

- `DATABASE_URL` (PostgreSQL connection string)
- `STORAGE_ROOT` (filesystem root for ZIP artifacts)

Optional env variables:

- `PORT` (default `8787`)
- `AUTH_HEADER_SUB` (default `x-oidc-sub`)
- `AUTH_HEADER_EMAIL` (default `x-oidc-email`)
- `AUTH_HEADER_NAME` (default `x-oidc-name`)

Reference file: `.env.example`.

For local/dev commands (`npm run migrate`, `npm run start:api`), `.env` is auto-loaded from the repository root via `server/api/config.js` using `dotenv` with `override: false` (shell/system-provided env vars keep precedence).

## PostgreSQL schema and migration path

Migration bootstrap is implemented with SQL files under `server/api/db/migrations/` and runner `server/api/db/migrate.js`.

Current migration:

- `001_phase_d_server_foundation.sql`

Tables:

- `uploaded_drafts`
  - Owner: `owner_sub`
  - Draft identity: `uploaded_draft_id` (UUID)
  - ZIP metadata: `artifact_path`, `artifact_sha256`, `artifact_size_bytes`
  - Authoring metadata: `title`, `subject`
- `published_packages`
  - Published identity: `published_package_id` (UUID, immutable per publish)
  - Provenance: `source_uploaded_draft_id`
  - Ownership and ZIP metadata fields
  - Search metadata: `title`, `subject`, plus indexes
- `schema_migrations` for applied migration tracking

## Filesystem artifact storage model

Canonical worksheet content remains ZIP artifacts on VPS filesystem.

Storage buckets:

- Drafts: `drafts/<owner_sub>/<uploadedDraftId>.zip`
- Published: `published/<owner_sub>/<publishedPackageId>.zip`

`owner_sub` path segments are sanitized to safe `[a-zA-Z0-9_-]`.

Stored integrity metadata:

- SHA-256 hash (`artifact_sha256`)
- byte size (`artifact_size_bytes`)

## API foundation (Phase D)

All endpoints below are authenticated except `/healthz`.

### 1) Upload draft ZIP

`POST /api/v1/drafts/upload?title=<title>&subject=<subject>`

- Required `Content-Type`: `application/zip`
- Body: ZIP bytes
- Enforces owner slot cap of 3 uploaded drafts.

Success: `201`

```json
{
  "ok": true,
  "data": {
    "uploaded_draft_id": "uuid",
    "owner_sub": "oidc-sub",
    "title": "Algebra Practice",
    "subject": "math",
    "artifact_sha256": "...",
    "artifact_size_bytes": 12345,
    "created_at": "2026-04-05T..."
  }
}
```

Slot cap response: `409` with `DRAFT_SLOT_LIMIT_REACHED`.

### 2) List owner uploaded drafts

`GET /api/v1/drafts`

- Returns drafts for current `owner_sub` only.

### 3) Publish immutable package

`POST /api/v1/published`

Request JSON:

```json
{ "uploadedDraftId": "uuid" }
```

Behavior:

- Reads owner draft by id.
- Copies canonical ZIP artifact into immutable published bucket.
- Creates new `published_package_id` every publish.
- Stores provenance link to `source_uploaded_draft_id`.

### 4) Load published package metadata by id

`GET /api/v1/published/:publishedPackageId`

- Returns metadata for viewer/server integration.

### 5) Download published package ZIP by id

`GET /api/v1/published/:publishedPackageId/artifact`

- Returns `application/zip` bytes.

### 6) Basic published browse/search

`GET /api/v1/published?q=<titleQuery>&subject=<subject>&limit=<n>&offset=<n>`

- Search scope: published packages only.
- Query currently applies case-insensitive `LIKE` on title and subject.
- Sorted by most recent `published_at DESC`.

## Local-first compatibility

Phase D adds server capabilities without replacing local editor/viewer behavior:

- Local drafts and local attempts remain local-first.
- Attempt sync/upload is not implemented in this phase.
- Existing local package ZIP import/export remains canonical for worksheet content.

## Bootstrap commands

```bash
npm install
npm run migrate
npm run start:api
```


## Phase D hardening update (atomic slots + UUID validation)

- Draft slot cap enforcement is serialized per `owner_sub` using `pg_advisory_xact_lock(hashtext(owner_sub))` inside the upload transaction before slot counting and insert.
- Publish now validates `uploadedDraftId` UUID format before any database query and returns a 400 `INVALID_UPLOADED_DRAFT_ID` client error when invalid.
- Published metadata/artifact routes validate `publishedPackageId` UUID format before DB lookup and return 400 `INVALID_PUBLISHED_PACKAGE_ID` when invalid.
- Published browse query params now return explicit 400 `INVALID_QUERY_PARAM` errors for invalid `limit`/`offset` values.

- Draft and publish flows now delete filesystem artifacts on transaction failure to avoid orphaned ZIP accumulation.
- Published detail route strictness: only `/api/v1/published/:publishedPackageId` and `/api/v1/published/:publishedPackageId/artifact` are valid; unknown nested subroutes return 404.
- Production/internal-error behavior now returns a generic 500 message while logging full server error details.
- Migration `002_published_search_trgm.sql` adds `pg_trgm` GIN indexes on `lower(title)` / `lower(subject)` for efficient `%term%` search semantics.
