# Worksheet Launcher Database Schema Specification

## Purpose

This document defines the recommended PostgreSQL schema for the `web-worksheet-launcher` project.

It is written for AI coding agents and developers so they can:
- understand the purpose of each table
- understand the expected column types and values
- implement backend CRUD functions correctly
- keep future development aligned with the agreed architecture

This schema is designed for:
- editor mode
- viewer mode
- draft save
- publish snapshot
- autosave attempt
- resume later
- final submit

It is intentionally minimal for v1.

---

## Design Principles

1. **Draft and published content must be separated**
   - The editable draft lives in `worksheets`
   - Published snapshots live in `worksheet_versions`

2. **Viewer attempts must point to a published version, not the live draft**
   - This prevents later edits from breaking old attempts

3. **JSONB is used for content and answers**
   - Worksheet structure can evolve without frequent schema changes
   - Block/answer payloads remain flexible

4. **OIDC identity is stored as stable subject strings**
   - Use OIDC `sub` claim values for ownership and authenticated attempts
   - Do not use display names as identity keys

5. **Support both authenticated and guest attempts**
   - Authenticated users use `user_oidc_sub`
   - Guest users use `anonymous_token`

---

## Identifier Mapping

Implementers should keep internal relational keys distinct from public contract identifiers.

- `worksheets.id` is the internal relational key only. Use it for joins, foreign keys, and internal backend logic; do not expose it as the canonical `worksheetId` in frontend or API contracts.
- `worksheets.public_id` is the recommended public, durable worksheet identifier. If the product contract uses `worksheetId`, it should map to `worksheets.public_id`.
- `worksheet_versions.id` is the internal relational key for joins from `worksheets.current_version_id` and `worksheet_attempts.worksheet_version_id`.
- If `snapshotId` is intended to be public and durable, `worksheet_versions` should carry its own dedicated public identifier column such as `public_id UUID NOT NULL DEFAULT gen_random_uuid()`. Do not overload the internal numeric `worksheet_versions.id` as the public `snapshotId`.
- `worksheet_attempts.id` is the internal relational key only.
- `worksheet_attempts.public_id` is the recommended public attempt identifier for resume links, API payloads, analytics exports, or any contract that needs a durable attempt reference.

This document assumes the public-contract mapping `worksheetId -> worksheets.public_id`, `snapshotId -> worksheet_versions.public_id`, and `attemptId -> worksheet_attempts.public_id` unless a later ADR explicitly changes that mapping.

### Local/cloud identity alignment

The browser runtime keeps separate local identifiers that are **not** stored as authoritative relational IDs in PostgreSQL:
- local worksheet drafts should use a client-generated identifier such as `localDraftId = ld_<ulid>` before backend persistence
- local attempts should use a client-generated identifier such as `localAttemptId = la_<ulid>` before backend persistence
- server-backed worksheet identifiers should map to `worksheets.public_id` and use the backend-issued public UUID format
- server-backed attempt identifiers should map to `worksheet_attempts.public_id` and use the backend-issued public UUID format

A synced local worksheet keeps both identifiers in the client state layer: the local `localDraftId` remains the browser-stable key, while the linked server `worksheetId` / `worksheets.public_id` becomes the authoritative backend reference. A synced local attempt follows the same rule for `localAttemptId` plus server `attemptId` / `worksheet_attempts.public_id`.

The relational schema does not need to persist browser-local IDs as primary business keys. If the backend wants to correlate uploads with a client record for debugging or idempotency, it may accept a client-local identifier in request metadata, but the authoritative persisted identity remains the server public ID columns described above.

### Sync and conflict rules

- Importing a file that already came from a synced worksheet should not overwrite an existing worksheet row automatically. The imported file may reference an existing `worksheets.public_id`, but the backend should treat any resulting save/publish as an explicit user-directed action rather than assuming the import is authoritative.
- Syncing a local draft after both local and server edits requires backend conflict detection using the authoritative persisted draft revision and/or `worksheets.updated_at`. The backend must reject silent last-writer-wins behavior unless the product explicitly chooses an overwrite path.
- Promoting a local attempt into a server-backed attempt after login should create a new `worksheet_attempts` row only when there is no linked server `attemptId`. If the backend resumes an existing attempt, the client must link the local record to that existing `worksheet_attempts.public_id` instead of creating a duplicate.

