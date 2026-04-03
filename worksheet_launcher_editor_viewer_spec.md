# Worksheet Launcher Editor + Viewer Technical Specification

> **Related docs**
> - Phase 1 blueprint index: `docs/phase1-blueprint-index.md`
> - This document is part of the Phase 1 documentation set.


> **Change log note (2026-03-24):** Reconciled Phase 1 scope wording across documentation after conflicting statements. This spec now explicitly treats Phase 1 as **contracts/scaffolding only** and positions editor/viewer runtime delivery as later-phase work.
>
> **Scope authority:** `docs/message-contract.md` → **Section 6) Phase boundary** is the canonical scope statement for Phase 1.

## Purpose

This document defines the target functions and technical behavior for later-phase `web-worksheet-launcher` editor and viewer implementation.

It is written for AI coding agents and developers.

The later-phase implementation target is a **mainly JavaScript client-side application** with:
- local-first editing
- local import/export
- public client-side editor and viewer surfaces
- authentication only for protected backend and AI capabilities
- future PostgreSQL-backed protected save/load/publish services

This specification intentionally keeps v1 small and implementation-friendly while clarifying that Phase 1 itself is contracts/scaffolding only.

## Architecture direction update (2026-04-03)

This spec is updated to align with the package-first/hybrid direction:

- **Drafts are the only editable object** in the editor.
- **Published packages are immutable** and opened canonically by `publishedPackageId`.
- **Attempts are source-bound** to exact source identity/version.
- **Inline `viewerPayload` is compatibility-only**, not the preferred main viewer route.
- **No-parameter `/viewer/` launch shows a start screen** with a resume option instead of hard auto-resume.
- “Sync draft” terminology is replaced with **Upload draft for later edit** (cross-device continuation/recovery, not real-time collaboration sync).

---

## Existing Project Direction

The current repo is described as a simple web worksheet launcher with popup rendering, AI rewrite support, and secure result return. The current prototype establishes contracts and scaffolding rather than a full editor/viewer application.

This specification extends that direction into a fuller worksheet editor + viewer product for later phases; it is not a statement that Phase 1 delivers runtime implementation.

## Legacy / compatibility popup flow

Treat the existing popup launcher flow as a legacy or compatibility-oriented integration path, not as the main worksheet runtime.

- `server/worksheet_launcher/render.html` remains only the popup compatibility renderer.
- The real worksheet editor must get its own app entry, such as `server/editor/index.html`.
- The real worksheet viewer must get its own app entry, such as `server/viewer/index.html`.
- Popup transport and query contracts do **not** define the editor/viewer product contracts; those contracts must be defined separately for the real editor and viewer apps.

This legacy/compatibility labeling is intentional so future implementation work does not accidentally extend the popup surface into the main runtime.

---

## Route + Auth Contract (Normative)

This section is the single normative source for editor/viewer route behavior and auth-trigger behavior in later phases.

Cross-links:
- Popup-only compatibility contract: `docs/message-contract.md`
- This section is authoritative for editor/viewer route/auth rules and should be linked by any implementation ADRs or tickets.

### Route contract (normative)

| Route path | Surface | Entry file | Public access | Notes |
| --- | --- | --- | --- | --- |
| `/editor/` | Worksheet editor app | `server/editor/index.html` | Yes | Local-first editor route. Must load and run without login for local create/edit/autosave/import/export. |
| `/viewer/` | Worksheet viewer app | `server/viewer/index.html` | Yes | Local-first viewer route. Must load and run without login for local viewing/attempt flow. |
| `/worksheet/render.html` | Legacy popup compatibility renderer | `server/worksheet_launcher/render.html` | Launch-controlled | Popup compatibility-only surface bound to `docs/message-contract.md`; not the main editor/viewer runtime. |

Normative route rules:
1. `/editor/` and `/viewer/` are the primary product surfaces for later-phase runtime.
2. Entry files above are the canonical startup documents for those surfaces.
3. Protected capabilities may require auth redirects, but route boot itself must remain publicly reachable.
4. Popup route contract remains separately versioned and must not be treated as editor/viewer route contract.

### Auth trigger matrix (normative)

