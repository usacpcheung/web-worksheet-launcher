# Worksheet Launcher Editor + Viewer Technical Specification (Package-First/Hybrid)

> **Related docs**
> - Phase 1 blueprint index: `docs/phase1-blueprint-index.md`
> - Popup launch/postMessage contract: `docs/message-contract.md`
> - DB schema direction: `worksheet_launcher_db_schema.md`
>
> **Phase boundary note:** Phase 1 remains contracts/scaffolding only. This file specifies later-phase runtime targets.

## 1) Purpose

This spec defines the target behavior for later-phase editor/viewer implementation so work stays aligned with the redesigned package-first/hybrid architecture.

## 2) Canonical model direction (normative)

1. **Drafts are the only editable objects.**
2. **Published packages are immutable.**
3. **Attempts are bound to exact source/version/hash.**
4. **Viewer opens mainly by reference; `publishedPackageId` is the preferred published identity.**
5. **No-parameter viewer open shows a start screen with resume option (no forced auto-resume).**
6. **“Sync” wording is replaced by Upload draft for later edit.**
7. **Ownership is keyed by OIDC `sub` only (email is non-authoritative metadata).**
8. **Import/export direction is package-first (manifest + content + media-ready envelope).**

## 3) Route + auth contract (normative)

| Route | Surface | Entry file | Public boot access | Notes |
| --- | --- | --- | --- | --- |
| `/editor/` | Editor app | `server/editor/index.html` | Yes | Local-first create/edit/import/export/autosave. |
| `/viewer/` | Viewer app | `server/viewer/index.html` | Yes | Local-first attempt flow and explicit source loading. |
| `/worksheet/render.html` | Popup compatibility renderer | `server/worksheet_launcher/render.html` | Launch-controlled | Compatibility-only popup surface; not main runtime. |

Auth trigger rule:
- Route boot remains public.
- Auth is on-demand only for protected capabilities (upload draft, publish, protected fetch, protected autosave, rewrite/T2A).

## 4) Viewer source/loading contract (normative)

The canonical launch precedence is defined in `docs/message-contract.md` and is repeated here for implementation clarity:

1. `localAttemptId`
2. `publishedPackageId`
3. `importedWorksheetId`
4. `localDraftId` + `preview=1` (+ optional `draftUpdatedAt`)
5. `viewerPayload` / `snapshot` compatibility path only

Rules:
- No explicit source params => show start screen (may offer Resume when resumable attempt exists).
- Explicit source params => load requested source or fail with typed fatal error.
- Do not silently fall back to unrelated content when explicit launch intent fails.

## 5) Response input schema contract (normative)

Canonical question `responseConfig.inputType` values are:

- `text`
- `number`
- `boolean`
- `multiple_choice`

Legacy aliases (`short_text`, `textarea`, `checkbox_group`, `single_choice`, etc.) are not canonical and should be treated as compatibility-input only if a migration adapter exists; new authored content must use canonical values.

## 6) Local persistence and ID model

### IndexedDB (source of truth for local payloads)

- `localDrafts`
- `importedWorksheets`
- `localAttempts`

### localStorage (lightweight metadata only)

- post-login restore flags
- pending intent markers
- selected local object IDs

### Local/server identity separation

- Local draft identity: `localDraftId = ld_<ulid>`
- Local attempt identity: `localAttemptId = la_<ulid>`
- Server identities are stored separately and never overwrite local IDs.
- Preferred server identities: `uploadedDraftId`, `publishedPackageId`, `attemptId`.

## 7) Import/export contract (package-first)

### Target package envelope

- `manifest.json` (schema version, package metadata, provenance, media index)
- `content/worksheet.json` (worksheet structure)
- `media/*` (future images/audio)

Rules:
- Import/export must work without login.
- Importing published content always creates/updates a local draft copy; published package remains immutable.
- Raw worksheet JSON import/export may remain as transitional compatibility, but package format is the preferred direction.
- Phase A package-groundwork details (manifest/content/media shape, asset IDs, local asset storage, JSON-compat mapping) are defined in `docs/local-package-format-phase-a.md`.

## 8) Protected backend API scaffolding (normative)

Success envelope:

```json
{ "ok": true, "data": {} }
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "string_enum",
    "message": "human readable",
    "details": {}
  }
}
```

### 8.1 `uploadDraftForLaterEdit`

Purpose: store authenticated server draft copy for restore on another device.

