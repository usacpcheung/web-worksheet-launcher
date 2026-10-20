import { promptForReadSignIn } from './read-auth-prompt.js';

const stale = () => ({ ok: false, skipped: true, status: 'superseded' });

// Prepare only: this helper deliberately accepts no transport or replay callback.
// Share the read coordinator so concurrent reads and mutations use one login.
export async function prepareMutation(auth, { intent, isCurrent = () => true, signal,
  confirm = options => promptForReadSignIn({ ...options, confirmation: true }),
} = {}) {
  const current = () => !signal?.aborted && isCurrent();
  const result = await auth.ensure({ intent, isCurrent: current, signal, withContext: true });
  if (!current()) return { ok: false, result: stale(), isCurrent: () => false };
  if (!result?.ok) return { ok: false, result, isCurrent: () => false };
  const accountCurrent = result.isCurrent;
  if (typeof accountCurrent !== 'function') return { ok: false, result: stale(), isCurrent: () => false };
  const readyCurrent = () => current() && accountCurrent();
  if (!readyCurrent()) return { ok: false, result: stale(), isCurrent: () => false };
  if (result.authenticationRecovered) {
    const accepted = await confirm({ intent, isCurrent: readyCurrent });
    if (!readyCurrent()) return { ok: false, result: stale(), isCurrent: () => false };
    if (!accepted) return { ok: false, result: { ok: false, skipped: true, cancelled: true, status: 'cancelled' }, isCurrent: () => false };
  }
  // Return only the account lease: adapters compose it with their existing
  // owner predicate, so returning readyCurrent would create a recursive guard.
  return { ok: true, result, isCurrent: accountCurrent };
}
