import { imageQuestions, imageAnswerRefs } from '../image-response.js';
const DB_NAME = 'worksheetLauncherStorage';
const DB_VERSION = 2;

const STORE_NAMES = {
  localDrafts: 'localDrafts',
  importedWorksheets: 'importedWorksheets',
  localAttempts: 'localAttempts',
  localAssets: 'localAssets',
};

const REQUIRED_METADATA_FIELDS = ['localId', 'origin', 'updatedAt'];

let dbPromise;

function assertValidStoreName(storeName) {
  if (!Object.values(STORE_NAMES).includes(storeName)) {
    throw new Error(`Unsupported IndexedDB store: ${String(storeName)}`);
  }
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Record metadata must be a non-null object.');
  }

  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field]) {
      throw new Error(`Record metadata is missing required field: ${field}`);
    }
  }
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Record must be a non-null object.');
  }

  const metadata = record.metadata || {};
  validateMetadata(metadata);

  return {
    ...record,
    metadata: {
      ...metadata,
      updatedAt: new Date(metadata.updatedAt).toISOString(),
    },
  };
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let request;

      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        dbPromise = undefined;
        reject(error);
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        for (const storeName of Object.values(STORE_NAMES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: 'localId' });
            store.createIndex('updatedAt', 'metadata.updatedAt', { unique: false });
            store.createIndex('origin', 'metadata.origin', { unique: false });
            store.createIndex('linkedServerId', 'metadata.serverLink.serverId', {
              unique: false,
            });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = undefined;
        reject(request.error || new Error('Failed to open IndexedDB.'));
      };
      request.onblocked = () => {
        dbPromise = undefined;
        reject(new Error('IndexedDB open request was blocked.'));
      };
    });
  }

  return dbPromise;
}

function runTransaction(storeName, mode, executor) {
  assertValidStoreName(storeName);

  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);

        let result;

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error(`IndexedDB transaction failed for ${storeName}.`));
        tx.onabort = () => reject(tx.error || new Error(`IndexedDB transaction aborted for ${storeName}.`));

        try {
          result = executor(store);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      })
  );
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

async function putRecord(storeName, record) {
  const normalizedRecord = normalizeRecord(record);
  const persistedRecord = {
    ...normalizedRecord,
    localId: normalizedRecord.metadata.localId,
  };

  await runTransaction(storeName, 'readwrite', (store) => {
    if (storeName === STORE_NAMES.localAttempts && imageQuestions(persistedRecord.viewerPayload?.blocks).length) {
      const request=store.get(persistedRecord.localId);
      request.onsuccess=()=>{
        const old=request.result;
        if(old && imageQuestions(old.viewerPayload?.blocks).some(q=>JSON.stringify(old.answers?.[q.blockId]?.value||[])!==JSON.stringify(persistedRecord.answers?.[q.blockId]?.value||[]))) { store.transaction.abort(); return; }
        store.put(persistedRecord);
      };
    } else store.put(persistedRecord);
  });

  return persistedRecord;
}

async function getRecord(storeName, localId) {
  return runTransaction(storeName, 'readonly', (store) => promisifyRequest(store.get(localId)));
}

async function recoverRecord(storeName, record, expected, isCurrent) {
  const normalized = normalizeRecord(record);
  const pending = { ...normalized, localId: normalized.metadata.localId };
  let recovered;
  let failure;
  try {
    await runTransaction(storeName, 'readwrite', store => {
      const request = store.get(pending.localId);
      request.onsuccess = () => {
        try {
          recovered = request.result;
          // A newer write or deletion must win over this stale recovery read.
          if (!isCurrent() || JSON.stringify(recovered) !== JSON.stringify(expected)) return;
          if(storeName===STORE_NAMES.localAttempts && recovered && imageQuestions(recovered.viewerPayload?.blocks).some(q=>JSON.stringify(recovered.answers?.[q.blockId]?.value||[])!==JSON.stringify(pending.answers?.[q.blockId]?.value||[]))) return;
          store.put(pending);
          recovered = pending;
        } catch (error) {
          failure = error;
          store.transaction.abort();
        }
      };
    });
  } catch (error) { throw failure || error; }
  return recovered;
}

// Reclaim only answer assets owned by the deleted attempt. Worksheet/shared media
// has no ownerAttemptId and must survive local attempt deletion.
async function deleteAttemptsAndOwnedImages(localId) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAMES.localAttempts, STORE_NAMES.localAssets], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Unable to remove attempt.'));
    const attempts = tx.objectStore(STORE_NAMES.localAttempts);
    if (localId === undefined) attempts.clear();
    else attempts.delete(localId);
    const request = tx.objectStore(STORE_NAMES.localAssets).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const owner = cursor.value?.metadata?.ownerAttemptId;
      if (owner && (localId === undefined || owner === localId)) cursor.delete();
      cursor.continue();
    };
  });
}