| capability | login required? | local fallback behavior | expected user prompt/state restoration |
| --- | --- | --- | --- |
| Local autosave/import/export (editor) | No | Continue entirely local (IndexedDB/file APIs). | No login prompt. Preserve draft and UI state as-is. |
| Rewrite / T2A | On demand | Keep user in local editor state; do not execute service call while signed out. | Prompt: “Sign in to use Rewrite/T2A.” Persist draft + restore intent, redirect to auth, then restore state and replay intent if still valid. |
| Upload draft for later edit | On demand | Keep draft local and mark as not-uploaded. | Prompt: “Sign in to upload this draft for later edit.” Persist draft + selected draft ID + pending upload intent, then restore and run upload after login. |
| Publish (guest/signed-out attempt) | Yes | No publish action while signed out; local draft remains editable/exportable. | Prompt: “Sign in required to publish.” Persist draft + publish intent + route/UI selection, restore after login, then re-validate publishability before submit. |
| Viewer local attempt | No | Continue local answer capture/autosave only. | No login prompt. Preserve local attempt state and resume locally after reload. |
| Viewer server-backed autosave / cross-device resume | Yes | Continue local attempt only if user declines login; do not call protected sync APIs. | Prompt: “Sign in to sync progress across devices.” Persist local attempt + resume target + pending sync intent, restore viewer state after login, then attach/sync attempt. |

Normative auth-trigger rules:
1. “On demand” means auth is initiated only when the user invokes that protected capability.
2. Protected action buttons may be visible while signed out, but must clearly indicate sign-in requirement.
3. Any auth redirect must be preceded by local persistence of minimum restore state.
4. Post-login restore must not drop in-progress local draft/attempt data.

### Flow contract: signed-out editor → protected feature

Numbered flow:
1. User is on `/editor/` signed out with local draft in progress.
2. User clicks a protected action (`Rewrite`, `T2A`, `Upload draft for later edit`, or `Publish`).
3. App blocks protected API call pre-auth and records pending intent (`resumeRewriteAfterLogin`, `resumeT2AAfterLogin`, `resumeDraftUploadAfterLogin`, or `resumePublishAfterLogin`).
4. App persists local restore bundle:
   - current `localDraftId`
   - draft payload in IndexedDB
   - route/UI state in localStorage (mode, selected block, optional scroll/hash)
5. App redirects browser to protected login endpoint.
6. After successful auth return, app reloads `/editor/`, checks session, and reloads draft by `localDraftId`.
7. App restores UI state and re-validates pending intent.
8. If intent still valid, app executes the protected action; otherwise shows clear recovery message and keeps draft intact.

### Flow contract: signed-out viewer → protected sync/rewrite feature

Numbered flow:
1. User is on `/viewer/` signed out with a local attempt in progress.
2. User invokes protected viewer feature (server-backed autosave/cross-device sync or viewer-side rewrite assist, if enabled).
3. App blocks protected call pre-auth and writes pending intent (`resumeAttemptSyncAfterLogin` or equivalent protected viewer intent).
4. App persists local viewer restore bundle:
   - `localAttemptId`
   - current answer state/autosave snapshot in IndexedDB
   - lightweight UI/route resume metadata in localStorage
5. App redirects to protected login endpoint.
6. After login return to `/viewer/`, app verifies session and restores local attempt state.
7. App replays protected intent:
   - for sync: create/link server attempt and keep localAttemptId stable
   - for rewrite: call protected rewrite service against restored local state
8. On any protected-call failure, app surfaces error and continues local attempt without data loss.

---

## Product Model

## Core Principle

The editor and viewer routes/pages are public client-side app surfaces. Authentication is required only when the app invokes protected backend or API capabilities. Protected capabilities include draft save/load, publish, server-backed worksheet load, attempt sync/save/load, rewrite, and text-to-audio (T2A). Local import/export, local autosave, local preview, and local viewer usage must remain usable without login.

### Public client-side capabilities
No login required for:
- open app
- create worksheet
- edit worksheet
- preview worksheet
- run viewer locally
- local autosave
- import worksheet
- export worksheet

### Protected capabilities
Require an authenticated session through Apache OIDC protected service endpoints:
- rewrite API
- text-to-audio API
- online draft save
- online draft load
- publish online
- load protected server-backed worksheet content
- attempt sync/save/load
- future multi-device continuity built on protected backend state

---

## Authentication Architecture

## Required Approach

Do **not** implement custom popup OIDC inside the frontend app.

Use:
- public frontend app shell for editor and viewer routes/pages
- one **Sign in** button when protected capabilities are available
- browser redirect to an Apache OIDC protected endpoint only when the user invokes a protected capability
- return to app after successful login
- app restores local state after login

