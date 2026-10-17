import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadOperationSlot } from './upload-operation-lifecycle.js';

test('one owner survives cancel until settlement; stale cleanup cannot release a later owner', () => {
  const slot = new UploadOperationSlot();
  const first = slot.begin();
  assert.equal(slot.begin(), null);
  first.controller.abort();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.canProgress(), false);
  assert.equal(first.canPublish(), true, 'cancellation feedback still belongs to this owner');
  assert.equal(slot.begin(), null);
  assert.equal(first.finish(), true);
  const second = slot.begin();
  assert.equal(first.finish(), false);
  assert.equal(first.canPublish(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
  assert.equal(slot.begin(), null);
  second.finish();
});

test('context replacement suppresses feedback but permits owner cleanup', () => {
  const slot = new UploadOperationSlot();
  let generation = 1;
  const operation = slot.begin(() => generation === 1);
  assert.equal(operation.canProgress(), true);
  generation++;
  assert.equal(operation.canPublish(), false);
  assert.equal(operation.canProgress(), false);
  assert.equal(operation.isCurrent(), true);
  assert.equal(operation.finish(), true);
  assert.ok(slot.begin());
});
