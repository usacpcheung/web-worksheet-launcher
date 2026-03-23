# ADR: Phase 1 Worksheet Data Model Boundaries

## Status

Proposed

## Context

Phase 1 establishes contracts and scaffolding for the worksheet launcher integration, but it does not yet define a durable application data model for authoring, publishing, viewing, and learner attempts. This ADR documents a recommended separation between:

1. editable draft state used by the frontend editor
2. immutable published snapshots produced at publish time
3. minimal read-only viewer payloads consumed by learners
4. learner attempt answer payloads stored independently from worksheet content definitions

The goal is to keep authoring concerns, publish-time durability, learner rendering, and learner responses clearly separated so that future phases can evolve each independently.

## Decision

Adopt four distinct JSON shapes with explicit field ownership boundaries.

### Access model

Phase 1 should distinguish the current local popup proof-of-concept from future productized routes so the demo launch path is not mistaken for the long-term serving model. The popup launcher and popup renderer that exist today are local prototype surfaces used to exercise contracts and UI scaffolding only; they are not the access-control design for the eventual product.

| Surface | Access classification | Phase note |
| --- | --- | --- |
| `parent_prototype/parent.html` popup launcher demo | local prototype/demo only | Exists now only to launch the popup with the Phase 1 query-string contract (`w`, `rid`, `returnOrigin`) during local contract validation; it is not a future product route. |
| `server/worksheet_launcher/render.html` popup renderer | local prototype/demo only | Exists now only as the Phase 1 renderer scaffold for the popup proof-of-concept. |
| Planned editor app route | local/public route unless auth-backed features are enabled | Not yet implemented; later phases may keep basic local authoring public when it runs entirely in-browser, but any use of server-backed features such as rewrite, T2A, autosave, publish, versioning, or storage must add authentication and backend authorization. |
| Planned viewer app route | local/public or authenticated route depending on capabilities | Not yet implemented; later phases may allow users to open imported or locally available worksheets without authentication, or load server-backed worksheets when authenticated. The viewer may stay public for local use, but any server-backed worksheet access, stored learner progress, or protected capability must add the required authentication and product gating. |
| Planned draft-save / publish / import / export endpoints | authenticated API | Not yet implemented; reserved for later phases that add backend persistence and authorization. |

### Trust boundary

Future phases must treat all client-originated worksheet payloads as untrusted input, including the current popup launch query parameters, popup `postMessage` payloads, draft JSON bodies submitted from an editor, import payloads, and any client-supplied metadata attached to save/export requests. If a later phase introduces fragment-based routing or client-side route state for product surfaces, those values are also untrusted client input. Client input may describe authored content, but it must not be treated as authoritative for publication state, identity issuance, or audit provenance.

The server must issue and validate durable identifiers and authoritative metadata, including canonical worksheet identifiers, published snapshot identifiers, authenticated user identity, persisted draft revision metadata, publish timestamps, and any integrity or audit fields. A client may echo those values back to the server, but the backend must verify that they were server-issued and still valid for the authenticated caller.

Any action that changes durable backend state requires authenticated backend authority. This includes draft save, draft import, publish, unpublish if introduced later, export of non-public authoring data, and any mutation of worksheet metadata. Publish especially must run as an authenticated backend transaction that derives the immutable snapshot from persisted draft state, assigns server-owned publish metadata, and refuses to trust client-declared `publishedAt`, `publishedByUserId`, `snapshotId`, `snapshotVersion`, or equivalent authority-bearing fields.

This means later editor/viewer routes are not required to be authenticated merely because they exist. A route that works entirely with local data or imported worksheets and does not call protected capabilities may stay public. Authentication becomes required when the route loads protected server-backed worksheets or uses backend-dependent features such as rewrite services, text-to-audio, autosave, durable storage, publish/versioning flows, or learner-state persistence.

---

## 1) Editable draft model

**Purpose:** frontend-owned authoring state for the worksheet editor.

**Characteristics:**

