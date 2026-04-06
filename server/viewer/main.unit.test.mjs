import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rewriteModuleSourceForTests } from '../test-utils/module-source-test-helpers.mjs';

async function loadViewerModule(overrides = {}) {
  const filePath = path.resolve('server/viewer/main.js');
  const source = await fs.readFile(filePath, 'utf8');
  const bagName = `__viewerTestBag_${Math.random().toString(16).slice(2)}`;

  globalThis[bagName] = {
    viewerStorage: overrides.viewerStorage || {},
    mapSnapshotToViewerPayload: overrides.mapSnapshotToViewerPayload || ((v) => v),
    normalizeNumberRules: (rules) => ({
      allowedKinds: Array.isArray(rules?.allowedKinds) ? rules.allowedKinds : ['integer', 'decimal'],
      allowSigned: rules?.allowSigned !== false,
      decimalPlacesAllowed: Number.isInteger(rules?.decimalPlacesAllowed) ? rules.decimalPlacesAllowed : null,
    }),
    validateNumberInputFormat: overrides.validateNumberInputFormat || ((value, rulesArg) => {
      const text = String(value ?? '').trim();
      if (!text) return { ok: false, errorCode: 'empty' };
      if (text.includes('/')) return { ok: false, errorCode: 'fraction_not_allowed' };
      const activeRules = globalThis[bagName].normalizeNumberRules(rulesArg);
      if (!activeRules.allowSigned && (text.startsWith('+') || text.startsWith('-'))) {
        return { ok: false, errorCode: 'sign_not_allowed' };
      }
      if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return { ok: false, errorCode: 'invalid_syntax' };
      const kind = text.includes('.') ? 'decimal' : 'integer';
      if (Array.isArray(activeRules.allowedKinds) && !activeRules.allowedKinds.includes(kind)) {
        return { ok: false, errorCode: 'kind_not_allowed' };
      }
      if (kind === 'decimal' && Number.isInteger(activeRules.decimalPlacesAllowed)) {
        const [, decimalPart = ''] = text.split('.');
        if (decimalPart.length > activeRules.decimalPlacesAllowed) {
          return { ok: false, errorCode: 'decimal_places_exceeded' };
        }
      }
      return { ok: true, normalizedValue: Number(text), kind };
    }),
    SharedAuthGate: overrides.SharedAuthGate || class {},
    createServerApiClient: overrides.createServerApiClient || (() => ({
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: false, error: { message: 'auth required' } }),
      listPublishedPackages: async () => ({ ok: true, data: { items: [] } }),
      fetchPublishedPackageArtifact: async () => ({ ok: false, error: { message: 'not configured' } }),
    })),
    mapLegacyJsonToPackageModel: overrides.mapLegacyJsonToPackageModel || ((value) => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.blocks) || value.blocks.length === 0) {
        throw new Error('Imported worksheet must have a non-empty blocks array.');
      }
      return { worksheet: value };
    }),
    parseWorksheetPackage: overrides.parseWorksheetPackage || (() => ({ worksheet: { title: 'Imported package', blocks: [] } })),
    validateViewerPayloadSchema: overrides.validateViewerPayloadSchema || (() => ({ valid: true, errors: [] })),
    renderViewerShell: overrides.renderViewerShell || (() => {}),
    document: overrides.document || { getElementById: () => null },
    window: overrides.window || {},
  };

  const rewrittenSource = rewriteModuleSourceForTests(source, [
    {
      name: 'replace viewerStorage import with test bag binding',
      pattern: /import\s*\{\s*viewerStorage\s*\}\s*from\s*['"]\.\/storage\/index\.js['"];/,
      replacement: `const __testBag = globalThis.${bagName};\nconst viewerStorage = __testBag.viewerStorage;`,
    },
    {
      name: 'replace mapSnapshotToViewerPayload import with test bag binding',
      pattern: /import\s*\{\s*mapSnapshotToViewerPayload\s*\}\s*from\s*['"]\.\.\/app\/contracts\/mappers\.js['"];/,
      replacement: 'const mapSnapshotToViewerPayload = __testBag.mapSnapshotToViewerPayload;',
    },
    {
      name: 'replace validateViewerPayloadSchema import with test bag binding',
      pattern: /import\s*\{\s*validateViewerPayloadSchema\s*\}\s*from\s*['"]\.\.\/app\/contracts\/validators\.js['"];/,
      replacement: 'const validateViewerPayloadSchema = __testBag.validateViewerPayloadSchema;',
    },
    {
      name: 'replace number validator imports with test bag bindings',
      pattern: /import\s*\{\s*normalizeNumberRules\s*,\s*validateNumberInputFormat\s*\}\s*from\s*['"]\.\.\/app\/contracts\/number-input-validator\.js['"];/,
      replacement: 'const normalizeNumberRules = __testBag.normalizeNumberRules;\nconst validateNumberInputFormat = __testBag.validateNumberInputFormat;',
    },
    {
      name: 'replace SharedAuthGate import with test bag binding',
      pattern: /import\s*\{\s*SharedAuthGate\s*\}\s*from\s*['"]\.\.\/app\/auth\/shared-auth-gate\.js['"];/,
      replacement: 'const SharedAuthGate = __testBag.SharedAuthGate;',
    },
    {
      name: 'replace worksheet package imports with test bag bindings',
      pattern: /import\s*\{\s*mapLegacyJsonToPackageModel\s*,\s*parseWorksheetPackage\s*\}\s*from\s*['"]\.\.\/editor\/worksheet-package\.js['"];/,
      replacement: 'const mapLegacyJsonToPackageModel = __testBag.mapLegacyJsonToPackageModel;\nconst parseWorksheetPackage = __testBag.parseWorksheetPackage;',
    },
    {
      name: 'replace createServerApiClient import with test bag binding',
      pattern: /import\s*\{\s*createServerApiClient\s*\}\s*from\s*['"]\.\.\/app\/api\/server-api-client\.js['"];/,
      replacement: 'const createServerApiClient = __testBag.createServerApiClient;',
    },
    {
      name: 'reroute renderViewerShell side effect',
      pattern: /renderViewerShell\(\s*session\s*\);/g,
      replacement: '__testBag.renderViewerShell(session);',
    },
    {
      name: 'replace bootstrap invocation with explicit test exports',
      pattern: /bootstrapViewer\(\)\.catch\([\s\S]*?\);\s*export\s*\{[\s\S]*?\};/,
      replacement: 'export { ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock, computeAnswerSummary, computeCheckResult, getCheckRevealMessage, hasGradeableQuestions, normalizeMultiSelectValues, areMultiSelectValuesEqual, partitionBlocksForDisplay, getInputHelperText, getNumberInputErrorMessage, coerceAnswerValueForQuestion, clampTextAnswer, computeTextLengthFeedback, updateTextCounterUI, getBooleanSelectionState, applyBooleanGroupState, getChoicePrefix, createChoiceButtonGroup, applyChoiceButtonGroupState, computeNextChoiceValue, deterministicShuffle, ensureControlDescribedBy, createInputErrorNode, computeResumeStartBlockIndex, renderViewerStartPanel, renderViewerFatalError, bootstrapViewer, ViewerBootError, VIEWER_BOOT_ERROR_CODES };',
    },
  ]);

  globalThis.document = globalThis[bagName].document;
  globalThis.window = globalThis[bagName].window;

  const dataUrl = `data:text/javascript,${encodeURIComponent(rewrittenSource)}`;
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

test('viewer handleAuthCompleteMessage refreshes session and re-browses packages on valid message', async () => {
  const mod = await loadViewerModule({
    window: { location: { origin: 'https://example.test' } },
  });
  const session = new mod.ViewerAttemptSession({}, {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'learner@example.test' } } }),
      listPublishedPackages: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  const handled = await session.handleAuthCompleteMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete', source: 'viewer' },
  });

  assert.equal(handled, true);
  assert.equal(session.state.serverSession.status, 'ready');
  assert.deepEqual(session.state.publishedPackages, []);
});

test('viewer handleAuthCompleteMessage ignores wrong-origin and malformed messages', async () => {
  const mod = await loadViewerModule({
    window: { location: { origin: 'https://example.test' } },
  });
  const session = new mod.ViewerAttemptSession({}, {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'learner@example.test' } } }),
      listPublishedPackages: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  const wrongOrigin = await session.handleAuthCompleteMessage({
    origin: 'https://malicious.test',
    data: { type: 'worksheet-launcher-auth-complete' },
  });
  const wrongShape = await session.handleAuthCompleteMessage({
    origin: 'https://example.test',
    data: { type: 'not-auth-complete' },
  });

  assert.equal(wrongOrigin, false);
  assert.equal(wrongShape, false);
  assert.equal(session.state.serverSession.status, 'checking');
});

test('viewer beginServerSignIn stores popup handle and fallback polling can recover missed callback', async () => {
  const intervalCallbacks = [];
  const clearedIntervals = [];
  const authPopup = { closed: false };
  const mod = await loadViewerModule({
    window: {
      location: { origin: 'https://example.test' },
      open: () => authPopup,
      addEventListener: () => {},
      setInterval: (callback) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      },
      clearInterval: (id) => {
        clearedIntervals.push(id);
      },
    },
  });

  const session = new mod.ViewerAttemptSession({}, {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'learner@example.test' } } }),
      listPublishedPackages: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  session.beginServerSignIn();
  assert.equal(session._authPopupWindow, authPopup);
  assert.equal(intervalCallbacks.length, 1);

  authPopup.closed = true;
  intervalCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.state.serverSession.status, 'ready');
  assert.equal(session.state.serverActionMessage, null);
  assert.equal(clearedIntervals.length > 0, true);
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

test('normalizeViewerBlock preserves non-canonical single_choice inputType without coercion', async () => {
  const mod = await loadViewerModule();
  const normalized = mod.normalizeViewerBlock({
    blockId: 'q1',
    kind: 'question',
    position: 0,
    prompt: { text: 'Choose one' },
    responseConfig: {
      inputType: 'single_choice',
      selectionMode: 'multi',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b' },
        'c',
        null,
      ],
    },
  }, 0);

  assert.equal(normalized.responseConfig.inputType, 'single_choice');
  assert.equal(Object.hasOwn(normalized.responseConfig, 'selectionMode'), false);
  assert.equal(Object.hasOwn(normalized.responseConfig, 'options'), false);
});

test('normalizeViewerBlock preserves non-string inputType without coercing to text', async () => {
  const mod = await loadViewerModule();
  const withNumber = mod.normalizeViewerBlock({
    blockId: 'q2',
    kind: 'question',
    position: 0,
    prompt: { text: 'Bad type?' },
    responseConfig: { inputType: 123 },
  }, 0);
  assert.equal(withNumber.responseConfig.inputType, 123);

  const withObject = mod.normalizeViewerBlock({
    blockId: 'q3',
    kind: 'question',
    position: 0,
    prompt: { text: 'Bad type object?' },
    responseConfig: { inputType: {} },
  }, 0);
  assert.deepStrictEqual(withObject.responseConfig.inputType, {});
});

