WITH latest_published_per_draft AS (
  SELECT
    p.source_uploaded_draft_id,
    p.owner_sub,
    p.artifact_sha256,
    p.published_at,
    ROW_NUMBER() OVER (
      PARTITION BY p.source_uploaded_draft_id
      ORDER BY p.published_at DESC, p.created_at DESC, p.published_package_id DESC
    ) AS rn
  FROM published_packages AS p
  WHERE p.source_uploaded_draft_id IS NOT NULL
), backfill AS (
  SELECT
    l.source_uploaded_draft_id AS uploaded_draft_id,
    l.owner_sub,
    l.artifact_sha256,
    l.published_at
  FROM latest_published_per_draft AS l
  WHERE l.rn = 1
)
UPDATE uploaded_drafts AS d
SET
  last_published_artifact_sha256 = b.artifact_sha256,
  last_published_at = b.published_at,
  updated_at = now()
FROM backfill AS b
WHERE d.uploaded_draft_id = b.uploaded_draft_id
  AND d.owner_sub = b.owner_sub
  AND d.last_published_artifact_sha256 IS NULL;