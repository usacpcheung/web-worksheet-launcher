import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAttemptPackage } from './attempt-package-validator.js';
const fixture = () => [
  { format: 'worksheet-attempt-package', packageVersion: 1 },
  { blocks: [{ blockId: 'q', kind: 'question', prompt: { text: 'Q' }, responseConfig: { inputType: 'text' } }] },
  { schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers: { q: { value: 'Answer' } } },
];
test('upload and reader boundary rejects missing or empty embedded worksheets', () => {
  for (const worksheet of [null, {}, { blocks: [] }]) {
    const args = fixture(); args[1] = worksheet;
    assert.throws(() => assertAttemptPackage(...args), /at least one block/);
    assert.throws(() => assertAttemptPackage(...args, { allowLegacyEnvelope: true }), /at least one block/);
  }
});
test('server envelope requirements remain stricter than compatible local imports', () => {
  const args = fixture();
  args[1].blocks = [{ id: 'q', kind: 'short_text' }]; args[2].answers.q = 'Legacy';
  assert.doesNotThrow(() => assertAttemptPackage(...args));
  delete args[2].kind; delete args[2].schemaVersion;
  assert.doesNotThrow(() => assertAttemptPackage(...args, { allowLegacyEnvelope: true }));
  assert.throws(() => assertAttemptPackage(...args));
  args[2] = { status: 'submitted' }; // Reader historically supplies missing answers/timestamps.
  assert.doesNotThrow(() => assertAttemptPackage(...args, { allowLegacyEnvelope: true }));
});
test('legacy answer coercion remains available while unknown checking IDs fail uploads', () => {
  const args = fixture(); args[1].blocks[0].responseConfig.inputType = 'number';
  args[2].answers.q.value = '1.0';
  assert.doesNotThrow(() => assertAttemptPackage(...args));
  assert.doesNotThrow(() => assertAttemptPackage(...args, { allowLegacyEnvelope: true }));
  args[2].checking = { items: { unknown: { result: 'correct' } } };
  assert.throws(() => assertAttemptPackage(...args), /unknown blockId/);
});

test('v1/v2 restore budgets count media aliases while preserving optional assets and large unique files', () => {
  const args = fixture();
  const path = 'media/voice';
  const assets = [{ assetId: 'a', path }, { assetId: 'b', path }, { assetId: 'optional', path: 'media/missing' }];
  // Only lengths enter the contract check, so the fixture needs no large allocation.
  const file = { byteLength: 15 * 1024 * 1024 };
  const files = new Map([[path, file]]);
  for (const version of [1, 2]) {
    args[0] = { ...args[0], packageVersion: version, assets };
    for (const allowLegacyEnvelope of [true, false]) {
      file.byteLength = 15 * 1024 * 1024;
      assert.doesNotThrow(() => assertAttemptPackage(...args, { files, allowLegacyEnvelope }));
      file.byteLength += 1;
      assert.throws(() => assertAttemptPackage(...args, { files, allowLegacyEnvelope }), /restore size limit/);
    }
    file.byteLength = 31 * 1024 * 1024;
    assert.doesNotThrow(() => assertAttemptPackage({ ...args[0], assets: [assets[0]] }, args[1], args[2], { files }));
  }
});
