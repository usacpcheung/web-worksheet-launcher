CREATE UNIQUE INDEX IF NOT EXISTS idx_published_packages_source_uploaded_draft_unique
ON published_packages (source_uploaded_draft_id)
WHERE source_uploaded_draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_published_packages_owner_name_lower
ON published_packages ((lower(owner_name)));