- Represents mutable authoring state before publish.
- Uses stable identifiers for the worksheet and for each question/content block.
- May include editor-only metadata, local validation state, and unsaved changes.
- Contains both client-authored fields and placeholders for server-assigned fields.

### Draft shape

```json
{
  "draftWorksheetId": "ws_draft_01HXYZ...",
  "serverWorksheetId": null,
  "status": "draft",
  "clientRevision": 12,
  "title": "Argument writing practice",
  "description": "Students compare two claims and revise a response.",
  "blocks": [
    {
      "blockId": "blk_q_001",
      "kind": "question",
      "position": 0,
      "prompt": {
        "text": "Read the claim and write a stronger revision.",
        "format": "plain_text"
      },
      "responseConfig": {
        "inputType": "rich_text",
        "maxLength": 500
      },
      "draftMeta": {
        "isNew": false,
        "isDirty": true,
        "lastEditedByClientAt": "2026-03-22T12:00:00Z"
      },
      "localValidation": {
        "level": "warning",
        "messages": ["Prompt should mention success criteria."]
      }
    },
    {
      "blockId": "blk_txt_002",
      "kind": "content",
      "position": 1,
      "content": {
        "text": "Use evidence from the passage in your revision.",
        "format": "plain_text"
      },
      "draftMeta": {
        "isNew": true,
        "isDirty": true
      },
      "localValidation": {
        "level": "ok",
        "messages": []
      }
    }
  ],
  "draftMeta": {
    "autosaveState": "pending",
    "unsavedChanges": true,
    "lastLocalSaveAt": "2026-03-22T12:01:00Z",
    "editorSessionId": "sess_abc123"
  },
  "serverAssigned": {
    "createdAt": null,
    "updatedAt": null,
    "createdByUserId": null,
    "canonicalRevision": null
  }
}
```

### Ownership notes

- **Client-authored fields:** `draftWorksheetId`, `title`, `description`, `blocks[*].blockId`, `blocks[*].position`, `blocks[*].prompt`, `blocks[*].content`, and `blocks[*].responseConfig`.
- **Frontend-local/transient fields:** `clientRevision`, `draftMeta`, `localValidation`, and any editor session state. These exist only to coordinate the current frontend editing session and must not be copied into immutable publish artifacts or treated as durable publish provenance.
- **Server-assigned fields:** `serverWorksheetId`, `serverAssigned.createdAt`, `serverAssigned.updatedAt`, `serverAssigned.createdByUserId`, and `serverAssigned.canonicalRevision`.

---

## 2) Published snapshot model

**Purpose:** immutable publish-time representation derived from a draft.

**Characteristics:**

- Created from the draft at publish time.
- Removes editor-only and transient fields.
- Carries publish metadata and explicit version fields.
- Is immutable after publish.
- Viewers consume snapshots, not mutable drafts.

### Snapshot shape

```json
{
  "worksheetId": "ws_01HXYZ...",
  "snapshotId": "wss_01JABC...",
  "draftWorksheetId": "ws_draft_01HXYZ...",
  "schemaVersion": 1,
  "snapshotVersion": 3,
  "publishedAt": "2026-03-22T12:05:00Z",
  "publishedByUserId": "usr_123",
  "sourceDraftRevision": "serverAssigned.canonicalRevision:42",
  "title": "Argument writing practice",
  "description": "Students compare two claims and revise a response.",
  "blocks": [
    {
      "blockId": "blk_q_001",
      "kind": "question",
      "position": 0,
      "prompt": {
        "text": "Read the claim and write a stronger revision.",
        "format": "plain_text"
      },
      "responseConfig": {
        "inputType": "rich_text",
        "maxLength": 500
      }
    },
    {
      "blockId": "blk_txt_002",
      "kind": "content",
      "position": 1,
      "content": {
        "text": "Use evidence from the passage in your revision.",
        "format": "plain_text"
      }
    }
  ],
  "integrity": {
    "contentHash": "sha256:...",
    "publishedFromEnvironment": "production"
  }
}
```

