DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        owner_sub,
        lower(regexp_replace(btrim(coalesce(title, '')), '\s+', ' ', 'g')) AS normalized_title,
        lower(regexp_replace(btrim(coalesce(subject, '')), '\s+', ' ', 'g')) AS normalized_subject,
        COUNT(*) AS duplicate_count
      FROM uploaded_drafts
      GROUP BY owner_sub, normalized_title, normalized_subject
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Duplicate uploaded drafts exist for owner/title/subject; cleanup is required before applying 005_uploaded_draft_conflict_identity.sql';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_drafts_owner_title_subject_unique
ON uploaded_drafts (
  owner_sub,
  lower(regexp_replace(btrim(coalesce(title, '')), '\s+', ' ', 'g')),
  lower(regexp_replace(btrim(coalesce(subject, '')), '\s+', ' ', 'g'))
);
