# Worksheet Editor/Viewer/Server Architecture Redesign (Package-First Hybrid)

Date: 2026-04-03  
Status: Living architecture direction (partially implemented; keep aligned with current repo reality)

Implementation checkpoint (2026-04-06):
- Local-first editor/viewer runtime is active under `server/editor/` and `server/viewer/`.
- Server foundation APIs are implemented under `server/api/` for upload/publish/load/browse.
- Apache-forwarded OIDC headers are the current API auth boundary.
- Attempt sync/upload remains deferred; attempts are still local-first in current implementation.

## 1) Target architecture summary

This redesign aligns the product around three core object types:

1. **Drafts**: the only editable objects.
2. **Published packages**: immutable, versioned publication artifacts.
3. **Attempts**: learner progress/submission records bound to an exact source/version.

The system direction is **package-first / hybrid**, not full inline payload as the default runtime path:

- Viewer should primarily open by reference (especially `publishedPackageId`, which is the canonical published identity in target direction).
- Inline `viewerPayload` is retained only for compatibility/debug paths and is no longer preferred as the main launch route.
- Local-first behavior remains primary for editing and preview.

## 2) Canonical models and rules

### 2.1 Draft model (canonical local/editor record)

Drafts are local-first and editable. Canonical fields:

- `localDraftId`
- `title`
- `content`
- `metadata`
- `origin`
- `derivedFrom`
- `updatedAt`
- `schemaVersion`
- `uploadState`
- `publishState`

Normative rules:

- Local autosave remains the default source of continuity.
- “Sync” is renamed conceptually to **Upload draft for later edit**.
- Upload is for cross-device continuation/recovery; it is **not** live collaborative sync.
- Editor UI state is stored separately from worksheet content.
- Importing a published package must create a **new** local draft (never edit published content in place).

### 2.2 Origin/lineage rules

`origin` identifies where a draft/package came from:

- `local_created`
- `imported_package`
- `published_import`
- `uploaded_draft_restore`

`derivedFrom` records lineage pointers, e.g.:

```json
{
  "type": "published_package",
  "publishedPackageId": "pkg_pub_01J...",
  "importedAt": "2026-04-03T00:00:00Z"
}
```

Lineage rules:

- Publish always creates a new immutable package and new `publishedPackageId`.
- IDs are never reused.
- Re-import from published always forks into a new local draft lineage branch.

### 2.3 Published package model (immutable)

Published packages are immutable and canonicalized by:

- `publishedPackageId` (global publication identity)
- optional lineage grouping identifiers (`packageFamilyId`, `derivedFrom`)

Minimum package shape:

```json
{
  "publishedPackageId": "pkg_pub_01J...",
  "packageVersion": 1,
  "schemaVersion": 1,
  "title": "Fractions practice",
  "subject": "Math",
  "content": {},
  "metadata": {
    "provenance": {},
    "search": { "title": "Fractions practice", "subject": "Math" }
  },
  "mediaManifest": [],
  "publishedAt": "2026-04-03T00:00:00Z",
  "publishedBySub": "oidc_sub_123"
}
```

### 2.4 Attempt model (source-bound)

Attempts must bind to exact source/version at creation:

- `sourceType` (`published_package` | `imported_package` | `draft_preview`)
- `sourceId` (e.g., `publishedPackageId`, `importedWorksheetId`, `localDraftId`)
- `sourceContentHash` (or equivalent immutable resolver for integrity)

Attempts do not embed authoring content as mutable source-of-truth.

## 3) Viewer source/loading model

Viewer supports multiple explicit source types:

- `localAttemptId` → resume exact attempt.
- `localDraftId + preview=1` (+ optional `draftUpdatedAt`) → explicit editor preview.
- `importedWorksheetId` → open imported local package.
- `publishedPackageId` → open immutable published package.

### 3.1 No-parameter viewer open

No-parameter open must show a **start screen**:

- Primary CTA: Start new/open source
- If resumable attempt exists: show prominent **Resume** option
- Do not auto-resume immediately on load

### 3.2 Explicit launch behavior

Any explicit source parameter must:

- load directly, or
- fail with clear typed error