### Snapshot rules

- Snapshot fields are derived from the current draft plus publish metadata.
- Editor-only fields such as `draftMeta`, `localValidation`, `autosaveState`, and `unsavedChanges` are excluded.
- `snapshotId`, `snapshotVersion`, `publishedAt`, and `publishedByUserId` are publish-time records and must be treated as immutable after publish.
- `sourceDraftRevision` records the persisted backend draft revision used by the publish transaction; it is provenance, not a copied frontend counter.
- Learner-facing viewers must consume snapshot data or payloads derived from snapshot data, never a live mutable draft.

### Publish snapshot rules

#### Draft fields copied verbatim into the published snapshot

The publish step copies these authored fields from the selected draft revision without semantic reinterpretation:

- `title`
- `description`
- `blocks[*].blockId`
- `blocks[*].kind`
- `blocks[*].position`
- `blocks[*].prompt`
- `blocks[*].content`
- `blocks[*].responseConfig`
- `draftWorksheetId` as a provenance pointer only; it is not the learner-facing primary identifier

Implementers should treat these as the canonical authored content frozen at publish time.

#### Draft fields stripped during publish

These fields are editor-only, local-only, or otherwise transient and must not appear in the snapshot:

- top-level `draftMeta`
- any nested `blocks[*].draftMeta`
- any `localValidation` data
- `clientRevision` as a mutable editor counter
- `status: "draft"`
- transient autosave/session state such as `autosaveState`, `unsavedChanges`, `lastLocalSaveAt`, and `editorSessionId`
- placeholder containers such as `serverAssigned` when they only describe draft persistence rather than the published artifact

A local draft save is not a publish event and must not create or update a published snapshot.

#### Fields generated by the backend at publish time

The backend assigns or computes publish-time fields such as:

- `worksheetId` when the canonical durable worksheet identity does not yet exist
- `snapshotId`
- `snapshotVersion`
- `publishedAt`
- `publishedByUserId`
- `sourceDraftRevision` derived from persisted backend draft revision metadata (for example `serverAssigned.canonicalRevision`)
- `schemaVersion`
- `integrity.contentHash`
- additional audit metadata needed to persist or verify the immutable artifact

These fields must be derived from the persisted publish transaction, not trusted from client input. The publish flow records the backend draft revision that storage actually committed for the transaction, such as `serverAssigned.canonicalRevision`, rather than mirroring a frontend-local counter.

#### Snapshot immutability after publish

Published snapshot content is immutable after publish. If authored content changes later, the system must create a new snapshot rather than editing the old one in place. Historical snapshots remain readable for auditability, replay, attempt attribution, and deterministic learner review.

#### Version numbers and revision identifiers

- `clientRevision` is a draft-local, frontend-managed counter used only for authoring workflows and optimistic coordination within the active UI; it is not authoritative publish provenance.
- `sourceDraftRevision` records the persisted backend draft revision used to produce a snapshot, such as `serverAssigned.canonicalRevision` captured during the publish transaction.
- `snapshotVersion` is the backend-assigned monotonic version number within a single `worksheetId` lineage.
- `snapshotId` is the opaque durable identifier for a specific immutable published snapshot.
- Multi-tab / multi-device rationale:
  - separate browser tabs or devices can each advance their own local `clientRevision` counters without representing the durable saved draft seen by the backend
  - the publish transaction must therefore record backend persistence metadata, not whichever frontend-local counter happened to be visible when the user clicked publish
- Comparison rules:
  - compare draft freshness in the UI using `clientRevision` for local coordination and backend persistence metadata for server truth, never `snapshotVersion`
  - compare published worksheet history using `snapshotVersion` within the same `worksheetId`
  - use `snapshotId` for exact identity equality, not ordering

#### Attempt references

Attempts should reference both `worksheetId` and `snapshotId`, and may also store `snapshotVersion` for easier reporting/debugging. The binding rules are:

