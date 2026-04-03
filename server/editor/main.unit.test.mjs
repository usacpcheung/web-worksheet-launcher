import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rewriteModuleSourceForTests } from '../test-utils/module-source-test-helpers.mjs';

async function loadEditorModule() {
  const filePath = path.resolve('server/editor/main.js');
  const source = await fs.readFile(filePath, 'utf8');

  const rewrittenSource = rewriteModuleSourceForTests(source, [
    {
      name: 'replace editor dependency imports with test doubles',
      pattern: /import\s*\{\s*editorStorage\s*\}\s*from\s*['"]\.\/storage\/index\.js['"];\s*import\s*\{\s*SharedAuthGate\s*\}\s*from\s*['"]\.\.\/app\/auth\/shared-auth-gate\.js['"];\s*import\s*\{\s*createWorksheetPackageFromDraft,\s*mapLegacyJsonToPackageModel,\s*parseWorksheetPackage,\s*\}\s*from\s*['"]\.\/worksheet-package\.js['"];\s*/,
      replacement: `const editorStorage = {};
const SharedAuthGate = class {};
const createWorksheetPackageFromDraft = () => ({ bytes: new Uint8Array([1, 2, 3]) });
const mapLegacyJsonToPackageModel = (input) => {
  if (!input || typeof input !== 'object' || !Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw new Error('Imported worksheet must have a non-empty blocks array.');
  }
  return {
    worksheet: {
      title: String(input.title || 'Imported worksheet'),
      blocks: input.blocks,
      metadata: input.metadata || {},
    },
    manifest: { format: 'worksheet-package', packageVersion: 1, assets: [] },
    assets: [],
  };
};
const parseWorksheetPackage = () => ({ manifest: {}, worksheet: { title: 'Pkg', blocks: [] }, assets: [] });
`,
    },
    {
      name: 'replace media config import with deterministic constants',
      pattern: /import\s*\{\s*MEDIA_LIMITS,\s*IMAGE_MIME_TYPES,\s*IMAGE_EXTENSIONS,\s*AUDIO_MIME_TYPES,\s*AUDIO_EXTENSIONS\s*\}\s*from\s*['"]\.\/media-config\.js['"];\s*/,
      replacement: `const MEDIA_LIMITS = { imageMaxBytes: 8 * 1024 * 1024, audioMaxBytes: 5 * 1024 * 1024 };
const IMAGE_MIME_TYPES = ['image/png','image/jpeg','image/webp'];
const IMAGE_EXTENSIONS = ['png','jpg','jpeg','webp'];
const AUDIO_MIME_TYPES = ['audio/mpeg','audio/mp3'];
const AUDIO_EXTENSIONS = ['mp3'];
`,
    },
    {
      name: 'replace dynamic contracts loader with deterministic test stub',
      pattern: /async function loadContracts\(\)\s*\{[\s\S]*?\n\}\s*\nfunction createEmptyQuestionBlock/,
      replacement: `async function loadContracts() {
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

function createEmptyQuestionBlock`,
    },
    {
      name: 'replace bootstrap invocation with explicit test exports',
      pattern: /bootstrapEditor\(\)\.catch\([\s\S]*?\);\s*export\s*\{[^}]+\};/,
      replacement: 'export { EditorDraftSession, createDraftRecord, normalizeBlocks, mapOptionsTextToResponseOptions, buildViewerUrlFromCurrentLocation, getNumberQuestionValidationErrors };',
    },
  ]);

  globalThis.document = {
    getElementById: () => null,
    activeElement: null,
  };
  globalThis.window = {
    location: { hash: '#fallback' },
    scrollY: 150,
  };

  const dataUrl = `data:text/javascript,${encodeURIComponent(rewrittenSource)}`;
  return import(dataUrl);
}

function stripOptionIds(options = []) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    value: option.value,
    label: option.label,
  }));
}

