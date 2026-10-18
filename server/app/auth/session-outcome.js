// Pure classification: no UI, retries, login, state changes or message matching.
export function classifySessionFailure(result, { legacyAuthStatuses = false } = {}) {
  const value = result?.result && typeof result.result === 'object' ? result.result : result;
  const error = value?.error || value || {};
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const rawStatus = error.status ?? value?.status;
  const status = typeof rawStatus === 'number' ? rawStatus
    : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : null;
  // Preserve the existing readiness helper's authentication precedence until
  // consumers migrate. Explicit FORBIDDEN can override requiresSignIn only in
  // the new policy, because the current client sets that flag on every 403.
  if (legacyAuthStatuses) {
    const legacyStatus = Number(error.status);
    return error.requiresSignIn || legacyStatus === 401 || legacyStatus === 403 || code === 'AUTH_REQUIRED'
      ? 'authentication_required' : 'unavailable';
  }
  if (value?.skipped || value?.status === 'superseded') return 'superseded';
  if (['SESSION_PROBE_CANCELLED', 'SESSION_WAIT_CANCELLED', 'AUTH_POPUP_FLOW_CANCELLED', 'ABORTED', 'CANCELED'].includes(code)
    || value?.cancelled || value?.status === 'cancelled') return 'cancelled';
  if (status === 401) return 'authentication_required';
  if (['FORBIDDEN', 'PERMISSION_DENIED'].includes(code)) return 'permission_denied';
  // HTTP 5xx transport failures must not start a login loop, even if the
  // upstream result carries a misleading auth hint.
  if (status >= 500) return 'unavailable';
  if (['AUTH_REQUIRED', 'SESSION_EXPIRED', 'SESSION_NOT_READY'].includes(code)
    || error.requiresSignIn) return 'authentication_required';
  if (status === 403) return 'permission_denied';
  return 'unavailable';
}
