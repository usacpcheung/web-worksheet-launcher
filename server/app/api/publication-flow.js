// Adapters own reservations, DOM, metadata and account/context guards. They must
// retain their reservation across this whole dialog loop and release in finally.
const stale = () => ({ ok: false, skipped: true, status: 'superseded', refreshStatus: 'skipped' });
const failed = error => ({ ok: false, error: { code: 'NETWORK_ERROR' }, cause: error });

export async function runPublicationFlow({ initialMetadata, collectMetadata, publish,
  isConflict, chooseConflict, isCurrent = () => true }) {
  let metadata = initialMetadata;
  while (isCurrent()) {
    const selected = await collectMetadata(metadata);
    if (!isCurrent()) return stale();
    if (selected == null) return { ok: false, skipped: true, status: 'cancelled', refreshStatus: 'skipped' };
    metadata = selected;
    const result = await publish(metadata);
    // Preserve an attempted mutation's outcome, even after its owner disappears.
    if (!isCurrent() || result?.ok || result?.skipped || !isConflict(result)) return result;
    const choice = await chooseConflict(result);
    if (!isCurrent() || choice !== 'edit') return result;
    // Only an explicit edit choice opens another form; submission still requires
    // that form's confirmation and fresh preparation. Never retry transport errors.
  }
  return stale();
}

// One prepared submission, also usable by direct session callers without a form.
// No retry, receipt lookup, new authentication policy or transport deadline.
export async function runPublicationAttempt({ preflight, submit, onSubmitted,
  refresh, isCurrent = () => true }) {
  if (!isCurrent()) return stale();
  let ready;
  try { ready = await preflight(); }
  catch (error) { ready = { ok: false, result: failed(error) }; }
  if (!isCurrent()) return stale();
  if (!ready?.ok) return { ...ready?.result, ok: false, phase: 'preflight', refreshStatus: 'skipped' };
  let publicationResult;
  try { publicationResult = await submit(); }
  catch (error) { publicationResult = failed(error); }
  const result = { ...publicationResult, publicationResult, phase: 'submission', refreshStatus: 'skipped' };
  if (!isCurrent()) return result;
  onSubmitted?.(publicationResult);
  if (!publicationResult?.ok || !isCurrent() || !refresh) return result;
  try { result.refreshResult = await refresh(); }
  catch (error) { result.refreshResult = failed(error); }
  result.refreshStatus = !isCurrent() || ['superseded', 'stale_response'].includes(result.refreshResult?.status)
    ? 'superseded' : result.refreshResult?.ok === true ? 'succeeded' : 'failed';
  return result;
}
