# Worksheet Launcher Database Schema Specification (Package-First/Hybrid)

> **Related docs**
> - Phase 1 blueprint index: `docs/phase1-blueprint-index.md`
> - Viewer launch/message contract: `docs/message-contract.md`
> - Redesign plan: `docs/worksheet-architecture-redesign-plan.md`
>
> **Scope note:** This document is now the recommended backend schema direction for the architecture redesign. It explicitly separates **target schema** from **legacy/transitional mapping**.

## 1) Purpose and status

This document defines the recommended PostgreSQL schema direction for backend implementation under the package-first/hybrid model.

### Status labels used in this doc

- **Target (recommended):** preferred long-term implementation direction.
- **Transitional:** compatibility mapping for older `worksheet/snapshot` terms.
- **Legacy:** prior schema shape kept only for migration reference.

## 2) Canonical architecture commitments (target)

1. **Drafts are the only editable objects.**
2. **Published packages are immutable.**
3. **Attempts bind to exact source identity + version/hash.**
4. **Viewer opens mainly by reference (`publishedPackageId`).**
5. **Ownership keys are OIDC `sub` values (never email).**
6. **Import/export direction is package-first, with media support.**

## 3) Identity and terminology mapping

### Canonical public identifiers (target)

- `uploadedDraftId` → server copy of a user draft upload
- `publishedPackageId` → immutable published package identity (**canonical published viewer identity**)
- `attemptId` → attempt identity

### Transitional terminology mapping

Older docs/use-sites may still use snapshot wording:

- `snapshotId` (transitional) maps conceptually to `publishedPackageId`
- `worksheet_versions.public_id` (legacy/transitional) maps to `published_packages.published_package_id`

If both terms appear in APIs during migration, responses should include canonical field names and treat snapshot fields as compatibility aliases only.

## 4) Recommended target schema

Enable extension:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### 4.1 `uploaded_drafts` (target)

Server-side uploaded draft state for later edit/restore. This is **not** collaborative realtime sync.

```sql
CREATE TABLE uploaded_drafts (
    id BIGSERIAL PRIMARY KEY,
    uploaded_draft_id UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_oidc_sub TEXT NOT NULL,

    local_draft_id TEXT,
    title TEXT NOT NULL,
    draft_content JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    revision TEXT NOT NULL,
    upload_state TEXT NOT NULL DEFAULT 'uploaded',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uploaded_drafts_upload_state_check
      CHECK (upload_state IN ('uploaded', 'restored', 'superseded')),
    CONSTRAINT uploaded_drafts_unique_uploaded_draft_id
      UNIQUE (uploaded_draft_id)
);
```

Notes:
- Ownership is `owner_oidc_sub`.
- `local_draft_id` is optional client linkage metadata only.
- `revision` is authoritative backend draft revision metadata.

### 4.2 `published_packages` (target)

Immutable published artifacts. Every publish creates a new row and new `publishedPackageId`.

```sql
CREATE TABLE published_packages (
    id BIGSERIAL PRIMARY KEY,
    published_package_id UUID NOT NULL DEFAULT gen_random_uuid(),

    owner_oidc_sub TEXT NOT NULL,
    published_by_oidc_sub TEXT NOT NULL,

    package_family_id UUID,
    derived_from_published_package_id UUID,
    derived_from_uploaded_draft_id UUID,

    schema_version INTEGER NOT NULL,
    package_version INTEGER NOT NULL DEFAULT 1,

    manifest JSONB NOT NULL,
    content JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    content_hash TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT published_packages_unique_published_package_id
      UNIQUE (published_package_id)
);
```

Notes:
- `content_hash` is used for integrity/binding checks.
- `package_family_id` supports lineage grouping (optional MVP use).
- Published rows are immutable after insert.

### 4.3 `publication_index` (target)

Search/filter metadata for published packages.

```sql
CREATE TABLE publication_index (
    id BIGSERIAL PRIMARY KEY,
    published_package_id UUID NOT NULL REFERENCES published_packages(published_package_id) ON DELETE CASCADE,

    owner_oidc_sub TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    subject TEXT,
    grade_band TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',

    published_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT publication_index_visibility_check
      CHECK (visibility IN ('public', 'unlisted', 'restricted')),
    CONSTRAINT publication_index_unique_package
      UNIQUE (published_package_id)
);
```

### 4.4 `attempts` (target)

Attempt records must bind to exact immutable source.

```sql
CREATE TABLE attempts (
    id BIGSERIAL PRIMARY KEY,
    attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),

    user_oidc_sub TEXT,
    anonymous_token TEXT,

    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    source_version INTEGER,
    source_hash TEXT NOT NULL,

    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'in_progress',

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,

    CONSTRAINT attempts_status_check
      CHECK (status IN ('in_progress', 'submitted', 'abandoned')),
    CONSTRAINT attempts_identity_check
      CHECK (user_oidc_sub IS NOT NULL OR anonymous_token IS NOT NULL),
    CONSTRAINT attempts_source_type_check
      CHECK (source_type IN ('published_package', 'imported_package', 'draft_preview')),
    CONSTRAINT attempts_unique_attempt_id
      UNIQUE (attempt_id)
);
```

