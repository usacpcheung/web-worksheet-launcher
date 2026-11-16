// Bulk callers retain the single-asset API, but share one reference-safe scan.
// Every caller still waits for the transaction (and receives its failure).
export function createAssetRemovalBatch(collect) {
  let pending = null;
  return assetId => {
    if (!pending) {
      pending = { ids: new Set(), waiters: [] };
      queueMicrotask(async () => {
        const batch = pending;
        pending = null;
        try {
          const result = await collect({ assetIds: [...batch.ids] });
          for (const waiter of batch.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of batch.waiters) waiter.reject(error);
        }
      });
    }
    pending.ids.add(assetId);
    return new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
  };
}
