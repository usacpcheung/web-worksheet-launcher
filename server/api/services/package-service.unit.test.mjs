import test from 'node:test';
import assert from 'node:assert/strict';
import { PackageService } from './package-service.js';

function createFakeDb({ draftCount = 0 } = {}) {
  const state = { draftCount };

  return {
    async connect() {
      return {
        async query(sql) {
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

test('uploadDraft returns slot-limit error when 3 uploaded drafts already exist', async () => {
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
});
