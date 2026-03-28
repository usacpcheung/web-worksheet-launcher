import { createStorageApi } from '../../app/storage/indexeddb.js';

const db = createStorageApi();

function nowIso() {
  return new Date().toISOString();
}

function withRequiredMetadata(record, fallbackOrigin = 'server/editor') {
  const localId = record?.localId || record?.metadata?.localId;
  if (!localId) {
    throw new Error('Draft localId is required.');
  }

  return {
    ...record,
    localId,
    metadata: {
      ...(record.metadata || {}),
      localId,
      origin: record?.metadata?.origin || fallbackOrigin,
      updatedAt: record?.metadata?.updatedAt || nowIso(),
    },
  };
}

function compareByUpdatedAtDesc(a, b) {
  const left = Date.parse(a?.metadata?.updatedAt || 0);
  const right = Date.parse(b?.metadata?.updatedAt || 0);
  return right - left;
}

const editorStorage = {
  drafts: {
    async create(record) {
      return db.putLocalDraft(withRequiredMetadata(record));
    },
    async update(record) {
      const normalized = withRequiredMetadata(record);
      normalized.metadata.updatedAt = nowIso();
      return db.putLocalDraft(normalized);
    },
    async get(localId) {
      return db.getLocalDraft(localId);
    },
    async getLatest() {
      const drafts = await db.listLocalDrafts();
      if (!Array.isArray(drafts) || drafts.length === 0) return null;
      return [...drafts].sort(compareByUpdatedAtDesc)[0];
    },
    async list() {
      return db.listLocalDrafts();
    },
    async remove(localId) {
      return db.deleteLocalDraft(localId);
    },
    async clear() {
      return db.clearLocalDrafts();
    },
  },
};

export { editorStorage, withRequiredMetadata, compareByUpdatedAtDesc };
