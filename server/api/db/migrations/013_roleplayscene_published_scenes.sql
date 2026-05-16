CREATE TABLE IF NOT EXISTS roleplayscene_published_scenes (
  roleplayscene_published_scene_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  owner_email TEXT,
  owner_name TEXT,
  source_roleplayscene_uploaded_draft_id UUID REFERENCES roleplayscene_uploaded_drafts(roleplayscene_uploaded_draft_id) ON DELETE SET NULL,
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
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roleplayscene_published_scenes_published_at
  ON roleplayscene_published_scenes (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_roleplayscene_published_scenes_source_draft
  ON roleplayscene_published_scenes (
    source_roleplayscene_uploaded_draft_id,
    published_at DESC,
    created_at DESC,
    roleplayscene_published_scene_id DESC
  )
  WHERE source_roleplayscene_uploaded_draft_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_roleplayscene_published_scenes_owner_title
  ON roleplayscene_published_scenes (
    owner_sub,
    lower(regexp_replace(btrim(coalesce(title, '')), '\s+', ' ', 'g'))
  );