test('normalizeViewerBlock does not emit text-only responseConfig fields for non-text input types', async () => {
  const mod = await loadViewerModule();
  const number = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'How many?' },
    responseConfig: { inputType: 'number', min: 1, max: 5, maxLength: 20, displayMode: 'single_line' },
  }, 0);
  const bool = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'True/False?' },
    responseConfig: { inputType: 'boolean', maxLength: 20, displayMode: 'single_line' },
  }, 1);
  const multi = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick' },
    responseConfig: { inputType: 'multiple_choice', options: ['a'], maxLength: 20, displayMode: 'single_line' },
  }, 2);

  assert.equal(Object.hasOwn(number.responseConfig, 'maxLength'), false);
  assert.equal(Object.hasOwn(number.responseConfig, 'displayMode'), false);
  assert.equal(Object.hasOwn(bool.responseConfig, 'maxLength'), false);
  assert.equal(Object.hasOwn(bool.responseConfig, 'displayMode'), false);
  assert.equal(Object.hasOwn(multi.responseConfig, 'maxLength'), false);
  assert.equal(Object.hasOwn(multi.responseConfig, 'displayMode'), false);
});

test('normalizeViewerBlock preserves option_audio media refs for multiple-choice options', async () => {
  const mod = await loadViewerModule();
  const block = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick one' },
    responseConfig: {
      inputType: 'multiple_choice',
      options: [
        {
          value: 'a',
          label: 'A',
          mediaRefs: [
            { usage: 'option_audio', assetId: 'asset_opt_1' },
            { usage: 'question_audio', assetId: 'ignored' },
          ],
        },
        { value: 'b', label: 'B', mediaRefs: [{ usage: 'option_audio', assetId: '' }] },
      ],
    },
  }, 0);

  assert.deepEqual(block.responseConfig.options[0].mediaRefs, [{ usage: 'option_audio', assetId: 'asset_opt_1' }]);
  assert.deepEqual(block.responseConfig.options[1].mediaRefs, []);
});

function createMockDocument() {
  class MockElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.className = '';
      this.textContent = '';
      this.id = '';
      this.disabled = false;
      this.tabIndex = 0;
      this.classList = { toggle: () => {} };
    }
    append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    }
    appendChild(node) {
      this.children.push(node);
      return node;
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener() {}
  }
  return {
    getElementById: () => null,
    createElement: (tag) => new MockElement(tag),
  };
}

test('createChoiceButtonGroup renders option-audio play buttons only when option_audio mediaRef exists', async () => {
  const mod = await loadViewerModule({
    document: createMockDocument(),
  });
  const session = { state: { answers: {} }, setAnswer: () => {} };
  const group = mod.createChoiceButtonGroup({
    block: {
      blockId: 'q1',
      responseConfig: { selectionMode: 'single' },
    },
    labelId: 'label_q1',
    controlId: 'control_q1',
    optionSource: [
      { value: 'a', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_1' }] },
      { value: 'b', label: 'B', mediaRefs: [] },
    ],
    session,
    updateSummary: () => {},
  });

  const firstRow = group.children[0];
  const secondRow = group.children[1];
  const firstAudioButton = firstRow.children.find((node) => String(node.className || '').includes('choice-audio-btn'));
  const secondAudioButton = secondRow.children.find((node) => String(node.className || '').includes('choice-audio-btn'));

  assert.equal(firstAudioButton?.textContent, '🔊');
  assert.equal(String(firstAudioButton?.className || '').includes('question-card__prompt-audio-btn'), true);
  assert.equal(secondAudioButton, undefined);
});

test('normalizeViewerBlock preserves non-canonical plain_text/short_text inputType values', async () => {
  const mod = await loadViewerModule();
  const plain = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Q1' },
    responseConfig: { inputType: 'plain_text' },
  }, 0);
  const short = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Q2' },
    responseConfig: { inputType: 'short_text', maxLength: 80, displayMode: 'single_line' },
  }, 1);

  assert.equal(plain.responseConfig.inputType, 'plain_text');
  assert.equal(short.responseConfig.inputType, 'short_text');
  assert.equal(Object.hasOwn(plain.responseConfig, 'maxLength'), false);
  assert.equal(Object.hasOwn(short.responseConfig, 'maxLength'), false);
  assert.equal(Object.hasOwn(short.responseConfig, 'displayMode'), false);
});

test('viewer start panel includes session-ready published browse integration', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes('await session.refreshServerSession();'), true);
  assert.equal(source.includes('await session.browsePublishedPackages'), true);
  assert.equal(source.includes('await session.startFromPublishedPackage'), true);
});

test('normalizeViewerBlock preserves correctAnswer for gradeable question types', async () => {
  const mod = await loadViewerModule();
  const number = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'How many?' },
    responseConfig: { inputType: 'number', correctAnswer: '4' },
  }, 0);
  const bool = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'True/False?' },
    responseConfig: { inputType: 'boolean', correctAnswer: 'true' },
  }, 1);
  const single = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick one' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'single',
      options: ['a', 'b'],
      correctAnswer: 'b',
    },
  }, 2);
  const multi = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick many' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: ['a', 'b', 'c'],
      correctAnswer: ['b', 'a', 'b'],
    },
  }, 3);

  assert.equal(number.responseConfig.correctAnswer, 4);
  assert.equal(bool.responseConfig.correctAnswer, true);
  assert.equal(single.responseConfig.correctAnswer, 'b');
  assert.deepEqual(multi.responseConfig.correctAnswer, ['b', 'a']);
});

test('normalizeViewerBlock omits multi-select correctAnswer when source is not a non-empty array', async () => {
  const mod = await loadViewerModule();

  const missing = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick many' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: ['a', 'b', 'c'],
    },
  }, 0);
  const nullValue = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick many' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: ['a', 'b', 'c'],
      correctAnswer: null,
    },
  }, 1);
  const scalarValue = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick many' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: ['a', 'b', 'c'],
      correctAnswer: 'a',
    },
  }, 2);
  const emptyArray = mod.normalizeViewerBlock({
    kind: 'question',
    prompt: { text: 'Pick many' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: ['a', 'b', 'c'],
      correctAnswer: [],
    },
  }, 3);

  assert.equal(Object.hasOwn(missing.responseConfig, 'correctAnswer'), false);
  assert.equal(Object.hasOwn(nullValue.responseConfig, 'correctAnswer'), false);
  assert.equal(Object.hasOwn(scalarValue.responseConfig, 'correctAnswer'), false);
  assert.equal(Object.hasOwn(emptyArray.responseConfig, 'correctAnswer'), false);
});

test('computeCheckResult can grade normalized payload that includes correctAnswer fields', async () => {
  const mod = await loadViewerModule();
  const payload = mod.normalizeViewerPayload({
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: '2 + 2?' },
        responseConfig: { inputType: 'number', correctAnswer: '4' },
      },
      {
        blockId: 'q2',
        kind: 'question',
        position: 1,
        prompt: { text: 'Sky is blue?' },
        responseConfig: { inputType: 'boolean', correctAnswer: true },
      },
    ],
  });

  const result = mod.computeCheckResult(payload, {
    q1: { value: 4 },
    q2: { value: true },
  });

  assert.equal(result.totalQuestions, 2);
  assert.equal(result.correctCount, 2);
  assert.deepEqual(result.byBlockId, { q1: true, q2: true });
});

test('coerceAnswerValueForQuestion does not silently clamp out-of-range numbers', async () => {
  const mod = await loadViewerModule();
  const question = {
    responseConfig: { inputType: 'number', min: 0, max: 10 },
  };
  assert.equal(mod.coerceAnswerValueForQuestion(question, '12.3'), 12.3);
  assert.equal(mod.coerceAnswerValueForQuestion(question, '-3'), -3);
  assert.equal(mod.coerceAnswerValueForQuestion(question, '3.24'), 3.24);
});

test('coerceAnswerValueForQuestion preserves already-normalized finite numbers including scientific notation', async () => {
  const mod = await loadViewerModule();
  const question = { responseConfig: { inputType: 'number' } };
  assert.equal(mod.coerceAnswerValueForQuestion(question, 1e-7), 1e-7);
  assert.equal(mod.coerceAnswerValueForQuestion(question, 0.0000001), 1e-7);
  assert.equal(mod.coerceAnswerValueForQuestion(question, 42), 42);
});

test('coerceAnswerValueForQuestion validates number format rules (integer/decimal only)', async () => {
  const mod = await loadViewerModule();
  const question = {
    responseConfig: {
      inputType: 'number',
      numberRules: {
        allowedKinds: ['integer', 'decimal'],
        allowSigned: true,
        decimalPlacesAllowed: 1,
      },
    },
  };
  assert.equal(mod.coerceAnswerValueForQuestion(question, '3'), 3);
  assert.equal(mod.coerceAnswerValueForQuestion(question, '3.0'), 3);
  assert.equal(mod.coerceAnswerValueForQuestion(question, '+3'), 3);
  assert.equal(mod.coerceAnswerValueForQuestion(question, '2/3'), '');
  assert.equal(mod.coerceAnswerValueForQuestion(question, '1.23'), '');
});

test('coerceAnswerValueForQuestion keeps over-limit text during edit and truncates on save', async () => {
  const mod = await loadViewerModule();
  const question = {
    responseConfig: { inputType: 'text', maxLength: 5 },
  };
  assert.equal(mod.coerceAnswerValueForQuestion(question, 'abcdefghij', { phase: 'edit' }), 'abcdefghij');
  assert.equal(mod.coerceAnswerValueForQuestion(question, 'abcdefghij', { phase: 'save' }), 'abcde');
});

test('coerceAnswerValueForQuestion supports multiple_choice single and multi answers', async () => {
  const mod = await loadViewerModule();
  const single = {
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'single',
      options: [{ value: 'a' }, { value: 'b' }],
    },
  };
  const multi = {
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'multi',
      options: [{ value: 'a' }, { value: 'b' }],
    },
  };
  assert.equal(mod.coerceAnswerValueForQuestion(single, 'a'), 'a');
  assert.equal(mod.coerceAnswerValueForQuestion(single, 'z'), '');
  assert.deepEqual(mod.coerceAnswerValueForQuestion(multi, ['b', 'a', 'b', 'x']), ['b', 'a']);
});

