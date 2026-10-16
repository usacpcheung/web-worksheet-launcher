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
    ...restoreMetadata,
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

// Pending actions belong to the tab that navigates through authentication.
// Resume flags remain shared for the existing start-panel resume behavior.
function setPendingIntent(intentMetadata) {
  sessionStorage.setItem(STORAGE_KEYS.pendingIntent, JSON.stringify({
    ...intentMetadata,
    intentId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    updatedAt: intentMetadata?.updatedAt || new Date().toISOString(),
  }));
}

function getPendingIntent() {
  const current = sessionStorage.getItem(STORAGE_KEYS.pendingIntent);
  if (current !== null) return safeParse(current);
  // Import the legacy singleton once, preserving in-progress login returns.
  // New writes never touch this origin-wide key.
  if (new URL(globalThis.location?.href || 'http://localhost/').searchParams.get('authReturn') !== '1') return null;
  const legacy = localStorage.getItem(STORAGE_KEYS.pendingIntent);
  if (legacy === null) return null;
  sessionStorage.setItem(STORAGE_KEYS.pendingIntent, legacy);
  localStorage.removeItem(STORAGE_KEYS.pendingIntent);
  return safeParse(legacy);
}

function clearPendingIntent() {
  // A tombstone prevents a later legacy record from being adopted after cancel.
  sessionStorage.setItem(STORAGE_KEYS.pendingIntent, 'null');
}


export {
  STORAGE_KEYS,
  setResumeFlag,
  getResumeFlag,
  clearResumeFlag,
  setPendingIntent,
  getPendingIntent,
  clearPendingIntent,
};
