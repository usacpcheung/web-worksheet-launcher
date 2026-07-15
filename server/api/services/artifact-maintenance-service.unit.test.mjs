import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactMaintenanceService } from './artifact-maintenance-service.js';
import { PackageArtifactStore } from '../storage/package-artifact-store.js';

const PUBLISHED_ID = '11111111-1111-4111-8111-111111111111';

test('audit classifies healthy, missing, old orphan, and young unreferenced files', async () => {
  const now = new Date('2026-06-09T12:00:00.000Z');
  const db = {
    async query(sql) {
      if (sql.includes('FROM published_packages')) {
        return {
          rowCount: 2,
          rows: [
            {
              published_id: PUBLISHED_ID,
              artifact_path: 'published/owner/healthy.zip',
              artifact_size_bytes: 10,
            },
            {
              published_id: '22222222-2222-4222-8222-222222222222',
              artifact_path: 'published/owner/missing.zip',
              artifact_size_bytes: 12,
            },
          ],
        };
      }
      if (sql.includes('FROM roleplayscene_published_scenes')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM published_artifact_quarantine')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const artifactStore = {
    async listPublishedArtifacts() {
      return [
        {
          artifactPath: 'published/owner/healthy.zip',
          sizeBytes: 10,
          modifiedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          artifactPath: 'published/owner/orphan.zip',
          sizeBytes: 20,
          modifiedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          artifactPath: 'roleplayscene/published/owner/young.zip',
          sizeBytes: 30,
          modifiedAt: new Date('2026-06-09T11:00:00.000Z'),
        },
      ];
    },
  };

  const service = new ArtifactMaintenanceService({ db, artifactStore, now: () => now });
  const result = await service.audit();

  assert.equal(result.totals.healthy, 1);
  assert.equal(result.totals.missing, 1);
  assert.deepEqual(result.orphaned.map((row) => row.artifactPath), ['published/owner/orphan.zip']);
  assert.deepEqual(
    result.youngUnreferenced.map((row) => row.artifactPath),
    ['roleplayscene/published/owner/young.zip']
  );
});

test('worksheet quarantine removes only the active publication row and moves its artifact', async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-service-'));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const artifactStore = new PackageArtifactStore({ storageRoot });
  const sourcePath = 'published/owner/source.zip';
  const source = artifactStore.resolveAbsolutePath(sourcePath);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'published bytes');

  const publication = {
    published_package_id: PUBLISHED_ID,
    owner_sub: 'owner',
    owner_email: 'owner@example.test',
    owner_name: 'Owner',
    source_uploaded_draft_id: '33333333-3333-4333-8333-333333333333',
    title: 'Worksheet',
    subject: 'English',
    artifact_path: sourcePath,
    artifact_sha256: 'abc',
    artifact_size_bytes: 15,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    published_at: new Date('2026-06-01T00:00:00.000Z'),
  };
  const state = { active: true, quarantine: null, deletedSql: '' };
  const db = {
    async connect() {
      return {
        async query(sql, values = []) {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rowCount: 0, rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
          if (sql.includes('FROM published_packages') && sql.includes('FOR UPDATE')) {
            return state.active ? { rowCount: 1, rows: [publication] } : { rowCount: 0, rows: [] };
          }
          if (sql.includes('INSERT INTO published_artifact_quarantine')) {
            state.quarantine = {
              quarantine_id: values[0],
              artifact_kind: values[1],
              original_published_id: values[2],
              original_artifact_path: values[3],
              quarantine_artifact_path: values[4],
              status: 'pending_quarantine',
              purge_after: values[15],
            };
            return { rowCount: 1, rows: [state.quarantine] };
          }
          if (sql.includes('DELETE FROM published_packages')) {
            state.active = false;
            state.deletedSql = sql;
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() {},
      };
    },
    async query(sql) {
      if (sql.includes("SET status = 'quarantined'")) {
        state.quarantine = { ...state.quarantine, status: 'quarantined' };
        return { rowCount: 1, rows: [state.quarantine] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  };

  const service = new ArtifactMaintenanceService({
    db,
    artifactStore,
    now: () => new Date('2026-06-09T12:00:00.000Z'),
  });
  const result = await service.quarantinePublication({
    kind: 'worksheet',
    publishedId: PUBLISHED_ID,
    requestedBy: 'admin',
    reason: 'Remove obsolete publication',
  });

  assert.equal(result.ok, true);
  assert.equal(state.active, false);
  assert.match(state.deletedSql, /DELETE FROM published_packages/);
  assert.doesNotMatch(state.deletedSql, /uploaded_drafts/);
  assert.equal(await artifactStore.statArtifact(sourcePath), null);
  assert.equal(
    (await artifactStore.statArtifact(result.quarantine.quarantine_artifact_path)).isFile,
    true
  );
});

test('restore preserves the original worksheet ID and nulls a deleted source draft', async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-restore-'));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const artifactStore = new PackageArtifactStore({ storageRoot });
  const quarantineId = '44444444-4444-4444-8444-444444444444';
  const originalPath = 'published/owner/restored.zip';
  const quarantinePath = `quarantine/worksheet/${quarantineId}.zip`;
  const quarantineFile = artifactStore.resolveAbsolutePath(quarantinePath);
  await fs.mkdir(path.dirname(quarantineFile), { recursive: true });
  await fs.writeFile(quarantineFile, 'quarantined bytes');

  const metadata = {
    published_package_id: PUBLISHED_ID,
    owner_sub: 'owner',
    owner_email: 'owner@example.test',
    owner_name: 'Owner',
    source_uploaded_draft_id: '33333333-3333-4333-8333-333333333333',
    title: 'Worksheet',
    subject: 'English',
    artifact_path: originalPath,
    artifact_sha256: 'abc',
    artifact_size_bytes: 17,
    created_at: '2026-06-01T00:00:00.000Z',
    published_at: '2026-06-01T00:00:00.000Z',
  };
  const row = {
    quarantine_id: quarantineId,
    artifact_kind: 'worksheet',
    original_published_id: PUBLISHED_ID,
    original_artifact_path: originalPath,
    quarantine_artifact_path: quarantinePath,
    publication_metadata: metadata,
    status: 'quarantined',
    purge_after: '2026-07-09T12:00:00.000Z',
  };
  const state = { insertedValues: null, restoredBy: null };
  const db = {
    async connect() {
      return {
        async query(sql, values = []) {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rowCount: 0, rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
          if (sql.includes('FROM published_artifact_quarantine') && sql.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [row] };
          }
          if (sql.includes("SET status = 'pending_restore'")) {
            state.restoredBy = values[2];
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('SELECT 1 FROM published_packages WHERE published_package_id')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM uploaded_drafts')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM published_packages') && sql.includes('regexp_replace')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('INSERT INTO published_packages')) {
            state.insertedValues = values;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("SET status = 'restored'")) {
            return { rowCount: 1, rows: [{ ...row, status: 'restored' }] };
          }
          throw new Error(`Unexpected restore query: ${sql}`);
        },
        release() {},
      };
    },
  };

  const service = new ArtifactMaintenanceService({
    db,
    artifactStore,
    now: () => new Date('2026-06-09T12:00:00.000Z'),
  });
  const result = await service.restore({
    quarantineId,
    requestedBy: 'admin',
  });

  assert.equal(result.ok, true);
  assert.equal(state.restoredBy, 'admin');
  assert.equal(state.insertedValues[0], PUBLISHED_ID);
  assert.equal(state.insertedValues[4], null);
  assert.equal(state.insertedValues[7], originalPath);
  assert.equal((await artifactStore.statArtifact(originalPath)).isFile, true);
  assert.equal(await artifactStore.statArtifact(quarantinePath), null);
});

test('restore locks an existing source draft before retaining its foreign key', async () => {
  const quarantineId = '66666666-6666-4666-8666-666666666666';
  const sourceDraftId = '33333333-3333-4333-8333-333333333333';
  const row = {
    quarantine_id: quarantineId,
    artifact_kind: 'worksheet',
    original_published_id: PUBLISHED_ID,
    original_artifact_path: 'published/owner/restored.zip',
    quarantine_artifact_path: `quarantine/worksheet/${quarantineId}.zip`,
    publication_metadata: {
      published_package_id: PUBLISHED_ID,
      owner_sub: 'owner',
      owner_email: 'owner@example.test',
      owner_name: 'Owner',
      source_uploaded_draft_id: sourceDraftId,
      title: 'Worksheet',
      subject: 'English',
      artifact_path: 'published/owner/restored.zip',
      artifact_sha256: 'abc',
      artifact_size_bytes: 17,
      created_at: '2026-06-01T00:00:00.000Z',
      published_at: '2026-06-01T00:00:00.000Z',
    },
    status: 'quarantined',
    purge_after: '2026-07-09T12:00:00.000Z',
  };
  let sourceLookupSql = '';
  let insertedValues = null;
  const db = {
    async connect() {
      return {
        async query(sql, values = []) {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rowCount: 0, rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
          if (sql.includes('FROM published_artifact_quarantine') && sql.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [row] };
          }
          if (sql.includes('FROM uploaded_drafts')) {
            sourceLookupSql = sql;
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes('SELECT 1 FROM published_packages WHERE published_package_id')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM published_packages') && sql.includes('regexp_replace')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("SET status = 'pending_restore'")) return { rowCount: 1, rows: [] };
          if (sql.includes('INSERT INTO published_packages')) {
            insertedValues = values;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("SET status = 'restored'")) {
            return { rowCount: 1, rows: [{ ...row, status: 'restored' }] };
          }
          throw new Error(`Unexpected source-lock restore query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const artifactStore = {
    async moveArtifact() {
      return { moved: true };
    },
  };
  const service = new ArtifactMaintenanceService({
    db,
    artifactStore,
    now: () => new Date('2026-06-09T12:00:00.000Z'),
  });

  const result = await service.restore({ quarantineId, requestedBy: 'admin' });

  assert.equal(result.ok, true);
  assert.match(sourceLookupSql, /FOR KEY SHARE/);
  assert.equal(insertedValues[4], sourceDraftId);
});

test('restore rejects an expired quarantine before state or filesystem mutation', async () => {
  const quarantineId = '55555555-5555-4555-8555-555555555555';
  const row = {
    quarantine_id: quarantineId,
    artifact_kind: 'worksheet',
    original_published_id: PUBLISHED_ID,
    original_artifact_path: 'published/owner/expired.zip',
    quarantine_artifact_path: `quarantine/worksheet/${quarantineId}.zip`,
    publication_metadata: {},
    status: 'quarantined',
    purge_after: '2026-06-09T12:00:00.000Z',
  };
  let mutationQueries = 0;
  let moveCalls = 0;
  const db = {
    async connect() {
      return {
        async query(sql) {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rowCount: 0, rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
          if (sql.includes('FROM published_artifact_quarantine') && sql.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [row] };
          }
          if (sql.includes('UPDATE') || sql.includes('INSERT') || sql.includes('DELETE')) {
            mutationQueries += 1;
          }
          throw new Error(`Unexpected expired restore query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const artifactStore = {
    async moveArtifact() {
      moveCalls += 1;
    },
  };
  const service = new ArtifactMaintenanceService({
    db,
    artifactStore,
    now: () => new Date('2026-06-09T12:00:00.000Z'),
  });

  const result = await service.restore({
    quarantineId,
    requestedBy: 'admin',
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'QUARANTINE_EXPIRED',
    purgeAfter: row.purge_after,
  });
  assert.equal(mutationQueries, 0);
  assert.equal(moveCalls, 0);
});
