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
const createWorksheetPackageFromDraft = (draft, assets) => {
  globalThis.__lastCreateWorksheetPackageCall = { draft, assets };
  return { bytes: new Uint8Array([1, 2, 3]) };
};
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
const IMAGE_MIME_TYPES = ['image/png','image/jpeg','image/jpg','image/webp'];
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

function createSessionForTests() {
  return {
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  };
}

function toBlockFieldsWithoutPosition(block) {
  const snapshot = {
    blockId: block.blockId,
    kind: block.kind,
    prompt: block.prompt,
    content: block.content,
    responseConfig: block.responseConfig,
  };
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return {
    blockId: snapshot.blockId,
    kind: snapshot.kind,
    prompt: snapshot.prompt ? JSON.parse(JSON.stringify(snapshot.prompt)) : snapshot.prompt,
    content: snapshot.content ? JSON.parse(JSON.stringify(snapshot.content)) : snapshot.content,
    responseConfig: snapshot.responseConfig ? JSON.parse(JSON.stringify(snapshot.responseConfig)) : snapshot.responseConfig,
  };
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

test('multiple-choice option audio controls gate placeholder options with helper feedback', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const persistedOptionIds = new Set(normalizedOptions.map((option) => String(option?.id || \'\')));'), true);
  assert.equal(source.includes('const isPersistedOption = persistedOptionIds.has(optionId);'), true);
  assert.equal(source.includes("optionAudioBtn.disabled = !isPersistedOption;"), true);
  assert.equal(source.includes("Enter option text or click Add option before attaching audio."), true);
});

test('multiple-choice option row collapses audio actions into a more-menu and shows attached asset id', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("optionActionsMenu.className = 'option-actions-menu';"), true);
  assert.equal(source.includes("optionActionsToggle.textContent = '⋯';"), true);
  assert.equal(source.includes('row.append(correctToggle, optionInput, optionActionsMenu, removeBtn);'), true);
  assert.equal(source.includes('Option audio attached ('), true);
});

test('multiple-choice option action state rerenders while typing when option ids/media refs change and restores caret', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const computeOptionActionSignature = (selectedBlock) => {'), true);
  assert.equal(source.includes('nextOptionActionSignature === optionActionSignature'), true);
  assert.equal(source.includes("optionInput.dataset.optionIndex = String(optionIndex);"), true);
  assert.equal(source.includes('queueMicrotask(() => {'), true);
  assert.equal(source.includes('replacementOptionInput.setSelectionRange(activeOptionSelectionStart, activeOptionSelectionEnd);'), true);
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

test('question input type change flow routes destructive switches through in-app confirm modal', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("questionInputType.addEventListener('change', async () => {"), true);
  assert.equal(source.includes("reason === 'confirm-switch-required'"), true);
  assert.equal(source.includes("title: 'Switching answer type will remove data'"), true);
  assert.equal(source.includes("confirmLabel: 'Switch and Remove'"), true);
  assert.equal(source.includes('await showConfirmDialog({'), true);
});

test('non-destructive type switch does not require confirmation', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = {
    localId: 'draft_type_switch_non_destructive',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: '', label: '' }],
        },
      },
    ],
    assets: [],
  };

  const impact = session.getQuestionInputTypeSwitchImpact('q1', 'text');
  assert.equal(impact.optionCountToRemove, 1);
  assert.equal(impact.optionAttachmentCountToRemove, 0);
  assert.equal(impact.hasOptionTextLoss, false);
  assert.equal(impact.hasMeaningfulDataLoss, false);

  const result = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(result.ok, true);
  const updated = session.state.draft.blocks[0];
  assert.equal(updated.responseConfig.inputType, 'text');
  assert.equal(updated.responseConfig.options, undefined);
});

test('destructive type switch requires confirm and cancel path preserves data', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = {
    localId: 'draft_type_switch_cancel',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'Alpha', label: 'Alpha' }],
        },
      },
    ],
    assets: [],
  };

  const result = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'confirm-switch-required');
  assert.equal(result.impact.optionCountToRemove, 1);
  assert.equal(result.impact.hasOptionTextLoss, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.inputType, 'multiple_choice');
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 1);
});