test('getBooleanSelectionState maps stored values to selected button state', async () => {
  const mod = await loadViewerModule();
  assert.deepEqual(mod.getBooleanSelectionState(true), {
    selectedValue: true,
    truePressed: true,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState(false), {
    selectedValue: false,
    truePressed: false,
    falsePressed: true,
  });
  assert.deepEqual(mod.getBooleanSelectionState(null), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState('true'), {
    selectedValue: true,
    truePressed: true,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState('false'), {
    selectedValue: false,
    truePressed: false,
    falsePressed: true,
  });
  assert.deepEqual(mod.getBooleanSelectionState(''), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState(undefined), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
});

test('applyBooleanGroupState hydrates selected and disabled button state', async () => {
  const mod = await loadViewerModule();
  function createButton(booleanValue) {
    const button = {
      dataset: { booleanValue },
      disabled: false,
      attributes: {},
      selectedClass: false,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
    };
    button.classList = {
      toggle: (_className, flag) => {
        button.selectedClass = Boolean(flag);
      },
    };
    return button;
  }
  const trueButton = createButton('true');
  const falseButton = createButton('false');
  const group = {
    querySelectorAll: () => [trueButton, falseButton],
  };

  mod.applyBooleanGroupState(group, true, true);
  assert.equal(trueButton.selectedClass, true);
  assert.equal(falseButton.selectedClass, false);
  assert.equal(trueButton.attributes['aria-pressed'], 'true');
  assert.equal(falseButton.attributes['aria-pressed'], 'false');
  assert.equal(trueButton.disabled, true);
  assert.equal(falseButton.disabled, true);

  mod.applyBooleanGroupState(group, null, false);
  assert.equal(trueButton.selectedClass, false);
  assert.equal(falseButton.selectedClass, false);
  assert.equal(trueButton.attributes['aria-pressed'], 'false');
  assert.equal(falseButton.attributes['aria-pressed'], 'false');
  assert.equal(trueButton.disabled, false);
  assert.equal(falseButton.disabled, false);
});

test('deterministicShuffle remains stable per seed', async () => {
  const mod = await loadViewerModule();
  const items = [{ value: '1' }, { value: '2' }, { value: '3' }];
  assert.deepEqual(
    mod.deterministicShuffle(items, 'seed-1').map((item) => item.value),
    mod.deterministicShuffle(items, 'seed-1').map((item) => item.value)
  );
});

test('deterministicShuffle handles nullish seed values safely', async () => {
  const mod = await loadViewerModule();
  const items = ['a', 'b', 'c', 'd'];
  assert.doesNotThrow(() => mod.deterministicShuffle(items, null));
  assert.doesNotThrow(() => mod.deterministicShuffle(items, undefined));
  assert.deepEqual(mod.deterministicShuffle(items, null), mod.deterministicShuffle(items, ''));
  assert.deepEqual(mod.deterministicShuffle(items, undefined), mod.deterministicShuffle(items, ''));
});

test('getChoicePrefix returns alphabetical labels in sequence', async () => {
  const mod = await loadViewerModule();
  assert.equal(mod.getChoicePrefix(0), 'A.');
  assert.equal(mod.getChoicePrefix(1), 'B.');
  assert.equal(mod.getChoicePrefix(25), 'Z.');
  assert.equal(mod.getChoicePrefix(26), 'AA.');
});

test('multiple choice UI renderer uses button-group semantics for single and multi', async () => {
  const mod = await loadViewerModule();
  function createChoiceButton(value) {
    const button = {
      dataset: { choiceValue: value },
      disabled: false,
      attributes: {},
      selectedClass: false,
      tagName: 'BUTTON',
      setAttribute(name, attrValue) {
        this.attributes[name] = attrValue;
      },
    };
    button.classList = {
      toggle: (_className, flag) => {
        button.selectedClass = Boolean(flag);
      },
    };
    return button;
  }

  const buttons = [createChoiceButton('b'), createChoiceButton('a'), createChoiceButton('c')];
  const group = {
    querySelectorAll: (selector) => (selector === 'button[data-choice-value]' ? buttons : []),
  };

  mod.applyChoiceButtonGroupState(group, 'a', 'single', false);
  assert.equal(buttons[1].selectedClass, true);
  assert.equal(buttons[1].attributes['aria-checked'], 'true');
  assert.equal(buttons[0].attributes['aria-checked'], 'false');

  mod.applyChoiceButtonGroupState(group, ['b', 'c'], 'multi', false);
  assert.equal(buttons[0].selectedClass, true);
  assert.equal(buttons[1].selectedClass, false);
  assert.equal(buttons[2].selectedClass, true);
});

test('computeNextChoiceValue toggles multi-select values without dropping existing selections', async () => {
  const mod = await loadViewerModule();
  const validValues = ['a', 'b', 'c'];
  assert.deepEqual(
    mod.computeNextChoiceValue({ selectionMode: 'multi', currentValue: ['a'], clickedValue: 'b', validValues }),
    ['a', 'b']
  );
  assert.deepEqual(
    mod.computeNextChoiceValue({ selectionMode: 'multi', currentValue: ['a', 'b'], clickedValue: 'a', validValues }),
    ['b']
  );
  assert.equal(
    mod.computeNextChoiceValue({ selectionMode: 'single', currentValue: 'b', clickedValue: 'b', validValues }),
    ''
  );
});

test('multiple choice selection state sync supports rerender and completed status disablement', async () => {
  const mod = await loadViewerModule();
  function createChoiceButton(value) {
    const button = {
      dataset: { choiceValue: value },
      disabled: false,
      attributes: {},
      selectedClass: false,
      setAttribute(name, attrValue) {
        this.attributes[name] = attrValue;
      },
    };
    button.classList = {
      toggle: (_className, flag) => {
        button.selectedClass = Boolean(flag);
      },
    };
    return button;
  }

  const firstRenderButtons = [createChoiceButton('x'), createChoiceButton('y')];
  const secondRenderButtons = [createChoiceButton('x'), createChoiceButton('y')];
  const firstGroup = { querySelectorAll: () => firstRenderButtons };
  const secondGroup = { querySelectorAll: () => secondRenderButtons };

  mod.applyChoiceButtonGroupState(firstGroup, 'y', 'single', false);
  assert.equal(firstRenderButtons[1].selectedClass, true);
  assert.equal(firstRenderButtons[1].disabled, false);

  mod.applyChoiceButtonGroupState(secondGroup, 'y', 'single', true);
  assert.equal(secondRenderButtons[1].selectedClass, true);
  assert.equal(secondRenderButtons[0].disabled, true);
  assert.equal(secondRenderButtons[1].disabled, true);
});

test('deterministic shuffle seed format remains attempt+block based', async () => {
  const mod = await loadViewerModule();
  const options = [{ value: 'a' }, { value: 'b' }, { value: 'c' }, { value: 'd' }];
  const seed = `${'attempt_42'}:${'block_7'}`;
  const first = mod.deterministicShuffle(options, seed).map((opt) => opt.value);
  const second = mod.deterministicShuffle(options, seed).map((opt) => opt.value);
  const differentAttempt = mod.deterministicShuffle(options, `${'attempt_99'}:${'block_7'}`).map((opt) => opt.value);

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, differentAttempt);
});

test('multiple_choice render path no longer creates select or checkbox controls', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.match(source, /createChoiceButtonGroup\(/);
  assert.doesNotMatch(source, /createElement\('select'\)/);
  assert.doesNotMatch(source, /type = 'checkbox'/);
});

test('viewer summary text includes distinct finalize outcome messages', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.match(source, /Finalizing submission…/);
  assert.match(source, /Finalize failed\. Please check your connection and try again\./);
  assert.match(source, /Finalized/);
});

test('viewer shell exposes check action only in completed state', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.match(source, /checkBtn\.textContent = 'Check Answer';/);
  assert.match(source, /const checkAvailable = session\.state\.status === 'completed';/);
  assert.match(source, /checkBtn\.hidden = !checkAvailable;/);
  assert.match(source, /checkBtn\.disabled = session\.state\.isFinalizing \|\| !checkAvailable;/);
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

test('completeLocalAttempt is idempotent while finalize is in progress', async () => {
  const mod = await loadViewerModule();
  let resolveSave;
  const savePromise = new Promise((resolve) => {
    resolveSave = resolve;
  });
  let autosaveCalls = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });
  session.state.localAttemptId = 'attempt_finalize_once';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };
  session.autosave = async () => {
    autosaveCalls += 1;
    await savePromise;
    return { ok: true };
  };

  const firstFinalize = session.completeLocalAttempt();
  assert.equal(session.state.isFinalizing, true);
  const secondFinalize = await session.completeLocalAttempt();
  assert.equal(secondFinalize, null);
  assert.equal(autosaveCalls, 1);

  resolveSave();
  await firstFinalize;
  assert.equal(session.state.isFinalizing, false);
  assert.equal(session.state.status, 'completed');
});

test('checkAnswers is unavailable before finalize and computes results after finalize', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });
  session.state.localAttemptId = 'attempt_check_after_finalize';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: '2 + 2?' },
      responseConfig: { inputType: 'number', correctAnswer: 4 },
    }],
  };
  session.state.answers = {
    q1: { value: 4, answeredAt: '2026-01-01T00:00:00.000Z' },
  };

  assert.equal(session.checkAnswers(), null);
  assert.equal(session.state.checkResult, null);

  await session.completeLocalAttempt();
  const checked = session.checkAnswers();
  const expected = mod.computeCheckResult(session.state.viewerPayload, session.state.answers);
  assert.deepEqual(checked, expected);
  assert.deepEqual(session.state.checkResult, expected);
});

test('checkAnswers returns null while finalizing is in progress', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });
  session.state.status = 'completed';
  session.state.isFinalizing = true;
  session.state.viewerPayload = {
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'True?' },
      responseConfig: { inputType: 'boolean', correctAnswer: true },
    }],
  };
  session.state.answers = { q1: { value: true } };

  assert.equal(session.checkAnswers(), null);
  assert.equal(session.state.checkResult, null);
});

test('completeLocalAttempt failure reverts status and allows retry to succeed', async () => {
  const mod = await loadViewerModule();
  let saveAttempts = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });
  session.state.localAttemptId = 'attempt_finalize_retry';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };
  session.autosave = async () => {
    saveAttempts += 1;
    if (saveAttempts === 1) {
      throw new Error('db unavailable');
    }
    return { ok: true };
  };
  session.state.checkResult = { correctCount: 1, totalQuestions: 1 };

  const failedFinalize = await session.completeLocalAttempt();
  assert.equal(failedFinalize, null);
  assert.equal(session.state.status, 'in_progress');
  assert.equal(session.state.completedAt, null);
  assert.equal(session.state.isFinalizing, false);
  assert.equal(session.state.checkResult, null);
  assert.equal(session.checkAnswers(), null);
  assert.match(session.state.lastFinalizeError, /Finalize failed\./);
  assert.match(session.state.lastFinalizeError, /db unavailable/);

  const successfulFinalize = await session.completeLocalAttempt();
  assert.deepEqual(successfulFinalize, { ok: true });
  assert.equal(session.state.status, 'completed');
  assert.equal(session.state.isFinalizing, false);
  assert.equal(session.state.lastFinalizeError, null);
  assert.equal(saveAttempts, 2);
});

