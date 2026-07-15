CREATE TABLE IF NOT EXISTS published_artifact_quarantine (
  quarantine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('worksheet', 'roleplayscene', 'orphan')),
  original_published_id UUID,
  original_artifact_path TEXT NOT NULL,
  quarantine_artifact_path TEXT NOT NULL,
  owner_sub TEXT,
  owner_email TEXT,
  owner_name TEXT,
  title TEXT,
  artifact_sha256 TEXT,
  artifact_size_bytes BIGINT CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes >= 0),
  publication_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_quarantine',
      'quarantined',
      'pending_restore',
      'restored',
      'pending_purge',
      'purged',
      'missing'
    )
  ),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  automated_confirmation BOOLEAN NOT NULL DEFAULT false,
  quarantined_at TIMESTAMPTZ,
  restore_requested_at TIMESTAMPTZ,
  restored_by TEXT,
  restored_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ NOT NULL,
  purged_by TEXT,
  purged_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (artifact_kind = 'orphan' AND original_published_id IS NULL)
    OR
    (artifact_kind IN ('worksheet', 'roleplayscene') AND original_published_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_published_artifact_quarantine_active_source
  ON published_artifact_quarantine (original_artifact_path)
  WHERE status NOT IN ('purged', 'restored');

CREATE INDEX IF NOT EXISTS idx_published_artifact_quarantine_status_purge
  ON published_artifact_quarantine (status, purge_after);

CREATE INDEX IF NOT EXISTS idx_published_artifact_quarantine_original_id
  ON published_artifact_quarantine (artifact_kind, original_published_id)
  WHERE original_published_id IS NOT NULL;
