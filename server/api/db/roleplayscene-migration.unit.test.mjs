import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('RolePlayScene uploaded draft migration uses isolated tables and indexes', async () => {
  const sql = await fs.readFile(
    path.join(__dirname, 'migrations', '011_roleplayscene_uploaded_drafts.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS roleplayscene_uploaded_drafts/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS uploaded_drafts\b/);
  assert.match(sql, /roleplayscene_uploaded_draft_id UUID PRIMARY KEY/);
  assert.match(sql, /description TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /package_version INTEGER NOT NULL/);
  assert.match(sql, /scene_count INTEGER NOT NULL CHECK \(scene_count > 0\)/);
  assert.match(sql, /media_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /missing_media_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /validation_warning_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /idx_roleplayscene_uploaded_drafts_owner_created/);
  assert.match(sql, /ux_roleplayscene_uploaded_drafts_owner_title/);
  assert.match(sql, /owner_sub,\s*lower\(regexp_replace\(btrim\(coalesce\(title, ''\)\), '\\s\+', ' ', 'g'\)\)/);
});

test('RolePlayScene uploaded draft publish marker migration is isolated', async () => {
  const sql = await fs.readFile(
    path.join(__dirname, 'migrations', '012_roleplayscene_uploaded_draft_publish_markers.sql'),
    'utf8'
  );

  assert.match(sql, /ALTER TABLE roleplayscene_uploaded_drafts/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_published_artifact_sha256 TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_published_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /ALTER TABLE uploaded_drafts\b/);
});
