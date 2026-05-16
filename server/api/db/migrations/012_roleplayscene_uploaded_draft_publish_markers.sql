ALTER TABLE roleplayscene_uploaded_drafts
  ADD COLUMN IF NOT EXISTS last_published_artifact_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS last_published_at TIMESTAMPTZ;
