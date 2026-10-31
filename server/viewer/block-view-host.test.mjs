import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockViewHost, createBlockViewScope } from './block-view-host.js';

function fixture(options = {}) {
  const events = [];
  const container = { children: [], replaceChildren(...children) { this.children = children; } };
  const views = [];
  const host = createBlockViewHost({ container, signal: options.signal,
    beforeReplace() { events.push('before'); },
    createView(block) {
      if (options.fail?.()) throw new Error('fixture construction failure');
      const view = { element: { id: block.blockId }, updates: 0, disposals: 0,
        update() { this.updates++; events.push('update:' + block.blockId); },
        dispose() { this.disposals++; events.push('dispose:' + block.blockId); } };
      views.push(view);return view;
    },
  });
  return { host, container, views, events };
}

test('answer/status refresh preserves the mounted card; grading change replaces it once', () => {
  const f = fixture();
  f.host.update({ blockId: 'q1' }, { signature: 'editing' });
  const first = f.container.children[0];
  f.host.update({ blockId: 'q1' }, { signature: 'editing' });
  assert.equal(f.container.children[0], first);
  assert.equal(f.views[0].updates, 2);
  assert.deepEqual(f.events, ['before', 'update:q1', 'update:q1']);
  f.host.update({ blockId: 'q1' }, { signature: 'checked' });
  assert.notEqual(f.container.children[0], first);
  assert.equal(f.views[0].disposals, 1);
  assert.equal(f.views[1].updates, 1);
});

test('content/question replacement releases only the old view and hosts have independent ownership', () => {
  const a = fixture(), b = fixture();
  a.host.update({ blockId: '__proto__' }, { signature: 'same' });
  b.host.update({ blockId: '__proto__' }, { signature: 'same' });
  a.host.update({ blockId: 'reading' }, { signature: 'same' });
  assert.equal(a.views[0].disposals, 1);
  assert.equal(b.views[0].disposals, 0);
  assert.equal(a.container.children[0].id, 'reading');
  assert.equal(b.container.children[0].id, '__proto__');
  a.host.update(null, { signature: 'empty' });
  assert.equal(a.views[1].disposals, 1);
  assert.deepEqual(a.container.children, []);
});

test('shell abort disposes once and late updates cannot mount old UI', () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  f.host.update({ blockId: 'q1' }, { signature: 'editing' });
  controller.abort();f.host.dispose();
  f.host.update({ blockId: 'q2' }, { signature: 'editing' });
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].disposals, 1);
  assert.deepEqual(f.container.children, []);
  const alreadyAborted = fixture({ signal: controller.signal });
  alreadyAborted.host.update({ blockId: 'q1' }, { signature: 'editing' });
  assert.equal(alreadyAborted.views.length, 0);
});

test('failed construction does not cache a signature that suppresses a retry', () => {
  let fail = true;
  const f = fixture({ fail: () => fail });
  assert.throws(() => f.host.update({ blockId: 'q1' }, { signature: 'editing' }));
  fail = false;
  f.host.update({ blockId: 'q1' }, { signature: 'editing' });
  assert.equal(f.container.children[0].id, 'q1');
});

test('view scope releases outstanding URLs once and rejects late resource creation', t => {
  const released = [];
  let next = 0;
  t.mock.method(URL, 'createObjectURL', () => 'blob:fixture-' + ++next);
  t.mock.method(URL, 'revokeObjectURL', url => released.push(url));
  const scope = createBlockViewScope();
  const loaded = scope.createObjectURL(new Blob(['loaded']));
  const pending = scope.createObjectURL(new Blob(['pending']));
  scope.releaseObjectURL(loaded);
  scope.dispose();scope.dispose();scope.releaseObjectURL(pending);
  assert.deepEqual(released, [loaded, pending]);
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.createObjectURL(new Blob(['late'])), null);
  assert.equal(next, 2);
});

test('disposing one view removes its UI listeners without touching another view', () => {
  const scope = createBlockViewScope(), other = createBlockViewScope(), target = new EventTarget();
  let calls = 0, otherCalls = 0;
  target.addEventListener('input', () => calls++, { signal: scope.signal });
  target.addEventListener('input', () => otherCalls++, { signal: other.signal });
  target.dispatchEvent(new Event('input'));
  scope.dispose();target.dispatchEvent(new Event('input'));
  assert.equal(calls, 1);
  assert.equal(otherCalls, 2);
  other.dispose();
});