test('confirming destructive type switch removes targeted option data and attachments only', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_type_switch_confirm',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_remove' }] },
          ],
        },
      },
      {
        blockId: 'q2',
        kind: 'question',
        position: 1,
        prompt: { text: 'Q2' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o2', value: 'B', label: 'B', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_keep_shared' }] },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_remove' }, { assetId: 'asset_keep_shared' }, { assetId: 'asset_keep_unused' }],
  };

  const blocked = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'confirm-switch-required');

  const confirmed = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text', { confirmSwitch: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.inputType, 'text');
  assert.equal(session.state.draft.blocks[0].responseConfig.options, undefined);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_remove'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep_shared'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep_unused'), true);
  assert.deepEqual(removed, ['asset_remove']);
});

test('reorderBlockByDelta moves middle block up/down and normalizes positions to 0..n-1', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_middle');
  clearTimeout(session.autosaveTimer);

  const blockA = {
    blockId: 'blk_a',
    kind: 'content',
    position: 0,
    content: { text: 'Intro', format: 'plain_text' },
  };
  const blockB = {
    blockId: 'blk_b',
    kind: 'question',
    position: 1,
    prompt: { text: 'Question B?', format: 'plain_text', mediaRefs: [{ assetId: 'asset_q', usage: 'question_audio' }] },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'single',
      options: [
        { id: 'opt_1', value: 'One', label: 'One', mediaRefs: [{ assetId: 'asset_opt', usage: 'option_audio' }] },
        { id: 'opt_2', value: 'Two', label: 'Two', mediaRefs: [] },
      ],
      correctAnswer: 'opt_1',
    },
  };
  const blockC = {
    blockId: 'blk_c',
    kind: 'content',
    position: 2,
    content: { text: 'Outro', format: 'markdown' },
  };

  session.state.draft.blocks = [blockA, blockB, blockC];
  session.state.selectedBlockId = 'blk_b';
  const beforeById = new Map(session.state.draft.blocks.map((block) => [block.blockId, toBlockFieldsWithoutPosition(block)]));

  session.reorderBlockByDelta('blk_b', -1);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['blk_b', 'blk_a', 'blk_c']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.equal(session.state.selectedBlockId, 'blk_b');
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  session.state.draft.blocks.forEach((block) => {
    assert.deepEqual(toBlockFieldsWithoutPosition(block), beforeById.get(block.blockId));
  });

  session.reorderBlockByDelta('blk_b', 1);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['blk_a', 'blk_b', 'blk_c']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.equal(session.state.selectedBlockId, 'blk_b');
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  session.state.draft.blocks.forEach((block) => {
    assert.deepEqual(toBlockFieldsWithoutPosition(block), beforeById.get(block.blockId));
  });
});

test('reorderBlockByDelta no-ops for out-of-bounds moves and preserves fields/selection', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_bounds');
  clearTimeout(session.autosaveTimer);

  session.state.draft.blocks = [
    { blockId: 'first', kind: 'content', position: 0, content: { text: 'First', format: 'plain_text' } },
    {
      blockId: 'middle',
      kind: 'question',
      position: 1,
      prompt: { text: 'Middle?', format: 'plain_text', mediaRefs: [{ assetId: 'asset_m', usage: 'question_image' }] },
      responseConfig: { inputType: 'text', maxLength: 120, displayMode: 'multi_line' },
    },
    { blockId: 'last', kind: 'content', position: 2, content: { text: 'Last', format: 'plain_text' } },
  ];
  session.state.selectedBlockId = 'middle';
  const snapshot = session.state.draft.blocks.map((block) => structuredClone(block));
  const revisionBefore = session.state.draftRevision;

  session.reorderBlockByDelta('first', -1);
  session.reorderBlockByDelta('last', 1);

  assert.deepEqual(session.state.draft.blocks, snapshot);
  assert.equal(session.state.selectedBlockId, 'middle');
  assert.equal(session.state.draftRevision, revisionBefore);
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
});

test('reorderBlockByDelta follows position order when array order diverges', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_position_canonical');
  clearTimeout(session.autosaveTimer);

  // Intentionally divergent array order vs. position order:
  // array: [b(1), c(2), a(0)] but visible/render order should be [a, b, c].
  session.state.draft.blocks = [
    { blockId: 'b', kind: 'content', position: 1, content: { text: 'B', format: 'plain_text' } },
    { blockId: 'c', kind: 'content', position: 2, content: { text: 'C', format: 'plain_text' } },
    { blockId: 'a', kind: 'content', position: 0, content: { text: 'A', format: 'plain_text' } },
  ];

  session.reorderBlockByDelta('b', 1);

  // Moving "b" down in visible order [a, b, c] should become [a, c, b].
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['a', 'c', 'b']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
});

