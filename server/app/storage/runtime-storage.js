import { createStorageApi } from './indexeddb.js';
import {
  setResumeFlag,
  getResumeFlag,
  clearResumeFlag,
  setPendingIntent,
  getPendingIntent,
  clearPendingIntent,
} from './local-storage.js';

function createRuntimeStorage() {
  const db = createStorageApi();

  return {
    drafts: {
      put: db.putLocalDraft,
      get: db.getLocalDraft,
      list: db.listLocalDrafts,
      remove: db.deleteLocalDraft,
      clear: db.clearLocalDrafts,
    },
    importedWorksheets: {
      put: db.putImportedWorksheet,
      get: db.getImportedWorksheet,
      list: db.listImportedWorksheets,
      remove: db.deleteImportedWorksheet,
      clear: db.clearImportedWorksheets,
    },
    attempts: {
      put: db.putLocalAttempt,
      get: db.getLocalAttempt,
      list: db.listLocalAttempts,
      remove: db.deleteLocalAttempt,
      clear: db.clearLocalAttempts,
    },
    localAssets: {
      put: db.putLocalAsset,
      get: db.getLocalAsset,
      list: db.listLocalAssets,
      remove: db.deleteLocalAsset,
      clear: db.clearLocalAssets,
    },
    resumeFlags: {
      set: setResumeFlag,
      get: getResumeFlag,
      clear: clearResumeFlag,
    },
    pendingIntent: {
      set: setPendingIntent,
      get: getPendingIntent,
      clear: clearPendingIntent,
    },
  };
}

export { createRuntimeStorage };
