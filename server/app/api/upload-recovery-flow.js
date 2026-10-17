import { classifyUploadResult } from './upload-result.js';

// Coordinates decisions only. Callers own the package, UI, auth and transport.
// A retry requires a new explicit choice or confirmed deletion; uncertain
// responses remain terminal here and are handled by transport receipt lookup.
export async function runUploadRecoveryFlow({
  resource, submit, chooseConflict, recoverSlots,
  isCurrent = () => true, signal, initialResult, conflictAction = '',
}) {
  let result = initialResult;
  let hasResult = initialResult !== undefined;
  const stopped = () => !isCurrent() ? 'stale' : signal?.aborted ? 'canceled' : null;
  while (true) {
    let status = stopped();
    if (status) return { status, result };
    if (!hasResult) result = await submit(conflictAction);
    hasResult = false;
    if (!isCurrent()) return { status: 'stale', result };
    // Preserve a confirmed mutation even if cancellation arrived with success.
    const outcome = classifyUploadResult(result, resource);
    if (!['conflict', 'slot_limit'].includes(outcome.kind) || outcome.requiresSignIn) {
      return { status: 'completed', result };
    }
    status = stopped();
    if (status) return { status, result };
    if (outcome.kind === 'conflict') {
      const choice = await chooseConflict(result);
      status = stopped();
      if (status) return { status, result };
      if (choice !== 'copy' && choice !== 'replace') return { status: 'canceled', result };
      conflictAction = choice;
    } else if (outcome.kind === 'slot_limit') {
      const recovery = await recoverSlots(result);
      status = stopped();
      if (status) return { status, result };
      if (recovery?.deleted !== true) return { status: 'canceled', result };
    } else {
      return { status: 'completed', result };
    }
  }
}
