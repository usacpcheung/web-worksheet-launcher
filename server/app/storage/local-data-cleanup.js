// Reference-aware local garbage collection. All reads and deletions happen in
// one transaction, so editor saves cannot race a media-reference check.
export const LIFECYCLE_STORE = 'localLifecycle';
const stores = ['localDrafts', 'importedWorksheets', 'localAttempts', 'localAssets', LIFECYCLE_STORE];
export const assetStamp = a => JSON.stringify([a.localId, a.metadata, a.byteLength ?? a.binary?.byteLength ?? a.binary?.size ?? 0]);
export const recordStamp = record => JSON.stringify(record ?? null);
export function assetReferences(value, found = new Set()) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'assetId' && typeof item === 'string') found.add(item);
    else assetReferences(item, found);
  }
  return found;
}
export function planLocalCleanup({ drafts, worksheets, attempts, assets }, { candidates = {}, protectedIds = [], currentId, orphanCutoff = 0, assetIds = [], approvedWorksheets, approvedAssets } = {}) {
  const protectedSet = new Set([...protectedIds, currentId].filter(Boolean));
  const removed = attempts.filter(a => !protectedSet.has(a.localId) && candidates[a.localId] === recordStamp(a));
  const removedIds = new Set(removed.map(a => a.localId));
  const kept = attempts.filter(a => !removedIds.has(a.localId));
  const referencedWorksheets = new Set(kept.map(a => a.sourceImportedWorksheetId || a.metadata?.sourceImportedWorksheetId).filter(Boolean));
  const removedSources = new Set(removed.map(a => a.sourceImportedWorksheetId || a.metadata?.sourceImportedWorksheetId).filter(Boolean));
  const obsoleteWorksheets = worksheets.filter(w => (!approvedWorksheets || approvedWorksheets[w.localId] === recordStamp(w)) && !referencedWorksheets.has(w.localId)
    && (removedSources.has(w.localId) || (orphanCutoff > 0 && Date.parse(w.metadata?.updatedAt) < orphanCutoff)));
  const obsoleteIds = new Set(obsoleteWorksheets.map(w => w.localId));
  const references = assetReferences([...drafts, ...kept, ...worksheets.filter(w => !obsoleteIds.has(w.localId))]);
  const eligibleAssets = assetReferences([...removed, ...obsoleteWorksheets]);
  for (const id of assetIds) eligibleAssets.add(id);
  const obsoleteAssets = assets.filter(a => (!approvedAssets || approvedAssets[a.localId] === assetStamp(a)) && !references.has(a.localId) && (eligibleAssets.has(a.localId)
    || a.metadata?.pendingRemoval === true || (orphanCutoff > 0 && Date.parse(a.metadata?.updatedAt) < orphanCutoff)));
  return { attempts: removed, worksheets: obsoleteWorksheets, assets: obsoleteAssets,
    bytes: obsoleteAssets.reduce((n, a) => n + (a.byteLength ?? a.binary?.byteLength ?? a.binary?.size ?? 0), 0)
      + new TextEncoder().encode(JSON.stringify([...removed, ...obsoleteWorksheets])).length };
}
export function createLocalDataCleanup(openDatabase) {
  async function transact(options = {}, apply = false) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, apply ? 'readwrite' : 'readonly');
      let result; let failure; const data = {};
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Local cleanup failed.'));
      const names = { localDrafts: 'drafts', importedWorksheets: 'worksheets', localAttempts: 'attempts', localAssets: 'assets' };
      let remaining = Object.keys(names).length;
      for (const [name, key] of Object.entries(names)) {
        const request = name === 'localAssets' ? tx.objectStore(name).openCursor() : tx.objectStore(name).getAll();
        if (name === 'localAssets') data[key] = [];
        request.onsuccess = () => {
          if (name === 'localAssets' && request.result) {
            const a = request.result.value;
            data[key].push({ localId: a.localId, metadata: a.metadata, byteLength: a.binary?.byteLength ?? a.binary?.size ?? 0 });
            request.result.continue(); return;
          }
          if (name !== 'localAssets') data[key] = request.result;
          if (--remaining) return;
          try {
            result = planLocalCleanup(data, options);
            if (!apply) return;
            for (const a of result.attempts) {
              tx.objectStore('localAttempts').delete(a.localId);
              tx.objectStore(LIFECYCLE_STORE).put({ localId: `deleted:${a.localId}`, deletedAt: Date.now() });
            }
            for (const w of result.worksheets) tx.objectStore('importedWorksheets').delete(w.localId);
            for (const a of result.assets) tx.objectStore('localAssets').delete(a.localId);
            // Editor removal may precede its next save. Remember the request,
            // but retain bytes until both draft and attempt references disappear.
            for (const id of options.assetIds || []) {
              const asset = data.assets.find(a => a.localId === id);
              if (asset && !result.assets.some(a => a.localId === id)) {
                const original = tx.objectStore('localAssets').get(id);
                original.onsuccess = () => { if (original.result) tx.objectStore('localAssets').put({ ...original.result, metadata: { ...original.result.metadata, pendingRemoval: true } }); };
              }
            }
          } catch (error) { failure = error; tx.abort(); }
        };
      }
    });
  }
  return { inspect: options => transact(options), collect: options => transact(options, true) };
}
