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
    store.put(persistedRecord);
  });

  return persistedRecord;
}

async function getRecord(storeName, localId) {
  return runTransaction(storeName, 'readonly', (store) => promisifyRequest(store.get(localId)));
}

async function deleteRecord(storeName, localId) {
  await runTransaction(storeName, 'readwrite', (store) => {
    store.delete(localId);
  });
}

async function listRecords(storeName) {
  return runTransaction(storeName, 'readonly', (store) => promisifyRequest(store.getAll()));
}

async function clearStore(storeName) {
  await runTransaction(storeName, 'readwrite', (store) => {
    store.clear();
  });
}

function createStorageApi() {
  return {
    putLocalDraft: (record) => putRecord(STORE_NAMES.localDrafts, record),
    getLocalDraft: (localId) => getRecord(STORE_NAMES.localDrafts, localId),
    listLocalDrafts: () => listRecords(STORE_NAMES.localDrafts),
    deleteLocalDraft: (localId) => deleteRecord(STORE_NAMES.localDrafts, localId),

    putImportedWorksheet: (record) => putRecord(STORE_NAMES.importedWorksheets, record),
    getImportedWorksheet: (localId) => getRecord(STORE_NAMES.importedWorksheets, localId),
    listImportedWorksheets: () => listRecords(STORE_NAMES.importedWorksheets),
    deleteImportedWorksheet: (localId) => deleteRecord(STORE_NAMES.importedWorksheets, localId),

    putLocalAttempt: (record) => putRecord(STORE_NAMES.localAttempts, record),
    getLocalAttempt: (localId) => getRecord(STORE_NAMES.localAttempts, localId),
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
