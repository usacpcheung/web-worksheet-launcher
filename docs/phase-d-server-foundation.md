# Phase D Server-Backed Worksheet Foundation

This document defines the first server/database foundation added in Phase D.

## Scope

Implemented in this phase:

- Upload draft ZIP for later edit (owner private, max 3 per owner).
- Publish immutable package from uploaded draft (one uploaded draft maps to one published package).
- Load published package metadata by `publishedPackageId`.
- Download published package ZIP artifact by `publishedPackageId`.
- Basic authenticated browse/search of published packages.
- Protected lightweight session check endpoint (`GET /api/v1/session`).
- Uploaded draft artifact download for editor reopen flow (`GET /api/v1/drafts/:uploadedDraftId/artifact`).

Out of scope (still deferred):

- Attempt upload/sync.
- Advanced search/indexing.
- Full UI wiring for slot management and publish browser.

## Runtime and auth assumptions

- App runs behind Apache on Ubuntu VPS.
- Apache performs OIDC and forwards trusted identity headers.
- Public Apache API path and internal Node API path may differ by deployment; canonical public prefix is `/api/worksheet-launcher/v1/*` and Node routes remain `/api/v1/*`.
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

### Reverse-proxy path mapping (canonical external examples)

- Canonical external prefix: `/api/worksheet-launcher/v1/*`
- Internal Node API prefix: `/api/v1/*`

Example external → internal mapping:

- `GET /api/worksheet-launcher/v1/session` → `GET /api/v1/session`
- `GET /api/worksheet-launcher/v1/drafts` → `GET /api/v1/drafts`

Important composition rule:

- Never compose `/api/worksheet-launcher/api/v1/...`.
- The external prefix already maps `/api/worksheet-launcher/` to internal `/api/`.
- Correct external session URL is `/api/worksheet-launcher/v1/session`.

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
  - Published identity: `published_package_id` (UUID, immutable)
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

### 2b) Download owner uploaded draft ZIP by id

`GET /api/v1/drafts/:uploadedDraftId/artifact`

- Returns `application/zip` bytes for the authenticated owner only.
- Supports editor “reopen uploaded draft as local copy” workflow.

### 2c) Delete owner uploaded draft by id

`DELETE /api/v1/drafts/:uploadedDraftId`

- Owner-scoped delete only (`uploaded_draft_id` + authenticated `owner_sub`).
- Validates UUID format and returns `400 INVALID_UPLOADED_DRAFT_ID` for malformed ids.
- Removes the uploaded draft database row and deletes the stored draft ZIP artifact.
- Returns `404 UPLOADED_DRAFT_NOT_FOUND` when the draft does not exist for the current owner.
- Deleting an uploaded draft immediately frees one draft slot (slot cap remains 3 per owner).
- Deleting an uploaded draft does **not** delete a previously published package created from it.

### 3) Publish immutable package

`POST /api/v1/published`

Request JSON:

```json
{ "uploadedDraftId": "uuid", "title": "Optional published title override", "subject": "Optional published subject override" }
```

Behavior:

- Reads owner draft by id.
- Copies canonical ZIP artifact into immutable published bucket on first publish.
- Enforces one uploaded draft → one published package. Re-publish of the same uploaded draft returns the existing package instead of creating duplicates.
- Stores provenance link to `source_uploaded_draft_id`.
- Optional publish-time `title`/`subject` overrides apply to published package metadata only (uploaded draft metadata is unchanged).

### 4) Load published package metadata by id

`GET /api/v1/published/:publishedPackageId`

- Returns metadata for viewer/server integration.

### 5) Download published package ZIP by id

`GET /api/v1/published/:publishedPackageId/artifact`

- Returns `application/zip` bytes.

### 6) Basic published browse/search

`GET /api/v1/published?q=<query>&title=<title>&subject=<subject>&owner=<ownerName>&limit=<n>&offset=<n>`

- Search scope: published packages only.
- Query applies case-insensitive `LIKE` on title, subject, and owner name.
- Sorted by most recent `published_at DESC`.

### 7) Lightweight session check

`GET /api/v1/session`

- Protected by the same upstream OIDC header model as other `/api/v1/*` routes.
- Returns authenticated identity payload for frontend session-ready gating.

## Browser popup sign-in flow (editor/viewer)

The JSON session endpoint is now a background readiness API, not a browser landing page for human sign-in UX.

- Browser-facing sign-in popup page: `/worksheet_launcher/app/login/popup.html`
- Expected Apache protected location: `/worksheet_launcher/app/login/`
- Session readiness API remains: `/api/worksheet-launcher/v1/session` (proxied to internal `/api/v1/session`)

Flow:

1. Editor/viewer opens `/worksheet_launcher/app/login/popup.html`.
2. Apache OIDC challenge/login runs on that page.
3. Popup page posts `worksheet-launcher-auth-complete` to `window.opener` with `targetOrigin = window.location.origin`.
4. Popup attempts `window.close()`.
5. Editor/viewer validates `event.origin` and `event.data.type`, then re-checks `GET /api/worksheet-launcher/v1/session`.
6. Popup callback is the primary success path; any fallback polling is bounded, best-effort, and silent (no repeated visible “checking” churn).
7. Protected server actions run a silent preflight session check before API reads/writes and block with a sign-in prompt if session is missing/expired.
8. If ready, server-gated UI updates automatically (no manual hard refresh required).

### Apache OIDC / reverse proxy example (sanitized placeholders)

```apache
# ---- OIDC (Google login) ----
OIDCProviderMetadataURL https://accounts.google.com/.well-known/openid-configuration
OIDCClientID YOUR_GOOGLE_CLIENT_ID
OIDCClientSecret XXXX
OIDCRedirectURI https://YOUR_DOMAIN/oidc/callback
OIDCCryptoPassphrase XXXX

OIDCScope "openid email profile"
OIDCRemoteUserClaim email
OIDCClaimPrefix "OIDC_CLAIM_"

# ---- Worksheet Launcher API (OIDC protected) ----
<Location "/api/worksheet-launcher/">
  AuthType openid-connect
  Require valid-user

  RequestHeader unset X-OIDC-Sub
  RequestHeader unset X-OIDC-Email
  RequestHeader unset X-OIDC-Name

  RequestHeader set X-OIDC-Sub "%{OIDC_CLAIM_sub}e" env=OIDC_CLAIM_sub
  RequestHeader set X-OIDC-Email "%{OIDC_CLAIM_email}e" env=OIDC_CLAIM_email
  RequestHeader set X-OIDC-Name "%{OIDC_CLAIM_name}e" env=OIDC_CLAIM_name
</Location>

# ---- Popup login page only (OIDC protected) ----
<Location "/worksheet_launcher/app/login/">
  AuthType openid-connect
  Require valid-user
</Location>

# ---- Reverse proxy mapping ----
ProxyPass /api/worksheet-launcher/ http://127.0.0.1:8787/api/
ProxyPassReverse /api/worksheet-launcher/ http://127.0.0.1:8787/api/

# ---- Static aliases ----
Alias /worksheet_launcher/editor/ /opt/web-worksheet-launcher/server/editor/
Alias /worksheet_launcher/viewer/ /opt/web-worksheet-launcher/server/viewer/
Alias /worksheet_launcher/app/    /opt/web-worksheet-launcher/server/app/
```

Keep `/worksheet_launcher/app/login/` isolated for OIDC protection so shared runtime assets under `/worksheet_launcher/app/auth/`, `/worksheet_launcher/app/api/`, etc. remain publicly loadable unless explicitly required otherwise.

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