No silent fallback to unrelated sources when explicit launch intent fails.

### 3.3 Local cache preference for published packages

For `publishedPackageId` launches:

- If a valid cached local copy of the same `publishedPackageId` is present, prefer it.
- Otherwise fetch from server and cache.
- Validate cache consistency via package hash/version metadata.

## 4) Ownership/auth model

Server ownership must be keyed by **OIDC `sub`**:

- Primary ownership columns: `owner_oidc_sub`, `published_by_oidc_sub`, `user_oidc_sub`.
- Email may be stored only as profile/display metadata and must not be used as ownership key.

## 5) Package import/export + media direction

Import/export direction is package-based, not raw worksheet-JSON-only.

Minimum package envelope:

- `manifest.json` (package metadata, schema/package versions, provenance, media index)
- `content/worksheet.json` (worksheet structure)
- `media/*` assets (future images/audio)

Media references should be logical IDs in content, resolved via manifest mapping:

- Content stores `mediaRef: "media:image:diagram_1"`
- Manifest maps `diagram_1` → local package path and integrity metadata.

## 6) Server-side redesign: conceptual schema direction

Recommended conceptual tables (names illustrative):

1. `uploaded_drafts`
   - server copy of user draft for later edit restore.
   - key fields: `uploaded_draft_id`, `owner_oidc_sub`, `local_draft_id`, `draft_content`, `metadata`, `upload_state`, `updated_at`.

2. `published_packages`
   - immutable package records.
   - key fields: `published_package_id`, `owner_oidc_sub`, `package_family_id`, `derived_from_*`, `schema_version`, `package_version`, `content`, `metadata`, `media_manifest`, `content_hash`, `published_at`.

3. `publication_index` (or indexed columns on `published_packages`)
   - MVP search metadata: normalized title/name + subject + owner + published_at.

4. `attempts`
   - learner state bound to exact source/version.
   - key fields: `attempt_id`, `user_oidc_sub`/`anonymous_token`, `source_type`, `source_id`, `source_hash`, `answers`, `status`, `started_at`, `updated_at`, `submitted_at`.

5. `package_media` (future-ready)
   - media metadata and storage pointers.
   - key fields: `media_id`, `published_package_id`, `kind`, `mime_type`, `storage_uri`, `checksum`.

6. `lineage_events` (optional but recommended)
   - explicit provenance trail for import/fork/publish actions.

## 7) Gap analysis (current docs/shape vs target direction)

### 7.1 Mismatches / obsolete assumptions

- Current docs emphasize `worksheetId`/`snapshotId`; target needs canonical `publishedPackageId`.
- “Sync draft” wording implies bidirectional cloud sync; target reframes this as upload-for-later-edit.
- Viewer launch precedence currently elevates inline payload modes; target de-emphasizes inline `viewerPayload`.
- Some flows still imply auto-resume behavior without a start screen choice.
- Import/export examples still center on worksheet JSON rather than package envelope + media manifest.

### 7.2 Risky areas

- Attempt records may drift if source binding is not explicit (`sourceType` + immutable source identity/hash).
- If published import can mutate existing records, immutability guarantees break.
- Cache behavior for `publishedPackageId` without integrity checks risks stale/incorrect rendering.
- Ownership keyed by mutable identifiers (email) would create account-linking hazards; must stay on OIDC `sub`.

### 7.3 Missing model/data components

- Dedicated uploaded draft server object model.
- Search metadata/index shape for published packages (MVP title + subject).
- Media-aware package manifest and asset reference schema.
- Explicit lineage fields for publish/import/fork transitions.

## 8) Phased implementation plan (PR-sized workstreams)

### Phase 0 — Docs/contracts alignment
- **Goal:** lock architecture terms and launch contracts.
- **Dependencies:** none.
- **Likely files:** `docs/message-contract.md`, `worksheet_launcher_editor_viewer_spec.md`, this doc.
- **Risks:** term drift across old docs.
- **Tests:** doc consistency checklist + launch parameter contract review.

### Phase 1 — Local draft model hardening
- **Goal:** enforce canonical draft fields and split UI state from content.
- **Dependencies:** Phase 0.
- **Likely modules:** editor local store, serializers, draft metadata helpers.
- **Risks:** migration of existing local records.
- **Tests:** create/edit/autosave/reload, draft schema validation, backward-compat parse.

