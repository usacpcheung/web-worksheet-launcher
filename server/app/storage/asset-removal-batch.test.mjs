import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetRemovalBatch } from './asset-removal-batch.js';

test('bulk media removal performs one scan and every caller waits for its completion', async () => {
  const calls = [];
  let finish;
  const remove = createAssetRemovalBatch(options => {
    calls.push(options);
    return new Promise(resolve => { finish = resolve; });
  });
  let settled = 0;
  const ids = Array.from({ length: 64 }, (_, i) => `media-${i}`);
  const pending = [...ids, ids[0]].map(id => remove(id).then(() => settled++));
  await Promise.resolve();
  assert.deepEqual(calls, [{ assetIds: ids }]);
  assert.equal(settled, 0);
  finish();
  await Promise.all(pending);
  assert.equal(settled, 65);
});

test('requests during an in-flight batch are not lost or resolved by the earlier batch', async () => {
  const batches = [];
  const remove = createAssetRemovalBatch(options => new Promise(resolve => batches.push({ options, resolve })));
  const first = remove('first');
  await Promise.resolve();
  let secondDone = false;
  const second = remove('second').then(() => { secondDone = true; });
  await Promise.resolve();
  assert.deepEqual(batches.map(b => b.options.assetIds), [['first'], ['second']]);
  batches[0].resolve(); await first;
  assert.equal(secondDone, false);
  batches[1].resolve(); await second;
});

test('failed cleanup rejects all affected callers and a later request can retry', async () => {
  const failure = new Error('transaction failed');
  let fail = true;
  const remove = createAssetRemovalBatch(() => {
    if (fail) throw failure;
    return { assets: ['a'] };
  });
  const result = await Promise.allSettled([remove('a'), remove('b')]);
  assert.ok(result.every(r => r.status === 'rejected' && r.reason === failure));
  fail = false;
  assert.deepEqual(await remove('a'), { assets: ['a'] });
});