test('startImportedWorksheetFromJsonText creates fresh attempt from imported worksheet JSON', async () => {
  const mod = await loadViewerModule();
  const importedRecords = [];
  let createAttemptCalls = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: {
      put: async (record) => {
        importedRecords.push(record);
        return record;
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });
  const originalCreateLocalAttemptState = session.createLocalAttemptState.bind(session);
  session.createLocalAttemptState = (...args) => {
    createAttemptCalls += 1;
    return originalCreateLocalAttemptState(...args);
  };

  await session.startImportedWorksheetFromJsonText(JSON.stringify({
    title: 'Imported worksheet',
    blocks: [
      { blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question 1' }, responseConfig: { inputType: 'text' } },
    ],
  }));
  clearTimeout(session.autosaveTimer);

  assert.equal(importedRecords.length, 1);
  assert.equal(importedRecords[0].localId, importedRecords[0].metadata.localId);
  assert.equal(importedRecords[0].metadata.origin, 'imported_file');
  assert.equal(importedRecords[0].metadata.updatedAt, importedRecords[0].importedAt);
  assert.ok(importedRecords[0].metadata.updatedAt);
  assert.equal(createAttemptCalls, 1);
  assert.equal(session.state.source, 'imported_worksheet');
  assert.equal(session.state.status, 'in_progress');
  assert.equal(session.state.viewerPayload.title, 'Imported worksheet');
  assert.equal(session.state.viewerPayload.blocks.length, 1);
});

test('startImportedWorksheetFromPackageFile creates fresh attempt from worksheet package bytes', async () => {
  const mod = await loadViewerModule({
    parseWorksheetPackage: () => ({
      worksheet: {
        title: 'Package worksheet',
        blocks: [
          { blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'From package' }, responseConfig: { inputType: 'text' } },
        ],
      },
    }),
  });
  const importedRecords = [];
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: {
      put: async (record) => {
        importedRecords.push(record);
        return record;
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  await session.startImportedWorksheetFromPackageFile(new ArrayBuffer(0));
  clearTimeout(session.autosaveTimer);

  assert.equal(importedRecords.length, 1);
  assert.equal(session.state.sourceType, 'imported_worksheet');
  assert.equal(session.state.sourceImportedWorksheetId, importedRecords[0].localId);
  assert.equal(session.state.viewerPayload.title, 'Package worksheet');
});

test('startImportedWorksheetFromPackageFile persists packaged assets into localAssets store', async () => {
  const mod = await loadViewerModule({
    parseWorksheetPackage: () => ({
      worksheet: {
        title: 'Package worksheet with media',
        blocks: [
          {
            blockId: 'q1',
            kind: 'question',
            position: 0,
            prompt: { text: 'Listen', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_audio_1' }] },
            responseConfig: { inputType: 'text' },
          },
        ],
      },
      assets: [
        {
          assetId: 'asset_audio_1',
          usage: 'question_audio',
          kind: 'audio',
          mimeType: 'audio/mpeg',
          path: 'media/asset_audio_1.mp3',
          binary: new Uint8Array([1, 2, 3]),
        },
      ],
    }),
  });
  const persistedAssets = [];
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    localAssets: {
      put: async (record) => {
        persistedAssets.push(record);
        return record;
      },
    },
    importedWorksheets: { put: async (record) => record },
    resumeFlags: { set: () => {}, get: () => null },
  });

  await session.startImportedWorksheetFromPackageFile(new ArrayBuffer(0));
  clearTimeout(session.autosaveTimer);

  assert.equal(persistedAssets.length, 1);
  assert.equal(persistedAssets[0].localId, 'asset_audio_1');
  assert.deepEqual(Array.from(persistedAssets[0].binary), [1, 2, 3]);
  assert.equal(persistedAssets[0].metadata.origin, 'imported_package_asset');
  assert.equal(persistedAssets[0].metadata.mimeType, 'audio/mpeg');
});

test('startImportedWorksheetFromPackageFile does not persist assets when payload validation fails', async () => {
  const mod = await loadViewerModule({
    validateViewerPayloadSchema: () => ({ valid: false, errors: ['bad payload'] }),
    parseWorksheetPackage: () => ({
      worksheet: {
        title: 'Invalid worksheet with media',
        blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: { inputType: 'text' } }],
      },
      assets: [{ assetId: 'asset_bad_1', binary: new Uint8Array([9, 9, 9]), usage: 'question_audio', kind: 'audio' }],
    }),
  });

  let importedPutCalls = 0;
  let assetPutCalls = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    localAssets: {
      put: async (record) => {
        assetPutCalls += 1;
        return record;
      },
      remove: async () => {},
    },
    importedWorksheets: {
      put: async (record) => {
        importedPutCalls += 1;
        return record;
      },
      remove: async () => {},
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  await assert.rejects(
    () => session.startImportedWorksheetFromPackageFile(new ArrayBuffer(0)),
    /Viewer payload validation failed: bad payload/
  );

  assert.equal(importedPutCalls, 0);
  assert.equal(assetPutCalls, 0);
});

test('startImportedWorksheetFromJsonText returns friendly parse/schema errors', async () => {
  const mod = await loadViewerModule();
  let putCalls = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: {
      put: async (record) => {
        putCalls += 1;
        return record;
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  await assert.rejects(
    () => session.startImportedWorksheetFromJsonText('{bad json'),
    /Unable to parse worksheet JSON\./
  );
  assert.equal(putCalls, 0);

  await assert.rejects(
    () => session.startImportedWorksheetFromJsonText(JSON.stringify({ title: 'Invalid worksheet', blocks: [] })),
    /Imported worksheet is invalid\./
  );
  assert.equal(putCalls, 0);
});

test('startImportedWorksheetFromPackageFile returns friendly invalid-package errors', async () => {
  const mod = await loadViewerModule({
    parseWorksheetPackage: () => {
      throw new Error('missing required file manifest.json');
    },
  });
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { put: async (record) => record },
    resumeFlags: { set: () => {}, get: () => null },
  });

  await assert.rejects(
    () => session.startImportedWorksheetFromPackageFile(new Uint8Array([1, 2, 3])),
    /Unable to import worksheet package\. missing required file manifest\.json/
  );
});

test('viewer autosave emits state transitions and clears pending state without extra clicks', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (v) => v },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.localAttemptId = 'attempt_emit';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };
  session.state.attemptRevision = 1;

  let emissions = 0;
  session.setOnStateChange(() => {
    emissions += 1;
  });

  session.scheduleAutosave();
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  assert.equal(session.state.autosavePending, false);
  assert.ok(emissions >= 3, 'expected pending, success, and final state emissions');
});

test('viewer stores raw over-limit text in edit state and truncates in autosave/manual/finalize persistence', async () => {
  const mod = await loadViewerModule();
  const savedPayloads = [];
  const session = new mod.ViewerAttemptSession({
    attempts: {
      put: async (value) => {
        savedPayloads.push(value);
        return value;
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.localAttemptId = 'attempt_text_save';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Q' },
      responseConfig: { inputType: 'text', maxLength: 5 },
    }],
  };
  session.state.attemptRevision = 1;

  session.setAnswer('q1', 'abcdefghij');
  assert.equal(session.state.answers.q1.value, 'abcdefghij');

  clearTimeout(session.autosaveTimer);
  await session.autosave();
  assert.equal(savedPayloads[0].answers.q1.value, 'abcde');

  await session.saveNow();
  assert.equal(savedPayloads[1].answers.q1.value, 'abcde');

  await session.completeLocalAttempt();
  assert.equal(savedPayloads[2].answers.q1.value, 'abcde');
});

test('viewer autosave keeps newest save status when older save finishes later', async () => {
  const mod = await loadViewerModule();
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const first = deferred();
  const second = deferred();
  let call = 0;

  const session = new mod.ViewerAttemptSession({
    attempts: {
      put: async (value) => {
        call += 1;
        if (call === 1) {
          await first.promise;
          return { ...value, metadata: { ...(value.metadata || {}), updatedAt: '2026-01-01T00:00:01.000Z' } };
        }
        await second.promise;
        return { ...value, metadata: { ...(value.metadata || {}), updatedAt: '2026-01-01T00:00:02.000Z' } };
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.localAttemptId = 'attempt_race';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };
  session.state.attemptRevision = 1;
  const save1 = session.autosave();

  session.state.attemptRevision = 2;
  const save2 = session.autosave();

  second.resolve();
  await save2;
  first.resolve();
  await save1;

  assert.equal(session.state.lastSavedRevision, 2);
  assert.equal(session.state.lastSavedAt, '2026-01-01T00:00:02.000Z');
});

test('viewer save error clears after subsequent successful save', async () => {
  const mod = await loadViewerModule();
  let shouldFail = true;
  const session = new mod.ViewerAttemptSession({
    attempts: {
      put: async (value) => {
        if (shouldFail) {
          throw new Error('db unavailable');
        }
        return value;
      },
    },
    resumeFlags: { set: () => {}, get: () => null },
  });

  session.state.localAttemptId = 'attempt_retry';
  session.state.viewerPayload = {
    worksheetId: 'ws',
    snapshotId: 'snap',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
  };
  session.state.attemptRevision = 1;

  await assert.rejects(() => session.autosave(), /db unavailable/);
  assert.equal(session.state.lastSaveError, 'db unavailable');

  shouldFail = false;
  await session.autosave();
  assert.equal(session.state.lastSaveError, null);
});

test('bootstrap with no launch params resumes attempt from resume flag localId', async () => {
  const mod = await loadViewerModule({
    window: {
      location: {
        search: '',
      },
    },
  });

  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async (localId) => {
        assert.equal(localId, 'attempt_from_flag');
        return {
          localId: 'attempt_from_flag',
          viewerPayload: {
            worksheetId: 'flag_ws',
            snapshotId: 'flag_snap',
            blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Resume me' }, responseConfig: {} }],
          },
          answers: { q1: { value: 'saved answer' } },
          metadata: { origin: 'resume_flag' },
        };
      },
    },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => ({ localId: 'attempt_from_flag' }), set: () => {} },
  });

  await session.bootstrap();

  assert.equal(session.state.localAttemptId, 'attempt_from_flag');
  assert.equal(session.state.viewerPayload.worksheetId, 'flag_ws');
  assert.equal(session.state.answers.q1.value, 'saved answer');
});

test('bootstrap with no launch params errors with NO_CONTENT_SOURCE when resume flag attempt is missing', async () => {
  const mod = await loadViewerModule({
    window: {
      location: {
        search: '',
      },
    },
  });

  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => null,
      put: async (value) => value,
    },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => ({ localId: 'attempt_missing' }), set: () => {} },
  });

  await assert.rejects(() => session.bootstrap(), (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.NO_CONTENT_SOURCE);
});

test('bootstrap ignores window.__VIEWER_PAYLOAD__ when query launch params are missing', async () => {
  const mod = await loadViewerModule({
    window: {
      __VIEWER_PAYLOAD__: JSON.stringify({
        worksheetId: 'legacy_ws',
        snapshotId: 'legacy_snap',
        blocks: [{ blockId: 'legacy_q1', kind: 'question', position: 0, prompt: { text: 'Legacy' }, responseConfig: {} }],
      }),
      location: {
        search: '',
      },
    },
  });

  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => null,
      put: async (value) => value,
    },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(() => session.bootstrap(), (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.NO_CONTENT_SOURCE);
});

