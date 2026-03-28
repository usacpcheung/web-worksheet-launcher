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
    /bootstrapEditor\(\)\.catch\([\s\S]*?\);\n\nexport \{ EditorDraftSession, createDraftRecord, normalizeBlocks \};/,
    'export { EditorDraftSession, createDraftRecord, normalizeBlocks };'
  );

  globalThis.document = {
    getElementById: () => null,
    activeElement: null,
  };
  globalThis.window = {
    location: { hash: '#fallback' },
    scrollY: 150,
  };

  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  return import(dataUrl);
}

test('normalizeBlocks preserves question responseConfig and extra fields', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Question?', format: 'markdown' },
      responseConfig: { inputType: 'plain_text', maxLength: 42 },
      extraField: 'keep-me',
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'question');
  assert.deepEqual(blocks[0].responseConfig, { inputType: 'plain_text', maxLength: 42 });
  assert.equal(blocks[0].extraField, 'keep-me');
});

test('normalizeBlocks preserves non-prompt extra fields while normalizing content', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'c1',
      kind: 'content',
      position: 2,
      content: { text: 99, format: '' },
      customMeta: { foo: 'bar' },
    },
  ]);

  assert.equal(blocks[0].kind, 'content');
  assert.equal(blocks[0].content.text, '99');
  assert.equal(blocks[0].content.format, 'plain_text');
  assert.deepEqual(blocks[0].customMeta, { foo: 'bar' });
});

test('persistRestoreMetadata preserves explicit empty hash and zero-like scroll token', async () => {
  const mod = await loadEditorModule();
  let saved = null;

  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: {
      get: () => null,
      set: (_key, value) => {
        saved = value;
      },
    },
  });

  session.state.draft = { localId: 'draft_1', blocks: [] };
  session.state.hash = '';
  session.state.scrollToken = 0;

  session.persistRestoreMetadata();

  assert.equal(saved.hash, '');
  assert.equal(saved.scrollToken, 0);
});

test('importWorksheetJson throws clear parse error for invalid JSON text', async () => {
  const mod = await loadEditorModule();

  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.importWorksheetJson('{not-valid-json', {}),
    /Imported worksheet JSON could not be parsed/
  );
});

test('editor shell no longer relies on 500ms summary interval loop', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('setInterval(updateSummary, 500)'), false);
});

test('question editor transforms input type, maxLength, and options on selected block', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_q');
  session.setSelectedBlockKind('question');

  session.updateSelectedQuestionInputType('short_text');
  session.updateSelectedQuestionMaxLength('120');
  let selected = session.state.draft.blocks.find((b) => b.blockId === session.state.selectedBlockId);
  assert.equal(selected.responseConfig.inputType, 'short_text');
  assert.equal(selected.responseConfig.maxLength, 120);

  session.updateSelectedQuestionInputType('single_choice');
  session.updateSelectedQuestionOptions('Red\nBlue\nGreen');
  selected = session.state.draft.blocks.find((b) => b.blockId === session.state.selectedBlockId);
  assert.equal(selected.responseConfig.inputType, 'single_choice');
  assert.deepEqual(selected.responseConfig.options, [
    { value: 'Red', label: 'Red' },
    { value: 'Blue', label: 'Blue' },
    { value: 'Green', label: 'Green' },
  ]);
});

test('updateBlockContent writes to content and question prompts for selected draft blocks', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_updates');
  const contentBlockId = session.state.selectedBlockId;
  session.updateBlockContent(contentBlockId, 'Intro text');
  let contentBlock = session.state.draft.blocks.find((b) => b.blockId === contentBlockId);
  assert.equal(contentBlock.content.text, 'Intro text');

  session.setSelectedBlockKind('question');
  const questionBlockId = session.state.selectedBlockId;
  session.updateBlockContent(questionBlockId, 'What is your answer?');
  const questionBlock = session.state.draft.blocks.find((b) => b.blockId === questionBlockId);
  assert.equal(questionBlock.prompt.text, 'What is your answer?');
});
