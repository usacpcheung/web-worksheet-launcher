import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function loadViewerModule(overrides = {}) {
  const filePath = path.resolve('server/viewer/main.js');
  let source = await fs.readFile(filePath, 'utf8');

  source = source.replace(
    "import { viewerStorage } from './storage/index.js';\nimport { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';\nimport { validateViewerPayloadSchema } from '../app/contracts/validators.js';\nimport { normalizeNumberRules, validateNumberInputFormat } from '../app/contracts/number-input-validator.js';\nimport { SharedAuthGate } from '../app/auth/shared-auth-gate.js';\n",
    'const viewerStorage = {};\nconst mapSnapshotToViewerPayload = globalThis.__mapSnapshotToViewerPayload;\nconst validateViewerPayloadSchema = (p) => ({ valid: true, errors: [] });\nconst normalizeNumberRules = globalThis.__normalizeNumberRules;\nconst validateNumberInputFormat = globalThis.__validateNumberInputFormat;\nconst SharedAuthGate = class {};\n'
  );

  source = source.replace(
    /bootstrapViewer\(\)\.catch\([\s\S]*?\);\n\nexport \{[\s\S]*?\};/,
    'export { ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock, computeAnswerSummary, partitionBlocksForDisplay, getInputHelperText, getNumberInputErrorMessage, coerceAnswerValueForQuestion, clampTextAnswer, computeTextLengthFeedback, updateTextCounterUI, getBooleanSelectionState, applyBooleanGroupState, getChoicePrefix, applyChoiceButtonGroupState, computeNextChoiceValue, deterministicShuffle, ensureControlDescribedBy, createInputErrorNode };'
  );

  globalThis.__mapSnapshotToViewerPayload = overrides.mapSnapshotToViewerPayload || ((v) => v);
  globalThis.__normalizeNumberRules = (rules) => ({
    allowedKinds: Array.isArray(rules?.allowedKinds) ? rules.allowedKinds : ['integer', 'decimal'],
    allowSigned: rules?.allowSigned !== false,
    decimalPlacesAllowed: Number.isInteger(rules?.decimalPlacesAllowed) ? rules.decimalPlacesAllowed : null,
  });
  globalThis.__validateNumberInputFormat = overrides.validateNumberInputFormat || ((value, rulesArg) => {
    const text = String(value ?? '').trim();
    if (!text) return { ok: false, errorCode: 'empty' };
    if (text.includes('/')) return { ok: false, errorCode: 'fraction_not_allowed' };
    const activeRules = globalThis.__normalizeNumberRules(rulesArg);
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
  });
  globalThis.document = overrides.document || { getElementById: () => null };
  globalThis.window = overrides.window || {};

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

test('normalizeViewerBlock migrates legacy single_choice to multiple_choice', async () => {
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

  assert.equal(normalized.responseConfig.inputType, 'multiple_choice');
  assert.equal(normalized.responseConfig.selectionMode, 'single');
  assert.deepEqual(normalized.responseConfig.options, [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'b' },
    { value: 'c', label: 'c' },
  ]);
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

test('normalizeViewerBlock migrates plain_text/short_text to text with defaults', async () => {
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

  assert.equal(plain.responseConfig.inputType, 'text');
  assert.equal(plain.responseConfig.maxLength, 200);
  assert.equal(plain.responseConfig.displayMode, 'multi_line');
  assert.equal(short.responseConfig.inputType, 'text');
  assert.equal(short.responseConfig.maxLength, 80);
  assert.equal(short.responseConfig.displayMode, 'single_line');
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
  assert.equal(source.includes('Finalizing submission…'), true);
  assert.equal(source.includes('Finalize failed. Please check your connection and try again.'), true);
  assert.equal(source.includes('Finalized'), true);
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

  const failedFinalize = await session.completeLocalAttempt();
  assert.equal(failedFinalize, null);
  assert.equal(session.state.status, 'in_progress');
  assert.equal(session.state.completedAt, null);
  assert.equal(session.state.isFinalizing, false);
  assert.match(session.state.lastFinalizeError, /Finalize failed\./);
  assert.match(session.state.lastFinalizeError, /db unavailable/);

  const successfulFinalize = await session.completeLocalAttempt();
  assert.deepEqual(successfulFinalize, { ok: true });
  assert.equal(session.state.status, 'completed');
  assert.equal(session.state.isFinalizing, false);
  assert.equal(session.state.lastFinalizeError, null);
  assert.equal(saveAttempts, 2);
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

test('bootstrap starts fresh preview attempt when draft freshness marker mismatches resumed attempt', async () => {
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

  await session.bootstrap();
  clearTimeout(session.autosaveTimer);

  assert.equal(session.state.source, 'local_draft_preview');
  assert.equal(session.state.viewerPayload.worksheetId, 'draft_latest');
  assert.equal(session.state.answers.q1, undefined);
  assert.equal(session.state.sourceDraftUpdatedAt, '2026-03-31T10:00:00.000Z');
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
  });

  assert.equal(attempt.metadata.sourceDraftUpdatedAt, '2026-03-31T11:00:00.000Z');
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
  assert.equal(mod.getInputHelperText('multiple_choice'), 'Choose one or more options.');
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
