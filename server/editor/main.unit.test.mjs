import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function loadEditorModule() {
  const filePath = path.resolve('server/editor/main.js');
  let source = await fs.readFile(filePath, 'utf8');

  source = source.replace(
    "import { editorStorage } from './storage/index.js';\nimport { SharedAuthGate } from '../app/auth/shared-auth-gate.js';\n",
    'const editorStorage = {};\nconst SharedAuthGate = class {};\n'
  );

  source = source.replace(
    /async function loadContracts\(\) \{[\s\S]*?\n\}\n\nfunction createDefaultBlock/,
    `async function loadContracts() {
  return {
    validateDraftSchema() {
      return { valid: true, errors: [] };
    },
  };
}

function createDefaultBlock`
  );

  source = source.replace(
    /bootstrapEditor\(\)\.catch\([\s\S]*?\);\n\nexport \{[\s\S]*?\};/,
    'export { EditorDraftSession, createDraftRecord, normalizeBlocks, validateWorksheet, createDefaultBlock, buildViewerUrlFromCurrentLocation };'
  );

  globalThis.document = { getElementById: () => null, activeElement: null };
  globalThis.window = { location: { hash: '#fallback' }, scrollY: 200 };

  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  return import(dataUrl);
}

function createStorageStub() {
  return {
    drafts: {
      get: async () => null,
      put: async (value) => value,
    },
    importedWorksheets: {
      put: async () => {},
    },
    resumeFlags: {
      get: () => null,
      set: () => {},
    },
  };
}

test('add/remove/reorder blocks works for multi-block worksheet', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createStorageStub());
  await session.createOrOpenByLocalDraftId('draft_blocks');
  clearTimeout(session.autosaveTimer);

  const a = session.addBlock('text_input');
  const b = session.addBlock('numeric');
  clearTimeout(session.autosaveTimer);
  assert.equal(session.state.draft.worksheet.blocks.length, 3);

  session.reorderBlock(b.id, 'up');
  clearTimeout(session.autosaveTimer);
  const order = session.state.draft.worksheet.blocks.map((block) => block.id);
  assert.equal(order[1], b.id);

  session.removeBlock(a.id);
  clearTimeout(session.autosaveTimer);
  assert.equal(session.state.draft.worksheet.blocks.some((block) => block.id === a.id), false);
});

test('per-type settings persist for text, multiple choice, and numeric', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createStorageStub());
  await session.createOrOpenByLocalDraftId('draft_types');
  clearTimeout(session.autosaveTimer);

  session.updateSelectedBlockType('text_input');
  session.updateSelectedConfig({ placeholder: 'Type answer', maxLength: 120, multiline: true });
  clearTimeout(session.autosaveTimer);

  const mc = session.addBlock('multiple_choice');
  session.selectBlock(mc.id);
  session.updateChoiceOption(0, 'A');
  session.updateChoiceOption(1, 'B');
  session.updateSelectedConfig({ allowMultiple: true, shuffle: true });
  clearTimeout(session.autosaveTimer);

  const numeric = session.addBlock('numeric');
  session.selectBlock(numeric.id);
  session.updateSelectedConfig({ min: 0, max: 10, step: 2, integerOnly: true, unitLabel: 'kg' });
  clearTimeout(session.autosaveTimer);

  const blocks = session.state.draft.worksheet.blocks;
  assert.deepEqual(blocks[0].config, { placeholder: 'Type answer', maxLength: 120, multiline: true });
  assert.deepEqual(blocks[1].config, { options: ['A', 'B'], allowMultiple: true, shuffle: true });
  assert.deepEqual(blocks[2].config, { min: 0, max: 10, step: 2, integerOnly: true, unitLabel: 'kg' });
});

test('import/export schema handling supports legacy mapping and roundtrip shape', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createStorageStub());
  await session.createOrOpenByLocalDraftId('draft_import');
  clearTimeout(session.autosaveTimer);

  const legacyPayload = {
    title: 'Legacy',
    blocks: [
      { blockId: 'q1', kind: 'question', prompt: { text: 'Pick one' }, responseConfig: { inputType: 'single_choice', options: [{ value: 'X' }, { value: 'Y' }] } },
      { blockId: 'q2', kind: 'question', prompt: { text: 'Amount' }, responseConfig: { inputType: 'number' } },
    ],
  };

  await session.importWorksheetJson(JSON.stringify(legacyPayload), { convertToEditableDraft: true });
  clearTimeout(session.autosaveTimer);

  assert.equal(session.state.draft.schemaVersion, 2);
  assert.equal(session.state.draft.worksheet.blocks[0].type, 'multiple_choice');
  assert.equal(session.state.draft.worksheet.blocks[1].type, 'numeric');

  const exported = {
    schemaVersion: 2,
    worksheet: session.state.draft.worksheet,
  };
  const restored = session.parseImportedWorksheet(exported);
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.worksheet.blocks.length, 2);
});

test('autosave/restore supports multiple blocks and status transitions', async () => {
  const persisted = new Map();
  const storage = createStorageStub();
  storage.drafts.put = async (value) => {
    persisted.set(value.localId, structuredClone(value));
    return value;
  };
  storage.drafts.get = async (id) => persisted.get(id) || null;

  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(storage);
  await session.createOrOpenByLocalDraftId('draft_restore');
  clearTimeout(session.autosaveTimer);

  session.addBlock('numeric');
  session.updateSelectedPrompt('How many?');
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  assert.equal(session.state.lastAutosaveStatus === 'saved' || session.state.lastAutosaveStatus === 'saved_with_warnings', true);

  const restoreSession = new mod.EditorDraftSession(storage);
  await restoreSession.createOrOpenByLocalDraftId('draft_restore');
  clearTimeout(restoreSession.autosaveTimer);
  assert.equal(restoreSession.state.draft.worksheet.blocks.length >= 2, true);
});

test('validation gates export and reports actionable reasons', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createStorageStub());
  await session.createOrOpenByLocalDraftId('draft_validate');
  clearTimeout(session.autosaveTimer);

  session.updateSelectedBlockType('multiple_choice');
  session.updateSelectedPrompt('Choose');
  session.updateChoiceOption(0, '');
  session.updateChoiceOption(1, '');
  clearTimeout(session.autosaveTimer);

  const validation = session.validateCurrentDraft();
  assert.equal(validation.valid, false);
  assert.throws(() => session.exportCurrentDraftToFile(), /Export blocked:/);
});

test('buildViewerUrlFromCurrentLocation uses sibling viewer path', async () => {
  const mod = await loadEditorModule();
  const resolved = mod.buildViewerUrlFromCurrentLocation('https://example.test/server/editor/index.html', 'draft_x');
  assert.equal(resolved.toString(), 'https://example.test/server/viewer/?localDraftId=draft_x');
});
