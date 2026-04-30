ALTER TABLE uploaded_attempts
  ALTER COLUMN owner_email DROP NOT NULL,
  ALTER COLUMN owner_name DROP NOT NULL;