---

## Required Extension

The schema uses `gen_random_uuid()`.

Enable:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

---

## Table 1: `worksheets`

## Purpose

Stores the main editable worksheet record.

This is the teacher/author working copy.

It contains:
- worksheet ownership
- title and description
- draft JSON content
- publication status
- pointer to the current published version

## SQL

```sql
CREATE TABLE worksheets (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_oidc_sub TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    draft_content JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_version_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT worksheets_status_check
        CHECK (status IN ('draft', 'published', 'archived'))
);
```

## Column Details

### `id`
- Type: `BIGSERIAL`
- Internal primary key
- Used for joins and backend logic
- Not intended for public URLs

### `public_id`
- Type: `UUID`
- Public-facing stable identifier
- Safe for URLs and frontend references
- Example: `1f1f3f7e-8e7e-4f5a-a4d1-2d4a4ff0f3de`

### `owner_oidc_sub`
- Type: `TEXT`
- Stable OIDC subject identifier of the worksheet owner
- Example: `auth0|abc123xyz`
- Must come from trusted server-side auth context

### `title`
- Type: `TEXT`
- Worksheet title shown in UI
- Example: `Fractions Practice`

### `description`
- Type: `TEXT`
- Optional worksheet description or notes
- Can be `NULL`

### `status`
- Type: `TEXT`
- Allowed values:
  - `draft`
  - `published`
  - `archived`

Meaning:
- `draft`: not yet published or currently under editing
- `published`: at least one version exists and current version is available
- `archived`: no longer active for normal use; historical published snapshots may remain stored, but new viewer access or republish behavior must be explicitly allowed by product policy rather than assumed

### `draft_content`
- Type: `JSONB`
- Main editable worksheet JSON payload
- Always contains the latest draft structure
- Default is empty object

Expected structure example:

