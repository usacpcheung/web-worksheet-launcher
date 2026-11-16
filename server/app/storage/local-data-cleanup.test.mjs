import test from 'node:test';
import assert from 'node:assert/strict';
import { planLocalCleanup, recordStamp, assetStamp } from './local-data-cleanup.js';
const attempt = (id, image, source) => ({ localId: id, sourceImportedWorksheetId: source, viewerPayload: { blocks: [{ prompt: { mediaRefs: [{ assetId: image }] } }] }, answers: {} });
const asset = id => ({ localId: id, binary: new Uint8Array(100), metadata: { updatedAt: '2020-01-01T00:00:00Z' } });
const empty = () => ({ drafts: [], worksheets: [], attempts: [], assets: [] });
test('replacing A reclaims its unique media but retains media shared by B or an editor draft', () => {
  const a = attempt('a', 'shared'), b = attempt('b', 'shared'); a.answers.photo = { value: [{ assetId: 'owned-a' }] };
  const data = { ...empty(), drafts: [{ blocks: [{ mediaRefs: [{ assetId: 'draft-image' }] }] }], attempts: [a, b], assets: ['shared','owned-a','draft-image'].map(asset) };
  const result = planLocalCleanup(data, { candidates: { a: recordStamp(a) }, currentId: 'b', assetIds: ['draft-image'] });
  assert.deepEqual(result.attempts.map(a => a.localId), ['a']);
  assert.deepEqual(result.assets.map(a => a.localId), ['owned-a']);
});
test('active, current and changed attempts are retained even when previously approved', () => {
  const a = attempt('a', 'a'), b = attempt('b', 'b'), c = attempt('c', 'c');
  const candidates = Object.fromEntries([a,b,c].map(a => [a.localId, recordStamp(a)]));
  c.answers.q = { value: 'New work' };
  const result = planLocalCleanup({ ...empty(), attempts: [a,b,c], assets: ['a','b','c'].map(asset) }, { candidates, currentId: 'a', protectedIds: ['b'] });
  assert.equal(result.attempts.length, 0); assert.equal(result.assets.length, 0);
});
test('source worksheet is retained until its last attempt is removed', () => {
  const a = attempt('a', 'image', 'source'), b = attempt('b', 'image', 'source');
  const worksheet = { localId: 'source', worksheet: { image: { assetId: 'image' } } };
  const data = { ...empty(), attempts: [a,b], worksheets: [worksheet], assets: [asset('image')] };
  const first = planLocalCleanup(data, { candidates: { a: recordStamp(a) } });
  assert.equal(first.worksheets.length, 0); assert.equal(first.assets.length, 0);
  const both = planLocalCleanup(data, { candidates: { a: recordStamp(a), b: recordStamp(b) } });
  assert.equal(both.worksheets.length, 1); assert.equal(both.assets.length, 1);
});
test('manual cleanup cannot delete orphan data introduced after the review', () => {
  const a = asset('a'), b = asset('b');
  const result = planLocalCleanup({ ...empty(), assets: [a,b] }, { orphanCutoff: Date.now(), approvedAssets: { a: assetStamp(a) }, approvedWorksheets: {} });
  assert.deepEqual(result.assets.map(a => a.localId), ['a']);
});
test('editor removal waits for a persisted reference to disappear before reclaiming bytes', () => {
  const image = asset('image'); image.metadata.pendingRemoval = true;
  const data = { ...empty(), drafts: [{ assets: [{ assetId: 'image' }] }], assets: [image] };
  assert.equal(planLocalCleanup(data).assets.length, 0);
  data.drafts = [];
  assert.equal(planLocalCleanup(data).assets.length, 1);
});
