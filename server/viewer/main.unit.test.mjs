import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function loadViewerModule(overrides = {}) {
  const filePath = path.resolve('server/viewer/main.js');
  let source = await fs.readFile(filePath, 'utf8');

  source = source.replace(
    "import { viewerStorage } from './storage/index.js';\nimport { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';\nimport { validateViewerPayloadSchema } from '../app/contracts/validators.js';\nimport { SharedAuthGate } from '../app/auth/shared-auth-gate.js';\n",
    'const viewerStorage = {};\nconst mapSnapshotToViewerPayload = globalThis.__mapSnapshotToViewerPayload;\nconst validateViewerPayloadSchema = (p) => ({ valid: true, errors: [] });\nconst SharedAuthGate = class {};\n'
  );

  source = source.replace(
    /bootstrapViewer\(\)\.catch\([\s\S]*?\);\n\nexport \{\n  ViewerAttemptSession,\n  normalizeViewerPayload,\n  resolveImportedWorksheetPayload,\n  normalizeViewerBlock,\n  computeAnswerSummary,\n  partitionBlocksForDisplay,\n  getInputHelperText,\n\};/,
    'export { ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock, computeAnswerSummary, partitionBlocksForDisplay, getInputHelperText };'
  );

  globalThis.__mapSnapshotToViewerPayload = overrides.mapSnapshotToViewerPayload || ((v) => v);
  globalThis.document = { getElementById: () => null };
  globalThis.window = {};

  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  return import(dataUrl);
}

test('resolveImportedWorksheetPayload falls back when snapshot mapping fails', async () => {
  const mod = await loadViewerModule({
    mapSnapshotToViewerPayload: () => {
      throw new Error('invalid snapshot');
    },
  });

  const payload = mod.resolveImportedWorksheetPayload({
    localId: 'imported_1',
    worksheet: {
      worksheetId: 'ws_1',
      snapshotId: 'snap_1',
      schemaVersion: 1,
      publishedAt: 'not-iso',
      title: 'Imported worksheet',
      blocks: [
        {
          blockId: 'b1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Q1' },
          responseConfig: {},
        },
      ],
    },
  });

  assert.equal(payload.title, 'Imported worksheet');
  assert.equal(payload.blocks.length, 1);
});

test('resolveImportedWorksheetPayload does not treat draftWorksheetId-only payload as snapshot', async () => {
  const mod = await loadViewerModule({
    mapSnapshotToViewerPayload: () => {
      throw new Error('should not be called for draft import');
    },
  });

  const payload = mod.resolveImportedWorksheetPayload({
    localId: 'imported_2',
    worksheet: {
      draftWorksheetId: 'draft_1',
      title: 'Draft import',
      blocks: [{ blockId: 'b1', kind: 'content', position: 0, content: { text: 'Hello' } }],
    },
  });

  assert.equal(payload.title, 'Draft import');
  assert.equal(payload.blocks.length, 1);
});

test('normalizeViewerPayload tolerates malformed blocks and coerces unknown kind', async () => {
  const mod = await loadViewerModule();

  const payload = mod.normalizeViewerPayload({
    blocks: [null, 'bad', { blockId: 'x', kind: 'custom', position: 2 }],
  });

  assert.equal(payload.blocks.length, 3);
  assert.equal(payload.blocks[0].kind, 'content');
  assert.equal(payload.blocks[1].kind, 'content');
  assert.equal(payload.blocks[2].kind, 'content');
});

test('normalizeViewerBlock preserves and normalizes single_choice options', async () => {
  const mod = await loadViewerModule();
  const normalized = mod.normalizeViewerBlock({
    blockId: 'q1',
    kind: 'question',
    position: 0,
    prompt: { text: 'Choose one' },
    responseConfig: {
      inputType: 'single_choice',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b' },
        'c',
        null,
      ],
    },
  }, 0);

  assert.equal(normalized.responseConfig.inputType, 'single_choice');
  assert.deepEqual(normalized.responseConfig.options, [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'b' },
    { value: 'c', label: 'c' },
  ]);
});

test('completeLocalAttempt clears pending autosave timer before immediate autosave', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.localAttemptId = 'attempt_1';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };

  let timerFired = false;
  let autosaveCalls = 0;
  session.autosaveTimer = setTimeout(() => {
    timerFired = true;
  }, 10);

  session.autosave = async () => {
    autosaveCalls += 1;
    return { ok: true };
  };

  await session.completeLocalAttempt();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(session.autosaveTimer, null);
  assert.equal(autosaveCalls, 1);
  assert.equal(timerFired, false);
});

test('partitionBlocksForDisplay returns ordered content and question sets', async () => {
  const mod = await loadViewerModule();
  const result = mod.partitionBlocksForDisplay([
    { blockId: 'q2', kind: 'question', position: 2 },
    { blockId: 'c1', kind: 'content', position: 0 },
    { blockId: 'q1', kind: 'question', position: 1 },
  ]);

  assert.deepEqual(result.contentBlocks.map((b) => b.blockId), ['c1']);
  assert.deepEqual(result.questionBlocks.map((b) => b.blockId), ['q1', 'q2']);
});

test('computeAnswerSummary counts only question blocks with non-empty answers', async () => {
  const mod = await loadViewerModule();
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'c1', kind: 'content' },
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
      ],
    },
    {
      q1: { value: 'hello' },
      q2: { value: '' },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 2 });
});

test('computeAnswerSummary treats whitespace-only answers as unanswered', async () => {
  const mod = await loadViewerModule();
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
        { blockId: 'q3', kind: 'question' },
      ],
    },
    {
      q1: { value: '   ' },
      q2: { value: '\t\n' },
      q3: { value: 'real answer' },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 3 });
});

test('getInputHelperText maps input types to guidance', async () => {
  const mod = await loadViewerModule();
  assert.equal(mod.getInputHelperText('number'), 'Numeric answer only.');
  assert.equal(mod.getInputHelperText('single_choice'), 'Choose one option.');
  assert.equal(mod.getInputHelperText('plain_text'), 'Long-form text response.');
});
