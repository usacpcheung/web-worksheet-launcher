import test from 'node:test';
import assert from 'node:assert/strict';
import { PackageService } from './package-service.js';

function createFakeDb({ draftCount = 0 } = {}) {
  const state = { draftCount, queries: [] };

  return {
    state,
    async connect() {
      return {
        async query(sql) {
          state.queries.push(sql);
          if (sql.includes('SELECT pg_advisory_xact_lock(hashtext($1))')) {
            return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
          }
          if (sql.includes('COUNT(*)::int AS count FROM uploaded_drafts')) {
            return { rows: [{ count: state.draftCount }], rowCount: 1 };
          }
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`Unhandled query in fake db: ${sql}`);
        },
        release() {},
      };
    },
  };
}

test('uploadDraft acquires per-owner advisory lock before counting slots', async () => {
  const db = createFakeDb({ draftCount: 3 });
  const artifactStore = {
    async storeArtifact() {
      throw new Error('storeArtifact should not be called for slot-limit path');
    },
  };

  const service = new PackageService({
    db,
    artifactStore,
    config: {
      draftSlotLimit: 3,
      browsePageLimitDefault: 20,
      browsePageLimitMax: 100,
    },
  });

  const result = await service.uploadDraft({
    identity: { sub: 'oidc-sub' },
    title: 'Title',
    subject: 'Math',
    zipBytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'DRAFT_SLOT_LIMIT_REACHED');

  const lockQueryIndex = db.state.queries.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const countQueryIndex = db.state.queries.findIndex((sql) => sql.includes('COUNT(*)::int AS count FROM uploaded_drafts'));
  assert.notEqual(lockQueryIndex, -1);
  assert.notEqual(countQueryIndex, -1);
  assert.equal(lockQueryIndex < countQueryIndex, true);
});