test('bootstrap prefers localDraftId preview over resume flag session', async () => {
  const mod = await loadViewerModule({
    window: {
      location: {
        search: '?localDraftId=draft_latest&preview=1',
      },
    },
  });

  let resumedAttemptReads = 0;
  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => {
        resumedAttemptReads += 1;
        return {
          localId: 'attempt_old',
          viewerPayload: {
            worksheetId: 'old_ws',
            snapshotId: 'old_snap',
            blocks: [{ blockId: 'q_old', kind: 'question', position: 0, prompt: { text: 'Old' }, responseConfig: {} }],
          },
          answers: {},
          metadata: { origin: 'resume_flag' },
        };
      },
      put: async (value) => value,
    },
    drafts: {
      get: async (localId) => {
        assert.equal(localId, 'draft_latest');
        return {
          localId: 'draft_latest',
          title: 'Latest draft',
          blocks: [{ blockId: 'q_new', kind: 'question', position: 0, prompt: { text: 'New' }, responseConfig: {} }],
        };
      },
    },
    importedWorksheets: { get: async () => null },
    resumeFlags: {
      get: () => ({ localId: 'attempt_old' }),
      set: () => {},
    },
  });

  await session.bootstrap();
  clearTimeout(session.autosaveTimer);

  assert.equal(resumedAttemptReads, 0);
  assert.equal(session.state.source, 'local_draft_preview');
  assert.equal(session.state.viewerPayload.worksheetId, 'draft_latest');
});

test('bootstrap resumes explicit localAttemptId before loading draft sources', async () => {
  const mod = await loadViewerModule({
    window: {
      location: {
        search: '?localAttemptId=attempt_explicit&localDraftId=draft_latest&preview=1',
      },
    },
  });

  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async (localId) => {
        assert.equal(localId, 'attempt_explicit');
        return {
          localId: 'attempt_explicit',
          viewerPayload: {
            worksheetId: 'explicit_ws',
            snapshotId: 'explicit_snap',
            blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Resume me' }, responseConfig: {} }],
          },
          answers: { q1: { value: 'saved' } },
          metadata: { origin: 'local_attempt' },
        };
      },
    },
    drafts: {
      get: async () => {
        throw new Error('draft lookup should not be called for explicit localAttemptId');
      },
    },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => ({ localId: 'attempt_from_flag' }), set: () => {} },
  });

  await session.bootstrap();

  assert.equal(session.state.localAttemptId, 'attempt_explicit');
  assert.equal(session.state.viewerPayload.worksheetId, 'explicit_ws');
  assert.equal(session.state.answers.q1.value, 'saved');
});

test('tryResumeAttempt reconstructs payload from source metadata and overlays matching answers only', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => ({
        localId: 'attempt_src',
        sourceType: 'local_draft',
        sourceLocalDraftId: 'draft_1',
        viewerPayload: {
          worksheetId: 'legacy_ws',
          snapshotId: 'legacy_snap',
          blocks: [{ blockId: 'legacy_q', kind: 'question', position: 0, prompt: { text: 'Old' }, responseConfig: {} }],
        },
        answers: {
          q1: { value: 'answer-1' },
          orphan: { value: 'should-drop' },
        },
        studentName: 'Casey Student',
      }),
    },
    drafts: {
      get: async () => ({
        localId: 'draft_1',
        title: 'Fresh draft',
        blocks: [
          { blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} },
          { blockId: 'q2', kind: 'question', position: 1, prompt: { text: 'Q2' }, responseConfig: {} },
        ],
      }),
    },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  const resumed = await session.tryResumeAttempt('attempt_src');
  assert.equal(resumed, true);
  assert.equal(session.state.viewerPayload.worksheetId, 'draft_1');
  assert.equal(session.state.answers.q1.value, 'answer-1');
  assert.equal(session.state.answers.orphan, undefined);
  assert.equal(session.state.studentName, 'Casey Student');
});

test('bootstrap hard-fails when explicit localAttemptId cannot resume even with preview params', async () => {
  const mod = await loadViewerModule({
    window: {
      location: {
        search: '?localAttemptId=attempt_explicit&localDraftId=draft_latest&preview=1&draftUpdatedAt=2026-03-31T10:00:00.000Z',
      },
    },
  });

  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => ({
        localId: 'attempt_explicit',
        viewerPayload: {
          worksheetId: 'stale_ws',
          snapshotId: 'stale_snap',
          blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Old' }, responseConfig: {} }],
        },
        answers: { q1: { value: 'stale answer' } },
        metadata: { origin: 'local_attempt', sourceDraftUpdatedAt: '2026-03-31T09:00:00.000Z' },
      }),
      put: async (value) => value,
    },
    drafts: {
      get: async () => ({
        localId: 'draft_latest',
        title: 'Latest draft',
        metadata: { updatedAt: '2026-03-31T10:00:00.000Z' },
        blocks: [{ blockId: 'q_new', kind: 'question', position: 0, prompt: { text: 'New' }, responseConfig: {} }],
      }),
    },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.bootstrap(),
    (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.LOCAL_ATTEMPT_RESUME_FAILED
  );
});

test('bootstrap hard-fails when explicit localAttemptId cannot be resumed', async () => {
  const mod = await loadViewerModule({
    window: { location: { search: '?localAttemptId=missing_attempt' } },
  });
  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.bootstrap(),
    (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.LOCAL_ATTEMPT_RESUME_FAILED
  );
});

test('createLocalAttemptState persists sourceDraftUpdatedAt in attempt metadata', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });
  const payload = mod.normalizeViewerPayload({
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} }],
  });
  const attempt = session.createLocalAttemptState(payload, 'local_draft_preview', {
    sourceDraftUpdatedAt: '2026-03-31T11:00:00.000Z',
    sourceLocalDraftId: 'draft_11',
  });

  assert.equal(attempt.metadata.sourceDraftUpdatedAt, '2026-03-31T11:00:00.000Z');
  assert.equal(attempt.sourceType, 'local_draft_preview');
  assert.equal(attempt.sourceLocalDraftId, 'draft_11');
  assert.equal(attempt.worksheetId, 'ws_1');
  assert.equal(attempt.snapshotId, 'snap_1');
});

test('autosave persists new attempt linkage fields', async () => {
  const mod = await loadViewerModule();
  let persisted = null;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => { persisted = value; return value; } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.localAttemptId = 'attempt_1';
  session.state.viewerPayload = {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} }],
  };
  session.state.sourceType = 'imported_worksheet';
  session.state.sourceImportedWorksheetId = 'imported_1';
  session.state.studentName = 'Student A';
  session.state.lastActiveBlockId = 'q1';
  session.state.lastActiveIndex = 0;
  session.state.attemptRevision = 1;

  await session.autosave();
  assert.equal(persisted.sourceType, 'imported_worksheet');
  assert.equal(persisted.sourceImportedWorksheetId, 'imported_1');
  assert.equal(persisted.studentName, 'Student A');
  assert.equal(persisted.lastActiveBlockId, 'q1');
});

test('computeResumeStartBlockIndex prioritizes lastActiveBlockId then first unanswered then zero', async () => {
  const mod = await loadViewerModule();
  const payload = {
    blocks: [
      { blockId: 'q1', kind: 'question', position: 0 },
      { blockId: 'q2', kind: 'question', position: 1 },
      { blockId: 'q3', kind: 'question', position: 2 },
    ],
  };

  assert.equal(mod.computeResumeStartBlockIndex(payload, {}, { lastActiveBlockId: 'q2' }), 1);
  assert.equal(mod.computeResumeStartBlockIndex(payload, { q1: { value: 'done' } }, {}), 1);
  assert.equal(mod.computeResumeStartBlockIndex(payload, {
    q1: { value: 'done' }, q2: { value: 'done' }, q3: { value: 'done' },
  }, {}), 0);
});

test('tryResumeAttempt supports legacy schema by falling back to stored viewerPayload and metadata student name', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: {
      get: async () => ({
        localId: 'attempt_legacy',
        viewerPayload: {
          worksheetId: 'ws_legacy',
          snapshotId: 'snap_legacy',
          blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} }],
        },
        answers: { q1: { value: 'legacy answer' } },
        metadata: { origin: 'local_source', studentName: 'Legacy Name' },
      }),
    },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  const resumed = await session.tryResumeAttempt('attempt_legacy');
  assert.equal(resumed, true);
  assert.equal(session.state.viewerPayload.worksheetId, 'ws_legacy');
  assert.equal(session.state.studentName, 'Legacy Name');
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

test('computeAnswerSummary treats empty multi-select arrays as unanswered', async () => {
  const mod = await loadViewerModule();
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
      ],
    },
    {
      q1: { value: [] },
      q2: { value: ['a'] },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 2 });
});

test('getInputHelperText maps input types to guidance', async () => {
  const mod = await loadViewerModule();
  assert.equal(
    mod.getInputHelperText('number', { min: 1, max: 5 }),
    'Enter integer/decimal only (fractions like 2/3 are not supported). Range: minimum 1, maximum 5.'
  );
  assert.equal(
    mod.getInputHelperText('multiple_choice', { selectionMode: 'single' }),
    'Choose one option only.'
  );
  assert.equal(
    mod.getInputHelperText('multiple_choice', { selectionMode: 'multi' }),
    'Choose one or more options.'
  );
  assert.equal(mod.getInputHelperText('multiple_choice'), 'Choose one option only.');
  assert.equal(mod.getInputHelperText('boolean'), 'Choose True / False.');
  assert.equal(mod.getInputHelperText('text'), 'Text response.');
});

test('getNumberInputErrorMessage reports range and rule errors without coercion', async () => {
  const mod = await loadViewerModule();
  const responseConfig = {
    min: 1,
    max: 5,
    numberRules: {
      allowedKinds: ['integer', 'decimal'],
      allowSigned: false,
      decimalPlacesAllowed: 1,
    },
  };

  assert.deepEqual(mod.getNumberInputErrorMessage('0', responseConfig), {
    message: 'Value is below minimum (1).',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('6', responseConfig), {
    message: 'Value is above maximum (5).',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('+2', responseConfig), {
    message: 'Signed values are not allowed for this question.',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('1.23', responseConfig), {
    message: 'Too many decimal places for this question.',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('4.5', responseConfig), {
    message: '',
    normalizedValue: 4.5,
  });
});

test('getNumberInputErrorMessage ignores legacy step config', async () => {
  const mod = await loadViewerModule();
  const responseConfig = { min: 0, max: 10, step: 0.5 };

  assert.deepEqual(mod.getNumberInputErrorMessage('1.3', responseConfig), {
    message: '',
    normalizedValue: 1.3,
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('2.5', responseConfig), {
    message: '',
    normalizedValue: 2.5,
  });
});



test('renderCurrentBlockCard signature includes grading-derived fields and guarded check feedback rendering', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');

  assert.equal(source.includes('hasGlobalCheckResult = session.state.checkResult !== null;'), true);
  assert.equal(source.includes('currentBlockIsCheckable = isSupportedCheckQuestionBlock(currentBlock);'), true);
  assert.equal(source.includes('currentBlockCheckStatus = currentBlock?.blockId'), true);
  assert.equal(source.includes('currentBlockCheckStatus: hasCurrentBlockCheckStatus ? currentBlockCheckStatus : null,'), true);
  assert.equal(source.includes('const shouldShowCheckFeedback = hasGlobalCheckResult && currentBlockIsCheckable && hasCurrentBlockCheckStatus;'), true);
  assert.equal(source.includes('if (shouldShowCheckFeedback) {'), true);
});
test('number rendering branch avoids text input min/max attributes and uses pattern hint', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes("if (Number.isFinite(block.responseConfig?.min)) control.min"), false);
  assert.equal(source.includes("if (Number.isFinite(block.responseConfig?.max)) control.max"), false);
  assert.equal(source.includes('control.pattern ='), true);
  assert.equal(source.includes('control.title ='), true);
  assert.equal(source.includes("'Enter a valid integer or decimal number for this question.'"), false);
});

test('boolean rendering branch uses aria-labelledby and only labelable controls receive htmlFor', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes("label.id = `${controlId}-label`;"), true);
  assert.equal(source.includes("control.setAttribute('aria-labelledby', label.id);"), true);
  assert.equal(source.includes("control.setAttribute('aria-label', 'Choose True or False');"), false);
  assert.equal(source.includes("if (control.matches('input, select, textarea'))"), true);
  assert.equal(source.includes("const normalizedCurrentValue = coerceAnswerValueByInputType('boolean', currentValue);"), true);
});