function getOptionIdByValue(options = [], value) {
  return (Array.isArray(options) ? options : []).find((option) => option.value === value)?.id || null;
}

test('normalizeBlocks preserves canonical question responseConfig and extra fields', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Question?', format: 'markdown' },
      responseConfig: { inputType: 'text', maxLength: 42, displayMode: 'single_line' },
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

test('validateCurrentDraft flags non-canonical responseConfig.inputType values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  session.state.draft = {
    draftWorksheetId: 'draft_legacy_input_type',
    localId: 'draft_legacy_input_type',
    title: 'Legacy draft',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Legacy?' },
        responseConfig: { inputType: 'plain_text' },
      },
    ],
  };

  const validation = session.validateCurrentDraft();
  assert.equal(validation.valid, false);
  assert.equal(
    validation.errors.includes(
      'draft.blocks[0].responseConfig.inputType must be one of: text, number, boolean, multiple_choice'
    ),
    true
  );
});

test('validateCurrentDraft flags non-string responseConfig.inputType values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  for (const badInputType of [123, {}, [], true]) {
    session.state.draft = {
      draftWorksheetId: 'draft_non_string_input_type',
      localId: 'draft_non_string_input_type',
      title: 'Non-string inputType draft',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Bad inputType?' },
          responseConfig: { inputType: badInputType },
        },
      ],
    };

    const validation = session.validateCurrentDraft();
    assert.equal(
      validation.valid,
      false,
      `expected invalid for inputType: ${JSON.stringify(badInputType)}`
    );
    assert.equal(
      validation.errors.includes(
        'draft.blocks[0].responseConfig.inputType must be one of: text, number, boolean, multiple_choice'
      ),
      true,
      `expected canonical inputType error for inputType: ${JSON.stringify(badInputType)}`
    );
  }
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

test('importWorksheetJson rejects legacy JSON without blocks array', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.importWorksheetJson({ title: 'bad legacy' }, {}),
    /non-empty blocks array/
  );
});

test('editor shell no longer relies on 500ms summary interval loop', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('setInterval(updateSummary, 500)'), false);
});

test('detail signature excludes per-keystroke numeric fields to avoid focus loss during typing', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('selectedBlock.responseConfig?.min ?? \'\''), false);
  assert.equal(source.includes('selectedBlock.responseConfig?.max ?? \'\''), false);
  assert.equal(source.includes('selectedBlock.responseConfig?.correctAnswer ?? null'), false);
});

test('detail signature includes normalized multiple_choice correctAnswer to prevent stale clear button state', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const normalizedCorrectAnswer = (() => {'), true);
  assert.equal(source.includes("normalizedInputType !== 'multiple_choice'"), true);
  assert.equal(source.includes("normalizedSelectionMode === 'single'"), true);
  assert.equal(source.includes("normalizedSelectionMode === 'multi'"), true);
  assert.equal(source.includes('normalizedCorrectAnswer,'), true);
});

test('detail signature includes media refs so media attach/remove rerenders immediately', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const normalizedPromptMediaRefs = selectedBlock.kind === \'question\''), true);
  assert.equal(source.includes('const normalizedOptionMediaRefs = selectedBlock.kind === \'question\''), true);
  assert.equal(source.includes('normalizedPromptMediaRefs,'), true);
  assert.equal(source.includes('normalizedOptionMediaRefs,'), true);
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
  assert.equal(source.includes('buildViewerUrlFromCurrentLocation(window.location.href, localDraftId, draftUpdatedAt)'), true);
  assert.equal(source.includes("new URL('../viewer/', currentHref)"), true);
});

test('buildViewerUrlFromCurrentLocation resolves sibling viewer route from current page', async () => {
  const mod = await loadEditorModule();
  const rootResolved = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/editor/',
    'draft_root',
    '2026-03-31T00:00:00.000Z'
  );
  assert.equal(
    rootResolved.toString(),
    'https://example.test/viewer/?localDraftId=draft_root&preview=1&draftUpdatedAt=2026-03-31T00%3A00%3A00.000Z'
  );

  const nestedResolved = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/server/editor/index.html?mode=edit#section',
    'draft_nested'
  );
  assert.equal(nestedResolved.toString(), 'https://example.test/server/viewer/?localDraftId=draft_nested&preview=1');
});