```json
{
  "title": "Fractions Practice",
  "blocks": [
    {
      "blockId": "blk_q1",
      "kind": "question",
      "prompt": "What is 1/2 + 1/4?",
      "responseConfig": {
        "inputType": "short_text"
      }
    },
    {
      "blockId": "blk_q2",
      "kind": "question",
      "prompt": "Which is equivalent to 3/4?",
      "responseConfig": {
        "inputType": "multiple_choice",
        "options": ["6/8", "2/8", "1/2"]
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

### `current_version_id`
- Type: `BIGINT`
- Part of a composite foreign key from `(worksheets.id, worksheets.current_version_id)`
  to `(worksheet_versions.worksheet_id, worksheet_versions.id)`
- Must reference the latest published version for the same worksheet row
- Can be `NULL` before first publish

### `created_at`
- Type: `TIMESTAMPTZ`
- Record creation time

### `updated_at`
- Type: `TIMESTAMPTZ`
- Last draft update time
- Should be updated whenever draft metadata or content changes

---

## Table 2: `worksheet_versions`

## Purpose

Stores immutable published snapshots of worksheet content.

Each publish action creates a new version row.

Viewer mode and student attempts must always use this table instead of the live draft.

## SQL

```sql
CREATE TABLE worksheet_versions (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    worksheet_id BIGINT NOT NULL REFERENCES worksheets(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    content JSONB NOT NULL,
    source_draft_revision TEXT NOT NULL,
    published_by_oidc_sub TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT worksheet_versions_unique_version
        UNIQUE (worksheet_id, version_no),

    CONSTRAINT worksheet_versions_unique_worksheet_id_id
        UNIQUE (worksheet_id, id)
);
```

## Column Details

### `id`
- Type: `BIGSERIAL`
- Internal primary key
- Internal-only relational key; do not expose as `snapshotId`

### `public_id`
- Type: `UUID`
- Recommended public-facing immutable snapshot identifier
- Safe to expose as the contract-level `snapshotId`
- Example: `7c6d6c9f-5a2c-4dd3-90ce-7e99af0dba72`

### `worksheet_id`
- Type: `BIGINT`
- Foreign key to `worksheets.id`
- Indicates which worksheet this version belongs to
- Together with `id`, forms a composite unique pair that can be referenced safely
  by `(worksheets.id, worksheets.current_version_id)`

### `version_no`
- Type: `INTEGER`
- Sequential publish number per worksheet
- Example values:
  - `1`
  - `2`
  - `3`

### `content`
- Type: `JSONB`
- Immutable published worksheet snapshot
- Copied by the backend from the validated saved worksheet draft at publish time

### `source_draft_revision`
- Type: `TEXT`
- Canonical publish provenance for this snapshot row
- Stores the persisted backend draft revision used by the publish transaction
- Must come from authoritative backend draft storage metadata, not from frontend-local counters
- Example: `canonicalRevision:42`

### `published_by_oidc_sub`
- Type: `TEXT`
- OIDC subject of the user who performed the publish action

### `published_at`
- Type: `TIMESTAMPTZ`
- Publication timestamp

## Revision and publish provenance terms

These terms are related but non-interchangeable:

- `clientRevision`: frontend-local authoring counter used only for optimistic UI coordination during an active editing session. It is not durable publish provenance.
- persisted draft revision / canonical server draft revision: the authoritative backend revision metadata for the saved draft state, such as `serverAssigned.canonicalRevision`. This is what the backend compares when deciding which saved draft was actually published.
- `snapshotVersion`: backend-assigned monotonic publish number within a worksheet lineage. It orders immutable snapshots, not draft saves.
- `sourceDraftRevision`: the exact persisted backend draft revision captured on the `worksheet_versions.source_draft_revision` column for the publish transaction that created the snapshot.

Publish provenance must come from the persisted backend draft revision used by the publish transaction, never from a frontend-local counter such as `clientRevision`.

---

## Foreign Key from `worksheets.current_version_id`

Add after `worksheet_versions` exists:

```sql
ALTER TABLE worksheets
ADD CONSTRAINT worksheets_current_version_fk
FOREIGN KEY (id, current_version_id)
REFERENCES worksheet_versions(worksheet_id, id)
ON DELETE SET NULL (current_version_id);
```

Meaning:
- `current_version_id` can only point to a version row whose `worksheet_id` matches the same `worksheets.id`
- if the referenced version is removed, only `current_version_id` becomes `NULL`; `worksheets.id` remains unchanged
- on PostgreSQL, the column list in `SET NULL (current_version_id)` is required for this composite foreign key so a version delete does not try to null the worksheet primary key

---

## Table 3: `worksheet_attempts`

## Purpose

Stores viewer progress, autosave state, resume data, and final submission data.

Each attempt belongs to one published worksheet version.

## SQL

```sql
CREATE TABLE worksheet_attempts (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    worksheet_version_id BIGINT NOT NULL REFERENCES worksheet_versions(id) ON DELETE RESTRICT,

    user_oidc_sub TEXT,
    anonymous_token TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'in_progress',
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT worksheet_attempts_status_check
        CHECK (status IN ('in_progress', 'submitted', 'abandoned')),

    CONSTRAINT worksheet_attempt_identity_check
        CHECK (
            user_oidc_sub IS NOT NULL OR anonymous_token IS NOT NULL
        )
);
```

## Column Details

### `id`
- Type: `BIGSERIAL`
- Internal primary key

### `public_id`
- Type: `UUID`
- Recommended public-facing durable identifier for attempt references
- Safe to expose as the contract-level `attemptId`

### `worksheet_version_id`
- Type: `BIGINT`
- Foreign key to `worksheet_versions.id`
- Attempts must always target a published version

### `user_oidc_sub`
- Type: `TEXT`
- Present when viewer is authenticated
- Stores stable OIDC subject

### `anonymous_token`
- Type: `TEXT`
- Present when viewer is not signed in
- Used for guest resume-later flows when the viewer mode explicitly permits guest access
- Should be issued by the backend as the authoritative token for resume and attempt correlation
- Frontend may temporarily hold or echo the token for resume, but it should not mint its own durable `anonymous_token` values for persisted attempts

### `started_at`
- Type: `TIMESTAMPTZ`
- Time the attempt began

### `last_saved_at`
- Type: `TIMESTAMPTZ`
- Time of last autosave or update

### `submitted_at`
- Type: `TIMESTAMPTZ`
- Set only when final submission occurs
- Can be `NULL`

### `status`
- Type: `TEXT`
- Allowed values:
  - `in_progress`
  - `submitted`
  - `abandoned`

Meaning:
- `in_progress`: still editable
- `submitted`: final response submitted
- `abandoned`: optional terminal state for expired/cancelled attempts

### `answers`
- Type: `JSONB`
- Stores current answer payload for the attempt
- Canonical persisted shape is an object keyed by question-block `blockId`
- Array-shaped answers are non-canonical and should be normalized into the `blockId`-keyed object form before persistence

Expected example:

```json
{
  "blk_q1": {
    "value": {
      "text": "3/4"
    },
    "answeredAt": "2026-03-22T12:14:30Z"
  },
  "blk_q2": {
    "value": {
      "selected": ["6/8"]
    }
  },
  "blk_q3": {
    "value": {
      "selected": ["a", "c"]
    },
    "answeredAt": "2026-03-22T12:15:10Z"
  }
}
```

In this envelope, each top-level key must match a `blockId` for a `kind: "question"` block from the published worksheet snapshot; non-question blocks must not appear in `answers`.

---

## Recommended Indexes

```sql
CREATE UNIQUE INDEX idx_worksheets_public_id
    ON worksheets(public_id);

CREATE UNIQUE INDEX idx_versions_public_id
    ON worksheet_versions(public_id);

CREATE UNIQUE INDEX idx_attempts_public_id
    ON worksheet_attempts(public_id);

CREATE INDEX idx_worksheets_owner_oidc_sub
    ON worksheets(owner_oidc_sub);

CREATE INDEX idx_versions_worksheet_id
    ON worksheet_versions(worksheet_id);

CREATE INDEX idx_attempts_version_id
    ON worksheet_attempts(worksheet_version_id);

CREATE INDEX idx_attempts_user_oidc_sub
    ON worksheet_attempts(user_oidc_sub);

CREATE INDEX idx_attempts_anonymous_token
    ON worksheet_attempts(anonymous_token);
```

---

## Backend Behavior Expectations

## State-transition and access rules
- A worksheet becomes publishable only when backend validation passes for required metadata, block structure, question configuration, and the presence of a persisted canonical draft revision to record as publish provenance.
- Viewer load must always resolve through an immutable row in `worksheet_versions`; it must never fall back to `worksheets.draft_content` for online viewing.
- If `worksheets.current_version_id` is `NULL` and no explicit `worksheet_versions.public_id` is requested, viewer load should return a not-published/not-found result rather than exposing draft content.
- Archived worksheets should not accept new learner attempts by default. Any exception for historical review or resume must be an explicit product-mode decision that still targets an immutable published snapshot.
- Attempts that were already in progress before archival may continue only if the selected viewer mode allows archived-snapshot access; otherwise resume should be blocked with an archived/unavailable outcome.
- Guest attempts are allowed only for viewer modes that explicitly opt into guest access. Authenticated-only viewer modes must reject guest attempt creation even when a worksheet is published.

## Draft Save
- Update `worksheets.title`, `worksheets.description`, `worksheets.draft_content`, and `worksheets.updated_at`
- No row should be created in `worksheet_versions` during normal draft saves

## Publish
- Require authenticated backend publish authority
- Allow publish only when the worksheet already has a saved backend draft record, the saved draft passes backend validation, and a persisted canonical draft revision is available for provenance
- Treat the client request as publish intent only; do not trust the client to authoritatively submit canonical publish metadata
- Copy the validated saved `worksheets.draft_content` into `worksheet_versions.content`
- Create a new immutable `worksheet_versions` row for the publish transaction
- Assign a new `worksheet_versions.public_id` for the immutable public `snapshotId`
- Persist the canonical backend draft revision used by the publish transaction into `worksheet_versions.source_draft_revision`
- Increment `version_no` per worksheet
- Assign `published_at` and `published_by_oidc_sub` on the backend as authoritative provenance fields
- Update `worksheets.current_version_id`
- Ensure `current_version_id` belongs to the same `worksheets.id` row via the composite foreign key
- Set `worksheets.status = 'published'`
- Update `worksheets.updated_at`
- Treat republish from `archived` state as disallowed by default unless a later product rule explicitly permits unarchive-and-publish or equivalent admin behavior

## Viewer Load
- Load the worksheet lineage by `worksheets.public_id` when resolving a contract-level `worksheetId`
- Resolve `current_version_id` or a specific `worksheet_versions.public_id` when resolving a contract-level `snapshotId`
- Treat `current_version_id` as valid only when it belongs to the same `worksheets.id` row
- If no current published version exists and no explicit snapshot is requested, return a not-published/not-found result
- Render data from `worksheet_versions.content` only after published-snapshot resolution succeeds
- For archived worksheets, block new public viewing by default unless the chosen product mode explicitly allows archived-snapshot review

## Start Attempt
- Create row in `worksheet_attempts` only after published-snapshot viewer resolution succeeds
- Use authenticated `user_oidc_sub` if signed in
- Otherwise create and store a backend-issued `anonymous_token` when guest attempts are allowed for that viewer mode
- Reject guest attempt creation when the viewer mode or worksheet access policy requires authentication
- Reject new attempt creation for archived worksheets unless archived-snapshot access is explicitly allowed by product policy

## Autosave
- Update `answers`
- Update `last_saved_at`
- Keep `status = 'in_progress'`

## Submit
- Update `answers`
- Set `status = 'submitted'`
- Set `submitted_at`
- Update `last_saved_at`

---

## What Is Intentionally Not In Scope for v1

The following are intentionally excluded from the schema for simplicity:

- users table
- classes/groups
- permissions table
- grading tables
- media attachment tables
- analytics tables
- collaboration
- audit log/history table
- per-question answer rows
- cloud file storage metadata

These can be added later if needed.

---

## Full Initialization SQL

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE worksheets (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_oidc_sub TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    draft_content JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_version_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT worksheets_status_check
        CHECK (status IN ('draft', 'published', 'archived'))
);

CREATE TABLE worksheet_versions (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    worksheet_id BIGINT NOT NULL REFERENCES worksheets(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    content JSONB NOT NULL,
    source_draft_revision TEXT NOT NULL,
    published_by_oidc_sub TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT worksheet_versions_unique_version
        UNIQUE (worksheet_id, version_no),

    CONSTRAINT worksheet_versions_unique_worksheet_id_id
        UNIQUE (worksheet_id, id)
);

ALTER TABLE worksheets
ADD CONSTRAINT worksheets_current_version_fk
FOREIGN KEY (id, current_version_id)
REFERENCES worksheet_versions(worksheet_id, id)
ON DELETE SET NULL (current_version_id);

CREATE TABLE worksheet_attempts (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid(),
    worksheet_version_id BIGINT NOT NULL REFERENCES worksheet_versions(id) ON DELETE RESTRICT,

    user_oidc_sub TEXT,
    anonymous_token TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'in_progress',
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT worksheet_attempts_status_check
        CHECK (status IN ('in_progress', 'submitted', 'abandoned')),

    CONSTRAINT worksheet_attempt_identity_check
        CHECK (
            user_oidc_sub IS NOT NULL OR anonymous_token IS NOT NULL
        )
);

CREATE UNIQUE INDEX idx_worksheets_public_id
    ON worksheets(public_id);

CREATE UNIQUE INDEX idx_versions_public_id
    ON worksheet_versions(public_id);

CREATE UNIQUE INDEX idx_attempts_public_id
    ON worksheet_attempts(public_id);

CREATE INDEX idx_worksheets_owner_oidc_sub
    ON worksheets(owner_oidc_sub);

CREATE INDEX idx_versions_worksheet_id
    ON worksheet_versions(worksheet_id);

CREATE INDEX idx_attempts_version_id
    ON worksheet_attempts(worksheet_version_id);

CREATE INDEX idx_attempts_user_oidc_sub
    ON worksheet_attempts(user_oidc_sub);

CREATE INDEX idx_attempts_anonymous_token
    ON worksheet_attempts(anonymous_token);
```
