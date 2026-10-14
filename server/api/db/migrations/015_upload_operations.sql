-- Successful upload receipts commit atomically with the resource mutation.
-- Keep receipts after resource deletion: replay must never recreate deleted data.
CREATE TABLE upload_operations (
  owner_sub TEXT NOT NULL,
  operation_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('worksheet-draft', 'worksheet-attempt', 'roleplayscene-draft')),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response JSONB NOT NULL CHECK (response @> '{"ok":true}'::jsonb),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, operation_id)
);