test('createInputErrorNode applies stable id and live region semantics', async () => {
  const created = [];
  const mod = await loadViewerModule({
    document: {
      getElementById: () => null,
      createElement: (tag) => {
        const node = {
          tagName: tag,
          className: '',
          textContent: '',
          id: '',
          attrs: {},
          setAttribute(name, value) {
            this.attrs[name] = String(value);
          },
          getAttribute(name) {
            return this.attrs[name] ?? null;
          },
        };
        created.push(node);
        return node;
      },
    },
  });
  const node = mod.createInputErrorNode('answer-q1-error');
  assert.equal(created.length > 0, true);
  assert.equal(node.id, 'answer-q1-error');
  assert.equal(node.className, 'input-error');
  assert.equal(node.getAttribute('aria-live'), 'polite');
  assert.equal(node.getAttribute('role'), 'status');
});

test('ensureControlDescribedBy links control to existing error id without duplicates', async () => {
  const mod = await loadViewerModule();
  const control = {
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
  mod.ensureControlDescribedBy(control, 'answer-q1-error');
  mod.ensureControlDescribedBy(control, 'answer-q1-error');
  assert.equal(control.getAttribute('aria-describedby'), 'answer-q1-error');
});

test('clampTextAnswer enforces hard max length truncation', async () => {
  const mod = await loadViewerModule();
  assert.equal(mod.clampTextAnswer('abcdef', 4), 'abcd');
  assert.equal(mod.clampTextAnswer('abc', 10), 'abc');
  assert.equal(mod.clampTextAnswer('abc', null), 'abc');
});

test('clampTextAnswer handles non-integer finite maxLength via Math.trunc', async () => {
  const mod = await loadViewerModule();
  assert.equal(mod.clampTextAnswer('abcdef', 4.9), 'abcd');
  assert.equal(mod.clampTextAnswer('abcdef', 4.1), 'abcd');
  // Math.trunc(0.9) === 0, so no clamping occurs (treated as no valid limit)
  assert.equal(mod.clampTextAnswer('abcdef', 0.9), 'abcdef');
});

test('computeTextLengthFeedback returns normal, warning, and over-limit states', async () => {
  const mod = await loadViewerModule();
  assert.deepEqual(mod.computeTextLengthFeedback('abcd', 50), {
    current: 4,
    max: 50,
    remaining: 46,
    state: 'normal',
    statusText: '',
    counterText: '4/50',
  });
  assert.deepEqual(mod.computeTextLengthFeedback('x'.repeat(45), 50), {
    current: 45,
    max: 50,
    remaining: 5,
    state: 'warning',
    statusText: '5 characters remaining.',
    counterText: '45/50',
  });
  assert.deepEqual(mod.computeTextLengthFeedback('x'.repeat(55), 50), {
    current: 55,
    max: 50,
    remaining: -5,
    state: 'over',
    statusText: 'Over by 5 characters. On save, text will be truncated to 50.',
    counterText: '55/50',
  });
});

test('computeTextLengthFeedback handles non-integer finite maxLength via Math.trunc', async () => {
  const mod = await loadViewerModule();
  const result = mod.computeTextLengthFeedback('abcd', 50.7);
  assert.equal(result.max, 50);
  assert.equal(result.current, 4);
  assert.equal(result.counterText, '4/50');
});

test('computeTextLengthFeedback uses singular character when count is 1', async () => {
  const mod = await loadViewerModule();
  const warningResult = mod.computeTextLengthFeedback('x'.repeat(49), 50);
  assert.equal(warningResult.state, 'warning');
  assert.equal(warningResult.statusText, '1 character remaining.');

  const overResult = mod.computeTextLengthFeedback('x'.repeat(51), 50);
  assert.equal(overResult.state, 'over');
  assert.equal(overResult.statusText, 'Over by 1 character. On save, text will be truncated to 50.');
});

test('computeTextLengthFeedback uses plural characters when count is not 1', async () => {
  const mod = await loadViewerModule();
  const warningResult = mod.computeTextLengthFeedback('x'.repeat(45), 50);
  assert.equal(warningResult.statusText, '5 characters remaining.');

  const overResult = mod.computeTextLengthFeedback('x'.repeat(55), 50);
  assert.equal(overResult.statusText, 'Over by 5 characters. On save, text will be truncated to 50.');
});

test('updateTextCounterUI sets text and semantic classes', async () => {
  const mod = await loadViewerModule();
  const counterNode = { textContent: '', className: '' };
  const statusNode = { textContent: '', className: '' };
  mod.updateTextCounterUI(counterNode, statusNode, {
    counterText: '99/100',
    statusText: '1 character remaining.',
    state: 'warning',
  });
  assert.equal(counterNode.textContent, '99/100');
  assert.equal(counterNode.className, 'text-counter text-counter--warning');
  assert.equal(statusNode.textContent, '1 character remaining.');
  assert.equal(statusNode.className, 'text-counter-status text-counter-status--warning');
});

function createFakeDom() {
  class FakeNode {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.listeners = new Map();
      this.className = '';
      this.textContent = '';
      this.value = '';
      this.hidden = false;
      this.type = '';
      this.accept = '';
      this.files = null;
      this.attrs = {};
    }

    append(...nodes) {
      this.children.push(...nodes);
    }

    appendChild(node) {
      this.children.push(node);
      return node;
    }

    addEventListener(type, handler) {
      const existing = this.listeners.get(type) || [];
      existing.push(handler);
      this.listeners.set(type, existing);
    }

    async dispatch(type) {
      const handlers = this.listeners.get(type) || [];
      for (const handler of handlers) {
        await handler({ target: this });
      }
    }

    click() {}

    setAttribute(name, value) {
      this.attrs[name] = String(value);
    }
  }

  const appRoot = new FakeNode('div');
  const bottomBarRoot = new FakeNode('div');
  appRoot.id = 'app';
  bottomBarRoot.id = 'viewer-bottom-bar-root';

  const document = {
    getElementById(id) {
      if (id === 'app') return appRoot;
      if (id === 'viewer-bottom-bar-root') return bottomBarRoot;
      return null;
    },
    createElement(tag) {
      return new FakeNode(tag);
    },
  };

  return { document, appRoot, bottomBarRoot };
}

test('bootstrapViewer on bare /viewer/ opens start panel with explicit resume action instead of auto-resume', { concurrency: false }, async () => {
  const { document } = createFakeDom();
  let renderedSession = null;
  const attemptRecord = {
    localId: 'attempt_resume',
    status: 'in_progress',
    viewerPayload: {
      worksheetId: 'ws_1',
      snapshotId: 'snap_1',
      blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} }],
    },
    answers: {},
  };

  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/', search: '' },
      history: { replaceState: () => {} },
    },
    renderViewerShell: (session) => {
      renderedSession = session;
    },
    viewerStorage: {
      attempts: { get: async () => attemptRecord, put: async (value) => value },
      resumeFlags: { get: () => ({ localId: 'attempt_resume' }), set: () => {} },
      importedWorksheets: { get: async () => null },
      drafts: { get: async () => null },
    },
  });

  await mod.bootstrapViewer();

  assert.equal(renderedSession, null);
  const panel = document.getElementById('app').children[0];
  const hasResumeButton = panel.children.some((child) => child.className === 'viewer-resume-card');
  assert.equal(hasResumeButton, true);
});

test('renderViewerStartPanel package import flow updates URL with localAttemptId via replaceState', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  const replaceCalls = [];
  const session = {
    state: { localAttemptId: null },
    startImportedWorksheetFromPackageFile: async () => {
      session.state.localAttemptId = 'attempt_new';
    },
    startImportedWorksheetFromJsonText: async () => {
      throw new Error('json path should not run in this test');
    },
  };

  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/?auth=1', search: '?auth=1' },
      history: {
        replaceState: (...args) => replaceCalls.push(args),
      },
    },
    renderViewerShell: () => {},
    viewerStorage: {
      attempts: { get: async () => null, put: async (value) => value },
      resumeFlags: { get: () => null, set: () => {} },
      importedWorksheets: { get: async () => null },
      drafts: { get: async () => null },
    },
  });
  mod.renderViewerStartPanel(session);

  const fileInput = appRoot.children[0].children.find((child) => child.tagName === 'INPUT' && child.accept.includes('.zip'));
  fileInput.files = [{ arrayBuffer: async () => new ArrayBuffer(0) }];
  await fileInput.dispatch('change');

  assert.equal(replaceCalls.length, 1);
  const [, , nextUrl] = replaceCalls[0];
  assert.equal(String(nextUrl).includes('localAttemptId=attempt_new'), true);
  assert.equal(String(nextUrl).includes('auth=1'), true);
});

test('renderViewerStartPanel resume card prefers metadata.updatedAt when updatedAt is absent', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/', search: '' },
      history: { replaceState: () => {} },
    },
  });

  mod.renderViewerStartPanel({ state: {} }, {
    resumeAttempt: {
      localId: 'attempt_resume_meta',
      metadata: { updatedAt: '2026-04-02T03:04:05.000Z' },
      lastSavedAt: '2026-01-01T01:01:01.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const panel = appRoot.children[0];
  const resumeCard = panel.children.find((child) => child.className === 'viewer-resume-card');
  const resumeMeta = resumeCard.children.find((child) => child.className === 'muted');
  const expected = new Date('2026-04-02T03:04:05.000Z').toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  assert.equal(resumeMeta.textContent, `Attempt attempt_resume_meta · ${expected}`);
});

test('renderViewerStartPanel resume card strips fractional seconds in display timestamp', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/', search: '' },
      history: { replaceState: () => {} },
    },
  });

  mod.renderViewerStartPanel({ state: {} }, {
    resumeAttempt: {
      localId: 'attempt_resume_ms',
      metadata: { updatedAt: '2026-04-02T03:04:05.123Z' },
    },
  });

  const panel = appRoot.children[0];
  const resumeCard = panel.children.find((child) => child.className === 'viewer-resume-card');
  const resumeMeta = resumeCard.children.find((child) => child.className === 'muted');
  const expected = new Date('2026-04-02T03:04:05.123Z').toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  assert.equal(resumeMeta.textContent, `Attempt attempt_resume_ms · ${expected}`);
});

