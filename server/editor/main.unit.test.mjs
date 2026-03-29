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
    /async function loadContracts\(\) \{[\s\S]*?\n\}\n\nfunction createEmptyQuestionBlock/,
    `async function loadContracts() {
  return {
    validateDraftSchema(draft) {
      const errors = [];
      if (!draft || typeof draft !== 'object') {
        return { valid: false, errors: ['draft must be object'] };
      }
      if (!Array.isArray(draft.blocks) || draft.blocks.length === 0) {
        errors.push('draft.blocks must be a non-empty array');
      } else {
        draft.blocks.forEach((block, index) => {
          if (block.kind === 'question' && !String(block?.prompt?.text || '').trim()) {
            errors.push(\`draft.blocks[\${index}].prompt.text is required for question blocks\`);
          }
          if (block.kind === 'content' && !String(block?.content?.text || '').trim()) {
            errors.push(\`draft.blocks[\${index}].content.text is required for content blocks\`);
          }
        });
      }
      return { valid: errors.length === 0, errors };
    },
  };
}

function createEmptyQuestionBlock`
  );

  source = source.replace(
    /bootstrapEditor\(\)\.catch\([\s\S]*?\);\n\nexport \{[^}]+\};/,
    'export { EditorDraftSession, createDraftRecord, normalizeBlocks, mapOptionsTextToResponseOptions, buildViewerUrlFromCurrentLocation };'
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
      responseConfig: { inputType: 'plain_text', maxLength: 42, displayMode: 'single_line' },
      extraField: 'keep-me',
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'question');
  assert.deepEqual(blocks[0].responseConfig, { inputType: 'text', maxLength: 42, displayMode: 'single_line' });
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

test('localDraftId render path avoids innerHTML interpolation for untrusted ids', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('localDraftIdEl.innerHTML'), false);
  assert.equal(source.includes("localDraftIdLabel.textContent = 'localDraftId:';"), true);
  assert.equal(source.includes("localDraftIdValue.textContent = session.state.draft?.localId || 'n/a';"), true);
});

test('autosave completion emits state updates and clears pending state without extra UI events', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  let emissions = 0;
  session.setOnStateChange(() => {
    emissions += 1;
  });

  await session.createOrOpenByLocalDraftId('draft_status');
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  assert.equal(session.state.autosavePending, false);
  assert.ok(emissions >= 2, 'expected state emissions for pending + completion transitions');
});

test('new question transient prompt validation is suppressed during first autosave', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_transient');
  clearTimeout(session.autosaveTimer);
  const firstBlock = session.state.draft.blocks[0];
  session.updateBlockContent(firstBlock.blockId, 'intro text');
  clearTimeout(session.autosaveTimer);

  const question = session.createBlock('question');
  clearTimeout(session.autosaveTimer);
  session.state.isPristineDraft = false;
  await session.autosave();

  assert.equal(session.state.lastSavedLocalValidationIssueCount > 0, true);
  assert.equal(session.state.lastContractValidationIssueCount > 0, true);
  assert.equal(session.state.lastValidationWarning, null, 'transient empty prompt warning should be suppressed');

  session.updateBlockContent(question.blockId, 'typed prompt');
  clearTimeout(session.autosaveTimer);
  await session.autosave();
  assert.equal(session.state.lastValidationWarning, null);
});

test('older autosave completion cannot override newer save status', async () => {
  const mod = await loadEditorModule();
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const first = deferred();
  const second = deferred();
  let putCall = 0;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        putCall += 1;
        if (putCall === 1) {
          await first.promise;
          return value;
        }
        await second.promise;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_race');
  clearTimeout(session.autosaveTimer);
  session.updateBlockContent(session.state.draft.blocks[0].blockId, 'intro text');
  clearTimeout(session.autosaveTimer);
  const q = session.createBlock('question');
  clearTimeout(session.autosaveTimer);
  session.state.isPristineDraft = false;

  const save1 = session.autosave(); // invalid (empty question)
  session.updateBlockContent(q.blockId, 'now valid');
  clearTimeout(session.autosaveTimer);
  const newerRevision = session.state.draftRevision;
  const save2 = session.autosave(); // valid

  second.resolve();
  await save2;
  first.resolve();
  await save1;

  assert.equal(session.state.lastSavedRevision, newerRevision);
  assert.equal(session.state.lastValidationWarning, null);
  assert.equal(session.state.lastSavedLocalValidationIssueCount, 0);
  assert.equal(session.state.lastContractValidationIssueCount, 0);
});