test('mapOptionsTextToResponseOptions maps trimmed non-empty lines', async () => {
  const mod = await loadEditorModule();
  const mapped = mod.mapOptionsTextToResponseOptions('  Alpha\n\nBeta  \n Gamma ');
  assert.deepEqual(stripOptionIds(mapped), [
    { value: 'Alpha', label: 'Alpha' },
    { value: 'Beta', label: 'Beta' },
    { value: 'Gamma', label: 'Gamma' },
  ]);
  assert.equal(mapped.every((option) => typeof option.id === 'string' && option.id.length > 0), true);
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
      },
    },
  ]);

  assert.deepEqual(blocks[0].responseConfig, {
    inputType: 'text',
    maxLength: 120,
    displayMode: 'single_line',
  });
});

test('normalizeBlocks preserves non-canonical single_choice inputType without migration', async () => {
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
  assert.equal(blocks[0].responseConfig.inputType, 'single_choice');
  assert.equal(Object.hasOwn(blocks[0].responseConfig, 'selectionMode'), false);
  assert.equal(Object.hasOwn(blocks[0].responseConfig, 'options'), false);
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
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  let optionIdA = getOptionIdByValue(updated.responseConfig.options, 'A');
  let optionIdC = getOptionIdByValue(updated.responseConfig.options, 'C');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [optionIdA, optionIdC]);
  session.updateQuestionOptionAtIndex(block.blockId, 2, 'D');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'D']);

  optionIdA = getOptionIdByValue(updated.responseConfig.options, 'A');
  const optionIdB = getOptionIdByValue(updated.responseConfig.options, 'B');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [optionIdA, optionIdB]);
  session.removeQuestionOption(block.blockId, 0);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B']);

  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(updated.responseConfig.options, 'B'));
  session.updateQuestionOptionsFromText(block.blockId, 'X\nY');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('duplicate multiple-choice option values are flagged during draft validation', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_duplicate_option_validation');
  const block = session.createBlock('question');

  session.updateBlockContent(block.blockId, 'Choose one');
  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nA\nB');

  const validation = session.validateCurrentDraft();
  assert.equal(
    validation.errors.some((message) => message.includes('contains duplicate values: A')),
    true
  );
});

test('duplicate selection values normalize deterministically in multi mode', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_duplicate_value_normalize');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nA\nB');
  const updatedBeforeSelect = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  const firstA = getOptionIdByValue(updatedBeforeSelect.responseConfig.options, 'A');
  const secondA = updatedBeforeSelect.responseConfig.options.find((opt) => opt.value === 'A' && opt.id !== firstA)?.id;
  const optionB = getOptionIdByValue(updatedBeforeSelect.responseConfig.options, 'B');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [firstA, secondA, optionB]);

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'A', 'B']);
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
    { min: updated.responseConfig.min, max: updated.responseConfig.max },
    { min: 1, max: 10 }
  );
  assert.equal(Object.hasOwn(updated.responseConfig, 'step'), false);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionShuffleOptions(block.blockId, true);
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.inputType, 'multiple_choice');
  assert.equal(updated.responseConfig.selectionMode, 'multi');
  assert.equal(updated.responseConfig.shuffleOptions, true);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
});

