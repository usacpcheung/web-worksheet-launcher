// Per-tab reload recovery. Binary media stays in IndexedDB; only local records
// are journaled synchronously when a page leaves with unsaved work.
const prefix = 'worksheetLauncher:pending:';
const keyFor = (store, id) => `${prefix}${store}:${encodeURIComponent(id)}`;
const time = record => Date.parse(record?.metadata?.updatedAt || '') || 0;
const matches = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function readRecovery(store, id) {
  try {
    const record = JSON.parse(globalThis.sessionStorage.getItem(keyFor(store, id)) || 'null');
    return record?.localId === id && record?.metadata?.localId === id ? record : null;
  } catch { return null; }
}
export function writeRecovery(store, record) {
  if (!record?.localId) return false;
  try {
    globalThis.sessionStorage.setItem(keyFor(store, record.localId), JSON.stringify(record));
    return true;
  } catch { return false; }
}
export function clearRecovery(store, id, savedRecord = null) {
  try {
    const pending = readRecovery(store, id);
    if (savedRecord && pending && (time(pending) > time(savedRecord)
      || (time(pending) === time(savedRecord) && !matches(pending, savedRecord)))) return;
    globalThis.sessionStorage.removeItem(keyFor(store, id));
  } catch { /* Unavailable browser storage must not break ordinary persistence. */ }
}
export function withRecovery(store, api) {
  return {
    ...api,
    async get(id) {
      const pending = readRecovery(store, id);
      let saved;
      try { saved = await api.get(id); } catch (error) { if (!pending) throw error; }
      if (!pending || time(saved) > time(pending) || matches(saved, pending)) {
        if (pending) clearRecovery(store, id, saved);
        return saved;
      }
      try { await api.put(pending); clearRecovery(store, id, pending); }
      catch { /* Keep the journal and allow the user to recover/export their work. */ }
      return pending;
    },
    async put(record) {
      const saved = await api.put(record);
      clearRecovery(store, record.localId, record);
      return saved;
    },
    async remove(id) { await api.remove(id); clearRecovery(store, id); },
    async clear() {
      await api.clear();
      try {
        for (let i = globalThis.sessionStorage.length - 1; i >= 0; i--) {
          const key = globalThis.sessionStorage.key(i);
          if (key?.startsWith(`${prefix}${store}:`)) globalThis.sessionStorage.removeItem(key);
        }
      } catch { /* Storage can be denied independently of IndexedDB. */ }
    },
  };
}

export function installPageRecovery(store, getSession, target = globalThis.window, doc = globalThis.document) {
  const flush = () => {
    const session = getSession();
    if (!session?.state?.autosavePending && !session?.inFlightSaveCount) return true;
    let journaled = false;
    try { journaled = writeRecovery(store, session.createRecoveryRecord()); } catch {}
    clearTimeout(session.autosaveTimer);
    session.autosaveTimer = null;
    session.autosave().catch(() => {}); // The session retains its save-error UI.
    return journaled;
  };
  const beforeUnload = event => {
    if (!flush()) { event.preventDefault(); event.returnValue = ''; }
  };
  const visibility = () => { if (doc?.visibilityState === 'hidden') flush(); };
  target?.addEventListener?.('beforeunload', beforeUnload);
  target?.addEventListener?.('pagehide', flush);
  doc?.addEventListener?.('visibilitychange', visibility);
  return () => {
    target?.removeEventListener?.('beforeunload', beforeUnload);
    target?.removeEventListener?.('pagehide', flush);
    doc?.removeEventListener?.('visibilitychange', visibility);
  };
}
