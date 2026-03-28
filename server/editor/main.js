import { editorStorage } from './storage/index.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 800;
const QUESTION_MAX_LENGTH = 800;

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix = 'draft') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function buildBlankDraft() {
  const localId = createLocalId('draft');
  return {
    localId,
    title: '',
    question: '',
    answer: '',
    metadata: {
      localId,
      origin: 'server/editor',
      updatedAt: nowIso(),
    },
  };
}

function cloneDraft(draft) {
  if (typeof structuredClone === 'function') {
    return structuredClone(draft);
  }
  return JSON.parse(JSON.stringify(draft));
}

function validateQuestion(question) {
  const trimmed = String(question || '').trim();
  if (!trimmed) {
    return 'Question is required.';
  }
  if (trimmed.length > QUESTION_MAX_LENGTH) {
    return `Question must be ${QUESTION_MAX_LENGTH} characters or fewer.`;
  }
  return '';
}

class EditorRuntimeController {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.autosaveMs = Number.isFinite(options.autosaveMs) ? options.autosaveMs : AUTOSAVE_MS;
    this.state = {
      draft: null,
      dirty: false,
      saveStatus: 'Saving...',
      validationMessage: '',
    };
    this.autosaveTimer = null;
    this.dom = this.bindDom();
  }

  bindDom() {
    return {
      titleInput: app?.querySelector('#title-input') || null,
      questionInput: app?.querySelector('#question-input') || null,
      questionMeta: app?.querySelector('#question-meta') || null,
      questionValidation: app?.querySelector('#question-validation') || null,
      answerInput: app?.querySelector('#answer-input') || null,
      answerPreview: app?.querySelector('#answer-preview-output') || null,
      saveStatus: app?.querySelector('#save-status') || null,
    };
  }

  attachListeners() {
    this.dom.titleInput?.addEventListener('input', (event) => {
      this.updateField('title', event.target.value);
    });
    this.dom.questionInput?.addEventListener('input', (event) => {
      this.updateField('question', event.target.value);
    });
    this.dom.answerInput?.addEventListener('input', (event) => {
      this.updateField('answer', event.target.value);
    });
  }

  async init() {
    this.attachListeners();
    const latest = await this.storage.drafts.getLatest();
    const draft = latest || buildBlankDraft();

    if (!latest) {
      await this.storage.drafts.create(draft);
    }

    this.state.draft = draft;
    this.state.dirty = false;
    this.state.saveStatus = 'Saved';
    this.syncValidation();
    this.hydrateFields();
    this.updateUiState();
  }

  hydrateFields() {
    if (!this.state.draft) return;
    if (this.dom.titleInput) this.dom.titleInput.value = this.state.draft.title || '';
    if (this.dom.questionInput) this.dom.questionInput.value = this.state.draft.question || '';
    if (this.dom.answerInput) this.dom.answerInput.value = this.state.draft.answer || '';
  }

  updateField(field, value) {
    this.state.draft[field] = value;
    this.state.dirty = true;
    this.state.saveStatus = 'Unsaved changes';
    this.state.draft.metadata.updatedAt = nowIso();
    this.syncValidation();
    this.updateUiState();
    this.scheduleAutosave();
  }

  syncValidation() {
    this.state.validationMessage = validateQuestion(this.state.draft?.question || '');
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        this.state.saveStatus = `Save failed: ${error.message}`;
        this.updateUiState();
      });
    }, this.autosaveMs);
  }

  async autosave() {
    if (!this.state.dirty) return;

    this.state.saveStatus = 'Saving...';
    this.updateUiState();

    const saved = await this.storage.drafts.update(cloneDraft(this.state.draft));
    this.state.draft = saved;
    this.state.dirty = false;
    this.state.saveStatus = 'Saved';
    this.updateUiState();
  }

  updateUiState() {
    const questionLength = String(this.state.draft?.question || '').length;

    if (this.dom.questionMeta) {
      this.dom.questionMeta.textContent = `${questionLength} / ${QUESTION_MAX_LENGTH} characters`;
    }
    if (this.dom.questionValidation) {
      this.dom.questionValidation.textContent = this.state.validationMessage;
    }
    if (this.dom.answerPreview) {
      this.dom.answerPreview.textContent = this.state.draft?.answer || 'Answer preview will appear here.';
    }
    if (this.dom.saveStatus) {
      this.dom.saveStatus.textContent = this.state.saveStatus;
    }
  }
}

async function bootstrapEditor() {
  const controller = new EditorRuntimeController(editorStorage);
  await controller.init();
  return controller;
}

bootstrapEditor().catch((error) => {
  console.error('Editor bootstrap failed.', error);
  if (app) {
    app.innerHTML = `<p class="error-text">Editor failed to load: ${error.message}</p>`;
  }
});

export {
  EditorRuntimeController,
  AUTOSAVE_MS,
  QUESTION_MAX_LENGTH,
  buildBlankDraft,
  validateQuestion,
};