test('number rules authoring persists and prunes conflicting correctAnswer', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_number_rules');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionCorrectAnswerNumber(block.blockId, '-1.25');
  session.updateQuestionNumberConfig(block.blockId, 'min', '-10');
  session.updateQuestionNumberConfig(block.blockId, 'max', '10');
  session.updateQuestionNumberRulesAllowSigned(block.blockId, false);
  session.updateQuestionNumberRulesDecimalPlacesAllowed(block.blockId, '1');

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.numberRules.allowSigned, false);
  assert.equal(updated.responseConfig.numberRules.decimalPlacesAllowed, 1);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
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
  let optionId = getOptionIdByValue(
    session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options,
    'B'
  );
  session.updateQuestionCorrectAnswerChoice(block.blockId, optionId);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'B');
  assert.equal(updated.responseConfig.correctAnswerOptionId, optionId);

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  const optionIds = session.state.draft.blocks
    .find((entry) => entry.blockId === block.blockId)
    .responseConfig.options
    .map((option) => option.id);
  session.updateQuestionCorrectAnswerChoices(block.blockId, optionIds);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'B']);
});

test('multiple choice toggle semantics match single and multi selection behavior', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_choice_toggle_semantics');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB\nC');

  let currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(currentOptions, 'A'));
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'A', 'single mode first click should set value');

  session.updateQuestionCorrectAnswerChoice(block.blockId, '');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false, 'single mode second click should clear');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(currentOptions, 'B'));
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'B', 'single mode selecting another option should replace');

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B'], 'mode switch should coerce single string to array');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [
    getOptionIdByValue(currentOptions, 'B'),
    getOptionIdByValue(currentOptions, 'C'),
  ]);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B', 'C'], 'multi mode toggle-on should add value');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [getOptionIdByValue(currentOptions, 'C')]);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['C'], 'multi mode toggle-off should remove value');

  session.updateQuestionSelectionMode(block.blockId, 'single');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'C', 'switching back to single should return string value');
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
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'Second', label: 'Second' }]);
});

test('typing first visible option persists when options array starts empty', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_first_option');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionOptionAtIndex(block.blockId, 0, 'First typed option');

  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'First typed option', label: 'First typed option' }]);

  session.addQuestionOption(block.blockId);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [
    { value: 'First typed option', label: 'First typed option' },
    { value: '', label: '' },
  ]);
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
  const autosaveOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [
    getOptionIdByValue(autosaveOptions, 'A'),
    getOptionIdByValue(autosaveOptions, 'B'),
    'missing-option-id',
  ]);
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
  assert.equal(typeof importedQuestion.responseConfig.correctAnswerOptionId, 'string');
});

test('number validation helper reports min > max error', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors({
    inputType: 'number',
    min: 10,
    max: 5,
    numberRules: { allowSigned: true, decimalPlacesAllowed: null },
  });

  assert.equal(errors.min, 'Max must be greater than or equal to Min');
  assert.equal(errors.max, 'Max must be greater than or equal to Min');
});

test('number validation helper reports decimal-place violation', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      numberRules: { allowSigned: true, decimalPlacesAllowed: 1 },
    },
    { correctAnswer: '1.23', decimalPlacesAllowed: '1' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer has more decimal places than allowed');
});

test('number validation helper reports out-of-range correct answer', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      min: 2,
      max: 8,
      numberRules: { allowSigned: true, decimalPlacesAllowed: null },
    },
    { correctAnswer: '9' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer must be less than or equal to Max');
});

test('number validation helper reports signed-rule violation', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      numberRules: { allowSigned: false, decimalPlacesAllowed: null },
    },
    { correctAnswer: '-3' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer must be positive when signed values are disabled');
});

test('number validation helper returns no errors for valid constraints', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      min: -5,
      max: 5,
      correctAnswer: 2.5,
      numberRules: { allowSigned: true, decimalPlacesAllowed: 1 },
    },
    { decimalPlacesAllowed: '1', correctAnswer: '2.5' }
  );

  assert.deepEqual(errors, {
    min: null,
    max: null,
    decimalPlacesAllowed: null,
    correctAnswer: null,
  });
});

function createFakeFile({ name, type, size = 4, bytes = [1, 2, 3, 4] }) {
  const data = new Uint8Array(bytes);
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return data.buffer.slice(0);
    },
  };
}

