CREATE INDEX IF NOT EXISTS idx_published_packages_source_uploaded_draft_lookup
ON published_packages (
  source_uploaded_draft_id,
  published_at DESC,
  created_at DESC,
  published_package_id DESC
)
WHERE source_uploaded_draft_id IS NOT NULL;