test('viewer navigation no longer uses hardcoded /viewer absolute assign path', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("window.location.assign(`/viewer/?localDraftId=${encodeURIComponent(localDraftId)}`);"), false);
  assert.equal(source.includes('buildViewerUrlFromCurrentLocation(window.location.href, localDraftId)'), true);
  assert.equal(source.includes("new URL('../viewer/', currentHref)"), true);
});

test('buildViewerUrlFromCurrentLocation resolves sibling viewer route from current page', async () => {
  const mod = await loadEditorModule();
  const rootResolved = mod.buildViewerUrlFromCurrentLocation('https://example.test/editor/', 'draft_root');
  assert.equal(rootResolved.toString(), 'https://example.test/viewer/?localDraftId=draft_root');

  const nestedResolved = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/server/editor/index.html?mode=edit#section',
    'draft_nested'
  );
  assert.equal(nestedResolved.toString(), 'https://example.test/server/viewer/?localDraftId=draft_nested');
});

test('mapOptionsTextToResponseOptions maps trimmed non-empty lines', async () => {
  const mod = await loadEditorModule();
  const mapped = mod.mapOptionsTextToResponseOptions('  Alpha\n\nBeta  \n Gamma ');
  assert.deepEqual(mapped, [
    { value: 'Alpha', label: 'Alpha' },
    { value: 'Beta', label: 'Beta' },
    { value: 'Gamma', label: 'Gamma' },
  ]);
});

test('question field updates map inputType, maxLength, and options through draft blocks', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_q');
  const block = session.createBlock('question');
  session.selectBlock(block.blockId);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionOptionsFromText(block.blockId, 'One\nTwo');
  session.updateQuestionInputType(block.blockId, 'text');
  session.updateQuestionMaxLength(block.blockId, '25');

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.inputType, 'text');
  assert.equal(updated.responseConfig.maxLength, 25);
  assert.equal(updated.responseConfig.options, undefined);
});

test('text response normalization removes stale numeric constraints', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Explain' },
      responseConfig: {
        inputType: 'text',
        maxLength: 120,
        displayMode: 'single_line',
        min: 1,
        max: 10,
        step: 2,
      },
    },
  ]);

  assert.deepEqual(blocks[0].responseConfig, {
    inputType: 'text',
    maxLength: 120,
    displayMode: 'single_line',
  });
});

test('normalizeBlocks migrates single_choice to multiple_choice and preserves options', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Choose?' },
      responseConfig: {
        inputType: 'single_choice',
        options: [{ value: 'a', label: 'A' }],
      },
    },
  ]);
  assert.equal(blocks[0].responseConfig.inputType, 'multiple_choice');
  assert.equal(blocks[0].responseConfig.selectionMode, 'single');
  assert.deepEqual(blocks[0].responseConfig.options, [{ value: 'a', label: 'A' }]);
});

test('normalizeBlocks keeps only type-compatible correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q_bool',
      kind: 'question',
      position: 0,
      prompt: { text: 'True?' },
      responseConfig: { inputType: 'boolean', correctAnswer: true },
    },
    {
      blockId: 'q_number',
      kind: 'question',
      position: 1,
      prompt: { text: 'How many?' },
      responseConfig: { inputType: 'number', correctAnswer: Number.NaN },
    },
    {
      blockId: 'q_multi',
      kind: 'question',
      position: 2,
      prompt: { text: 'Pick many' },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'multi',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        correctAnswer: ['a', 'b', 'a', 'x', 5],
      },
    },
    {
      blockId: 'q_malformed',
      kind: 'question',
      position: 3,
      prompt: { text: 'Broken options' },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'single',
        options: [null],
        correctAnswer: 'option_0',
      },
    },
  ]);

  assert.equal(blocks[0].responseConfig.correctAnswer, true);
  assert.equal(Object.hasOwn(blocks[1].responseConfig, 'correctAnswer'), false);
  assert.deepEqual(blocks[2].responseConfig.correctAnswer, ['a', 'b']);
  assert.equal(Object.hasOwn(blocks[3].responseConfig, 'correctAnswer'), false);
});

test('changing inputType or selectionMode re-normalizes/coerces correctAnswer', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_answer_key');
  const block = session.createBlock('question');

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'single',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: 'a',
        },
      }
      : entry
  ));

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['a']);

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: ['a', 'b'],
        },
      }
      : entry
  ));

  session.updateQuestionInputType(block.blockId, 'text');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('selectionMode coercion keeps first valid value when switching multi to single', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_selection_coerce');
  const block = session.createBlock('question');

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: ['x', 'b', 'a'],
        },
      }
      : entry
  ));

  session.updateQuestionSelectionMode(block.blockId, 'single');
  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'b');
});

