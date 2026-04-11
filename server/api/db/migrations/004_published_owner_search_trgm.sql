CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS idx_published_packages_owner_name_lower;

CREATE INDEX IF NOT EXISTS idx_published_packages_owner_email_trgm
  ON published_packages USING GIN (lower(owner_email) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_published_packages_owner_name_trgm
  ON published_packages USING GIN (lower(owner_name) gin_trgm_ops);