test('autosave/export/preview reorder paths remain position-driven without brittle source checks', async () => {
  const mod = await loadEditorModule();
  let persistedSnapshot = null;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        persistedSnapshot = value;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_reorder_autosave');
  clearTimeout(session.autosaveTimer);
  session.state.draft.blocks = [
    { blockId: 'a', kind: 'content', position: 0, content: { text: 'A', format: 'plain_text' } },
    { blockId: 'b', kind: 'content', position: 1, content: { text: 'B', format: 'plain_text' } },
    { blockId: 'c', kind: 'content', position: 2, content: { text: 'C', format: 'plain_text' } },
  ];

  session.reorderBlockByDelta('b', -1);
  await session.autosave();

  assert.ok(persistedSnapshot, 'autosave should persist a snapshot');
  assert.deepEqual(persistedSnapshot.blocks.map((block) => block.blockId), ['b', 'a', 'c']);
  assert.deepEqual(persistedSnapshot.blocks.map((block) => block.position), [0, 1, 2]);
  persistedSnapshot.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  assert.deepEqual(persistedSnapshot.contractDraft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.deepEqual(persistedSnapshot.contractDraft.blocks.map((block) => block.blockId), ['b', 'a', 'c']);

  const url = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/server/editor/index.html',
    'draft_reorder_autosave',
    '2026-04-05T00:00:00.000Z'
  );
  assert.equal(
    url.toString(),
    'https://example.test/server/viewer/?localDraftId=draft_reorder_autosave&preview=1&draftUpdatedAt=2026-04-05T00%3A00%3A00.000Z'
  );

  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const originalBlob = globalThis.Blob;
  const anchor = { clickCalled: false, removeCalled: false, click() { this.clickCalled = true; }, remove() { this.removeCalled = true; } };
  globalThis.URL = {
    createObjectURL: () => 'blob:test-export',
    revokeObjectURL: () => {},
  };
  globalThis.document = {
    ...originalDocument,
    body: { appendChild: () => {} },
    createElement: () => anchor,
  };
  globalThis.Blob = originalBlob;

  try {
    const filename = await session.exportCurrentDraftToPackageFile();
    assert.equal(filename.includes('worksheet-package-draft_reorder_autosave-'), true);
    assert.equal(anchor.clickCalled, true);
    assert.equal(anchor.removeCalled, true);
    assert.deepEqual(
      globalThis.__lastCreateWorksheetPackageCall?.draft?.blocks?.map((block) => block.blockId),
      ['b', 'a', 'c']
    );
    assert.deepEqual(
      globalThis.__lastCreateWorksheetPackageCall?.draft?.blocks?.map((block) => block.position),
      [0, 1, 2]
    );
  } finally {
    globalThis.document = originalDocument;
    globalThis.URL = originalUrl;
    globalThis.Blob = originalBlob;
    delete globalThis.__lastCreateWorksheetPackageCall;
  }
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

test('attach option audio on non-persisted option returns missing-option with helper feedback', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod, {
    inputType: 'multiple_choice',
    options: [],
  });

  const result = await session.attachOptionAudio('q1', 'placeholder_opt', createFakeFile({ name: 'opt.mp3', type: 'audio/mpeg' }));
  assert.equal(result.reason, 'missing-option');
  assert.equal(session.state.mediaFeedback, 'Enter option text or click Add option before attaching audio.');
});

// ─── preview helper tests ────────────────────────────────────────────────────

test('getLocalAssetRecord returns record from storage', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2]), metadata: { mimeType: 'audio/mpeg' } });
  const record = await session.getLocalAssetRecord('asset_1');
  assert.ok(record);
  assert.equal(record.localId, 'asset_1');
});

test('getLocalAssetRecord returns null for missing asset', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const record = await session.getLocalAssetRecord('no_such_id');
  assert.equal(record, null);
});

