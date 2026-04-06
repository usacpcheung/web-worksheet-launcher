CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS idx_published_packages_title_lower;
DROP INDEX IF EXISTS idx_published_packages_subject_lower;

CREATE INDEX IF NOT EXISTS idx_published_packages_title_trgm
  ON published_packages USING GIN (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_published_packages_subject_trgm
  ON published_packages USING GIN (lower(subject) gin_trgm_ops);