- `worksheetId` identifies the logical worksheet lineage
- `snapshotId` identifies the exact published artifact the learner saw
- the pair `worksheetId` + `snapshotId` identifies the exact immutable learner-visible artifact and is the authoritative attempt binding
- `snapshotVersion` is optional denormalized metadata for convenience/reporting and must agree with the referenced `worksheetId` + `snapshotId` pair

Attempts must never reference a draft-only id in place of the published identifiers, and reconciliation/export/replay logic must not key the learner artifact on `snapshotVersion` alone.

#### Editing a draft after a publish already exists

Once a worksheet has at least one published snapshot, subsequent draft edits only affect the mutable draft state. Existing published snapshots and attempts remain unchanged. A later publish creates a new immutable snapshot with a new `snapshotId` and incremented `snapshotVersion`; it does not rewrite or backfill the previous publish.

#### Required invariants

- Viewer reads only published snapshots or viewer payloads derived from published snapshots.
- Attempts are always tied to a specific published snapshot identified by `worksheetId` + `snapshotId`; `snapshotVersion` is optional metadata only.
- Publishing must not mutate historical snapshots.
- Local draft save must not be treated as publish.
- Publish semantics must remain separate from popup-launch transport concerns.

---

## 3) Viewer payload shape

**Purpose:** minimal read-only payload needed by the learner-facing viewer.

**Characteristics:**

- Derived from the published snapshot.
- Includes only identifiers, versioning, and renderable blocks required by the viewer.
- Excludes editor state and backend/admin metadata not needed to render.

### Viewer payload shape

```json
{
  "worksheetId": "ws_01HXYZ...",
  "snapshotId": "wss_01JABC...",
  "snapshotVersion": 3,
  "title": "Argument writing practice",
  "blocks": [
    {
      "blockId": "blk_q_001",
      "kind": "question",
      "position": 0,
      "prompt": {
        "text": "Read the claim and write a stronger revision.",
        "format": "plain_text"
      },
      "responseConfig": {
        "inputType": "rich_text",
        "maxLength": 500
      }
    },
    {
      "blockId": "blk_txt_002",
      "kind": "content",
      "position": 1,
      "content": {
        "text": "Use evidence from the passage in your revision.",
        "format": "plain_text"
      }
    }
  ]
}
```

### Viewer payload rules

- The viewer payload is read-only.
- It must include `worksheetId` and `snapshotId` so learner attempts can point back to the exact immutable published content seen by the learner; `snapshotVersion` may be included as optional denormalized metadata.
- It must exclude editor-only state, local validation data, autosave state, publishing audit trails, and other backend/admin metadata that is not required to render the experience.

---

## 4) Attempt answers payload shape

**Purpose:** store learner responses separately from the worksheet/snapshot definition.

**Characteristics:**

- References the worksheet and exact immutable snapshot that the learner saw.
- Stores per-question answers plus attempt-level timestamps/status.
- Separates canonical answer values from UI-only client state.

### Attempt payload shape

```json
{
  "attemptId": "att_01JDEF...",
  "worksheetId": "ws_01HXYZ...",
  "snapshotId": "wss_01JABC...",
  "snapshotVersion": 3,
  "learnerId": "lrn_456",
  "status": "submitted",
  "startedAt": "2026-03-22T12:10:00Z",
  "lastSavedAt": "2026-03-22T12:13:00Z",
  "submittedAt": "2026-03-22T12:15:00Z",
  "answers": [
    {
      "blockId": "blk_q_001",
      "kind": "question",
      "value": {
        "text": "A stronger claim uses evidence from the passage to support the argument."
      },
      "uiState": {
        "isFocused": false,
        "selectionStart": 0,
        "selectionEnd": 0,
        "localDraft": "A stronger claim uses evidence from the passage to support the argument."
      },
      "answeredAt": "2026-03-22T12:14:30Z"
    }
  ]
}
```

### Attempt payload rules

