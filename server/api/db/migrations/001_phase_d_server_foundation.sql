CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uploaded_drafts (
  uploaded_draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  owner_email TEXT,
  owner_name TEXT,
  title TEXT NOT NULL,
  subject TEXT,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes BIGINT NOT NULL CHECK (artifact_size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_drafts_owner_created ON uploaded_drafts (owner_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS published_packages (
  published_package_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  owner_email TEXT,
  owner_name TEXT,
  source_uploaded_draft_id UUID REFERENCES uploaded_drafts(uploaded_draft_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  subject TEXT,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes BIGINT NOT NULL CHECK (artifact_size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_published_packages_published_at ON published_packages (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_published_packages_title_lower ON published_packages ((lower(title)));
CREATE INDEX IF NOT EXISTS idx_published_packages_subject_lower ON published_packages ((lower(subject)));