### Phase 2 — Package import/export foundation
- **Goal:** move import/export to package envelope with provenance and versioning.
- **Dependencies:** Phase 1.
- **Likely modules:** import/export pipeline, package manifest handling.
- **Risks:** compatibility with existing JSON exports.
- **Tests:** round-trip import/export, provenance preservation, schema-version mismatch handling.

### Phase 3 — Media layer foundation
- **Goal:** support package media references for images/audio.
- **Dependencies:** Phase 2.
- **Likely modules:** media manifest parser, resolver, storage adapters.
- **Risks:** path/security validation and missing asset handling.
- **Tests:** package with image/audio, missing asset behavior, integrity mismatch behavior.

### Phase 4 — Upload draft for later edit
- **Goal:** replace “sync draft” semantics with upload/restore flow.
- **Dependencies:** Phases 1 and server schema foundations.
- **Likely modules:** auth-gated upload endpoints, draft restore UI/state.
- **Risks:** user expectation mismatch (thinks real-time sync exists).
- **Tests:** upload/retrieve on second device, conflict messaging, offline fallback.

### Phase 5 — Publish flow redesign
- **Goal:** publish from draft to new immutable package (`publishedPackageId` every time).
- **Dependencies:** Phases 2 and 4.
- **Likely modules:** publish endpoint, lineage/provenance recording, publish UI.
- **Risks:** accidental in-place mutation of published content.
- **Tests:** repeated publish creates unique IDs, package immutability checks, re-import->new-draft checks.

### Phase 6 — Viewer start screen + explicit source loading
- **Goal:** no-param start screen with resume option; strict explicit source loading behavior.
- **Dependencies:** Phase 0 contracts + Phase 5 published package load.
- **Likely modules:** viewer bootstrap/route parser, start screen UI, error states.
- **Risks:** regressions in existing deep links.
- **Tests:** all source parameter launch cases + no-param flows.

### Phase 7 — Attempt source-binding changes
- **Goal:** bind attempts to exact immutable source identity/hash.
- **Dependencies:** Phase 5/6.
- **Likely modules:** attempt creation schema, resume logic, server validation.
- **Risks:** inability to resume legacy attempts without adapter.
- **Tests:** resume exact attempt, wrong-source rejection, submission integrity checks.

### Phase 8 — Server DB/API rollout
- **Goal:** implement uploaded drafts/published packages/attempts/search schema and APIs.
- **Dependencies:** preceding contract/model phases.
- **Likely modules:** DB migrations, CRUD APIs, auth middleware, cache headers.
- **Risks:** migration complexity and data backfill.
- **Tests:** API contract tests, ownership authorization tests, search queries, cache-hit/fetch fallback.

## 9) End-to-end test checklist

- [ ] Editor preview via `localDraftId + preview=1` (+ `draftUpdatedAt` cache-bust).
- [ ] No-parameter viewer load shows start screen when resumable attempt exists.
- [ ] From start screen, user can choose “Start fresh” instead of resume.
- [ ] Open imported local package via `importedWorksheetId`.
- [ ] Open published package via `publishedPackageId`.
- [ ] Viewer prefers valid local cached published package before network fetch.
- [ ] Upload draft on device A; restore and continue edit on device B.
- [ ] Import published package into editor creates a **new** local draft (not in-place edit).
- [ ] Publish derived draft creates a new immutable `publishedPackageId`.
- [ ] Attempt persists source binding to exact source/version/hash and rejects mismatched resume source.

## 10) Open decisions for repo owner confirmation

1. Transitional API alias policy: what deprecation timeline should map legacy `snapshotId` fields to canonical `publishedPackageId`?
2. Should `packageFamilyId` be introduced at MVP, or deferred until branching UX requires it?
3. Cache validation strategy for published packages: strict hash match only, or hash + ETag flow?
4. Guest attempt policy defaults for published packages (allowed vs auth-only by default)?
5. Whether legacy inline `viewerPayload` should remain behind a feature flag or compatibility-only mode.
