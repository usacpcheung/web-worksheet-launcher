import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeedbackConfig,
  assertFeedbackConfig,
  assertFeedbackResponses,
  feedbackVoiceTargets,
} from './worksheet-feedback.js';
import {
  createWorksheetPackageFromDraft,
  parseWorksheetPackage,
} from '../editor/worksheet-package.js';
import {
  createStoredZip,
  parseStoredZip,
  decodeUtf8,
} from '../editor/zip-utils.js';
import { assertAttemptPackage } from './contracts/attempt-package-validator.js';
const config = () => {
  const c = createFeedbackConfig('target');
  c.enabled = true;
  c.targets[0].text = 'Explain a choice';
  return c;
};
const block = {
  blockId: 'q',
  kind: 'question',
  position: 0,
  prompt: { text: 'Explain' },
  responseConfig: { inputType: 'text', maxLength: 200 },
};
test('feedback settings round-trip independently and legacy worksheets retain their version', () => {
  const draft = {
    title: 'Fixture',
    localId: 'draft',
    blocks: [block],
    feedback: config(),
  };
  const pkg = createWorksheetPackageFromDraft(draft);
  assert.equal(pkg.manifest.packageVersion, 9);
  draft.feedback.targets[0].text = 'Changed later';
  assert.equal(
    parseWorksheetPackage(pkg.bytes).worksheet.feedback.targets[0].text,
    'Explain a choice',
  );
  const legacy = createWorksheetPackageFromDraft({
    ...draft,
    feedback: undefined,
  });
  assert.equal(legacy.manifest.packageVersion, 2);
  assert.equal(
    parseWorksheetPackage(legacy.bytes).worksheet.feedback,
    undefined,
  );
  const files = parseStoredZip(pkg.bytes),
    manifest = JSON.parse(decodeUtf8(files.get('manifest.json')));
  manifest.packageVersion = 8;
  manifest.schemaVersion = 8;
  files.set('manifest.json', JSON.stringify(manifest));
  assert.throws(
    () =>
      parseWorksheetPackage(
        createStoredZip([...files].map(([path, data]) => ({ path, data }))),
      ),
    /version 9/,
  );
});
test('feedback rejects invalid targets, limits and categories while allowing text-only and disabled drafts', () => {
  for (const mutate of [
    (c) => (c.categories = []),
    (c) => c.categories.push('teacher'),
    (c) => c.categories.push('admin'),
    (c) => c.targets.push({ ...c.targets[0] }),
    (c) => (c.targets[0].id = '__proto__'),
    (c) => (c.targets[0].text = ''),
    (c) => (c.targets[0].text = 'x'.repeat(201)),
    (c) =>
      (c.targets = Array.from({ length: 6 }, (_, i) => ({
        id: 't' + i,
        text: 'Target',
      }))),
    (c) => (c.text.student.limit = 1201),
    (c) => (c.text.student.limit = 1.5),
    (c) => (c.text.teacher.prompt = 'x'.repeat(501)),
  ]) {
    const c = config();
    mutate(c);
    assert.throws(() => assertFeedbackConfig(c));
  }
  const c = config();
  c.assessment = false;
  c.targets = [];
  c.categories = [];
  assert.doesNotThrow(() => assertFeedbackConfig(c));
  c.text.student.enabled = c.text.teacher.enabled = false;
  assert.throws(() => assertFeedbackConfig(c));
  c.enabled = false;
  assert.doesNotThrow(() => assertFeedbackConfig(c));
  assert.doesNotThrow(() => assertFeedbackConfig(undefined));
});
test('responses are optional, unscored, tied to enabled targets and accepted only after submission', () => {
  const c = config(),
    r = {
      ratings: { target: { student: 5 } },
      text: { student: 'A reflection' },
    };
  assert.doesNotThrow(() => assertFeedbackResponses(c, r, 'submitted'));
  for (const status of ['checked', 'completed'])
    assert.doesNotThrow(() => assertFeedbackResponses(c, r, status));
  assert.throws(() => assertFeedbackResponses(c, r, 'in_progress'));
  assert.throws(() =>
    assertFeedbackResponses({ ...c, enabled: false }, r, 'completed'),
  );
  for (const next of [
    { ratings: { target: { student: 0 } }, text: {} },
    { ratings: { unknown: { teacher: 1 } }, text: {} },
    { ratings: { target: { peer: 3 } }, text: {} },
    { ratings: {}, text: { teacher: 'x'.repeat(201) } },
    { ratings: {}, text: { peer: 'No' } },
  ])
    assert.throws(() => assertFeedbackResponses(c, next, 'submitted'));
  assert.doesNotThrow(() =>
    assertFeedbackResponses(c, { ratings: {}, text: {} }, 'in_progress'),
  );
  const manifest = {
    format: 'worksheet-attempt-package',
    packageVersion: 8,
    schemaVersion: 1,
    assets: [],
  };
  const attempt = {
    kind: 'worksheet-attempt',
    schemaVersion: 1,
    status: 'submitted',
    submittedAt: new Date().toISOString(),
    answers: { q: { value: 'Original' } },
    feedback: r,
  };
  assert.doesNotThrow(() =>
    assertAttemptPackage(manifest, { blocks: [block], feedback: c }, attempt),
  );
  assert.throws(
    () =>
      assertAttemptPackage(
        { ...manifest, packageVersion: 7 },
        { blocks: [block], feedback: c },
        attempt,
      ),
    /version 8/,
  );
  assert.throws(() =>
    assertAttemptPackage(manifest, { blocks: [block] }, attempt),
  );
});
test('feedback voice identities cannot alias real questions', () => {
  const payload = {
    feedback: config(),
    blocks: [
      { ...block, blockId: '@feedback/student' },
      { ...block, blockId: '@@feedback/student' },
    ],
  };
  const targets = feedbackVoiceTargets(payload);
  assert.equal(targets[0].blockId, '@@@feedback/student');
  assert.equal(targets[0].responseConfig.maxLength, 200);
  assert.equal(targets[0].responseConfig.feedbackTarget, 'student');
});