## Required Login UX

### Signed-out state
- app works for local editor and viewer flows without login
- protected backend/API features are visibly disabled or marked as sign-in required

### User clicks Sign in
Frontend must:
1. save current draft locally
2. save lightweight UI restore state locally
3. redirect browser to a protected auth/login endpoint
4. after successful login, return to app
5. app re-checks authenticated session and enables protected features

## Required Restore Behavior
If user clicks sign in during editing:
- draft content must not be lost
- editor state should be restorable
- at minimum restore:
  - current draft
  - current mode
  - current selected item if possible
  - route/hash if used
  - optional scroll position

Recommended local persistence:
- IndexedDB for worksheet draft and local viewer state
- localStorage for small resume-after-login flags

## Required local persistence model

The app must define explicit local storage responsibilities rather than treating local persistence as an implementation detail.

### IndexedDB
Use IndexedDB for durable local content/state records, including:
- local worksheet drafts
- imported worksheets stored for later editing or viewing
- local viewer attempts and local autosave state

Minimum IndexedDB record groups:
- `localDrafts`: editable local worksheet draft objects
- `importedWorksheets`: imported worksheet/source payloads preserved for local reuse
- `localAttempts`: viewer answer state, submit status, and local resume metadata

IndexedDB is the source of truth for larger local JSON payloads because it is better suited than `localStorage` for draft content, imported documents, and autosaved attempt state.

### localStorage
Use `localStorage` only for lightweight UI/session restore metadata, including:
- lightweight session restore flags
- selected worksheet reference or selected attempt reference for post-login resume
- pending action intent such as `resumePublishAfterLogin`, `resumeDraftSaveAfterLogin`, or `resumeAttemptSyncAfterLogin`

`localStorage` must not be treated as the canonical store for full worksheet JSON or full attempt payloads.

### Required local record metadata
Every locally persisted draft or attempt object must include stable local metadata such as:
- `localId`: durable local identifier generated on the client
- `origin`: `local_created` | `imported_file` | `server_synced`
- `updatedAt`: last local write timestamp
- optional server linkage fields when the record has been synced

---

## Technical Architecture

## Frontend
- Main implementation should remain browser-first and JavaScript-first
- No backend requirement for basic local operation
- Editor and viewer should work without cloud APIs

## Backend
Protected APIs are authenticated enhancement services:
- rewrite service
- T2A service
- worksheet draft/publish storage service
- server-backed worksheet load service
- attempt sync/save/load service

## Minimum Backend API Contract (Scaffolding-Normative)

This section defines the **minimum** JSON contract for backend draft/snapshot/attempt endpoints so frontend and backend can integrate before full business logic exists.

Identifier mapping in all request/response payloads is fixed to the database schema contract:
- frontend `worksheetId` ↔ DB `worksheets.public_id`
- frontend `snapshotId` ↔ DB `worksheet_versions.public_id`
- frontend `attemptId` ↔ DB `worksheet_attempts.public_id`

### Common response envelope and auth/error semantics

Success envelope:

```json
{
  "ok": true,
  "data": {}
}
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

Required auth/error status behavior across endpoints:

- `401 Unauthenticated` + `AUTH_UNAUTHENTICATED`: no valid OIDC session for an endpoint that requires authenticated identity
- `403 Unauthorized` + `AUTH_FORBIDDEN`: authenticated identity exists, the target resource is known to the server and is allowed to be *existence-revealing* for this endpoint, but the caller does not have permission to perform the requested action on that worksheet/snapshot/attempt
- `400 Invalid Request` + `INVALID_REQUEST`: malformed request shape or invalid create/update usage for contracts that support both create and update semantics
- `409 Conflict` + `STATE_CONFLICT`: optimistic concurrency/revision mismatch or duplicate-resume conflict
- `404 Not Found` + `NOT_FOUND`: the resource identifier is unknown **or** the resource exists but is *not visible to the caller by policy*, and the endpoint intentionally does not acknowledge its existence (i.e., the response is 404 instead of 403 to avoid existence disclosure)

**403 vs 404 rule:** For any endpoint, if a request targets a resource whose existence is safe and intended to be acknowledged (e.g., a user’s own worksheet listed via an index call), implementations MUST return `403` when the caller is authenticated but lacks permission for the requested action. If either (a) the identifier is unknown or (b) the endpoint’s access-control policy requires hiding whether the resource exists for this caller, implementations MUST return `404` and `NOT_FOUND` instead of `403` to avoid existence disclosure. Endpoints MUST apply this rule consistently for the same resource type.
### 1) `saveDraft`

Purpose: upsert authenticated draft state for a worksheet owner.

Auth:
- Requires authenticated OIDC subject (`sub`)
- Guest/anonymous not allowed

Request example:

```json
{
  "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
  "baseRevision": "wr_000041",
  "draftContent": {
    "title": "Fractions Practice",
    "blocks": []
  },
  "clientUpdatedAt": "2026-03-27T10:00:00Z"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
    "revision": "wr_000042",
    "updatedAt": "2026-03-27T10:00:01Z"
  }
}
```

### 2) `loadDraft`

Purpose: load current authenticated owner draft by public worksheet identifier.

Auth:
- Requires authenticated OIDC subject (`sub`)
- Guest/anonymous not allowed

Request example:

```json
{
  "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de"
}
```

Normative no-draft behavior:
- If `worksheetId` is valid and visible/authorized for the caller but no server draft exists yet, backend MUST return `200` with `{"ok": true, "data": null}`.
- `404 NOT_FOUND` is reserved for worksheet identifiers that are unknown or not visible to the caller by policy.

Response example:

```json
{
  "ok": true,
  "data": {
    "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
    "revision": "wr_000042",
    "draftContent": {
      "title": "Fractions Practice",
      "blocks": []
    },
    "updatedAt": "2026-03-27T10:00:01Z"
  }
}
```

Response example (no server draft yet):

```json
{
  "ok": true,
  "data": null
}
```

Frontend handling note:
- Branch `ok=true && data=null` as a normal “no server draft yet” state and continue local-first draft flow (optionally first-save prompt).
- Branch `404 NOT_FOUND` as “worksheet missing or not visible” and route to unavailable/not-found UX; do not silently treat this as empty draft state.

### 3) `publishSnapshot`

Purpose: create immutable published snapshot from current draft.

Auth:
- Requires authenticated OIDC subject (`sub`)
- Guest/anonymous not allowed

Request example:

```json
{
  "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
  "baseRevision": "wr_000042",
  "publishNote": "Unit 3 release"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
    "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "versionNo": 3,
    "publishedAt": "2026-03-27T10:05:00Z"
  }
}
```

### 4) `loadPublishedSnapshot`

Purpose: load immutable published worksheet content for viewer/runtime.

Auth:
- OIDC subject not required for public snapshot access
- If product policy marks a snapshot restricted, require authenticated OIDC subject and enforce authorization

Request example:

```json
{
  "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "worksheetId": "1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de",
    "versionNo": 3,
    "content": {
      "title": "Fractions Practice",
      "blocks": []
    },
    "publishedAt": "2026-03-27T10:05:00Z"
  }
}
```

### 5) `saveAttempt`

Purpose: persist or update in-progress viewer attempt state.

Auth / guest rules:
- Authenticated mode: requires OIDC subject (`sub`) and stores `user_oidc_sub`
- Guest mode: allowed without OIDC only when request includes `anonymousToken` and target snapshot policy allows guest attempts
- `anonymousToken` must be treated as a stable pseudonymous resume key, not as proof of ownership across unrelated snapshots
- `attemptId` is optional:
  - if omitted, backend MUST treat request as **create attempt** and return backend-issued `attemptId`
  - if present, backend MUST treat request as **update attempt** for an existing attempt owned/authorized for caller
- Backend MUST return `400 INVALID_REQUEST` for invalid create/update shape (for example, update path with unknown/invalid `attemptId` format or create/update field combinations that violate endpoint contract)

Request example (create attempt: no `attemptId`):

```json
{
  "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
  "baseRevision": "ar_000000",
  "answers": {
    "blk_q1": "3/4"
  },
  "status": "in_progress"
}
```

Request example (update attempt: with prior `attemptId`):

```json
{
  "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
  "attemptId": "e7d36570-8258-48a1-a6b5-0f96f6a3da6c",
  "baseRevision": "ar_000007",
  "answers": {
    "blk_q1": "3/4"
  },
  "status": "in_progress"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "attemptId": "e7d36570-8258-48a1-a6b5-0f96f6a3da6c",
    "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "revision": "ar_000008",
    "savedAt": "2026-03-27T10:15:00Z"
  }
}
```

Frontend handling note:
- If client has no server `attemptId`, call create path (omit `attemptId`) and persist returned backend-issued `attemptId` for subsequent saves.
- If client has an `attemptId`, call update path and handle `400 INVALID_REQUEST` as a request-shape/contract bug and `404/403` as missing/not-visible vs forbidden attempt access per endpoint policy.

### 6) `resumeAttempt`

Purpose: resume previously saved attempt state.

Auth / guest rules:
- Authenticated resume by `attemptId` requires matching authorized OIDC subject
- Guest resume is allowed via `{ snapshotId, anonymousToken }` when guest attempts are enabled
- If both OIDC and `anonymousToken` are present, backend must prioritize OIDC ownership checks and reject token-only escalation attempts

Request example (authenticated by attempt):

```json
{
  "attemptId": "e7d36570-8258-48a1-a6b5-0f96f6a3da6c"
}
```

Request example (guest by snapshot/token):

```json
{
  "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
  "anonymousToken": "anon_9xK2fV0uEw"
}
```

Response example:

```json
{
  "ok": true,
  "data": {
    "attemptId": "e7d36570-8258-48a1-a6b5-0f96f6a3da6c",
    "snapshotId": "7d5176ac-3cb9-46d6-b59f-c4bf15ce8fe1",
    "revision": "ar_000008",
    "status": "in_progress",
    "answers": {
      "blk_q1": "3/4"
    },
    "updatedAt": "2026-03-27T10:15:00Z"
  }
}
```

### Compatibility guardrail with popup Phase 1 transport

- These backend contracts are for later-phase editor/viewer APIs and do **not** alter popup launch-query or popup `postMessage` behavior defined in `docs/message-contract.md`.
- Do not modify popup transport fields, popup validation invariants, or Phase 1 popup scaffolding unless `docs/message-contract.md` itself is intentionally versioned/updated in the same change.

## Storage Modes

### Local Storage Mode
- default mode
- store local drafts, imported worksheets, and local attempts in IndexedDB
- keep lightweight restore flags and pending action intent in `localStorage`
- export/import file-based project format

### Cloud Storage Mode
- authenticated protected-capability mode
- store drafts, published versions, server-backed worksheet loads, and attempts in PostgreSQL-backed APIs

## Local IDs and server ID mapping

Local draft and local attempt objects must have durable local IDs that are distinct from server public IDs.

Required rules:
- a local draft uses a client-generated `localDraftId` even before any sign-in or backend save exists
- a local attempt uses a client-generated `localAttemptId` even before any server-backed attempt exists
- server-backed identifiers such as `worksheetId`, `snapshotId`, and `attemptId` must be stored separately from local IDs and must never overwrite them
- imported worksheets stored locally should keep a stable local record ID even if they later map to a server-backed worksheet
- a synced local worksheet keeps both its stable `localDraftId` and its linked server `worksheetId`
- a synced local attempt keeps both its stable `localAttemptId` and its linked server `attemptId`

### Identifier formats
Use explicit, mode-specific identifier formats:
- local worksheet identifier before login: `localDraftId = ld_<ulid>`
- server worksheet public identifier after sync: `worksheetId = <uuid>` mapped from the backend public worksheet identifier
- local attempt identifier before server persistence: `localAttemptId = la_<ulid>`
- server attempt identifier after upload/resume: `attemptId = <uuid>` mapped from the backend public attempt identifier

Format rules:
- local IDs are client-generated, opaque, and durable within the browser profile
- server IDs are backend-issued public identifiers and must never be client-generated
- exported files from a synced worksheet should preserve both the local record ID and the linked server public IDs in metadata when available

Recommended local record shape:

```json
{
  "localDraftId": "ld_01...",
  "serverWorksheetId": null,
  "serverDraftRevisionId": null,
  "lastSyncState": "local_only"
}
```

```json
{
  "localAttemptId": "la_01...",
  "serverAttemptId": null,
  "worksheetRef": {
    "localDraftId": "ld_01...",
    "snapshotId": null
  },
  "lastSyncState": "local_only"
}
```

### Sync behavior after login
When a user signs in and chooses a protected capability, sync must map local records to server-backed records without replacing the local identity layer.

Minimum sync rules:
1. Read the current local draft/attempt from IndexedDB using its local ID.
2. Create or update the corresponding backend record.
3. Persist returned server identifiers alongside the existing local IDs.
4. Update local sync metadata such as `lastSyncState`, `lastSyncedAt`, and any canonical server revision/snapshot/attempt reference.
5. Keep the local record addressable by its local ID so offline/local workflows and post-login restore continue to work.

Examples:
- Local draft save after login: `localDraftId` stays stable while the record gains `serverWorksheetId` and server revision metadata.
- Publish after login: publish resolves from the synced server draft revision; the local draft remains a draft record and stores the returned published snapshot reference separately.
- Attempt sync after login: `localAttemptId` stays stable while the record gains `serverAttemptId` and any server-backed resume metadata.

### Conflict rules

#### Importing a file that already came from a synced worksheet
- Import must always create or preserve a distinct local record with its own `localDraftId`; importing a file must not silently overwrite an existing synced local draft.
- If the imported file includes a linked `worksheetId` that already exists in local metadata, the app should treat the import as a potential fork/duplicate and require an explicit user choice such as `open as separate local copy` or `replace local copy`.
- Default safe behavior is `open as separate local copy` while retaining the linked server `worksheetId` only as source metadata until the user explicitly chooses to sync.

#### Syncing a local draft after edits were made both locally and on server
- The backend revision metadata linked to the local draft is authoritative for conflict detection.
- If local changes are based on an older server revision than the current backend revision, sync must not silently overwrite the newer server draft.
- Minimum outcome is an explicit conflict state that lets the user choose to reload server state, keep the local fork as a new local draft, or perform a deliberate overwrite through an explicit product action.

#### Promoting a local viewer attempt into a server-backed attempt after login
- If the local attempt has no linked `serverAttemptId`, the backend may create a new server-backed attempt and return `attemptId` while the local record keeps its existing `localAttemptId`.
- If the user resumed an existing backend attempt after login, the local attempt record must link to that returned `attemptId` rather than creating a duplicate server attempt.
- If both local and server attempt state changed independently, sync must prefer an explicit merge/review flow or server-defined reconciliation policy; it must not silently discard either side's latest answers.

---

## File / Data Format

## Worksheet Internal Model
Use a structured JSON model for the worksheet.

Minimum expected shape:

```json
{
  "title": "Fractions Practice",
  "description": "Simple worksheet",
  "blocks": [
    {
      "blockId": "blk_q1",
      "kind": "question",
      "prompt": "What is 1/2 + 1/4?",
      "responseConfig": {
        "inputType": "short_text"
      }
    }
  ],
  "settings": {
    "allow_resume": true,
    "show_result_after_submit": false
  }
}
```

Compatibility note: older examples may have used `sections` with block `type`, but future editor/viewer and persistence contracts must treat `blocks` and `kind` as authoritative.

## Important Rule
The worksheet JSON model is the source of truth.

That means:
- editor edits JSON
- viewer renders JSON
- export serializes JSON
- publish requests a backend publish transaction for the saved worksheet draft; the backend creates and stores the immutable snapshot
- online draft save stores JSON

---

## Import / Export Requirements

## Required in v1
The app must support file-based portability like a local-first tool.

### Export
The user must be able to export the current worksheet into a file format that can later be imported again.

Recommended v1 format:
- JSON file, or
- ZIP if media/assets are introduced later

### Import
The user must be able to import an exported worksheet file and restore it into the local editor.

## Important
Import/export must work without login.

---

## Editor Mode Requirements

## Functional Requirements

### Create worksheet
- Create a new worksheet in memory/local storage
- Apply default empty structure

### Edit worksheet metadata
- Edit title
- Edit description

### Manage blocks/questions
- Add new block/question
- Remove block/question
- Reorder block/question
- Edit question prompt
- Edit `blocks[*].kind` to change the coarse block category (for example `question` vs `content`)
- Edit `blocks[*].responseConfig.inputType` to change the question input subtype / answer UI for question blocks
- Switch question blocks between the required v1 input types: `short_text`, `multiple_choice`, `textarea`, and `checkbox_group`
- Edit `kind`-specific block settings and `responseConfig.inputType`-specific settings/options without conflating the two

### Supported minimum response input types for v1
Recommended minimum set for question blocks:
- `short_text`
- `multiple_choice`
- `textarea`
- `checkbox_group`

AI agent may implement more only if they do not complicate core flow.

### Autosave locally
- Changes should autosave to IndexedDB with debounce
- UI should indicate save state if practical

### Manual export
- Export current draft to file

### Manual import
- Import worksheet file into current local draft or as a new local worksheet

### Preview
- Open current draft in viewer mode using local draft data

---

## Editor Non-Functional Requirements

- Must work without server dependency for basic use
- Must tolerate page reload by restoring latest local autosave
- Must avoid destructive loss of draft during sign-in redirect
- Must be modular enough for future cloud sync

---

## Viewer Mode Requirements

## Functional Requirements

### Load worksheet
Viewer must be able to load from:
- local draft/preview mode
- local imported worksheet
- future published online worksheet

### Render blocks/questions
Viewer must render each block according to its kind while keeping response/input subtype fields distinct.

### Capture answers
Viewer must maintain answer state in a structured JSON object

### Local autosave
In local mode, answers can be kept in browser state or IndexedDB

### Submit
Viewer must support final submit action in two modes:
- local-only completion state
- future cloud submit to backend

### Resume
Viewer should be structured so future resume is possible, even if full cloud resume is added later

---

## AI Service Integration Requirements

## Rewrite
Rewrite is optional and requires sign-in.

Rule: rewrite is a service/UI capability, not a canonical worksheet JSON field. Future draft, snapshot, viewer, and persistence models should keep rewrite configuration out of the worksheet content model unless a later ADR defines a dedicated content-level capability field. The existing popup `rewrite` flag is therefore treated as popup-v1-only transport behavior rather than the default editor/viewer schema.

Examples:
- rewrite question-block prompt drafts
- rewrite user-entered teacher text
- rewrite answer text areas if desired later

Behavior:
- if signed out, feature is disabled and prompts for sign-in
- if signed in, frontend calls protected rewrite API

## Text-to-Audio (T2A)
T2A is optional and requires sign-in.

Potential uses:
- generate spoken reading for question-block prompts
- preview generated audio

Behavior:
- if signed out, feature is disabled and prompts for sign-in
- if signed in, frontend calls protected T2A API

---

## Cloud Storage Requirements

## Online Draft Save
Signed-in user can save worksheet draft online.

Expected behavior:
- create or update `worksheets`
- store latest JSON in `draft_content`

## Online Draft Load
Signed-in user can load previously saved worksheets.

Expected behavior:
- query backend for worksheets owned by user
- select and load draft JSON into editor

## Publish
Publish requires a signed-in user and must operate on a server-saved worksheet record plus its authoritative server draft revision.

Expected behavior:
- frontend sends a publish request for an already saved server worksheet record; it does not authoritatively submit canonical publish metadata
- backend validates the saved draft and the authoritative persisted draft revision before publish
- backend creates an immutable `worksheet_versions` snapshot row from the saved draft record
- backend assigns `snapshotId`, `version_no`, `published_at`, and provenance fields such as the authoritative source draft revision and publishing user identity
- backend updates `worksheets.current_version_id` and sets status appropriately
- frontend receives returned publish metadata from the backend and stores it as server-issued state

## Viewer Online Load
Future public or protected viewer flow can load a published worksheet by public identifier.

Rules:
- online viewer load must resolve through a published snapshot, never a live draft row
- if no current published version exists for the requested worksheet, online viewer load must fail with a not-published/not-found outcome rather than falling back to draft content
- archived worksheets should not be opened for new public viewing by default; a later product decision may allow privileged historical review, but that must still resolve to an immutable published snapshot
- guest attempts are allowed only for viewer modes explicitly configured to permit guest access; protected or authenticated-only viewer modes must require sign-in before starting or resuming an attempt
- attempts that started before archival may continue or be resumed only if the product explicitly allows archived-snapshot access for that viewer mode; otherwise the viewer should surface a clear archived/unavailable state

## Attempt Autosave / Submit
Future signed-in or token-backed viewer flow can save progress in `worksheet_attempts`.

---

## Required Frontend State Model

At minimum, frontend state should clearly separate:

```js
{
  auth: {
    authenticated: false,
    user: null
  },
  mode: "editor" | "viewer",
  storageMode: "local" | "cloud",
  worksheet: { ...worksheetJson },
  viewerAnswers: { ...answersJson },
  ui: {
    selectedBlockId: null,
    isDirty: false,
    saveState: "idle" | "saving" | "saved" | "error"
  }
}
```

Important:
- `storageMode` is not identical to auth
- signed-in user may still choose to work locally first

---

## Required API Boundaries

Frontend should depend on abstractions, not hardcoded storage details.

Recommended service modules:
- `authService`
- `localWorksheetStore`
- `cloudWorksheetStore`
- `rewriteService`
- `t2aService`

This keeps the code easier to extend and test.

---

## Suggested Frontend Module Breakdown

Recommended module areas:

- `app/`
  - app bootstrap
  - routing or mode switching
- `state/`
  - central state store
- `editor/`
  - editor UI and actions
- `viewer/`
  - viewer UI and answer capture
- `storage/`
  - local IndexedDB storage
  - file import/export
  - cloud API adapter
- `services/`
  - auth session check
  - rewrite
  - t2a
  - worksheet storage API client
- `utils/`
  - IDs
  - validation
  - JSON normalization

---

## Minimum Required UI Behavior

### Signed-out UI
- local features usable
- cloud/AI actions visible but locked or disabled
- clear sign-in entry point

### Signed-in UI
- same local features remain available
- cloud/AI actions become enabled
- user should not lose in-progress local worksheet when sign-in occurs mid-edit

---

## Validation Requirements

Minimum editor validation should check:
- worksheet title exists
- blocks/questions have unique `blockId`
- required prompts are present
- multiple choice options are valid
- unsupported or broken block kinds or response input types are flagged safely

Viewer validation should fail gracefully if JSON is malformed.

---

## Publish Rules

A draft is publishable only when all of the following are true:
- required worksheet metadata is present (at minimum a valid title)
- all blocks have stable unique `blockId` values and valid `kind` values
- every question block has a valid prompt and valid `responseConfig`
- the backend has persisted the draft and can identify the canonical server draft revision used for publish provenance
- the worksheet is not in an archived-only state that forbids republish in the current product mode

Publish operation should:
1. require login and ensure the draft has already been saved to the backend
2. block publish if the saved draft is invalid or lacks a persisted backend draft revision
3. send a publish intent for the saved worksheet record and authoritative server draft revision, not a client-authored canonical snapshot payload
4. let the backend validate the saved draft, create the immutable snapshot row, and assign publish metadata
5. return backend-issued published version metadata
6. keep local draft intact after publish

State-transition rules:
- `draft` -> `published` is allowed when the publishability conditions above pass
- `published` -> `published` is allowed for a republish that creates a new immutable snapshot version
- `archived` worksheets should not accept new learner attempts by default; republish from archived state should require an explicit product decision to unarchive or otherwise authorize a new publish path
- archival should never mutate or delete historical published snapshots; it changes access policy, not snapshot immutability

---

## Error Handling Requirements

Frontend must handle:
- signed-out calls to protected features
- network failure
- local storage failure
- invalid import file
- backend publish/save errors
- stale session or expired auth

Errors should not destroy local draft state.

---

## Nice-to-Have but Not Required for v1

These are optional and should not block initial implementation:
- drag-and-drop reorder
- collaborative editing
- analytics dashboard
- media attachments
- full template library
- version history UI
- offline service worker
- background cloud sync

---

## Development Priority Order

Recommended implementation order for AI agent:

1. define worksheet JSON model
2. build local editor mode
3. build local viewer mode
4. add IndexedDB autosave
5. add import/export
6. add sign-in button flow with redirect-safe local restore
7. add session check integration
8. add rewrite API integration
9. add cloud draft save/load
10. add publish flow
11. add attempt autosave/submit

---

## Explicit Constraints for AI Coding Agent

- Keep v1 mainly client-side
- Do not require login for local editing/import/export
- Do not implement custom popup OIDC login
- Use redirect-based sign-in through protected endpoint
- Do not couple viewer to live draft DB rows
- Use published version snapshots for online viewing
- Keep local-first behavior as a first-class feature
- Prefer simple, readable modules over early abstraction-heavy frameworks

---

## Deliverables Expected from AI Agent

### Frontend
- editor mode
- viewer mode
- local autosave
- import/export
- sign-in aware UI state
- protected service hooks for rewrite/T2A/cloud storage

### Backend-compatible integration points
- payloads aligned with worksheet JSON schema
- cloud save/load/publish functions aligned with DB schema document
- attempt payloads aligned with `worksheet_attempts.answers`

---

## Final Guidance

This project should be implemented as a **local-first worksheet tool with public client-side editor/viewer surfaces and authentication only for protected backend and AI capabilities**.

The AI agent should preserve that philosophy throughout implementation:
- local works first
- sign-in unlocks more
- draft and published content remain separated
- viewer behavior stays stable against later edits