Request example:

```json
{
  "uploadedDraftId": null,
  "baseRevision": "dr_000041",
  "draftContent": {
    "title": "Fractions Practice",
    "blocks": []
  },
  "clientUpdatedAt": "2026-04-03T10:00:00Z"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "uploadedDraftId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
    "revision": "dr_000042",
    "updatedAt": "2026-04-03T10:00:01Z"
  }
}
```

### 8.2 `loadUploadedDraft`

Purpose: load uploaded draft by authenticated owner.

Request:

```json
{ "uploadedDraftId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de" }
```

### 8.3 `publishPackage`

Purpose: publish immutable package from validated draft state.

Request:

```json
{
  "uploadedDraftId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
  "baseRevision": "dr_000042",
  "publishNote": "Unit 3 release"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "publishedPackageId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "packageVersion": 3,
    "publishedAt": "2026-04-03T10:05:00Z"
  }
}
```

### 8.4 `loadPublishedPackage`

Purpose: load immutable published package by `publishedPackageId`.

Request:

```json
{ "publishedPackageId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1" }
```

### 8.5 `saveAttempt`

Purpose: create/update source-bound attempt state.

Request (create):

```json
{
  "publishedPackageId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
  "attemptId": null,
  "baseRevision": "ar_000000",
  "sourceBinding": {
    "sourceType": "published_package",
    "sourceId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "sourceHash": "sha256:abc123"
  },
  "answers": {
    "blk_q1": "3/4"
  },
  "status": "in_progress"
}
```

### 8.6 `resumeAttempt`

Purpose: resume attempt by `attemptId` (auth) or approved guest token flow.

Request:

```json
{ "attemptId": "e7d36570-8258-48a1-a6b5-0f96f6a3da6c" }
```

### 8.7 Transitional compatibility aliases

If migration requires old names, backend may accept/emit compatibility aliases:

- `snapshotId` ⇄ `publishedPackageId`
- `publishSnapshot` ⇄ `publishPackage`
- `loadPublishedSnapshot` ⇄ `loadPublishedPackage`

These aliases are transitional and should be documented as deprecated when used.

## 9) Editor requirements (later phase)

- Create/edit local draft JSON.
- Autosave locally (debounced).
- Import package or compatibility JSON.
- Export package (preferred) and optional compatibility JSON.
- Preview via explicit viewer path: `localDraftId + preview=1` (+ optional `draftUpdatedAt`).
- Upload draft for later edit only when user invokes protected action.

## 10) Viewer requirements (later phase)

- Load from explicit source references listed in Section 4.
- Render question blocks and capture answers with canonical response types.
- Support local autosave and server-backed attempt autosave.
- Keep submit/resume logic source-bound and immutable-source-safe.

## 11) Publish and attempt invariants

### Publish invariants

- Publish always creates a new immutable package and new `publishedPackageId`.
- Publish must never mutate previously published package content.
- Re-importing published content into editor always creates/forks a draft branch.

### Attempt invariants

- Attempts bind to exact source identity/version/hash at creation.
- Resume/update must validate source binding.
- Attempts must not silently migrate to newer published packages.

## 12) Compatibility guardrail with popup contract

This document does not change popup launch/postMessage transport. Popup compatibility rules remain in `docs/message-contract.md`.

## 13) Implementation priority (later phases)

1. local draft model hardening
2. package import/export
3. viewer source-loading/start-screen behavior
4. upload draft for later edit
5. publish package flow
6. source-bound attempts

## 12) Phase D implementation baseline (2026-04-05)

Implemented backend foundation (server-side) now exists for:

- `POST /api/v1/drafts/upload` (authenticated ZIP upload, max 3 owner slots)
- `GET /api/v1/drafts` (owner-private list)
- `POST /api/v1/published` (publish immutable package from uploaded draft id)
- `GET /api/v1/published/:publishedPackageId` (metadata load)
- `GET /api/v1/published/:publishedPackageId/artifact` (ZIP bytes)
- `GET /api/v1/published` (basic authenticated browse/search by title/subject)

Operational notes:

- Authentication identity source is Apache-forwarded OIDC headers; required canonical owner key is `X-OIDC-Sub`.
- Metadata is in PostgreSQL and canonical package bytes remain filesystem ZIP artifacts.
- Attempts remain local-only in this phase.
- Local editor/viewer flow remains local-first; this phase adds backend capability but does not replace local behavior.