test('bootstrapViewer falls back to start panel when resume flag record is invalid', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/', search: '' },
      history: { replaceState: () => {} },
    },
    renderViewerShell: () => {
      throw new Error('should not render shell');
    },
    viewerStorage: {
      attempts: { get: async () => ({ localId: 'attempt_bad', status: 'completed' }) },
      resumeFlags: { get: () => ({ localId: 'attempt_bad' }), set: () => {} },
      importedWorksheets: { get: async () => null },
      drafts: { get: async () => null },
    },
  });

  await mod.bootstrapViewer();

  const panel = appRoot.children[0];
  const statusNode = panel.children.find((child) => child.className === 'viewer-start-error');
  assert.equal(statusNode.textContent, '');
});


test('bootstrap hard-fails with parse-specific errors for malformed explicit payload params', async () => {
  const mod = await loadViewerModule({
    window: { location: { search: '?viewerPayload=@@bad@@' } },
  });
  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.bootstrap(),
    (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.VIEWER_PAYLOAD_PARSE_FAILED
  );

  const snapshotMod = await loadViewerModule({
    window: { location: { search: '?snapshot=@@bad@@' } },
  });
  const snapshotSession = new snapshotMod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await assert.rejects(
    () => snapshotSession.bootstrap(),
    (error) => error?.code === snapshotMod.VIEWER_BOOT_ERROR_CODES.SNAPSHOT_PARSE_FAILED
  );
});

test('bootstrap hard-fails with typed not-found errors for explicit localDraftId/importedWorksheetId', async () => {
  const mod = await loadViewerModule({
    window: { location: { search: '?localDraftId=draft_missing' } },
  });
  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.bootstrap(),
    (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.LOCAL_DRAFT_NOT_FOUND
  );

  const importedMod = await loadViewerModule({
    window: { location: { search: '?importedWorksheetId=import_missing' } },
  });
  const importedSession = new importedMod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await assert.rejects(
    () => importedSession.bootstrap(),
    (error) => error?.code === importedMod.VIEWER_BOOT_ERROR_CODES.IMPORTED_WORKSHEET_NOT_FOUND
  );
});

test('bootstrap maps payload schema validation failures to INVALID_VIEWER_PAYLOAD', async () => {
  const mod = await loadViewerModule({
    window: { location: { search: '?viewerPayload=%7B%22blocks%22%3A%5B%7B%22kind%22%3A%22question%22%2C%22position%22%3A0%2C%22prompt%22%3A%7B%22text%22%3A%22Q%22%7D%2C%22responseConfig%22%3A%7B%7D%7D%5D%7D' } },
    validateViewerPayloadSchema: () => ({ valid: false, errors: ['missing worksheetId'] }),
  });

  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => null, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.bootstrap(),
    (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.INVALID_VIEWER_PAYLOAD
  );
});

test('bootstrapViewer renders start panel recovery warning for authReturn without restorable state and no content params', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  class FakeAuthGate {
    constructor({ onRecoveryMessage }) {
      this.onRecoveryMessage = onRecoveryMessage;
    }
    async restoreAfterAuthReturn() {
      if (this.onRecoveryMessage) {
        this.onRecoveryMessage('Session restore failed after sign-in.');
      }
      return { status: 'restore_failed' };
    }
  }

  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/?authReturn=1', search: '?authReturn=1' },
      history: { replaceState: () => {} },
    },
    SharedAuthGate: FakeAuthGate,
    renderViewerShell: () => {
      throw new Error('should not render shell for missing auth-return restore state');
    },
    viewerStorage: {
      attempts: { get: async () => null, put: async (value) => value },
      resumeFlags: { get: () => null, set: () => {} },
      importedWorksheets: { get: async () => null },
      drafts: { get: async () => null },
    },
  });

  await mod.bootstrapViewer();
  const panel = appRoot.children[0];
  const statusNode = panel.children.find((child) => child.className === 'viewer-start-error');
  assert.match(statusNode.textContent, /restore failed/i);
});

test('bootstrapViewer renders fatal panel for explicit localAttemptId resume failure and does not create synthetic attempt', { concurrency: false }, async () => {
  const { document, appRoot } = createFakeDom();
  let putCalls = 0;
  const mod = await loadViewerModule({
    document,
    window: {
      location: { href: 'https://example.test/viewer/?localAttemptId=missing_attempt', search: '?localAttemptId=missing_attempt' },
      history: { replaceState: () => {} },
    },
    renderViewerShell: () => {
      throw new Error('should not render shell');
    },
    viewerStorage: {
      attempts: {
        get: async () => null,
        put: async (value) => { putCalls += 1; return value; },
      },
      resumeFlags: { get: () => null, set: () => {} },
      importedWorksheets: { get: async () => null },
      drafts: { get: async () => null },
    },
  });

  await assert.rejects(async () => {
    try {
      await mod.bootstrapViewer();
    } catch (error) {
      mod.renderViewerFatalError(error);
      throw error;
    }
  }, (error) => error?.code === mod.VIEWER_BOOT_ERROR_CODES.LOCAL_ATTEMPT_RESUME_FAILED);

  const panel = appRoot.children[0];
  assert.equal(panel.className, 'viewer-fatal-panel');
  assert.equal(putCalls, 0);
});


test('areMultiSelectValuesEqual normalizes, deduplicates, and compares membership without sort/join', async () => {
  const mod = await loadViewerModule();

  assert.equal(mod.areMultiSelectValuesEqual(['a', 2, 'a', 2], ['2', 'a']), true);
  assert.equal(mod.areMultiSelectValuesEqual(['a', 'b'], ['b', 'a', 'a']), true);
  assert.equal(mod.areMultiSelectValuesEqual(['a', 'b'], ['a']), false);
  assert.equal(mod.areMultiSelectValuesEqual('a', ['a']), false);
});

test('computeCheckResult uses set membership for multi-select grading', async () => {
  const mod = await loadViewerModule();

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          correctAnswer: ['b', 'a', 'a'],
        },
      },
    ],
  };

  const resultMatch = mod.computeCheckResult(viewerPayload, {
    q1: { value: ['a', 'b', 'a'] },
  });
  const resultMiss = mod.computeCheckResult(viewerPayload, {
    q1: { value: ['a'] },
  });

  assert.equal(resultMatch.byBlockId.q1, true);
  assert.equal(resultMatch.correctCount, 1);
  assert.equal(resultMiss.byBlockId.q1, false);
  assert.equal(resultMiss.correctCount, 0);
});


test('ViewerAttemptSession initializes checkResult as null transient state', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => value },
    resumeFlags: { get: () => null, set: () => {} },
  });

  assert.equal(session.state.checkResult, null);
});

test('applyAttemptState and resume paths clear stale checkResult values', async () => {
  const mod = await loadViewerModule();
  const attemptRecord = {
    localId: 'attempt_resume_1',
    status: 'in_progress',
    checkResult: { correctCount: 2 },
    viewerPayload: {
      worksheetId: 'ws_1',
      snapshotId: 'snap_1',
      blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q' }, responseConfig: {} }],
    },
    answers: {},
    metadata: { origin: 'inline_payload', localId: 'attempt_resume_1', updatedAt: '2026-04-01T00:00:00.000Z' },
  };

  const session = new mod.ViewerAttemptSession({
    attempts: { get: async () => attemptRecord, put: async (value) => value },
    drafts: { get: async () => null },
    importedWorksheets: { get: async () => null },
    resumeFlags: { get: () => null, set: () => {} },
  });

  session.applyAttemptState(attemptRecord, { markDirty: false });
  assert.equal(session.state.checkResult, null);

  session.state.checkResult = { correctCount: 99 };
  const resumed = await session.tryResumeAttempt('attempt_resume_1');
  assert.equal(resumed, true);
  assert.equal(session.state.checkResult, null);
});

test('autosave payload does not persist transient checkResult', async () => {
  const mod = await loadViewerModule();
  let persisted = null;
  const session = new mod.ViewerAttemptSession({
    attempts: { put: async (value) => { persisted = value; return value; } },
    resumeFlags: { get: () => null, set: () => {} },
  });

  session.state.localAttemptId = 'attempt_transient';
  session.state.viewerPayload = {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Q1' }, responseConfig: {} }],
  };
  session.state.checkResult = { correctCount: 1, totalQuestions: 1 };
  session.state.attemptRevision = 1;

  await session.autosave();
  assert.equal(Object.hasOwn(persisted, 'checkResult'), false);
});


test('hasGradeableQuestions only returns true for question blocks with supported inputType and correctAnswer', async () => {
  const mod = await loadViewerModule();

  const noGradeable = {
    blocks: [
      { kind: 'content', blockId: 'c1' },
      { kind: 'question', blockId: 'q_text', responseConfig: { inputType: 'text', correctAnswer: 'x' } },
      { kind: 'question', blockId: 'q_unknown', responseConfig: { inputType: 'date', correctAnswer: '2026-01-01' } },
      { kind: 'question', blockId: 'q_missing', responseConfig: { inputType: 'number' } },
    ],
  };

  const hasGradeable = {
    blocks: [
      { kind: 'question', blockId: 'q_bool', responseConfig: { inputType: 'boolean', correctAnswer: true } },
    ],
  };

  assert.equal(mod.hasGradeableQuestions(noGradeable), false);
  assert.equal(mod.hasGradeableQuestions(hasGradeable), true);
});

test('computeCheckResult grades only supported input types with correctAnswer', async () => {
  const mod = await loadViewerModule();

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_multi',
        kind: 'question',
        responseConfig: { inputType: 'multiple_choice', selectionMode: 'multi', correctAnswer: ['a', 'b'] },
      },
      {
        blockId: 'q_bool',
        kind: 'question',
        responseConfig: { inputType: 'boolean', correctAnswer: true },
      },
      {
        blockId: 'q_number',
        kind: 'question',
        responseConfig: { inputType: 'number', correctAnswer: 3 },
      },
      {
        blockId: 'q_text',
        kind: 'question',
        responseConfig: { inputType: 'text', correctAnswer: 'hello' },
      },
      {
        blockId: 'q_unknown',
        kind: 'question',
        responseConfig: { inputType: 'date', correctAnswer: '2026-04-02' },
      },
      {
        blockId: 'q_missing',
        kind: 'question',
        responseConfig: { inputType: 'number' },
      },
    ],
  };

  const result = mod.computeCheckResult(viewerPayload, {
    q_multi: { value: ['b', 'a', 'a'] },
    q_bool: { value: true },
    q_number: { value: '3' },
    q_text: { value: 'hello' },
    q_unknown: { value: '2026-04-02' },
    q_missing: { value: 5 },
  });

  assert.deepEqual(Object.keys(result.byBlockId).sort(), ['q_bool', 'q_multi', 'q_number']);
  assert.deepEqual(result.statusByBlockId, {
    q_multi: 'correct',
    q_bool: 'correct',
    q_number: 'correct',
    q_missing: 'ungraded_missing_or_invalid_key',
  });
  assert.equal(result.correctCount, 3);
  assert.equal(result.totalQuestions, 3);
  assert.equal(Object.hasOwn(result, 'ungradedCount'), false);
});

