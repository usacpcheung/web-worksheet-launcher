ALTER TABLE uploaded_drafts
  ADD COLUMN IF NOT EXISTS last_published_artifact_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS last_published_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_published_packages_source_uploaded_draft_unique;
