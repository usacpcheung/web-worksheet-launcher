# ADR: Phase 1 Worksheet Data Model Boundaries

> **Change log note (2026-03-24):** Reconciled Phase 1 scope wording across docs after conflicting references to runtime delivery. This ADR now treats Phase 1 as **contracts/scaffolding only** and moves runtime implementation language to later phases.
>
> **Scope authority:** `docs/message-contract.md` → **Section 6) Phase boundary** is the canonical scope statement for Phase 1.

## Status

Proposed

## Context

Phase 1 is contracts/scaffolding only for the popup compatibility slice and does not deliver the editor/viewer runtime or protected backend/API implementation. This ADR therefore records forward-looking data-model boundaries so later phases can implement authoring, publishing, viewing, and learner attempts without treating the popup compatibility slice as the product-wide runtime model. It documents the recommended separation between:

1. editable draft state used by the frontend editor
2. immutable published snapshots produced at publish time
3. minimal read-only viewer payloads consumed by learners
4. learner attempt answer payloads stored independently from worksheet content definitions

The goal is to keep authoring concerns, publish-time durability, learner rendering, and learner responses clearly separated so Phase 1 scaffolding remains bounded to contracts while later phases can evolve each model independently.

## Decision

Adopt four distinct JSON shapes with explicit field ownership boundaries as a design baseline for later implementation phases; in Phase 1, these remain contract/scaffolding guidance.

### Access model

Phase 1 should distinguish the current popup compatibility slice from future editor/viewer product routes so the bounded popup launch path is not mistaken for the long-term serving model. The popup launcher and popup renderer remain compatibility/prototype surfaces used to preserve the existing query-string and `postMessage` contract. Editor/viewer route and backend capability implementation is deferred to later phases.

| Surface | Access classification | Phase note |
| --- | --- | --- |
| `parent_prototype/parent.html` popup launcher demo | local prototype/demo only | Preserved during Phase 1 as the launcher for the popup compatibility slice using the existing query-string contract (`w`, `rid`, `returnOrigin`); it is not the main product route. |
| `server/worksheet_launcher/render.html` popup renderer | local prototype/demo only | Preserved during Phase 1 as the bounded renderer for the popup compatibility slice; it is not the full editor/viewer runtime. |
| Planned editor app route | public client-side app surface | Later phases should add the editor route/page as the primary worksheet authoring surface for local authoring, local autosave, local preview, and import/export, with authentication required only when invoking protected backend or API capabilities such as draft save/load, publish, rewrite, T2A, or server-backed worksheet access. |
| Planned viewer app route | public client-side app surface | Later phases should add the viewer route/page as the primary learner/viewer surface for local preview, local viewer use, imported worksheets, and local autosave, with authentication required only when invoking protected backend or API capabilities such as server-backed worksheet load or attempt sync/save/load. |
| Planned draft-save / publish / import / export endpoints | mixed: protected APIs plus local client features | Later phases should add these capabilities behind the editor/viewer product surfaces: local import/export remain public client-side features, while protected backend capabilities such as draft save/load, publish, server-backed worksheet load, attempt sync/save/load, rewrite, and T2A require authentication and backend authorization. |

### Trust boundary

Future phases must treat all client-originated worksheet payloads as untrusted input, including the current popup launch query parameters, popup `postMessage` payloads, draft JSON bodies submitted from an editor, import payloads, and any client-supplied metadata attached to save/export requests. If a later phase introduces fragment-based routing or client-side route state for product surfaces, those values are also untrusted client input. Client input may describe authored content, but it must not be treated as authoritative for publication state, identity issuance, or audit provenance.

The server must issue and validate durable identifiers and authoritative metadata, including canonical worksheet identifiers, published snapshot identifiers, authenticated user identity, persisted draft revision metadata, publish timestamps, and any integrity or audit fields. A client may echo those values back to the server, but the backend must verify that they were server-issued and still valid for the authenticated caller.

Any action that changes durable backend state requires authenticated backend authority. This includes draft save, draft import, publish, unpublish if introduced later, export of non-public authoring data, and any mutation of worksheet metadata. Publish especially must run as an authenticated backend transaction that derives the immutable snapshot from persisted draft state, assigns server-owned publish metadata, and refuses to trust client-declared `publishedAt`, `publishedByUserId`, `snapshotId`, `snapshotVersion`, or equivalent authority-bearing fields.

This means later-phase editor and viewer routes/pages should be treated as public client-side app surfaces. Authentication is required only when the app invokes protected backend or API capabilities. Protected capabilities include draft save/load, publish, server-backed worksheet load, attempt sync/save/load, rewrite, and text-to-audio. Local import/export, local autosave, local preview, and local viewer usage must remain usable without login.

### Identifier mapping expectations