Binding rules:
- `published_package` attempts should use `source_id = publishedPackageId`.
- On resume/update, server must verify source binding invariants (`source_type`, `source_id`, `source_hash`).
- Attempts must not silently migrate to newer published package content.

### 4.5 `package_media` (target, future-ready)

```sql
CREATE TABLE package_media (
    id BIGSERIAL PRIMARY KEY,
    media_id UUID NOT NULL DEFAULT gen_random_uuid(),
    published_package_id UUID NOT NULL REFERENCES published_packages(published_package_id) ON DELETE CASCADE,

    media_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    checksum TEXT NOT NULL,
    bytes BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT package_media_kind_check
      CHECK (kind IN ('image', 'audio', 'other')),
    CONSTRAINT package_media_unique_key_per_package
      UNIQUE (published_package_id, media_key)
);
```

### 4.6 `lineage_events` (target, optional but recommended)

```sql
CREATE TABLE lineage_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL DEFAULT gen_random_uuid(),
    actor_oidc_sub TEXT,

    event_type TEXT NOT NULL,
    from_entity_type TEXT,
    from_entity_id TEXT,
    to_entity_type TEXT,
    to_entity_id TEXT,

    event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT lineage_events_type_check
      CHECK (event_type IN ('imported', 'uploaded', 'published', 'forked', 'restored')),
    CONSTRAINT lineage_events_unique_event_id
      UNIQUE (event_id)
);
```

## 5) Recommended indexes (target)

```sql
CREATE INDEX idx_uploaded_drafts_owner_oidc_sub
  ON uploaded_drafts(owner_oidc_sub);

CREATE INDEX idx_published_packages_owner_oidc_sub
  ON published_packages(owner_oidc_sub);

CREATE INDEX idx_published_packages_published_at
  ON published_packages(published_at DESC);

CREATE INDEX idx_publication_index_title
  ON publication_index(normalized_title);

CREATE INDEX idx_attempts_user_oidc_sub
  ON attempts(user_oidc_sub);

CREATE INDEX idx_attempts_source
  ON attempts(source_type, source_id);

CREATE INDEX idx_package_media_package
  ON package_media(published_package_id);
```

## 6) Backend behavior expectations (target)

### Upload draft for later edit
- Upsert into `uploaded_drafts` for authenticated `owner_oidc_sub`.
- Preserve local-first semantics; upload augments local drafts, does not replace local identity.

### Publish package
- Requires authenticated publisher (`published_by_oidc_sub`).
- Publish from validated uploaded/local draft state.
- Insert immutable row in `published_packages` with new `published_package_id` and `content_hash`.
- Insert/update `publication_index` row.

### Viewer load
- Preferred path: `publishedPackageId` lookup against `published_packages`.
- If explicit source is invalid, return typed error; do not fall back to unrelated content.
- No-parameter open behavior (start screen + resume option) is defined in `docs/message-contract.md`.

### Attempts
- Create attempts with exact source binding at creation time.
- Reject resume/update when source binding check fails.
- Keep guest mode behind explicit policy; authenticated ownership always keyed by OIDC `sub`.

## 7) Transitional/legacy mapping guidance

The old relational model (`worksheets`, `worksheet_versions`, `worksheet_attempts`) is now **transitional**.

- It may remain temporarily for migration or compatibility.
- It should not be treated as the final recommended architecture.
- New backend work should target the schema in Section 4.

If a transitional adapter is required:

- `worksheet_versions.public_id` ↔ compatibility alias for `publishedPackageId`
- `worksheet_attempts` ↔ compatibility adapter for `attempts`
- `worksheets` draft row ↔ compatibility adapter for uploaded draft semantics

## 8) What remains intentionally open (MVP-safe)

1. Whether `publication_index` is a separate table or computed/indexed columns on `published_packages`.
2. Whether `package_family_id` is required at MVP or deferred.
3. Hash strategy details (`sha256` only vs hash + ETag metadata).
4. Exact media binary storage backend (DB pointer only in this spec).

## 10) Phase D implemented baseline (2026-04-05)

The initial implementation in `server/api/db/migrations/001_phase_d_server_foundation.sql` intentionally ships a smaller subset:

- Implemented now:
  - `uploaded_drafts`
  - `published_packages`
  - `schema_migrations`
- Deferred for later phases:
  - `attempts`
  - richer publication index table (Phase D uses simple title/subject indexes directly on `published_packages`)
  - media/lineage event tables

Phase D storage model details:

- Database stores metadata + ownership + hash/size + filesystem path references.
- Canonical worksheet bytes are ZIP artifacts on filesystem (not DB blobs).
- Ownership key remains `owner_sub` (OIDC `sub`).
