CREATE TABLE IF NOT EXISTS roleplayscene_uploaded_drafts (
  roleplayscene_uploaded_draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  owner_email TEXT,
  owner_name TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  package_version INTEGER NOT NULL CHECK (package_version > 0),
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes BIGINT NOT NULL CHECK (artifact_size_bytes > 0),
  scene_count INTEGER NOT NULL CHECK (scene_count > 0),
  media_count INTEGER NOT NULL DEFAULT 0 CHECK (media_count >= 0),
  missing_media_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_media_count >= 0),
  validation_warning_count INTEGER NOT NULL DEFAULT 0 CHECK (validation_warning_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roleplayscene_uploaded_drafts_owner_created
  ON roleplayscene_uploaded_drafts (owner_sub, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_roleplayscene_uploaded_drafts_owner_title
  ON roleplayscene_uploaded_drafts (
    owner_sub,
    lower(regexp_replace(btrim(coalesce(title, '')), '\s+', ' ', 'g'))
  );