async function deleteRecord(storeName, localId) {
  if (storeName === STORE_NAMES.localAttempts) return deleteAttemptsAndOwnedImages(localId);
  await runTransaction(storeName, 'readwrite', (store) => {
    store.delete(localId);
  });
}

async function listRecords(storeName) {
  return runTransaction(storeName, 'readonly', (store) => promisifyRequest(store.getAll()));
}

async function clearStore(storeName) {
  if (storeName === STORE_NAMES.localAttempts) return deleteAttemptsAndOwnedImages();
  await runTransaction(storeName, 'readwrite', (store) => {
    store.clear();
  });
}


// Save bytes and answer references together. A stale tab cannot overwrite a newer image answer.
async function commitAnswerImages({ attemptId, blockId, expected, next, asset, isCurrent }) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAMES.localAttempts, STORE_NAMES.localAssets], 'readwrite');
    const attempts = tx.objectStore(STORE_NAMES.localAttempts),
      assets = tx.objectStore(STORE_NAMES.localAssets);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error('Image answer changed or could not be saved.'));
    const req = attempts.get(attemptId);
    req.onsuccess = () => {
      try {
        const record = req.result,
          q = record?.viewerPayload?.blocks?.find((b) => b.blockId === blockId);
        if (
          !record ||
          record.status === 'completed' ||
          q?.responseConfig?.inputType !== 'image_response' ||
          !isCurrent() ||
          JSON.stringify(record.answers?.[blockId]?.value || []) !== JSON.stringify(expected)
        ) {
          tx.abort();
          return;
        }
        imageAnswerRefs(next, q.responseConfig.maxImages);
        if (asset) assets.put(asset);
        const updatedAt = new Date().toISOString();
        result = {
          ...record,
          answers: { ...record.answers, [blockId]: { value: next, answeredAt: updatedAt } },
          lastSavedAt: updatedAt,
          metadata: { ...record.metadata, updatedAt },
        };
        attempts.put(result);
        // Only newly owned answer assets can be reclaimed. Imported/shared media remain intact.
        for (const ref of expected.filter((r) => !next.some((n) => n.assetId === r.assetId))) {
          const old = assets.get(ref.assetId);
          old.onsuccess = () => {
            const referenced = Object.values(result.answers).some(
              (a) => Array.isArray(a.value) && a.value.some((r) => r?.assetId === ref.assetId)
            );
            if (!referenced && old.result?.metadata?.ownerAttemptId === attemptId) assets.delete(ref.assetId);
          };
        }
      } catch {
        tx.abort();
      }
    };
  });
}

function createStorageApi() {
  return {
    commitAnswerImages,
    putLocalDraft: (record) => putRecord(STORE_NAMES.localDrafts, record),
    getLocalDraft: (localId) => getRecord(STORE_NAMES.localDrafts, localId),
    recoverLocalDraft: (record, expected, isCurrent) => recoverRecord(STORE_NAMES.localDrafts, record, expected, isCurrent),
    listLocalDrafts: () => listRecords(STORE_NAMES.localDrafts),
    deleteLocalDraft: (localId) => deleteRecord(STORE_NAMES.localDrafts, localId),

    putImportedWorksheet: (record) => putRecord(STORE_NAMES.importedWorksheets, record),
    getImportedWorksheet: (localId) => getRecord(STORE_NAMES.importedWorksheets, localId),
    listImportedWorksheets: () => listRecords(STORE_NAMES.importedWorksheets),
    deleteImportedWorksheet: (localId) => deleteRecord(STORE_NAMES.importedWorksheets, localId),

    putLocalAttempt: (record) => putRecord(STORE_NAMES.localAttempts, record),
    getLocalAttempt: (localId) => getRecord(STORE_NAMES.localAttempts, localId),
    recoverLocalAttempt: (record, expected, isCurrent) => recoverRecord(STORE_NAMES.localAttempts, record, expected, isCurrent),
    listLocalAttempts: () => listRecords(STORE_NAMES.localAttempts),
    deleteLocalAttempt: (localId) => deleteRecord(STORE_NAMES.localAttempts, localId),

    putLocalAsset: (record) => putRecord(STORE_NAMES.localAssets, record),
    getLocalAsset: (localId) => getRecord(STORE_NAMES.localAssets, localId),
    listLocalAssets: () => listRecords(STORE_NAMES.localAssets),
    deleteLocalAsset: (localId) => deleteRecord(STORE_NAMES.localAssets, localId),

    clearLocalDrafts: () => clearStore(STORE_NAMES.localDrafts),
    clearImportedWorksheets: () => clearStore(STORE_NAMES.importedWorksheets),
    clearLocalAttempts: () => clearStore(STORE_NAMES.localAttempts),
    clearLocalAssets: () => clearStore(STORE_NAMES.localAssets),
  };
}

export {
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  createStorageApi,
  openDatabase,
  putRecord,
  getRecord,
  listRecords,
  deleteRecord,
  clearStore,
};
