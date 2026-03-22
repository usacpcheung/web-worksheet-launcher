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

- **Client-authored fields:** `draftWorksheetId`, `clientRevision`, `title`, `description`, `blocks[*].blockId`, `blocks[*].position`, `blocks[*].prompt`, `blocks[*].content`, `blocks[*].responseConfig`, `draftMeta`, `localValidation`.
- **Server-assigned fields:** `serverWorksheetId`, `serverAssigned.createdAt`, `serverAssigned.updatedAt`, `serverAssigned.createdByUserId`, `serverAssigned.canonicalRevision`.
- **Draft-only/transient fields:** `draftMeta`, `localValidation`, `clientRevision`, and any editor session state. These may exist only before publish and must not be copied into immutable publish artifacts.

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
  "sourceDraftRevision": 12,
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
- Learner-facing viewers must consume snapshot data or payloads derived from snapshot data, never a live mutable draft.

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
- It must include snapshot identifiers and version references so learner attempts can point back to the exact published content seen by the learner.
- It must exclude editor-only state, local validation data, autosave state, publishing audit trails, and other backend/admin metadata that is not required to render the experience.

---

## 4) Attempt answers payload shape

**Purpose:** store learner responses separately from the worksheet/snapshot definition.

**Characteristics:**

- References the worksheet and snapshot that the learner saw.
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
- Attempt records must never redefine worksheet prompts or content blocks; they only reference the published worksheet snapshot and carry learner responses.

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
| `clientRevision` | frontend-owned | Local revision counter for authoring workflows. |
| `serverAssigned.*` | backend-owned | Audit and persistence metadata assigned by backend storage. |
| `publishedAt`, `publishedByUserId`, `sourceDraftRevision` | immutable-after-publish | Captured at publish time and not mutated afterward. |
| `integrity.contentHash` | derived/computed | Computed from published content for integrity or cache validation. |
| viewer payload as a whole | derived/computed | Produced from snapshot data for learner rendering. |
| `attemptId` | backend-owned | Canonical identifier for learner attempt storage. |
| `answers[*].value` | frontend-owned | Learner-authored response value, stored canonically in the attempt record. |
| `answers[*].answeredAt`, `startedAt`, `lastSavedAt`, `submittedAt` | backend-owned | Server-recorded timestamps preferred for consistency and auditability. |
| snapshot record as a whole | immutable-after-publish | Snapshot is frozen once published and serves as the durable learner-facing definition. |

## Relationship to the current popup launcher contract

`docs/message-contract.md` remains the source of truth for the current popup launcher contract used by the parent launcher and popup renderer. This ADR does **not** replace that contract. Instead, it describes a broader worksheet data-model separation that future phases can use behind or alongside the existing launcher contract.
