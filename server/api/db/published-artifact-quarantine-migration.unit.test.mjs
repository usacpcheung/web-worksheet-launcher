import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('published artifact quarantine migration keeps active publications in their existing tables', async () => {
  const sql = await fs.readFile(
    path.join(__dirname, 'migrations', '014_published_artifact_quarantine.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS published_artifact_quarantine/);
  assert.match(sql, /artifact_kind IN \('worksheet', 'roleplayscene', 'orphan'\)/);
  assert.match(sql, /publication_metadata JSONB NOT NULL/);
  assert.match(sql, /automated_confirmation BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /restored_by TEXT/);
  assert.match(sql, /purged_by TEXT/);
  assert.match(sql, /purge_after TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /pending_quarantine/);
  assert.match(sql, /pending_restore/);
  assert.match(sql, /pending_purge/);
  assert.match(sql, /WHERE status NOT IN \('purged', 'restored'\)/);
  assert.doesNotMatch(sql, /ALTER TABLE published_packages/);
  assert.doesNotMatch(sql, /ALTER TABLE roleplayscene_published_scenes/);
});
