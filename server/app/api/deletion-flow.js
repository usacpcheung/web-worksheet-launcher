// No DOM, authentication policy, resource routes, retries or receipt recovery.
// The reservation spans confirmation, preflight, DELETE and optional refresh.
const skipped = (deletionStatus, status) => ({ ok: false, skipped: true, deletionStatus, status, refreshStatus: 'skipped' });
const failedStep = error => ({ ok: false, error: { code: 'NETWORK_ERROR' }, cause: error });
const transportCodes = new Set(['NETWORK_ERROR', 'ABORTED', 'CANCELED', 'REQUEST_TIMEOUT', 'INVALID_JSON_RESPONSE', 'UNEXPECTED_NON_JSON_RESPONSE']);

export function classifyDeletion(result) {
  if (result?.ok === true) return 'confirmed';
  const status = Number(result?.error?.status ?? result?.status);
  if (status >= 400 && status < 500) return 'rejected';
  if (status >= 500 || transportCodes.has(result?.error?.code) || !result?.error?.code) return 'uncertain';
  return 'rejected';
}

export async function runDeletionFlow({
  pending, key, confirm = async () => true, preflight = null,
  remove, refresh = null, isCurrent = () => true,
}) {
  if (!isCurrent()) return skipped('stale', 'stale_delete');
  if (pending.has(key)) return skipped('busy', 'delete_in_progress');
  pending.add(key);
  try {
    try {
      const confirmed = await confirm();
      if (!isCurrent()) return skipped('stale', 'stale_delete');
      if (confirmed !== true) return skipped('canceled', 'delete_canceled');
      if (preflight) {
        const ready = await preflight();
        if (!isCurrent()) return skipped('stale', 'stale_delete');
        if (!ready?.ok) return { ...ready?.result, ok: false, deletionStatus: 'preflight_failed', refreshStatus: 'skipped' };
      }
    } catch (error) {
      if (!isCurrent()) return skipped('stale', 'stale_delete');
      return { ...failedStep(error), deletionStatus: 'preflight_failed', refreshStatus: 'skipped' };
    }
    if (!isCurrent()) return skipped('stale', 'stale_delete');
    let deleteResult;
    try { deleteResult = await remove(); }
    catch (error) { deleteResult = failedStep(error); }
    const deletionStatus = classifyDeletion(deleteResult);
    const result = {
      ...deleteResult, ok: deletionStatus === 'confirmed', deletionStatus,
      deleteResult, refreshStatus: 'skipped',
    };
    if (deletionStatus === 'uncertain') result.error = { code: 'DELETE_OUTCOME_UNCERTAIN' };
    // Losing ownership cannot undo a mutation already sent to the server.
    if (!result.ok || !isCurrent() || !refresh) return result;
    try { result.refreshResult = await refresh(); }
    catch (error) { result.refreshResult = failedStep(error); }
    result.refreshStatus = !isCurrent() || ['superseded', 'stale_response'].includes(result.refreshResult?.status)
      ? 'superseded' : result.refreshResult?.ok === true ? 'succeeded' : 'failed';
    return result;
  } finally {
    pending.delete(key);
  }
}
