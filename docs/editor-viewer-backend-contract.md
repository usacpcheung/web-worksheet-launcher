# Editor ↔ Published Package Backend Contract (Do-Not-Break)

This note documents the **existing editor contract** for searching and opening published packages.

**Goal:** viewer-side integrations must reuse this exact contract shape instead of inventing a parallel API.

## Canonical client + call sites

Primary shared API client and editor call paths:

- `createServerApiClient()` in `server/app/api/server-api-client.js`
- `listPublishedPackages(query)` in `server/app/api/server-api-client.js`
- `fetchPublishedPackageArtifact(publishedPackageId)` in `server/app/api/server-api-client.js`
- `serializePublishedPackagesQuery()` + `fetchPublishedPackagesPage()` + `normalizePublishedPackageRow()` in `server/app/api/published-packages-service.js`
- `runPublishedSearch()` in `server/editor/main.js`
- `reopenPublishedPackageAsLocalCopy(publishedPackageId)` in `server/editor/main.js`
- `ensureServerSessionReady()` in `server/editor/main.js` (auth preflight)

## Backend endpoints currently used by editor

Base path defaults to `'/api/worksheet-launcher/v1'` (overrideable via `?apiBase=...`):

1. **Session readiness preflight**
   - `GET /api/worksheet-launcher/v1/session`
   - Used before published search/open actions.

2. **Published package search/list**
   - `GET /api/worksheet-launcher/v1/published`
   - Used by browse modal search + pagination.

3. **Published package artifact open/import**
   - `GET /api/worksheet-launcher/v1/published/:publishedPackageId/artifact`
   - Must return `application/zip`; editor imports this ZIP as a local editable copy.

4. **Uploaded drafts list (slot management)**
   - `GET /api/worksheet-launcher/v1/drafts`
   - Contract includes `data.items` and `data.draftSlotLimit` for slot-usage UI.

## Query parameters (search + pagination)

For `GET /published`, editor sends the canonical query shape:

- `title` (string)
- `subject` (string)
- `owner` (string)
- `limit` (number, default `20`)
- `offset` (number, default `0`)

Notes:

- Empty/null query values are omitted from URL serialization.
- `limit`/`offset` are normalized in client (`20`/`0` fallbacks).
- UI filter labels map directly to these keys:
  - "Filter by title" → `title`
  - "Filter by subject" → `subject`
  - "Filter by owner" → `owner`
- Owner filter semantics are intentionally broad in viewer/editor compatibility:
  - backend still receives one canonical `owner` query key,
  - UI row rendering can show `owner_email`, `owner_name`, or `owner_sub`,
  - integrations should treat the owner filter as matching owner identity text (email/name/sub), not email-only.

## Response schema consumed by editor

### 1) JSON envelope for session + search endpoints

Editor expects API JSON responses in this envelope:

- Success: `{ ok: true, data: ... }`
- Error: `{ ok: false, error: { code, message, details? } }` (or non-2xx mapped by client)

### 2) Published list payload shape used by browse UI

For `GET /published`, editor consumes:

- `data.items` (array)
- `data.hasMore` (boolean)
- `data.nextOffset` (number)

For each `item` in `data.items`, UI currently reads:

- `published_package_id` (required for copy/open actions)
- `title` (display fallback: `Untitled`)
- `subject` (display fallback: `—`)
- `published_at` (display timestamp)
- `owner_email` (preferred owner display)
- `owner_name` (fallback owner display)
- `owner_sub` (fallback owner display)

### 3) Artifact payload shape used by open flow

For `GET /published/:id/artifact`, editor expects:

- HTTP success + `content-type` containing `application/zip`
- Binary body read as bytes (`Uint8Array`)

If content type is not ZIP, client returns `UNEXPECTED_CONTENT_TYPE` and open flow fails.

## Auth/session assumptions

- API requests use `fetch(..., { credentials: 'include' })` (cookie-backed session).
- No bearer token plumbing in editor for these paths.
- Sign-in required is inferred from:
  - HTTP `401` or `403`, or
  - HTML response where JSON/ZIP was expected (common auth redirect symptom).
- `ensureServerSessionReady()` gates published search/open and raises user-facing sign-in messages before retry.

## Error + empty-state behavior expected by editor

Published browse/search:

- While loading: "Loading published packages…"
- Empty successful result (`items.length === 0`): "No published packages found."
- API/network/auth error: modal error text set from structured `error.message`; notification emitted.

Open published package:

- In-flight dedupe by `openingPublishedPackageIds` to prevent duplicate opens.
- On success: imports ZIP into new local draft and emits success notifications.
- On failure: uses `serverActionMessage` or API `error.message`; browse modal stays open with error.

Uploaded draft upload conflict + slot handling:

- `DRAFT_SLOT_LIMIT_REACHED` must include `error.details.slotLimit` and `error.details.uploadedDrafts`.
- Editor slot-usage UI should read server-provided slot limit when available.
- After deleting one uploaded draft from the slot-full flow, upload is expected to continue in the same flow (no extra user "start over" step).

Viewer uploaded attempt slot handling:

- `ATTEMPT_SLOT_LIMIT_REACHED` must include `error.details.slotLimit`.
- `GET /attempts` should include `data.attemptSlotLimit` for slot-usage UI.
- After deleting one uploaded attempt from the slot-full flow, upload is expected to retry in the same flow.

## Do-not-break rules for viewer reuse

When adding viewer-side search/open for published packages, reuse:

1. same base endpoint family (`/session`, `/published`, `/published/:id/artifact`),
2. same query key names (`title`, `subject`, `owner`, `limit`, `offset`),
3. same envelope + list item field names (`published_package_id`, `published_at`, owner fallbacks),
4. same cookie/session model (`credentials: include`) and auth error interpretation,
5. same ZIP artifact expectation for open/import path.

If backend contract changes are required, update editor and viewer together through the shared API client contract rather than forking response shapes per surface.
