CREATE TABLE uploaded_attempts (
  uploaded_attempt_id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NULL,
  checked_at TIMESTAMPTZ NULL,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_uploaded_attempts_owner_created_at
  ON uploaded_attempts(owner_sub, created_at DESC);

CREATE UNIQUE INDEX ux_uploaded_attempts_owner_title_subject
  ON uploaded_attempts (
    owner_sub,
    lower(regexp_replace(btrim(coalesce(title, '')), '\\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(subject, '')), '\\s+', ' ', 'g'))
  );
