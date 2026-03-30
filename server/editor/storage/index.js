import { createStorageApi } from '../../app/storage/indexeddb.js';
import {
  setResumeFlag,
  getResumeFlag,
  clearResumeFlag,
  setPendingIntent,
  getPendingIntent,
  clearPendingIntent,
} from '../../app/storage/local-storage.js';

const db = createStorageApi();

const editorStorage = {
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

export { editorStorage };
