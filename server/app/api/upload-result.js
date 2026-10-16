// Pure presentation classification. Transport, auth recovery and retries remain
// with their existing owners. Keep the original result (including receipts and
// error details) intact; a classification never grants permission to retry.
const codesByResource = {
  'worksheet-draft': { conflict: 'DRAFT_NAME_CONFLICT', slot: 'DRAFT_SLOT_LIMIT_REACHED' },
  'worksheet-attempt': { conflict: 'ATTEMPT_NAME_CONFLICT', slot: 'ATTEMPT_SLOT_LIMIT_REACHED' },
  'roleplayscene-draft': { conflict: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT', slot: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED' },
};

export function classifyUploadResult(result, resource) {
  const code = String(result?.error?.code || '').toUpperCase();
  const requiresSignIn = [result, result?.error].some(candidate => Boolean(
    candidate?.requiresSignIn || [401, 403].includes(Number(candidate?.status))
    || String(candidate?.code || '').toUpperCase() === 'AUTH_REQUIRED'
  ));
  let kind = 'failure';
  if (result?.ok === true) kind = 'success';
  else if (result?.ok === false) {
    const codes = codesByResource[resource];
    if (codes && code === codes.conflict) kind = 'conflict';
    else if (codes && code === codes.slot) kind = 'slot_limit';
    else if (code === 'ABORTED') kind = 'canceled';
    else if (code === 'NETWORK_ERROR' || code === 'UPLOAD_TIMEOUT') kind = 'uncertain';
    else if (requiresSignIn) kind = 'auth_required';
  }
  // Authentication metadata is orthogonal to presentation. For example a
  // timeout may retain HTTP 401; the existing auth gate must still handle it.
  return { kind, code, requiresSignIn, result };
}

// SharedAuthGate returns envelopes for execution/blocks and raw non-auth
// failures for executed actions. Do not mistake the latter for a sign-in block.
export function classifyProtectedUploadResult(result, resource) {
  if (result?.status === 'redirected') return { kind: 'redirected', result };
  if (result?.status === 'executed') return { kind: 'executed', result };
  if (result?.ok === false) return { kind: 'upload', outcome: classifyUploadResult(result, resource), result };
  return { kind: 'blocked', reason: result?.status, result };
}
