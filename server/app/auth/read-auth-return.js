import { setPendingIntent, getPendingIntent, clearPendingIntent } from '../storage/local-storage.js';

const allowed = {
  editor: new Set(['drafts', 'published', 'draft', 'publication']),
  viewer: new Set(['attempts', 'published', 'attempt', 'attempt-download', 'publication']),
  roleplayscene: new Set(['drafts', 'published', 'draft', 'draft-download', 'publication', 'publication-download', 'publication-copy']),
};
const mutations = {
  editor: new Set(['upload', 'publish', 'delete-draft', 'delete-publication']),
  viewer: new Set(['upload', 'delete-attempt']),
  roleplayscene: new Set(['upload', 'publish', 'delete-draft', 'delete-publication']),
};
export function validReadIntent(app, intent) {
  if (intent?.kind === 'mutation') return Object.hasOwn(mutations, app) && mutations[app].has(intent.operation)
    && (intent.operation === 'upload' || (typeof intent.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(intent.id)));
  if (!intent || !Object.hasOwn(allowed, app) || !allowed[app].has(intent.kind)) return false;
  return ['drafts', 'attempts', 'published'].includes(intent.kind)
    || (typeof intent.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(intent.id));
}
function sanitizeReadFilters(filters) {
  return Object.fromEntries(['title', 'subject', 'owner', 'q', 'description']
    .filter(key => typeof filters?.[key] === 'string')
    .map(key => [key, filters[key].slice(0, 2000)]));
}
// Reuses the existing tab-scoped pending-intent store. No credentials or URL
// supplied by a callback can choose the return destination.
export async function redirectReadSignIn({ app, intent, save, localId, subject, isCurrent }) {
  if (!validReadIntent(app, intent) || !isCurrent()) return false;
  if (intent.kind === 'mutation' && Object.values(intent.filters || {}).some(value => typeof value === 'string' && value.length > 2000)) {
    throw new Error('The prepared metadata is too long to preserve for navigation. Use popup sign-in.');
  }
  await save(); // Must reject on failed persistence; never navigate after failure.
  if (!isCurrent()) return false;
  const previous = getPendingIntent();
  if (previous && previous.kind !== 'read-auth') throw new Error('An existing authentication action is still pending.');
  const filters = sanitizeReadFilters(intent.filters);
  setPendingIntent({ kind: 'read-auth', appArea: app, readIntent: { kind: intent.kind, id: intent.id || null, operation: intent.operation, filters },
    localId: localId() || null, subject: subject() || null });
  const saved = getPendingIntent();
  if (!saved?.intentId) throw new Error('Unable to preserve the requested action.');
  const url = new URL(window.location.href);
  for (const key of ['authReturn', 'authCallback', 'intent', 'publishedPackageId', 'viewerPayload', 'snapshot', 'publishedSceneId', 'browsePublished']) url.searchParams.delete(key);
  url.searchParams.set('auth', '1');
  url.searchParams.set('readAuthReturn', saved.intentId);
  if (app === 'editor' && saved.localId) url.searchParams.set('localDraftId', saved.localId);
  if (app === 'viewer' && saved.localId) url.searchParams.set('localAttemptId', saved.localId);
  window.location.assign(url.toString());
  return true;
}
export function takeReadAuthReturn(app) {
  if (!globalThis.window?.location?.href) return null;
  const url = new URL(window.location.href);
  const token = url.searchParams.get('readAuthReturn');
  if (!token) return null;
  const pending = getPendingIntent();
  url.searchParams.delete('readAuthReturn');
  url.searchParams.delete('auth');
  window.history.replaceState({}, '', url);
  if (!pending || pending.kind !== 'read-auth' || pending.appArea !== app || pending.intentId !== token) return null;
  clearPendingIntent();
  const age = Date.now() - Date.parse(pending.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000 || !validReadIntent(app, pending.readIntent)) return null;
  return { ...pending, readIntent: { kind: pending.readIntent.kind, id: pending.readIntent.id, operation: pending.readIntent.operation,
    filters: sanitizeReadFilters(pending.readIntent.filters) } };
}