test('getLocalAssetRecord returns null for falsy assetId', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  assert.equal(await session.getLocalAssetRecord(null), null);
  assert.equal(await session.getLocalAssetRecord(''), null);
});

test('createObjectUrlForAsset returns null when binary is missing', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    assert.equal(session.createObjectUrlForAsset(null), null);
    assert.equal(session.createObjectUrlForAsset({ metadata: {} }), null);
    assert.equal(objectUrls.length, 0);
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('createObjectUrlForAsset creates an object URL for a record with binary', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    const url = session.createObjectUrlForAsset({ binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
    assert.equal(typeof url, 'string');
    assert.ok(url.startsWith('blob:'));
    assert.equal(objectUrls.length, 1);
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('playAssetAudio returns missing-asset when record not in storage', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const result = await session.playAssetAudio('no_such_id');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-asset');
  assert.equal(session.state.mediaFeedback, 'Unable to load attached audio for preview.');
});

test('playAssetAudio returns missing-binary when record has no binary', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', metadata: { mimeType: 'audio/mpeg' } });
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = () => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-binary');
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('playAssetAudio returns playback-failed and revokes URL when play() rejects', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });

  const revokedUrls = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/audio1';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);

  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.reject(new Error('NotAllowedError')); }
    pause() {}
    addEventListener() {}
  };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'playback-failed');
    assert.ok(revokedUrls.includes('blob:test/audio1'), 'URL should be revoked on playback failure');
    assert.equal(session.previewAudio, null);
    assert.equal(session.previewAudioUrl, null);
    assert.equal(session.state.mediaFeedback, 'Audio playback was blocked. Try again.');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio succeeds and clears media feedback', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
  session.state.mediaFeedback = 'old message';

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:test/audio2';
  const origAudio = globalThis.Audio;
  const listeners = {};
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, true);
    assert.equal(session.state.mediaFeedback, null);
    assert.equal(session.previewAudioUrl, 'blob:test/audio2');
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio ignores stale error events from interrupted audio when switching clips', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
  assetStore.set('asset_2', { localId: 'asset_2', binary: new Uint8Array([4, 5, 6]), metadata: { mimeType: 'audio/mpeg' } });
  session.state.mediaFeedback = null;

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (() => {
    let i = 0;
    return () => `blob:test/audio-switch-${++i}`;
  })();

  const origAudio = globalThis.Audio;
  const audioInstances = [];
  globalThis.Audio = class {
    constructor(src) {
      this.src = src;
      this.listeners = {};
      this.playCallCount = 0;
      audioInstances.push(this);
    }
    play() {
      this.playCallCount += 1;
      return Promise.resolve();
    }
    pause() {
      this.listeners.error?.();
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  };

  try {
    const first = await session.playAssetAudio('asset_1');
    assert.equal(first.ok, true);

    const second = await session.playAssetAudio('asset_2');
    assert.equal(second.ok, true, 'new audio should start on first click after interrupting previous playback');
    assert.equal(session.state.mediaFeedback, null, 'stale interrupted-audio errors should not persist');
    assert.equal(audioInstances.length, 2);
    assert.equal(audioInstances[1].playCallCount, 1);
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio treats out-of-order asset loads as superseded instead of cancelling newer playback', async () => {
  const mod = await loadEditorModule();

  let resolveFirstGet;
  const firstGetPromise = new Promise((resolve) => {
    resolveFirstGet = resolve;
  });
  const localAssets = {
    get: async (id) => {
      if (id === 'asset_slow') {
        return firstGetPromise;
      }
      if (id === 'asset_fast') {
        return { localId: id, binary: new Uint8Array([7, 8, 9]), metadata: { mimeType: 'audio/mpeg' } };
      }
      return null;
    },
  };
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets,
    resumeFlags: { get: () => null, set: () => {} },
  });

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (() => {
    let i = 0;
    return () => `blob:test/audio-race-${++i}`;
  })();
  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
  };

  try {
    const slowPromise = session.playAssetAudio('asset_slow');
    const fastResult = await session.playAssetAudio('asset_fast');
    assert.equal(fastResult.ok, true);

    resolveFirstGet({ localId: 'asset_slow', binary: new Uint8Array([1, 1, 1]), metadata: { mimeType: 'audio/mpeg' } });
    const slowResult = await slowPromise;
    assert.equal(slowResult.ok, false);
    assert.equal(slowResult.reason, 'superseded');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('stopPreviewAudio revokes object URL for current preview', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });

  const revokedUrls = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/audio3';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);
  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() {}
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
  };
  try {
    await session.playAssetAudio('asset_1');
    assert.ok(session.previewAudio, 'audio should be set after play');
    assert.equal(session.previewAudioUrl, 'blob:test/audio3');
    session.stopPreviewAudio();
    assert.equal(session.previewAudio, null);
    assert.equal(session.previewAudioUrl, null);
    assert.ok(revokedUrls.includes('blob:test/audio3'), 'URL should be revoked by stopPreviewAudio');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.Audio = origAudio;
  }
});