- `value` is the canonical learner answer value.
- `uiState` contains client-only fields used for in-progress interaction and should not be required for grading, reporting, replay, or interoperability.
- Attempt records must never redefine worksheet prompts or content blocks; they only reference the published worksheet snapshot identified by `worksheetId` + `snapshotId` and carry learner responses.

---

## Field ownership

| Field or group | Ownership label | Notes |
| --- | --- | --- |
| `draftWorksheetId` | frontend-owned | Client-generated stable draft identifier for local/editor workflows. |
| `serverWorksheetId`, `worksheetId` | backend-owned | Canonical durable worksheet identifier assigned by the server. |
| `snapshotId` | backend-owned | Assigned when a draft is published. |
| `snapshotVersion`, `schemaVersion` | backend-owned | Publish-time version tracking. |
| `title`, `description` | frontend-owned | Authored in the editor; copied into snapshot at publish. |
| `blocks[*].blockId` | frontend-owned | Stable item identifier created in authoring flow and preserved across publish. |
| `blocks[*].position` | frontend-owned | Author-defined ordering before publish; snapshot preserves resulting order. |
| `blocks[*].prompt`, `blocks[*].content`, `blocks[*].responseConfig` | frontend-owned | Content authored in the editor. |
| `draftMeta`, `localValidation`, `uiState` | frontend-owned | Editor/view UI state only; excluded from canonical snapshot definition. |
| `clientRevision` | frontend-owned | Frontend-local/transient counter for authoring workflows and optimistic UI coordination only. |
| `serverAssigned.*` | backend-owned | Audit and persistence metadata assigned by backend storage, including canonical draft revision provenance. |
| `publishedAt`, `publishedByUserId` | immutable-after-publish | Captured at publish time and not mutated afterward. |
| `sourceDraftRevision` | immutable-after-publish | Publish provenance copied from persisted backend draft revision metadata, not from a mirrored frontend counter. |
| `integrity.contentHash` | derived/computed | Computed from published content for integrity or cache validation. |
| viewer payload as a whole | derived/computed | Produced from snapshot data for learner rendering. |
| `attemptId` | backend-owned | Canonical identifier for learner attempt storage. |
| `answers[*].value` | frontend-owned | Learner-authored response value, stored canonically in the attempt record. |
| `answers[*].answeredAt`, `startedAt`, `lastSavedAt`, `submittedAt` | backend-owned | Server-recorded timestamps preferred for consistency and auditability. |
| snapshot record as a whole | immutable-after-publish | Snapshot is frozen once published and serves as the durable learner-facing definition. |

## Compatibility guardrails checklist

Use this checklist during review for any Phase 1 editor/viewer planning or scaffolding work:

- [ ] `docs/message-contract.md` remains the source of truth for the current popup launcher contract.
- [ ] Phase 1 editor/viewer work does **not** change popup query params or the popup `postMessage` schema defined in `docs/message-contract.md`.
- [ ] Any future popup-contract change updates `docs/message-contract.md` in the same change.
- [ ] Parent-side validation continues to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window` in the existing launcher flow implemented across `parent_prototype/sdk/parent-launcher.js`, `server/worksheet_launcher/render.js`, and `server/worksheet_launcher/render.html`.
- [ ] `server/worksheet_launcher/widgets/rewrite-widget.js` remains unchanged for prototype-specific behavior; use versioned files loaded from `server/worksheet_launcher/render.html` when needed.

## Relationship to the current popup launcher contract

`docs/message-contract.md` remains the source of truth for the current popup launcher contract used by the parent launcher and popup renderer. This ADR does **not** replace that contract. Instead, it describes a broader worksheet data-model separation that future phases can use behind or alongside the existing launcher contract.

Implementers should keep publish semantics separate from popup launch transport semantics. Do not merge snapshot publication/versioning rules into the popup query payload or popup `postMessage` schema; continue to treat `docs/message-contract.md` as the legacy/current integration contract for that boundary.
