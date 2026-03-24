const KEY_PREFIX = 'worksheetLauncher';

const STORAGE_KEYS = {
  resumeFlags: `${KEY_PREFIX}:resumeFlags`,
  pendingIntent: `${KEY_PREFIX}:pendingIntent`,
};

function safeParse(jsonValue) {
  if (!jsonValue) {
    return null;
  }

  try {
    return JSON.parse(jsonValue);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readJson(key) {
  return safeParse(localStorage.getItem(key));
}

function setResumeFlag(flagKey, restoreMetadata) {
  if (!flagKey) {
    throw new Error('resume flag key is required');
  }
  if (!restoreMetadata || typeof restoreMetadata !== 'object') {
    throw new Error('resume restore metadata is required');
  }
  if (!restoreMetadata.localId) {
    throw new Error('resume restore metadata must include localId');
  }
  if (!restoreMetadata.store) {
    throw new Error('resume restore metadata must include store');
  }

  const currentFlags = readJson(STORAGE_KEYS.resumeFlags) || {};

  currentFlags[flagKey] = {
    localId: restoreMetadata.localId,
    store: restoreMetadata.store,
    updatedAt: restoreMetadata.updatedAt || new Date().toISOString(),
  };

  writeJson(STORAGE_KEYS.resumeFlags, currentFlags);
}

function getResumeFlag(flagKey) {
  const currentFlags = readJson(STORAGE_KEYS.resumeFlags) || {};
  return currentFlags[flagKey] || null;
}

function clearResumeFlag(flagKey) {
  const currentFlags = readJson(STORAGE_KEYS.resumeFlags) || {};
  delete currentFlags[flagKey];
  writeJson(STORAGE_KEYS.resumeFlags, currentFlags);
}

function setPendingIntent(intentMetadata) {
  writeJson(STORAGE_KEYS.pendingIntent, {
    ...intentMetadata,
    updatedAt: intentMetadata?.updatedAt || new Date().toISOString(),
  });
}

function getPendingIntent() {
  return readJson(STORAGE_KEYS.pendingIntent);
}

function clearPendingIntent() {
  localStorage.removeItem(STORAGE_KEYS.pendingIntent);
}

function clearAllStorageMarkers() {
  localStorage.removeItem(STORAGE_KEYS.resumeFlags);
  localStorage.removeItem(STORAGE_KEYS.pendingIntent);
}

export {
  STORAGE_KEYS,
  setResumeFlag,
  getResumeFlag,
  clearResumeFlag,
  setPendingIntent,
  getPendingIntent,
  clearPendingIntent,
  clearAllStorageMarkers,
};