test('computeCheckResult does not treat unanswered number input as 0 when correctAnswer is 0', async () => {
  const mod = await loadViewerModule();

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_number',
        kind: 'question',
        responseConfig: { inputType: 'number', correctAnswer: 0 },
      },
    ],
  };

  const resultEmpty = mod.computeCheckResult(viewerPayload, { q_number: { value: '' } });
  const resultNull = mod.computeCheckResult(viewerPayload, { q_number: { value: null } });
  const resultUndef = mod.computeCheckResult(viewerPayload, { q_number: { value: undefined } });
  const resultZero = mod.computeCheckResult(viewerPayload, { q_number: { value: '0' } });

  assert.equal(resultEmpty.byBlockId.q_number, false, 'empty string should not be correct');
  assert.equal(resultEmpty.correctCount, 0);
  assert.equal(resultNull.byBlockId.q_number, false, 'null should not be correct');
  assert.equal(resultNull.correctCount, 0);
  assert.equal(resultUndef.byBlockId.q_number, false, 'undefined should not be correct');
  assert.equal(resultUndef.correctCount, 0);
  assert.equal(resultZero.byBlockId.q_number, true, 'string "0" should be correct when correctAnswer is 0');
  assert.equal(resultZero.correctCount, 1);
});

test('getCheckRevealMessage uses explicit fallback when learner answer is empty', async () => {
  const mod = await loadViewerModule();

  const incorrectEmpty = mod.getCheckRevealMessage({
    status: 'incorrect',
    learnerAnswerText: '',
    correctAnswerText: 'A, B',
  });
  const incorrectWhitespace = mod.getCheckRevealMessage({
    status: 'incorrect',
    learnerAnswerText: '   ',
    correctAnswerText: 'True',
  });
  const correct = mod.getCheckRevealMessage({
    status: 'correct',
    learnerAnswerText: '',
    correctAnswerText: '4',
  });
  const ungradedMissingKey = mod.getCheckRevealMessage({
    status: 'ungraded_missing_or_invalid_key',
    learnerAnswerText: '',
    correctAnswerText: '',
  });

  assert.equal(incorrectEmpty, 'Your answer was: No answer submitted · Correct answer: A, B');
  assert.equal(incorrectWhitespace, 'Your answer was: No answer submitted · Correct answer: True');
  assert.equal(correct, 'Correct answer: 4');
  assert.equal(ungradedMissingKey, 'Your answer was: No answer submitted');
});

test('computeCheckResult marks gradeable missing key questions as ungraded without changing summary fields', async () => {
  const mod = await loadViewerModule();

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_missing_key',
        kind: 'question',
        responseConfig: { inputType: 'number' },
      },
      {
        blockId: 'q_graded',
        kind: 'question',
        responseConfig: { inputType: 'boolean', correctAnswer: true },
      },
    ],
  };

  const result = mod.computeCheckResult(viewerPayload, {
    q_missing_key: { value: '12' },
    q_graded: { value: false },
  });

  assert.equal(result.byBlockId.q_missing_key, undefined);
  assert.equal(result.statusByBlockId.q_missing_key, 'ungraded_missing_or_invalid_key');
  assert.equal(result.statusByBlockId.q_graded, 'incorrect');
  assert.deepEqual(Object.keys(result).sort(), ['byBlockId', 'correctCount', 'statusByBlockId', 'totalQuestions']);
  assert.equal(result.correctCount, 0);
  assert.equal(result.totalQuestions, 1);
});

test('render check feedback includes neutral ungraded banner copy and learner answer fallback', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');

  assert.equal(source.includes("checkTitle.textContent = isCorrect ? 'Correct' : isIncorrect ? 'Incorrect' : 'Not graded';"), true);
  assert.equal(source.includes("'Answer key missing or invalid for this question.'"), true);
  assert.equal(source.includes("status: checkStatus,"), true);
  assert.equal(source.includes("correctAnswerText: isUngradedMissingOrInvalidKey ? '' : formatCorrectAnswer(),"), true);
  assert.equal(source.includes("'Your answer was: No answer submitted'"), true);
});

test('viewer stylesheet defines neutral ungraded check banner styles', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.css'), 'utf8');
  assert.equal(source.includes('.viewer-check-banner.is-ungraded {'), true);
  assert.equal(source.includes('.viewer-check-banner.is-ungraded .viewer-check-banner__icon {'), true);
});

test('normalizeViewerBlock preserves prompt question media refs and option ids', async () => {
  const mod = await loadViewerModule();
  const normalized = mod.normalizeViewerBlock({
    blockId: 'q1',
    kind: 'question',
    position: 0,
    prompt: {
      text: 'With media',
      mediaRefs: [
        { usage: 'question_image', assetId: 'img_1' },
        { usage: 'question_audio', assetId: 'aud_1' },
      ],
    },
    responseConfig: {
      inputType: 'multiple_choice',
      options: [{ id: 'o1', value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
    },
  }, 0);
  assert.deepEqual(normalized.prompt.mediaRefs, [
    { usage: 'question_image', assetId: 'img_1' },
    { usage: 'question_audio', assetId: 'aud_1' },
  ]);
  assert.equal(normalized.responseConfig.options[0].id, 'o1');
  assert.equal(typeof normalized.responseConfig.options[1].id, 'string');
});

test('viewer playback enforces one active audio at a time', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    localAssets: { get: async () => ({ binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } }) },
    resumeFlags: { get: () => null, set: () => {} },
  });
  const instances = [];
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
  globalThis.Audio = class {
    constructor() {
      this.paused = false;
      instances.push(this);
    }
    addEventListener() {}
    async play() {}
    pause() { this.paused = true; }
    set src(_value) {}
  };
  const first = await session.playAssetAudio('a1');
  const second = await session.playAssetAudio('a2');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].paused, true);
});

test('viewer playback lifecycle hooks report start, ended, error, and interruption', async () => {
  const mod = await loadViewerModule();
  const session = new mod.ViewerAttemptSession({
    localAssets: { get: async () => ({ binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } }) },
    resumeFlags: { get: () => null, set: () => {} },
  });

  const urls = [];
  globalThis.URL = {
    createObjectURL: () => {
      const url = `blob:test:${urls.length}`;
      urls.push(url);
      return url;
    },
    revokeObjectURL: () => {},
  };

  const instances = [];
  globalThis.Audio = class {
    constructor() {
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    async play() {}
    pause() { this.paused = true; }
    set src(_value) {}
    emit(type) {
      this.listeners.get(type)?.();
    }
  };

  let started = 0;
  let ended = 0;
  let errored = 0;
  let interrupted = 0;

  const first = await session.playAssetAudio('a1', {
    onStart: () => { started += 1; },
    onEnded: () => { ended += 1; },
    onError: () => { errored += 1; },
    onInterrupted: () => { interrupted += 1; },
  });
  assert.equal(first.ok, true);
  assert.equal(started, 1);

  instances[0].emit('ended');
  assert.equal(ended, 1);

  const second = await session.playAssetAudio('a2', {
    onStart: () => { started += 1; },
    onEnded: () => { ended += 1; },
    onError: () => { errored += 1; },
    onInterrupted: () => { interrupted += 1; },
  });
  assert.equal(second.ok, true);
  instances[1].emit('error');
  assert.equal(errored, 1);

  const third = await session.playAssetAudio('a3', {
    onStart: () => { started += 1; },
    onEnded: () => { ended += 1; },
    onError: () => { errored += 1; },
    onInterrupted: () => { interrupted += 1; },
  });
  assert.equal(third.ok, true);
  const fourth = await session.playAssetAudio('a4');
  assert.equal(fourth.ok, true);
  assert.equal(interrupted, 1);
});

test('viewer playback race condition: last request wins when fetches resolve out of order', async () => {
  const mod = await loadViewerModule();

  let resolve1, resolve2;
  const makeAsset = () => ({ binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
  let callCount = 0;
  const session = new mod.ViewerAttemptSession({
    localAssets: {
      get: async () => {
        callCount++;
        if (callCount === 1) {
          return new Promise(r => { resolve1 = () => r(makeAsset()); });
        }
        return new Promise(r => { resolve2 = () => r(makeAsset()); });
      },
    },
    resumeFlags: { get: () => null, set: () => {} },
  });

  const instances = [];
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
  globalThis.Audio = class {
    constructor() {
      this.paused = false;
      instances.push(this);
    }
    addEventListener() {}
    async play() {}
    pause() { this.paused = true; }
    set src(_value) {}
  };

  // Start both requests concurrently without awaiting
  const p1 = session.playAssetAudio('a1');
  const p2 = session.playAssetAudio('a2');

  // Resolve the second fetch first (out of order), then the first.
  // setImmediate ensures all queued microtasks from resolve2 drain before resolve1 fires.
  resolve2();
  await new Promise(r => setImmediate(r));
  resolve1();

  const [r1, r2] = await Promise.all([p1, p2]);

  // The first request should be superseded by the second
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, true);
  // Only one audio instance should play
  assert.equal(instances.length, 1);
});

test('question prompt audio handler toggles disable state and does not persist success text', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes("if (questionAudioBtn.disabled) return;"), true);
  assert.equal(source.includes("questionAudioBtn.disabled = true;"), true);
  assert.equal(source.includes("onEnded: () => {\n            questionAudioBtn.disabled = false;"), true);
  assert.equal(source.includes("onError: () => {\n            questionAudioBtn.disabled = false;"), true);
  assert.equal(source.includes("setMediaFeedback(`Playing question audio (${questionAudioRef.assetId}).`);"), false);
});

test('choice option audio handler matches icon-button lifecycle behavior', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes("optionAudioBtn.className = 'choice-audio-btn question-card__prompt-audio-btn';"), true);
  assert.equal(source.includes("optionAudioBtn.textContent = '🔊';"), true);
  assert.equal(source.includes("if (optionAudioBtn.disabled) return;"), true);
  assert.equal(source.includes("optionAudioBtn.disabled = true;"), true);
  assert.equal(source.includes("onStart: () => {\n            optionAudioBtn.disabled = true;"), false);
  assert.equal(source.includes("onEnded: () => {\n            optionAudioBtn.disabled = false;"), true);
  assert.equal(source.includes("reportMediaFeedback(`Playing option audio (${optionAudioRef.assetId}).`);"), false);
});

test('viewer no-param bootstrap renders start panel with explicit resume controls', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes("textContent = 'Resume attempt';"), true);
  assert.equal(source.includes("textContent = 'Start fresh';"), false);
  assert.equal(source.includes("textContent = 'Discard attempt';"), true);
  assert.equal(source.includes('renderViewerStartPanel(session, {'), true);
});

test('viewer source binding blocks resume when source fingerprint or identity drifts', async () => {
  const source = await fs.readFile(path.resolve('server/viewer/main.js'), 'utf8');
  assert.equal(source.includes('expectedSourceId && expectedSourceId !== actualSourceId'), true);
  assert.equal(source.includes('expectedFingerprint && expectedFingerprint !== actualFingerprint'), true);
  assert.equal(source.includes('Saved attempt no longer matches this worksheet source. Start a new attempt.'), true);
});
