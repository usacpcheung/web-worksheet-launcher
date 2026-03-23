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
- `archived`: no longer active for normal use

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
- Usually copied from `worksheets.draft_content` at publish time

### `published_by_oidc_sub`
- Type: `TEXT`
- OIDC subject of the user who performed the publish action

### `published_at`
- Type: `TIMESTAMPTZ`
- Publication timestamp

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
- Used for guest resume-later flows
- Generated by backend or trusted frontend flow

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

## Draft Save
- Update `worksheets.title`, `worksheets.description`, `worksheets.draft_content`, and `worksheets.updated_at`
- No row should be created in `worksheet_versions` during normal draft saves

## Publish
- Copy current `worksheets.draft_content` into `worksheet_versions.content`
- Assign a new `worksheet_versions.public_id` for the immutable public `snapshotId`
- Increment `version_no` per worksheet
- Update `worksheets.current_version_id`
- Ensure `current_version_id` belongs to the same `worksheets.id` row via the composite foreign key
- Set `worksheets.status = 'published'`
- Update `worksheets.updated_at`

## Viewer Load
- Load the worksheet lineage by `worksheets.public_id` when resolving a contract-level `worksheetId`
- Resolve `current_version_id` or a specific `worksheet_versions.public_id` when resolving a contract-level `snapshotId`
- Treat `current_version_id` as valid only when it belongs to the same `worksheets.id` row
- Render data from `worksheet_versions.content`

## Start Attempt
- Create row in `worksheet_attempts`
- Use authenticated `user_oidc_sub` if signed in
- Otherwise create and store `anonymous_token`

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