Implementers must keep internal database join keys distinct from public contract identifiers. This ADR assumes the following recommended mapping when a relational backend is used:

- contract `worksheetId` maps to a durable public worksheet identifier such as `worksheets.public_id`, not the internal numeric `worksheets.id`
- contract `snapshotId` maps to a durable public snapshot identifier such as `worksheet_versions.public_id`, not the internal numeric `worksheet_versions.id`
- contract `attemptId` maps to a durable public attempt identifier such as `worksheet_attempts.public_id`, not the internal numeric `worksheet_attempts.id`

If later phases use PostgreSQL tables similar to the schema in `worksheet_launcher_db_schema.md`, `worksheets.id`, `worksheet_versions.id`, and `worksheet_attempts.id` remain relational keys only. Public API payloads and viewer/editor contracts should expose the corresponding durable public identifiers instead.

---

## 1) Editable draft model

**Purpose:** frontend-owned authoring state for the worksheet editor.

**Characteristics:**

- Represents mutable authoring state before publish.
- Uses stable identifiers for the worksheet and for each question/content block.
- May include editor-only metadata, local validation state, and unsaved changes.
- Contains both client-authored fields and placeholders for server-assigned fields.
- Does not include popup-v1 transport/UI flags such as `rewrite`; those are not part of the canonical worksheet draft/snapshot content model unless a later ADR adds a dedicated content-level capability field.

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

- **Client-authored fields:** `draftWorksheetId`, `title`, `description`, `blocks[*].blockId`, `blocks[*].position`, `blocks[*].prompt`, `blocks[*].content`, and `blocks[*].responseConfig`. Popup-v1 transport flags such as `rewrite` are excluded from the canonical worksheet content model.
- **Frontend-local/transient fields:** `clientRevision`, `draftMeta`, `localValidation`, and any editor session state. These exist only to coordinate the current frontend editing session and must not be copied into immutable publish artifacts or treated as durable publish provenance.
- **Server-assigned fields:** `serverWorksheetId`, `serverAssigned.createdAt`, `serverAssigned.updatedAt`, `serverAssigned.createdByUserId`, and `serverAssigned.canonicalRevision`.

---

## 2) Published snapshot model

**Purpose:** immutable publish-time representation derived by the backend from a saved draft record.

**Characteristics:**

- Created by the backend from a server-saved draft record at publish time.
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
- `sourceDraftRevision` records the persisted backend draft revision used by the publish transaction; in relational storage it should be persisted separately from snapshot content (for example as `worksheet_versions.source_draft_revision`). It is provenance, not a copied frontend counter.
- Learner-facing viewers must consume snapshot data or payloads derived from snapshot data, never a live mutable draft.
- Popup-v1 transport/UI flags such as `rewrite` do not become canonical snapshot content merely because they appear in the Phase 1 popup launch contract.

### Publish snapshot rules

Publish requires an authenticated backend transaction operating on a server-saved worksheet record plus its authoritative persisted draft revision. The client may request publish, but it does not authoritatively submit canonical snapshot metadata or decide snapshot identity/version/provenance fields.


#### Draft fields copied verbatim into the published snapshot

The backend publish step copies these authored fields from the selected saved draft revision without semantic reinterpretation:

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

- `worksheetId` when the canonical durable worksheet identity does not yet exist; in a relational implementation this should map to a public identifier such as `worksheets.public_id`
- `snapshotId`; in a relational implementation this should map to a public immutable identifier such as `worksheet_versions.public_id`
- `snapshotVersion`
- `publishedAt`
- `publishedByUserId`
- `sourceDraftRevision` derived from persisted backend draft revision metadata (for example `serverAssigned.canonicalRevision`) and, in relational storage, persisted on a dedicated column such as `worksheet_versions.source_draft_revision`
- `schemaVersion`
- `integrity.contentHash`
- additional audit metadata needed to persist or verify the immutable artifact

These fields must be derived from the persisted publish transaction, not trusted from client input. The publish flow records the backend draft revision that storage actually committed for the transaction, such as `serverAssigned.canonicalRevision`, rather than mirroring a frontend-local counter. The client may provide authored draft content and a publish request, but it must not be treated as the authoritative source of `snapshotId`, `snapshotVersion`, `publishedAt`, `publishedByUserId`, `sourceDraftRevision`, or equivalent publish metadata.

#### Snapshot immutability after publish

Published snapshot content is immutable after publish. If authored content changes later, the system must create a new snapshot rather than editing the old one in place. Historical snapshots remain readable for auditability, replay, attempt attribution, and deterministic learner review.

#### Version numbers and revision identifiers

