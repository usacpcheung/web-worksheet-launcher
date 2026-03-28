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
    /bootstrapViewer\(\)\.catch\([\s\S]*?\);\n\nexport \{ ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock \};/,
    'export { ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock };'
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

test('setAnswer keeps input-type coercion behavior for number and boolean questions', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.viewerPayload = {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    blocks: [
      { blockId: 'q_num', kind: 'question', position: 0, prompt: { text: 'How many?' }, responseConfig: { inputType: 'number' } },
      { blockId: 'q_bool', kind: 'question', position: 1, prompt: { text: 'True?' }, responseConfig: { inputType: 'boolean' } },
    ],
  };

  session.setAnswer('q_num', '42');
  session.setAnswer('q_bool', 'false');

  assert.equal(session.state.answers.q_num.value, 42);
  assert.equal(session.state.answers.q_bool.value, false);
});

test('normalizeViewerBlock keeps text maxLength defaults for plain/short text question types', async () => {
  const mod = await loadViewerModule();
  const plain = mod.normalizeViewerBlock({
    blockId: 'q_plain',
    kind: 'question',
    position: 0,
    prompt: { text: 'Describe' },
    responseConfig: { inputType: 'plain_text' },
  }, 0);
  const short = mod.normalizeViewerBlock({
    blockId: 'q_short',
    kind: 'question',
    position: 1,
    prompt: { text: 'Name' },
    responseConfig: { inputType: 'short_text', maxLength: 32 },
  }, 1);

  assert.equal(plain.responseConfig.inputType, 'plain_text');
  assert.equal(plain.responseConfig.maxLength, 1000);
  assert.equal(short.responseConfig.inputType, 'short_text');
  assert.equal(short.responseConfig.maxLength, 32);
});