test('openAssetImage returns blocked when window.open returns null', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const origOpen = globalThis.window.open;
  globalThis.window.open = () => null;
  try {
    const result = await session.openAssetImage('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blocked');
    assert.equal(session.state.mediaFeedback, 'Image preview was blocked. Allow pop-ups and try again.');
  } finally {
    globalThis.window.open = origOpen;
  }
});

test('openAssetImage omits noopener/noreferrer features so browsers return window handle', async () => {
  // Per spec (and Chrome 88+), window.open returns null when noopener or
  // noreferrer is in the features string, even though a tab still opens.
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image2';
  URL.revokeObjectURL = () => {};
  const origOpen = globalThis.window.open;
  const origSetTimeout = globalThis.window.setTimeout;
  let receivedFeatures = null;
  let navigatedTo = null;
  globalThis.window.open = (_url, _target, features) => {
    receivedFeatures = features ?? null;
    // Simulate spec behaviour: return null when noopener or noreferrer present.
    if (features?.includes('noreferrer') || features?.includes('noopener')) return null;
    return {
      set opener(_) {},
      document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
      location: { replace(url) { navigatedTo = url; } },
    };
  };
  try {
    globalThis.window.setTimeout = () => 0;
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true, 'should succeed without noopener/noreferrer features');
    assert.ok(
      !receivedFeatures?.includes('noreferrer') && !receivedFeatures?.includes('noopener'),
      `features must not contain noopener or noreferrer, got: ${receivedFeatures}`
    );
    assert.equal(navigatedTo, 'blob:test/image2');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.window.open = origOpen;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('openAssetImage returns missing-asset when asset not in storage', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  let closed = false;
  globalThis.window.open = () => ({
    close() { closed = true; },
    set opener(_) {},
    document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
    location: { replace() {} },
  });
  try {
    const result = await session.openAssetImage('no_such_id');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-asset');
    assert.equal(closed, true);
  } finally {
    delete globalThis.window.open;
  }
});

test('openAssetImage navigates new window to object URL on success', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const revokedUrls = [];
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image1';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);

  let navigatedTo = null;
  globalThis.window.open = () => ({
    set opener(_) {},
    document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
    location: { replace(url) { navigatedTo = url; } },
  });
  const origSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (fn) => fn();
  try {
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true);
    assert.equal(navigatedTo, 'blob:test/image1');
    assert.ok(revokedUrls.includes('blob:test/image1'), 'URL should be revoked via setTimeout');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    delete globalThis.window.open;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('openAssetImage falls back to in-window img render when location.replace throws', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image-fallback';
  URL.revokeObjectURL = () => {};

  let appendedSrc = null;
  globalThis.window.open = () => {
    const body = {
      innerHTML: '',
      style: {},
      appendChild(node) {
        appendedSrc = node?.src || null;
      },
    };
    return {
      set opener(_) {},
      document: {
        title: '',
        body,
        createElement() {
          return { src: '', alt: '', style: {} };
        },
      },
      location: {
        replace() {
          throw new Error('navigation blocked');
        },
      },
      close() {},
    };
  };
  const origSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (fn) => fn();
  try {
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true);
    assert.equal(appendedSrc, 'blob:test/image-fallback');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    delete globalThis.window.open;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('deleteBlock prunes linked question and option media assets', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_q_audio' }] },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] }],
        },
      },
    ],
    assets: [{ assetId: 'asset_q_audio' }, { assetId: 'asset_opt_audio' }, { assetId: 'asset_keep' }],
  };
  session.state.selectedBlockId = 'q1';

  session.deleteBlock('q1');
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_q_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_opt_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed.sort(), ['asset_opt_audio', 'asset_q_audio']);
});