test('option mutations prune correctAnswer values not present in options', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_option_prune');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB\nC');
  session.updateQuestionCorrectAnswerChoices(block.blockId, ['A', 'C']);
  session.updateQuestionOptionAtIndex(block.blockId, 2, 'D');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A']);

  session.updateQuestionCorrectAnswerChoices(block.blockId, ['A', 'B']);
  session.removeQuestionOption(block.blockId, 0);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B']);

  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionCorrectAnswerChoice(block.blockId, 'B');
  session.updateQuestionOptionsFromText(block.blockId, 'X\nY');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('input type transitions clear incompatible correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_type_transition');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'boolean');
  session.updateQuestionCorrectAnswerBoolean(block.blockId, 'true');
  session.updateQuestionInputType(block.blockId, 'number');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);

  session.updateQuestionCorrectAnswerNumber(block.blockId, '2');
  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('question number config and multiple choice settings update through helpers', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_number_config');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionNumberConfig(block.blockId, 'min', '1');
  session.updateQuestionNumberConfig(block.blockId, 'max', '10');
  session.updateQuestionNumberConfig(block.blockId, 'step', '0.5');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(
    { min: updated.responseConfig.min, max: updated.responseConfig.max, step: updated.responseConfig.step },
    { min: 1, max: 10, step: 0.5 }
  );

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionShuffleOptions(block.blockId, true);
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.inputType, 'multiple_choice');
  assert.equal(updated.responseConfig.selectionMode, 'multi');
  assert.equal(updated.responseConfig.shuffleOptions, true);
  assert.deepEqual(updated.responseConfig.options, [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
});

test('question correctAnswer helpers update typed answer keys', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_correct_answer_controls');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'boolean');
  session.updateQuestionCorrectAnswerBoolean(block.blockId, 'true');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, true);

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionCorrectAnswerNumber(block.blockId, '4.5');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 4.5);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  session.updateQuestionCorrectAnswerChoice(block.blockId, 'B');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'B');

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionCorrectAnswerChoices(block.blockId, ['A', 'B']);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'B']);
});

test('multiple choice option helpers add, update, and remove options', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_option_helpers');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.addQuestionOption(block.blockId);
  session.addQuestionOption(block.blockId);
  session.updateQuestionOptionAtIndex(block.blockId, 0, 'First');
  session.updateQuestionOptionAtIndex(block.blockId, 1, 'Second');
  session.removeQuestionOption(block.blockId, 0);

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.options, [{ value: 'Second', label: 'Second' }]);
});

test('updateQuestionMaxLength preserves existing maxLength on empty or non-numeric input', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_ml');
  const block = session.createBlock('question');
  session.selectBlock(block.blockId);

  session.updateQuestionMaxLength(block.blockId, '200');
  const afterValid = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterValid.responseConfig.maxLength, 200);

  session.updateQuestionMaxLength(block.blockId, '');
  const afterEmpty = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterEmpty.responseConfig.maxLength, 200, 'maxLength should be preserved on empty input');

  session.updateQuestionMaxLength(block.blockId, 'abc');
  const afterNan = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterNan.responseConfig.maxLength, 200, 'maxLength should be preserved on non-numeric input');
});

test('autosave persists normalized contractDraft with typed correctAnswer', async () => {
  const mod = await loadEditorModule();
  let lastPersisted = null;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        lastPersisted = value;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_autosave_answer_key');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  session.updateQuestionCorrectAnswerChoices(block.blockId, ['A', 'B', 'X']);
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  const savedQuestion = lastPersisted.contractDraft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(savedQuestion.responseConfig.correctAnswer, ['A', 'B']);
});

test('importWorksheetJson convert flow preserves normalized correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.importWorksheetJson({
    title: 'Imported',
    blocks: [
      {
        blockId: 'q_import',
        kind: 'question',
        position: 0,
        prompt: { text: 'Pick', format: 'plain_text' },
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'single',
          options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
          correctAnswer: 'A',
        },
      },
    ],
  }, { convertToEditableDraft: true });

  const importedQuestion = session.state.draft.blocks.find((entry) => entry.blockId === 'q_import');
  assert.equal(importedQuestion.responseConfig.correctAnswer, 'A');
});