function createSessionWithQuestion(mod, responseConfig = { inputType: 'text' }) {
  const assetStore = new Map();
  const removedIds = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: {
      get: async (id) => assetStore.get(id) || null,
      put: async (record) => {
        assetStore.set(record.localId, record);
        return record;
      },
      remove: async (id) => {
        removedIds.push(id);
        assetStore.delete(id);
      },
    },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_media',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Prompt', format: 'plain_text' },
      responseConfig,
    }],
  });
  return { session, assetStore, removedIds };
}

test('attach/replace/remove question image with confirmation behavior', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore, removedIds } = createSessionWithQuestion(mod);

  const first = await session.attachQuestionMedia('q1', 'question_image', createFakeFile({ name: 'pic.png', type: 'image/png' }));
  assert.equal(first.ok, true);
  assert.equal(assetStore.has(first.assetId), true);

  const replaceNeedsConfirm = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'next.png', type: 'image/png' }),
    { confirmReplace: false }
  );
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');

  const replaced = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'next.png', type: 'image/png' }),
    { confirmReplace: true }
  );
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(first.assetId), true, 'replaced binary should be deleted from localAssets');
  assert.equal(assetStore.has(first.assetId), false, 'replaced binary should be gone from store');
  assert.equal(assetStore.has(replaced.assetId), true, 'new binary should be in store');

  const removeNeedsConfirm = await session.removeQuestionMedia('q1', 'question_image', { confirmRemove: false });
  assert.equal(removeNeedsConfirm.reason, 'confirm-remove-required');
  const removed = await session.removeQuestionMedia('q1', 'question_image', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed binary should be deleted from localAssets');
  assert.equal(assetStore.has(replaced.assetId), false, 'removed binary should be gone from store');
});

test('rejects invalid and oversized question image files', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);

  const badType = await session.attachQuestionMedia('q1', 'question_image', createFakeFile({ name: 'pic.gif', type: 'image/gif' }));
  assert.equal(badType.reason, 'validation');

  const tooBig = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'pic.png', type: 'image/png', size: 9 * 1024 * 1024 })
  );
  assert.equal(tooBig.reason, 'validation');
});

test('attach/replace/remove question mp3 and validate type/size', async () => {
  const mod = await loadEditorModule();
  const { session, removedIds } = createSessionWithQuestion(mod);

  const attached = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.mp3', type: 'audio/mpeg' }));
  assert.equal(attached.ok, true);

  const replaceNeedsConfirm = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q2.mp3', type: 'audio/mpeg' }), { confirmReplace: false });
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');
  const replaced = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q2.mp3', type: 'audio/mpeg' }), { confirmReplace: true });
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(attached.assetId), true, 'replaced binary should be deleted from localAssets');

  const removed = await session.removeQuestionMedia('q1', 'question_audio', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed binary should be deleted from localAssets');

  const badType = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.wav', type: 'audio/wav' }));
  assert.equal(badType.reason, 'validation');
  const tooBig = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.mp3', type: 'audio/mpeg', size: 6 * 1024 * 1024 }));
  assert.equal(tooBig.reason, 'validation');
});

test('attach/replace/remove option mp3', async () => {
  const mod = await loadEditorModule();
  const { session, removedIds } = createSessionWithQuestion(mod, {
    inputType: 'multiple_choice',
    options: [{ id: 'o1', value: 'A', label: 'A' }],
  });

  const attached = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt.mp3', type: 'audio/mpeg' }));
  assert.equal(attached.ok, true);

  const replaceNeedsConfirm = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt2.mp3', type: 'audio/mpeg' }), { confirmReplace: false });
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');
  const replaced = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt2.mp3', type: 'audio/mpeg' }), { confirmReplace: true });
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(attached.assetId), true, 'replaced option binary should be deleted from localAssets');

  const removed = await session.removeOptionAudio('q1', 'o1', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed option binary should be deleted from localAssets');
});
