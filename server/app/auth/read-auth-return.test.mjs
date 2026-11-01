import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectReadSignIn, takeReadAuthReturn, validReadIntent } from './read-auth-return.js';
import { getPendingIntent, setPendingIntent } from '../storage/local-storage.js';
function fixture() {
  const map = new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  globalThis.sessionStorage = storage; globalThis.localStorage = storage;
  let target;
  globalThis.window = { location: { href: 'https://example.test/worksheet_launcher/editor/', assign: value => { target = value; } }, history: { replaceState: (_a, _b, value) => { window.location.href = String(value); } } };
  return { target: () => target, map };
}
test('only supported reads can be saved; mutation and URL payloads cannot navigate', async () => {
  fixture();
  for (const kind of ['upload', 'delete', 'publish', 'rewrite', 'unknown']) assert.equal(validReadIntent('editor', { kind, id: 'one' }), false);
  for (const id of ['https://other.test', '../one', 'one?x=1', 'one#two']) assert.equal(validReadIntent('editor', { kind: 'draft', id }), false);
});
test('save completes before tab-scoped intent and same-origin navigation; return is single-use', async () => {
  const h = fixture(); let saved = false;
  await redirectReadSignIn({ app: 'editor', intent: { kind: 'draft', id: 'one' },
    save: async () => { assert.equal(h.target(), undefined); saved = true; },
    localId: () => 'local', subject: () => 'account-a', isCurrent: () => true });
  assert.ok(saved); const url = new URL(h.target());
  assert.equal(url.origin, 'https://example.test'); assert.equal(url.searchParams.get('localDraftId'), 'local');
  window.location.href = h.target();
  const pending = takeReadAuthReturn('editor');
  assert.equal(pending.subject, 'account-a'); assert.equal(pending.readIntent.id, 'one');
  assert.equal(getPendingIntent(), null); assert.equal(takeReadAuthReturn('editor'), null);
});
test('failed persistence and cancellation never navigate or save an intent', async () => {
  for (const failed of [true, false]) {
    const h = fixture(); let current = true;
    const run = () => redirectReadSignIn({ app: 'viewer', intent: { kind: 'attempts' },
      save: async () => { if (failed) throw Error('disk full'); current = false; }, localId: () => null, subject: () => null, isCurrent: () => current });
    if (failed) await assert.rejects(run, /disk full/); else assert.equal(await run(), false);
    assert.equal(h.target(), undefined); assert.equal(getPendingIntent(), null);
  }
});
test('mismatched nonce or app cannot consume another pending action', async () => {
  const h = fixture();
  await redirectReadSignIn({ app: 'editor', intent: { kind: 'published' }, save: async () => {}, localId: () => null, subject: () => null, isCurrent: () => true });
  window.location.href = h.target(); assert.equal(takeReadAuthReturn('viewer'), null); assert.ok(getPendingIntent());
  window.location.href = h.target().replace(/readAuthReturn=[^&]+/, 'readAuthReturn=wrong');
  assert.equal(takeReadAuthReturn('editor'), null); assert.ok(getPendingIntent());
});
test('return sanitizes persisted filters and rejects expired intent', async () => {
  for (const expired of [false, true]) {
    const h = fixture();
    await redirectReadSignIn({ app: 'editor', intent: { kind: 'published' }, save: async () => {}, localId: () => null, subject: () => null, isCurrent: () => true });
    for (const [key, value] of h.map) {
      const pending = JSON.parse(value);
      if (pending.kind !== 'read-auth') continue;
      pending.readIntent.filters = { title: 'x'.repeat(3000), items: ['injected'], loading: true, owner: { bad: true } };
      if (expired) pending.updatedAt = new Date(Date.now() - 16 * 60_000).toISOString();
      h.map.set(key, JSON.stringify(pending));
    }
    window.location.href = h.target();
    const pending = takeReadAuthReturn('editor');
    if (expired) assert.equal(pending, null);
    else assert.deepEqual(pending.readIntent.filters, { title: 'x'.repeat(2000) });
  }
});

test('read fallback never overwrites a pending mutation and removes competing launch queries', async () => {
  const h = fixture();
  const options = { app: 'viewer', intent: { kind: 'publication', id: 'one' }, save: async () => {}, localId: () => null, subject: () => null, isCurrent: () => true };
  setPendingIntent({ kind: 'upload' }); const previous = getPendingIntent();
  await assert.rejects(() => redirectReadSignIn(options), /still pending/);
  assert.deepEqual(getPendingIntent(), previous); assert.equal(h.target(), undefined);
  h.map.clear();
  window.location.href += '?publishedPackageId=old&snapshot=old&authCallback=1';
  await redirectReadSignIn(options);
  const url = new URL(h.target());
  for (const key of ['publishedPackageId','snapshot','authCallback']) assert.equal(url.searchParams.has(key), false);
  assert.equal(url.searchParams.get('auth'), '1');
});

test('mutation return carries only an allowlisted action, resource and form metadata; never executes it', async () => {
  for (const app of ['editor', 'viewer', 'roleplayscene']) {
    const h = fixture();
    const operation = app === 'viewer' ? 'delete-attempt' : 'publish';
    await redirectReadSignIn({ app, intent: { kind: 'mutation', operation, id: 'resource-one', filters: { title: 'Prepared', subject: 'Math', description: 'Retained', token: 'discard' } },
      save: async () => {}, localId: () => 'local', subject: () => 'A', isCurrent: () => true });
    window.location.href = h.target();
    const pending = takeReadAuthReturn(app);
    assert.equal(pending.readIntent.operation, operation);
    assert.equal(pending.readIntent.filters.title, 'Prepared');
    assert.equal(pending.readIntent.filters.token, undefined);
    assert.equal(takeReadAuthReturn(app), null);
  }
  assert.equal(validReadIntent('viewer', { kind: 'mutation', operation: 'publish', id: 'one' }), false);
  assert.equal(validReadIntent('editor', { kind: 'mutation', operation: 'delete-draft', id: '../other' }), false);
});
test('oversized prepared metadata blocks navigation instead of silently losing form text', async () => {
  const h = fixture();
  await assert.rejects(redirectReadSignIn({ app: 'editor', intent: { kind: 'mutation', operation: 'publish', id: 'one', filters: { title: 'x'.repeat(2001) } },
    save: async () => {}, localId: () => 'local', subject: () => 'A', isCurrent: () => true }));
  assert.equal(h.target(), undefined); assert.equal(getPendingIntent(), null);
});

test('editor audio same-tab return preserves work and requires a fresh user action', async () => {
  const h = fixture();
  const intent = { kind: 'mutation', operation: 'generateAudio', id: 'draft-one' };
  assert.equal(validReadIntent('viewer', intent), false);
  assert.equal(validReadIntent('roleplayscene', intent), false);
  await redirectReadSignIn({ app: 'editor', intent, save: async () => {}, localId: () => 'draft-one', subject: () => null, isCurrent: () => true });
  window.location.href = h.target();
  const returned = takeReadAuthReturn('editor');
  assert.equal(returned.readIntent.operation, 'generateAudio');
  assert.equal(returned.localId, 'draft-one');
  assert.equal(takeReadAuthReturn('editor'), null);
});
