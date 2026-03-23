# Worksheet Launcher Editor + Viewer Technical Specification

## Purpose

This document defines the required functions and technical behavior for the `web-worksheet-launcher` editor and viewer implementation.

It is written for AI coding agents and developers.

The implementation target is a **mainly JavaScript client-side application** with:
- local-first editing
- local import/export
- public client-side editor and viewer surfaces
- authentication only for protected backend and AI capabilities
- future PostgreSQL-backed protected save/load/publish services

This specification intentionally keeps v1 small and implementation-friendly.

---

## Existing Project Direction

The current repo is described as a simple web worksheet launcher with popup rendering, AI rewrite support, and secure result return. The current prototype establishes contracts and scaffolding rather than a full editor/viewer application.

This specification extends that direction into a fuller worksheet editor + viewer product.

## Legacy / compatibility popup flow

Treat the existing popup launcher flow as a legacy or compatibility-oriented integration path, not as the main worksheet runtime.

- `server/worksheet_launcher/render.html` remains only the popup compatibility renderer.
- The real worksheet editor must get its own app entry, such as `server/editor/index.html`.
- The real worksheet viewer must get its own app entry, such as `server/viewer/index.html`.
- Popup transport and query contracts do **not** define the editor/viewer product contracts; those contracts must be defined separately for the real editor and viewer apps.

This legacy/compatibility labeling is intentional so future implementation work does not accidentally extend the popup surface into the main runtime.

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
- IndexedDB for worksheet draft
- localStorage for small resume-after-login flags

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

## Storage Modes

### Local Storage Mode
- default mode
- store draft in IndexedDB
- export/import file-based project format

### Cloud Storage Mode
- authenticated protected-capability mode
- store drafts, published versions, server-backed worksheet loads, and attempts in PostgreSQL-backed APIs

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
- publish stores JSON snapshot
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
Signed-in user can publish worksheet.

Expected behavior:
- backend creates `worksheet_versions` row
- backend updates `worksheets.current_version_id`
- backend sets status appropriately

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
1. validate current draft
2. block publish if draft is clearly invalid or lacks a persisted backend draft revision
3. send snapshot to backend
4. return published version metadata
5. keep local draft intact after publish

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