- `clientRevision` is a draft-local, frontend-managed counter used only for authoring workflows and optimistic coordination within the active UI; it is not authoritative publish provenance.
- persisted draft revision / canonical server draft revision is the authoritative backend revision metadata for the saved draft state, such as `serverAssigned.canonicalRevision`. This is the revision the backend actually publishes from.
- `sourceDraftRevision` records that persisted backend draft revision on the immutable published snapshot; in relational storage it should live on a dedicated field such as `worksheet_versions.source_draft_revision`, not be inferred from frontend-local state.
- `snapshotVersion` is the backend-assigned monotonic version number within a single `worksheetId` lineage.
- `snapshotId` is the opaque durable identifier for a specific immutable published snapshot.
- Multi-tab / multi-device rationale:
  - separate browser tabs or devices can each advance their own local `clientRevision` counters without representing the durable saved draft seen by the backend
  - the publish transaction must therefore record backend persistence metadata, not whichever frontend-local counter happened to be visible when the user clicked publish
- Comparison rules:
  - compare draft freshness in the UI using `clientRevision` for local coordination and persisted backend draft revision metadata for server truth, never `snapshotVersion`
  - compare published worksheet history using `snapshotVersion` within the same `worksheetId`
  - use `snapshotId` for exact identity equality, not ordering

Publish provenance must come from the persisted backend draft revision used by the publish transaction, never from a frontend-local counter.

#### Attempt references

Attempts should reference both `worksheetId` and `snapshotId`, and may also store `snapshotVersion` for easier reporting/debugging. The binding rules are:

- `worksheetId` identifies the logical worksheet lineage and should be a public durable identifier rather than an internal join key
- `snapshotId` identifies the exact published artifact the learner saw and should be a public durable identifier rather than an internal join key
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
  "answers": {
    "blk_q_001": {
      "value": {
        "text": "A stronger claim uses evidence from the passage to support the argument."
      },
      "answeredAt": "2026-03-22T12:14:30Z"
    }
  }
}
```

### Attempt payload rules

- `answers` is canonically an object map keyed by question `blockId` values from the published snapshot.
- Non-question blocks must not appear in `answers`.
- Viewer render order comes from the snapshot `blocks` array and each block's `position`, not from object key order inside `answers`.
- `answers[*].value` is the canonical learner answer value.
- `answeredAt` is optional persisted per-answer metadata when the product needs it; omit it rather than storing client-only UI state.
- Attempt records must never redefine worksheet prompts or content blocks; they only reference the published worksheet snapshot identified by `worksheetId` + `snapshotId` and carry learner responses.

---

## Field ownership

| Field or group | Ownership label | Notes |
| --- | --- | --- |
| `draftWorksheetId` | frontend-owned | Client-generated stable draft identifier for local/editor workflows. |
| `serverWorksheetId`, `worksheetId` | backend-owned | Canonical durable worksheet identifier assigned by the server; in relational storage this should map to a public identifier such as `worksheets.public_id`. |
| `snapshotId` | backend-owned | Assigned when a draft is published; in relational storage this should map to a public immutable identifier such as `worksheet_versions.public_id`. |
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
| `answers.{blockId}.value` | frontend-owned | Learner-authored response value, stored canonically in the attempt record under the question block's `blockId`. |
| `answers.{blockId}.answeredAt`, `startedAt`, `lastSavedAt`, `submittedAt` | backend-owned | Server-recorded timestamps preferred for consistency and auditability. |
| snapshot record as a whole | immutable-after-publish | Snapshot is frozen once published and serves as the durable learner-facing definition. |

## Compatibility guardrails checklist

Use this checklist during review for Phase 1 scaffolding and any later-phase editor/viewer implementation work:

- [ ] `docs/message-contract.md` remains the source of truth for the current popup launcher contract.
- [ ] Later-phase editor/viewer implementation does **not** change popup query params or the popup `postMessage` schema defined in `docs/message-contract.md` unless the popup compatibility contract is explicitly versioned.
- [ ] Any future popup-contract change updates `docs/message-contract.md` in the same change.
- [ ] Parent-side validation continues to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window` in the existing launcher flow implemented across `parent_prototype/sdk/parent-launcher.js`, `server/worksheet_launcher/render.js`, and `server/worksheet_launcher/render.html`.
- [ ] `server/worksheet_launcher/widgets/rewrite-widget.js` remains unchanged for prototype-specific behavior; use versioned files loaded from `server/worksheet_launcher/render.html` when needed.

## Relationship to the current popup launcher contract

`docs/message-contract.md` remains the source of truth for the current popup launcher contract used by the parent launcher and popup renderer. This ADR does **not** replace that contract. Instead, it describes broader worksheet data-model separation that later-phase editor/viewer implementation should use behind or alongside the existing launcher contract.

Implementers should keep publish semantics separate from popup launch transport semantics. Do not merge snapshot publication/versioning rules into the popup query payload or popup `postMessage` schema; continue to treat `docs/message-contract.md` as the legacy/current integration contract for that boundary.