test('deleteBlockWithPolicy directly deletes empty block', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_empty_block_delete',
    blocks: [
      {
        blockId: 'c1',
        kind: 'content',
        position: 0,
        content: { text: '   ', format: 'plain_text' },
      },
      {
        blockId: 'c2',
        kind: 'content',
        position: 1,
        content: { text: 'keep', format: 'plain_text' },
      },
    ],
    assets: [],
  };
  session.state.selectedBlockId = 'c1';

  const result = session.deleteBlockWithPolicy('c1');
  assert.equal(result.ok, true);
  assert.equal(result.policy.mode, 'safe_direct_delete');
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'c1'), false);
});

test('deleteBlockWithPolicy requires confirm when block has content/assets and confirm deletes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_risky_block_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Prompt text', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_q_audio' }] },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A' }],
        },
      },
      {
        blockId: 'c2',
        kind: 'content',
        position: 1,
        content: { text: 'keep', format: 'plain_text' },
      },
    ],
    assets: [{ assetId: 'asset_q_audio' }],
  };
  session.state.selectedBlockId = 'q1';

  const gated = session.deleteBlockWithPolicy('q1');
  assert.equal(gated.ok, false);
  assert.equal(gated.reason, 'confirm-delete-required');
  assert.equal(gated.policy.mode, 'confirm_delete');
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'q1'), true, 'cancel/no-confirm should leave block untouched');

  const confirmed = session.deleteBlockWithPolicy('q1', { confirmDelete: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'q1'), false, 'confirm should delete block');
});

test('deleteBlock preserves assets still referenced by remaining questions', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_shared',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_shared_audio' }] },
        responseConfig: { inputType: 'text' },
      },
      {
        blockId: 'q2',
        kind: 'question',
        position: 1,
        prompt: { text: 'Q2', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_shared_audio' }] },
        responseConfig: { inputType: 'text' },
      },
    ],
    assets: [{ assetId: 'asset_shared_audio' }, { assetId: 'asset_keep' }],
  };
  session.state.selectedBlockId = 'q1';

  session.deleteBlock('q1');
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_shared_audio'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, []);
});

test('removeQuestionOption prunes option audio asset link', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_opt',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] }],
        },
      },
    ],
    assets: [{ assetId: 'asset_opt_audio' }, { assetId: 'asset_keep' }],
  };

  session.removeQuestionOption('q1', 0);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_opt_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, ['asset_opt_audio']);
});

test('removeQuestionOption preserves shared option audio used by another option', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_opt_shared',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_shared_opt_audio' }] },
            { id: 'o2', value: 'B', label: 'B', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_shared_opt_audio' }] },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_shared_opt_audio' }, { assetId: 'asset_keep' }],
  };

  session.removeQuestionOption('q1', 0);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_shared_opt_audio'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, []);
});

test('removeQuestionOptionWithPolicy directly deletes empty option', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_empty_option_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: '', label: '' }, { id: 'o2', value: 'B', label: 'B' }],
        },
      },
    ],
    assets: [],
  };

  const result = session.removeQuestionOptionWithPolicy('q1', 0);
  assert.equal(result.ok, true);
  assert.equal(result.policy.mode, 'safe_direct_delete');
  const options = session.state.draft.blocks[0].responseConfig.options;
  assert.equal(options.length, 1);
  assert.equal(options[0].id, 'o2');
});

test('removeQuestionOptionWithPolicy requires confirm; cancel leaves option and confirm deletes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_risky_option_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] },
            { id: 'o2', value: 'B', label: 'B' },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_opt_audio' }],
  };

  const gated = session.removeQuestionOptionWithPolicy('q1', 0);
  assert.equal(gated.ok, false);
  assert.equal(gated.reason, 'confirm-delete-required');
  assert.equal(gated.policy.mode, 'confirm_delete');
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 2, 'cancel/no-confirm should leave option untouched');

  const confirmed = session.removeQuestionOptionWithPolicy('q1', 0, { confirmDelete: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 1, 'confirm should delete option');
  assert.equal(session.state.draft.blocks[0].responseConfig.options[0].id, 'o2');
});
