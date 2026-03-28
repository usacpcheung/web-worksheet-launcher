import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

function createElement() {
  return {
    value: '',
    textContent: '',
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    dispatchInput(value) {
      this.value = value;
      const handler = this.listeners.input;
      if (handler) {
        handler({ target: { value } });
      }
    },
  };
}

function createDomHarness() {
  const titleInput = createElement();
  const questionInput = createElement();
  const questionMeta = createElement();
  const questionValidation = createElement();
  const answerInput = createElement();
  const answerPreview = createElement();
  const saveStatus = createElement();

  const elements = {
    '#title-input': titleInput,
    '#question-input': questionInput,
    '#question-meta': questionMeta,
    '#question-validation': questionValidation,
    '#answer-input': answerInput,
    '#answer-preview-output': answerPreview,
    '#save-status': saveStatus,
  };

  const app = {
    querySelector(selector) {
      return elements[selector] || null;
    },
    innerHTML: '',
  };

  return { app, elements };
}

async function loadEditorModule() {
  const filePath = path.resolve('server/editor/main.js');
  let source = await fs.readFile(filePath, 'utf8');

  source = source.replace(
    "import { editorStorage } from './storage/index.js';\n",
    'const editorStorage = {};\n'
  );

  source = source.replace(
    /bootstrapEditor\(\)\.catch\([\s\S]*?\}\);\n\nexport \{/,
    'export {'
  );

  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}#${Date.now()}_${Math.random()}`;
  return import(dataUrl);
}

test('autosave writes updated draft after field edits', async () => {
  const { app, elements } = createDomHarness();
  globalThis.document = { getElementById: () => app };

  const mod = await loadEditorModule();

  const writeCalls = [];
  const storage = {
    drafts: {
      getLatest: async () => ({
        localId: 'draft_1',
        title: 'Before',
        question: 'Before Q',
        answer: 'Before A',
        metadata: { localId: 'draft_1', origin: 'server/editor', updatedAt: '2026-01-01T00:00:00.000Z' },
      }),
      create: async (record) => record,
      update: async (record) => {
        writeCalls.push(record);
        return record;
      },
    },
  };

  const controller = new mod.EditorRuntimeController(storage, { autosaveMs: 10 });
  await controller.init();

  elements['#title-input'].dispatchInput('After');
  elements['#question-input'].dispatchInput('After question');

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].title, 'After');
  assert.equal(writeCalls[0].question, 'After question');
  assert.equal(controller.state.saveStatus, 'Saved');
});

test('init restores latest draft into UI fields', async () => {
  const { app, elements } = createDomHarness();
  globalThis.document = { getElementById: () => app };

  const mod = await loadEditorModule();

  const latest = {
    localId: 'draft_latest',
    title: 'Recovered title',
    question: 'Recovered question',
    answer: 'Recovered answer',
    metadata: { localId: 'draft_latest', origin: 'server/editor', updatedAt: '2026-01-01T00:00:00.000Z' },
  };

  const controller = new mod.EditorRuntimeController({
    drafts: {
      getLatest: async () => latest,
      create: async (record) => record,
      update: async (record) => record,
    },
  });

  await controller.init();

  assert.equal(elements['#title-input'].value, 'Recovered title');
  assert.equal(elements['#question-input'].value, 'Recovered question');
  assert.equal(elements['#answer-input'].value, 'Recovered answer');
  assert.equal(controller.state.draft.localId, 'draft_latest');
});

test('blank draft model includes required metadata fields', async () => {
  const { app } = createDomHarness();
  globalThis.document = { getElementById: () => app };

  const mod = await loadEditorModule();
  const blank = mod.buildBlankDraft();

  assert.ok(blank.localId);
  assert.equal(blank.metadata.localId, blank.localId);
  assert.ok(blank.metadata.origin);
  assert.ok(blank.metadata.updatedAt);
});

test('validation returns message for empty question and clears for valid text', async () => {
  const { app, elements } = createDomHarness();
  globalThis.document = { getElementById: () => app };

  const mod = await loadEditorModule();

  assert.equal(mod.validateQuestion(''), 'Question is required.');
  assert.equal(mod.validateQuestion('Valid question'), '');

  const controller = new mod.EditorRuntimeController({
    drafts: {
      getLatest: async () => null,
      create: async (record) => record,
      update: async (record) => record,
    },
  });

  await controller.init();
  elements['#question-input'].dispatchInput('');

  assert.equal(controller.state.validationMessage, 'Question is required.');
  assert.equal(elements['#question-validation'].textContent, 'Question is required.');
});

test('validation reports too-long question', async () => {
  const { app } = createDomHarness();
  globalThis.document = { getElementById: () => app };

  const mod = await loadEditorModule();
  const tooLong = 'x'.repeat(mod.QUESTION_MAX_LENGTH + 1);

  assert.equal(
    mod.validateQuestion(tooLong),
    `Question must be ${mod.QUESTION_MAX_LENGTH} characters or fewer.`
  );
});
