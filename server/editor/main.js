import { editorStorage } from './storage/index.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';
const EXPORT_SCHEMA_VERSION = 2;
let contractsPromise;

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix = 'local') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function loadContracts() {
  if (!contractsPromise) {
    contractsPromise = import('../app/contracts/index.js');
  }
  return contractsPromise;
}

function createDefaultBlock(type = 'text_input', overrides = {}) {
  const safeType = ['text_input', 'multiple_choice', 'numeric'].includes(type) ? type : 'text_input';
  const base = {
    id: overrides.id || createLocalId('blk'),
    type: safeType,
    prompt: String(overrides.prompt || ''),
    config: {},
  };

  if (safeType === 'multiple_choice') {
    return {
      ...base,
      config: {
        options: Array.isArray(overrides?.config?.options)
          ? overrides.config.options.map((opt) => String(opt || ''))
          : ['', ''],
        allowMultiple: Boolean(overrides?.config?.allowMultiple),
        shuffle: Boolean(overrides?.config?.shuffle),
      },
    };
  }

  if (safeType === 'numeric') {
    const cfg = overrides?.config || {};
    return {
      ...base,
      config: {
        min: Number.isFinite(cfg.min) ? cfg.min : null,
        max: Number.isFinite(cfg.max) ? cfg.max : null,
        step: Number.isFinite(cfg.step) ? cfg.step : 1,
        integerOnly: Boolean(cfg.integerOnly),
        unitLabel: String(cfg.unitLabel || ''),
      },
    };
  }

  const cfg = overrides?.config || {};
  return {
    ...base,
    config: {
      placeholder: String(cfg.placeholder || ''),
      maxLength: Number.isFinite(cfg.maxLength) ? cfg.maxLength : 500,
      multiline: Boolean(cfg.multiline),
    },
  };
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [createDefaultBlock('text_input')];
  }

  return blocks.map((raw) => {
    if (!isRecord(raw)) return createDefaultBlock('text_input');

    if (raw.id && raw.type) {
      return createDefaultBlock(raw.type, raw);
    }

    const legacyKind = raw.kind;
    const promptText = String(raw?.prompt?.text || raw?.content?.text || raw.prompt || '');
    const inputType = raw?.responseConfig?.inputType;

    if (legacyKind === 'content') {
      return createDefaultBlock('text_input', {
        id: raw.blockId || raw.id,
        prompt: promptText,
        config: {
          placeholder: '',
          maxLength: 500,
          multiline: true,
        },
      });
    }

    if (inputType === 'single_choice') {
      return createDefaultBlock('multiple_choice', {
        id: raw.blockId || raw.id,
        prompt: promptText,
        config: {
          options: Array.isArray(raw?.responseConfig?.options)
            ? raw.responseConfig.options.map((opt) => String(opt?.label || opt?.value || ''))
            : ['', ''],
          allowMultiple: false,
          shuffle: false,
        },
      });
    }

    if (inputType === 'number') {
      return createDefaultBlock('numeric', {
        id: raw.blockId || raw.id,
        prompt: promptText,
      });
    }

    return createDefaultBlock('text_input', {
      id: raw.blockId || raw.id,
      prompt: promptText,
      config: {
        placeholder: '',
        maxLength: Number.isFinite(raw?.responseConfig?.maxLength) ? raw.responseConfig.maxLength : 500,
        multiline: false,
      },
    });
  });
}

function createDraftRecord(overrides = {}) {
  const localId = overrides.localId || createLocalId('draft');
  const updatedAt = nowIso();
  return {
    localId,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    worksheet: {
      title: String(overrides?.worksheet?.title || overrides.title || 'Untitled worksheet'),
      blocks: normalizeBlocks(overrides?.worksheet?.blocks || overrides.blocks),
    },
    metadata: {
      localId,
      origin: overrides.origin || 'local_created',
      createdAt: overrides?.metadata?.createdAt || updatedAt,
      updatedAt,
    },
  };
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function buildViewerUrlFromCurrentLocation(currentHref, localDraftId) {
  const viewerUrl = new URL('../viewer/', currentHref);
  viewerUrl.searchParams.set('localDraftId', localDraftId);
  return viewerUrl;
}

function validateWorksheet(worksheet) {
  const blockErrors = {};
  const worksheetErrors = [];
  const worksheetWarnings = [];

  if (!worksheet?.title?.trim()) {
    worksheetWarnings.push('Worksheet title is empty; export will still include "Untitled worksheet" if unchanged.');
  }

  if (!Array.isArray(worksheet?.blocks) || worksheet.blocks.length === 0) {
    worksheetErrors.push('Worksheet must contain at least one block.');
    return { valid: false, blockErrors, worksheetErrors, worksheetWarnings };
  }

  worksheet.blocks.forEach((block, index) => {
    const errors = [];
    if (!block.id) errors.push('Block id is missing.');
    if (!block.prompt?.trim()) errors.push('Prompt is required.');

    if (block.type === 'text_input') {
      const maxLength = block?.config?.maxLength;
      if (!Number.isFinite(maxLength) || maxLength <= 0) {
        errors.push('Text input max length must be greater than 0.');
      }
    } else if (block.type === 'multiple_choice') {
      const options = Array.isArray(block?.config?.options) ? block.config.options : [];
      const nonEmpty = options.map((opt) => String(opt || '').trim()).filter(Boolean);
      if (nonEmpty.length < 2) {
        errors.push('Multiple choice requires at least 2 non-empty options.');
      }
    } else if (block.type === 'numeric') {
      const min = block?.config?.min;
      const max = block?.config?.max;
      const step = block?.config?.step;
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
        errors.push('Numeric min must be less than or equal to max.');
      }
      if (!Number.isFinite(step) || step <= 0) {
        errors.push('Numeric step must be a positive number.');
      }
    } else {
      errors.push(`Unsupported block type: ${block.type}`);
    }

    if (errors.length) {
      blockErrors[block.id || `index_${index}`] = errors;
    }
  });

  const allBlockErrors = Object.values(blockErrors).flat();
  return {
    valid: worksheetErrors.length === 0 && allBlockErrors.length === 0,
    blockErrors,
    worksheetErrors,
    worksheetWarnings,
  };
}

class EditorDraftSession {
  constructor(storage) {
    this.storage = storage;
    this.state = {
      draft: null,
      selectedBlockId: null,
      mode: DEFAULT_MODE,
      hash: '',
      scrollToken: null,
      autosavePending: false,
      lastSavedAt: null,
      lastAutosaveStatus: 'idle',
      lastAutosaveError: null,
      validation: { valid: false, blockErrors: {}, worksheetErrors: [], worksheetWarnings: [] },
      lastExportedAt: null,
      lastImportedAt: null,
      draftRevision: 0,
      lastSavedRevision: 0,
      lastManualSaveAt: null,
      lastProtectedAction: null,
      recoveryMessage: null,
    };
    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (this.onStateChange) this.onStateChange(this.state);
  }

  validateCurrentDraft() {
    if (!this.state.draft?.worksheet) {
      this.state.validation = { valid: false, blockErrors: {}, worksheetErrors: ['No active draft.'], worksheetWarnings: [] };
      return this.state.validation;
    }
    this.state.validation = validateWorksheet(this.state.draft.worksheet);
    return this.state.validation;
  }

  async createOrOpenByLocalDraftId(localDraftId, options = {}) {
    const draftId = localDraftId || createLocalId('draft');
    let existing = null;
    if (localDraftId) {
      try {
        existing = await this.storage.drafts.get(localDraftId);
      } catch (error) {
        console.warn('Unable to read draft from IndexedDB.', error);
      }
    }

    this.state.draft = existing
      ? {
          ...existing,
          schemaVersion: EXPORT_SCHEMA_VERSION,
          worksheet: {
            title: String(existing?.worksheet?.title || existing?.title || 'Untitled worksheet'),
            blocks: normalizeBlocks(existing?.worksheet?.blocks || existing?.blocks),
          },
        }
      : createDraftRecord({ localId: draftId });

    this.state.selectedBlockId = options.selectedBlockId || this.state.draft.worksheet.blocks[0]?.id || null;
    this.state.mode = options.initialMode || DEFAULT_MODE;
    this.state.hash = options.hash || this.state.hash;
    this.state.scrollToken = options.scrollToken || this.state.scrollToken;
    this.state.draftRevision = 1;
    this.state.lastSavedRevision = existing ? 1 : 0;
    this.validateCurrentDraft();
    this.persistRestoreMetadata();
    if (!existing) this.scheduleAutosave();
    return this.state.draft;
  }

  get selectedBlock() {
    return this.state.draft?.worksheet?.blocks?.find((block) => block.id === this.state.selectedBlockId) || null;
  }

  touchDraft() {
    if (!this.state.draft) return;
    this.state.draftRevision += 1;
    this.state.draft.metadata = {
      ...this.state.draft.metadata,
      updatedAt: nowIso(),
    };
    this.validateCurrentDraft();
    this.scheduleAutosave();
    this.persistRestoreMetadata();
  }

  setWorksheetTitle(title) {
    if (!this.state.draft) return;
    this.state.draft.worksheet.title = String(title || '');
    this.touchDraft();
  }

  selectBlock(blockId) {
    this.state.selectedBlockId = blockId || null;
    this.persistRestoreMetadata();
    this.notifyStateChange();
  }

  addBlock(type) {
    if (!this.state.draft) return null;
    const block = createDefaultBlock(type);
    this.state.draft.worksheet.blocks = [...this.state.draft.worksheet.blocks, block];
    this.state.selectedBlockId = block.id;
    this.touchDraft();
    return block;
  }

  removeBlock(blockId) {
    if (!this.state.draft || !blockId) return;
    const next = this.state.draft.worksheet.blocks.filter((block) => block.id !== blockId);
    this.state.draft.worksheet.blocks = next.length ? next : [createDefaultBlock('text_input')];
    if (!this.state.draft.worksheet.blocks.some((block) => block.id === this.state.selectedBlockId)) {
      this.state.selectedBlockId = this.state.draft.worksheet.blocks[0].id;
    }
    this.touchDraft();
  }

  reorderBlock(blockId, direction) {
    if (!this.state.draft || !blockId) return;
    const idx = this.state.draft.worksheet.blocks.findIndex((block) => block.id === blockId);
    if (idx < 0) return;
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= this.state.draft.worksheet.blocks.length) return;
    const blocks = [...this.state.draft.worksheet.blocks];
    const [moved] = blocks.splice(idx, 1);
    blocks.splice(nextIdx, 0, moved);
    this.state.draft.worksheet.blocks = blocks;
    this.touchDraft();
  }

  updateSelectedBlockType(type) {
    if (!this.selectedBlock) return;
    const converted = createDefaultBlock(type, {
      id: this.selectedBlock.id,
      prompt: this.selectedBlock.prompt,
    });
    this.state.draft.worksheet.blocks = this.state.draft.worksheet.blocks.map((block) =>
      block.id === this.selectedBlock.id ? converted : block
    );
    this.touchDraft();
  }

  updateSelectedPrompt(prompt) {
    if (!this.selectedBlock) return;
    this.state.draft.worksheet.blocks = this.state.draft.worksheet.blocks.map((block) =>
      block.id === this.selectedBlock.id ? { ...block, prompt: String(prompt || '') } : block
    );
    this.touchDraft();
  }

  updateSelectedConfig(patch) {
    if (!this.selectedBlock || !isRecord(patch)) return;
    this.state.draft.worksheet.blocks = this.state.draft.worksheet.blocks.map((block) =>
      block.id === this.selectedBlock.id
        ? {
            ...block,
            config: {
              ...block.config,
              ...patch,
            },
          }
        : block
    );
    this.touchDraft();
  }

  updateChoiceOption(index, value) {
    if (!this.selectedBlock || this.selectedBlock.type !== 'multiple_choice') return;
    const options = [...this.selectedBlock.config.options];
    options[index] = String(value || '');
    this.updateSelectedConfig({ options });
  }

  addChoiceOption() {
    if (!this.selectedBlock || this.selectedBlock.type !== 'multiple_choice') return;
    this.updateSelectedConfig({ options: [...this.selectedBlock.config.options, ''] });
  }

  removeChoiceOption(index) {
    if (!this.selectedBlock || this.selectedBlock.type !== 'multiple_choice') return;
    const options = this.selectedBlock.config.options.filter((_, idx) => idx !== index);
    this.updateSelectedConfig({ options: options.length ? options : [''] });
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.state.autosavePending = true;
    this.state.lastAutosaveStatus = 'saving';
    this.notifyStateChange();
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  async autosave() {
    if (!this.state.draft) return null;
    const revisionAtStart = this.state.draftRevision;
    const snapshot = cloneValue({
      ...this.state.draft,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      metadata: {
        ...this.state.draft.metadata,
        updatedAt: nowIso(),
      },
    });

    const { validateDraftSchema } = await loadContracts();
    const contractValidation = validateDraftSchema({
      draftWorksheetId: snapshot.localId,
      title: snapshot.worksheet.title || 'Untitled worksheet',
      blocks: snapshot.worksheet.blocks.map((block, index) => ({
        blockId: block.id,
        kind: 'question',
        position: index,
        prompt: { text: block.prompt, format: 'plain_text' },
        responseConfig: { inputType: block.type },
      })),
    });
    snapshot.contractValidation = contractValidation;

    this.inFlightSaveCount += 1;
    try {
      const persisted = await this.storage.drafts.put(snapshot);
      if (revisionAtStart >= this.state.lastSavedRevision) {
        this.state.lastSavedRevision = revisionAtStart;
        this.state.lastSavedAt = nowIso();
        this.state.lastAutosaveStatus = contractValidation.valid ? 'saved' : 'saved_with_warnings';
        this.state.lastAutosaveError = null;
      }
      if (this.state.draftRevision === revisionAtStart) {
        this.state.draft = persisted;
      }
      return persisted;
    } catch (error) {
      if (revisionAtStart >= this.state.lastSavedRevision) {
        this.state.lastAutosaveStatus = 'error';
        this.state.lastAutosaveError = error?.message || String(error);
      }
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending = this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.draftRevision;
      this.notifyStateChange();
    }
  }

  async saveNow() {
    const persisted = await this.autosave();
    this.state.lastManualSaveAt = nowIso();
    return persisted;
  }

  parseImportedWorksheet(parsed) {
    if (!isRecord(parsed)) {
      throw new Error('Imported worksheet JSON must be an object.');
    }

    if (parsed.schemaVersion === EXPORT_SCHEMA_VERSION && isRecord(parsed.worksheet)) {
      return createDraftRecord({
        worksheet: {
          title: parsed.worksheet.title,
          blocks: parsed.worksheet.blocks,
        },
        origin: 'imported_file',
      });
    }

    if (Array.isArray(parsed.blocks) || Array.isArray(parsed?.worksheet?.blocks)) {
      return createDraftRecord({
        title: parsed.title || parsed?.worksheet?.title || 'Imported worksheet',
        blocks: parsed.blocks || parsed.worksheet.blocks,
        origin: 'imported_file',
      });
    }

    throw new Error('Unsupported worksheet structure. Expected schemaVersion+worksheet or blocks array.');
  }

  async importWorksheetJson(jsonInput, options = {}) {
    let parsed = jsonInput;
    if (typeof jsonInput === 'string') {
      try {
        parsed = JSON.parse(jsonInput);
      } catch (error) {
        throw new Error(`Imported worksheet JSON could not be parsed: ${error?.message || String(error)}`);
      }
    }

    const importedLocalId = createLocalId('imported');
    await this.storage.importedWorksheets.put({
      localId: importedLocalId,
      worksheet: parsed,
      metadata: { localId: importedLocalId, origin: 'imported_file', updatedAt: nowIso() },
    });

    if (options.convertToEditableDraft) {
      this.state.draft = this.parseImportedWorksheet(parsed);
      this.state.selectedBlockId = this.state.draft.worksheet.blocks[0]?.id || null;
      this.state.lastImportedAt = nowIso();
      this.state.draftRevision += 1;
      this.validateCurrentDraft();
      this.persistRestoreMetadata();
      this.scheduleAutosave();
      return { importedRecord: importedLocalId, draftRecord: this.state.draft };
    }

    return { importedRecord: importedLocalId, draftRecord: null };
  }

  exportCurrentDraftToFile() {
    if (!this.state.draft) throw new Error('No active draft to export.');
    const validation = this.validateCurrentDraft();
    if (!validation.valid) {
      const reasons = [...validation.worksheetErrors, ...Object.values(validation.blockErrors).flat()];
      throw new Error(`Export blocked: ${reasons.join('; ')}`);
    }

    const payload = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: nowIso(),
      worksheet: this.state.draft.worksheet,
      metadata: {
        localId: this.state.draft.localId,
      },
    };

    const filename = `worksheet-v${EXPORT_SCHEMA_VERSION}-${this.state.draft.localId}.json`;
    downloadJson(payload, filename);
    this.state.lastExportedAt = nowIso();
    return filename;
  }

  setMode(mode) {
    this.state.mode = mode || DEFAULT_MODE;
    this.persistRestoreMetadata();
    this.notifyStateChange();
  }

  getRouteUiRestoreMetadata() {
    return this.storage.resumeFlags.get(RESUME_FLAG_KEY);
  }

  getUiRestoreState() {
    return {
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken: this.state.scrollToken ?? (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
    };
  }

  async restoreByLocalId(localId) {
    if (!localId) return false;
    await this.createOrOpenByLocalDraftId(localId, this.getUiRestoreState());
    return true;
  }

  applyUiRestoreState(ui = {}) {
    this.state.mode = ui.mode ?? this.state.mode;
    this.state.selectedBlockId = ui.selectedBlockId ?? this.state.selectedBlockId;
    this.state.hash = ui.hash ?? this.state.hash;
    this.state.scrollToken = ui.scrollToken ?? this.state.scrollToken;
    this.persistRestoreMetadata();
  }

  async flushLocalStateForAuthRedirect() {
    if (this.state.lastSavedRevision < this.state.draftRevision) {
      return this.autosave();
    }
    return this.state.draft;
  }

  setRecoveryMessage(message) {
    this.state.recoveryMessage = message || null;
  }

  async replayProtectedAction(intent) {
    this.state.lastProtectedAction = intent.actionId;
    this.setRecoveryMessage(null);
  }

  async triggerProtectedAction(actionId) {
    if (!this.authGate) throw new Error('Auth gate is not configured for editor session.');
    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localDrafts',
      payload: { localDraftId: this.state.draft?.localId || null },
    });
  }

  persistRestoreMetadata() {
    if (!this.state.draft?.localId) return;
    this.storage.resumeFlags.set(RESUME_FLAG_KEY, {
      localId: this.state.draft.localId,
      store: 'localDrafts',
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken: this.state.scrollToken ?? (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
      updatedAt: nowIso(),
    });
  }
}

function renderEditorShell(session) {
  if (!app) return;

  app.innerHTML = `
    <div class="editor-shell">
      <header class="top-status" id="top-status"></header>
      <main class="editor-layout">
        <aside class="left-panel">
          <section class="panel-card">
            <h2>Block Library</h2>
            <div class="button-row">
              <button type="button" data-add="text_input">Add Text Input</button>
              <button type="button" data-add="multiple_choice">Add Multiple Choice</button>
              <button type="button" data-add="numeric">Add Numeric</button>
            </div>
          </section>
          <section class="panel-card">
            <h2>Worksheet Outline</h2>
            <ul class="block-list" id="block-list"></ul>
          </section>
          <section class="panel-card">
            <h2>Import / Export</h2>
            <textarea id="import-json" class="control" rows="7" placeholder="Paste worksheet JSON"></textarea>
            <div class="button-row">
              <button type="button" id="import-btn">Import JSON</button>
              <button type="button" id="export-btn">Export JSON</button>
            </div>
          </section>
        </aside>

        <section class="right-panel">
          <section class="panel-card">
            <h2>Active Block Editor</h2>
            <label>Worksheet title<input id="worksheet-title" class="control" /></label>
            <label>Block type
              <select id="block-type" class="control">
                <option value="text_input">text input</option>
                <option value="multiple_choice">multiple choice</option>
                <option value="numeric">numeric</option>
              </select>
            </label>
            <label>Prompt<textarea id="block-prompt" class="control" rows="4"></textarea></label>
            <div id="type-settings"></div>
            <div class="button-row">
              <button type="button" id="move-up">Move Up</button>
              <button type="button" id="move-down">Move Down</button>
              <button type="button" id="remove-block">Remove Block</button>
              <button type="button" id="save-now">Save Now</button>
              <button type="button" id="open-viewer">Open Viewer</button>
            </div>
          </section>

          <section class="panel-card" id="info-panel"></section>
          <section class="panel-card">
            <h2>Protected Actions (sign-in required)</h2>
            <div class="button-row">
              <button type="button" data-protected="resumeRewriteAfterLogin">Rewrite (Sign-in required)</button>
              <button type="button" data-protected="resumeT2AAfterLogin">T2A (Sign-in required)</button>
            </div>
          </section>
          <section class="panel-card">
            <h2>Validation / Errors</h2>
            <pre id="validation-panel" class="validation-box"></pre>
          </section>
        </section>
      </main>
    </div>
  `;

  const el = {
    status: app.querySelector('#top-status'),
    blockList: app.querySelector('#block-list'),
    title: app.querySelector('#worksheet-title'),
    blockType: app.querySelector('#block-type'),
    prompt: app.querySelector('#block-prompt'),
    typeSettings: app.querySelector('#type-settings'),
    infoPanel: app.querySelector('#info-panel'),
    validationPanel: app.querySelector('#validation-panel'),
    importJson: app.querySelector('#import-json'),
    importBtn: app.querySelector('#import-btn'),
    exportBtn: app.querySelector('#export-btn'),
    moveUp: app.querySelector('#move-up'),
    moveDown: app.querySelector('#move-down'),
    removeBlock: app.querySelector('#remove-block'),
    saveNow: app.querySelector('#save-now'),
    openViewer: app.querySelector('#open-viewer'),
  };

  const renderTypeSettings = () => {
    const selected = session.selectedBlock;
    if (!selected) {
      el.typeSettings.innerHTML = '<p class="muted">Select a block to edit settings.</p>';
      return;
    }

    if (selected.type === 'text_input') {
      el.typeSettings.innerHTML = `
        <h3>Text Input Settings</h3>
        <label>Placeholder<input id="cfg-placeholder" class="control" value="${selected.config.placeholder || ''}" /></label>
        <label>Max length<input id="cfg-max-length" type="number" min="1" class="control" value="${selected.config.maxLength || 500}" /></label>
        <label><input id="cfg-multiline" type="checkbox" ${selected.config.multiline ? 'checked' : ''}/> Multiline</label>
      `;
      el.typeSettings.querySelector('#cfg-placeholder').addEventListener('input', (e) => session.updateSelectedConfig({ placeholder: e.target.value }));
      el.typeSettings.querySelector('#cfg-max-length').addEventListener('input', (e) => {
        const parsed = Number.parseInt(e.target.value, 10);
        if (Number.isFinite(parsed)) session.updateSelectedConfig({ maxLength: parsed });
      });
      el.typeSettings.querySelector('#cfg-multiline').addEventListener('change', (e) => session.updateSelectedConfig({ multiline: e.target.checked }));
      return;
    }

    if (selected.type === 'multiple_choice') {
      const optionRows = selected.config.options
        .map((opt, idx) => `<div class="option-row"><input data-opt="${idx}" class="control mc-option" value="${String(opt || '')}"/><button type="button" data-rm-opt="${idx}">Remove</button></div>`)
        .join('');
      el.typeSettings.innerHTML = `
        <h3>Multiple Choice Settings</h3>
        <div class="mc-options">${optionRows}</div>
        <div class="button-row"><button type="button" id="add-opt">Add Option</button></div>
        <label><input id="cfg-allow-multi" type="checkbox" ${selected.config.allowMultiple ? 'checked' : ''}/> Allow multi-select</label>
        <label><input id="cfg-shuffle" type="checkbox" ${selected.config.shuffle ? 'checked' : ''}/> Shuffle options</label>
      `;
      el.typeSettings.querySelectorAll('.mc-option').forEach((input) => {
        input.addEventListener('input', (event) => {
          const idx = Number.parseInt(event.target.getAttribute('data-opt'), 10);
          session.updateChoiceOption(idx, event.target.value);
        });
      });
      el.typeSettings.querySelectorAll('[data-rm-opt]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          const idx = Number.parseInt(event.target.getAttribute('data-rm-opt'), 10);
          session.removeChoiceOption(idx);
        });
      });
      el.typeSettings.querySelector('#add-opt').addEventListener('click', () => session.addChoiceOption());
      el.typeSettings.querySelector('#cfg-allow-multi').addEventListener('change', (event) => session.updateSelectedConfig({ allowMultiple: event.target.checked }));
      el.typeSettings.querySelector('#cfg-shuffle').addEventListener('change', (event) => session.updateSelectedConfig({ shuffle: event.target.checked }));
      return;
    }

    el.typeSettings.innerHTML = `
      <h3>Numeric Settings</h3>
      <label>Min<input id="cfg-min" type="number" class="control" value="${selected.config.min ?? ''}" /></label>
      <label>Max<input id="cfg-max" type="number" class="control" value="${selected.config.max ?? ''}" /></label>
      <label>Step<input id="cfg-step" type="number" min="0.0001" step="any" class="control" value="${selected.config.step ?? 1}" /></label>
      <label>Unit label<input id="cfg-unit" class="control" value="${selected.config.unitLabel || ''}" /></label>
      <label><input id="cfg-int" type="checkbox" ${selected.config.integerOnly ? 'checked' : ''}/> Integer only</label>
    `;
    el.typeSettings.querySelector('#cfg-min').addEventListener('input', (e) => session.updateSelectedConfig({ min: e.target.value === '' ? null : Number(e.target.value) }));
    el.typeSettings.querySelector('#cfg-max').addEventListener('input', (e) => session.updateSelectedConfig({ max: e.target.value === '' ? null : Number(e.target.value) }));
    el.typeSettings.querySelector('#cfg-step').addEventListener('input', (e) => session.updateSelectedConfig({ step: Number(e.target.value) }));
    el.typeSettings.querySelector('#cfg-unit').addEventListener('input', (e) => session.updateSelectedConfig({ unitLabel: e.target.value }));
    el.typeSettings.querySelector('#cfg-int').addEventListener('change', (e) => session.updateSelectedConfig({ integerOnly: e.target.checked }));
  };

  const render = () => {
    const validation = session.validateCurrentDraft();
    const selected = session.selectedBlock;

    const saveState = session.state.lastAutosaveStatus === 'error'
      ? 'error'
      : session.state.autosavePending
        ? 'saving'
        : session.state.lastSavedRevision < session.state.draftRevision
          ? 'unsaved'
          : 'saved';

    el.status.innerHTML = `
      <div><strong>Status:</strong> ${saveState}</div>
      <div><strong>Last saved:</strong> ${session.state.lastSavedAt || 'Not yet saved'}</div>
      <div><strong>Autosave:</strong> ${session.state.lastAutosaveStatus}</div>
      <div><strong>Draft:</strong> ${session.state.draft?.localId || 'n/a'}</div>
      <div><strong>Error:</strong> ${session.state.lastAutosaveError || 'none'}</div>
    `;

    el.title.value = session.state.draft?.worksheet?.title || '';
    el.blockList.innerHTML = '';
    (session.state.draft?.worksheet?.blocks || []).forEach((block, idx) => {
      const li = document.createElement('li');
      li.className = `block-item ${block.id === session.state.selectedBlockId ? 'selected' : ''}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'block-select';
      btn.textContent = `${idx + 1}. ${block.type} — ${(block.prompt || '—').slice(0, 40)}`;
      btn.addEventListener('click', () => session.selectBlock(block.id));
      li.appendChild(btn);
      el.blockList.appendChild(li);
    });

    if (selected) {
      el.blockType.value = selected.type;
      el.prompt.value = selected.prompt;
    } else {
      el.prompt.value = '';
    }

    renderTypeSettings();

    const selectedErrors = selected ? (validation.blockErrors[selected.id] || []) : [];
    const worksheetIssues = [...validation.worksheetErrors, ...validation.worksheetWarnings];
    el.infoPanel.innerHTML = `
      <h2>Info & Validation Summary</h2>
      <p><strong>Selected type:</strong> ${selected?.type || 'none'}</p>
      <p><strong>Selected validity:</strong> ${selectedErrors.length ? 'invalid' : 'valid'}</p>
      <p><strong>Worksheet validity:</strong> ${validation.valid ? 'valid' : 'invalid'}</p>
      <p><strong>Worksheet issues:</strong> ${worksheetIssues.length}</p>
      <p><strong>Last autosave:</strong> ${session.state.lastSavedAt || 'Not yet saved'}</p>
    `;

    const actionable = [
      ...validation.worksheetErrors,
      ...Object.entries(validation.blockErrors).flatMap(([id, errs]) => errs.map((err) => `${id}: ${err}`)),
    ];
    el.validationPanel.textContent = actionable.length ? actionable.join('\n') : 'No blocking validation errors.';
    el.exportBtn.disabled = !validation.valid;
  };

  session.setOnStateChange(render);

  app.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => session.addBlock(btn.getAttribute('data-add')));
  });
  app.querySelectorAll('[data-protected]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await session.triggerProtectedAction(btn.getAttribute('data-protected'));
    });
  });

  el.title.addEventListener('input', () => session.setWorksheetTitle(el.title.value));
  el.blockType.addEventListener('change', () => session.updateSelectedBlockType(el.blockType.value));
  el.prompt.addEventListener('input', () => session.updateSelectedPrompt(el.prompt.value));
  el.moveUp.addEventListener('click', () => session.reorderBlock(session.state.selectedBlockId, 'up'));
  el.moveDown.addEventListener('click', () => session.reorderBlock(session.state.selectedBlockId, 'down'));
  el.removeBlock.addEventListener('click', () => session.removeBlock(session.state.selectedBlockId));
  el.saveNow.addEventListener('click', async () => { await session.saveNow(); render(); });
  el.importBtn.addEventListener('click', async () => {
    await session.importWorksheetJson(el.importJson.value, { convertToEditableDraft: true });
    el.importJson.value = '';
    render();
  });
  el.exportBtn.addEventListener('click', () => {
    session.exportCurrentDraftToFile();
    render();
  });
  el.openViewer.addEventListener('click', async () => {
    const localDraftId = session.state.draft?.localId;
    if (!localDraftId) return;
    await session.saveNow();
    const viewerUrl = buildViewerUrlFromCurrentLocation(window.location.href, localDraftId);
    window.location.assign(viewerUrl);
  });

  render();
}

async function bootstrapEditor() {
  const session = new EditorDraftSession(editorStorage);
  const params = new URLSearchParams(window.location.search);
  const initialRestore = session.getRouteUiRestoreMetadata();
  const localDraftId = params.get('localDraftId') || initialRestore?.localId || null;

  await session.createOrOpenByLocalDraftId(localDraftId, {
    initialMode: initialRestore?.mode || DEFAULT_MODE,
    selectedBlockId: initialRestore?.selectedBlockId || null,
    hash: initialRestore?.hash || window.location.hash || '',
    scrollToken: initialRestore?.scrollToken || null,
  });

  const authGate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: RESUME_FLAG_KEY,
    storage: session.storage,
    isAuthenticated: () => new URL(window.location.href).searchParams.get('auth') === '1',
    getCurrentLocalId: () => session.state.draft?.localId || null,
    getCurrentUiState: () => session.getUiRestoreState(),
    persistLocalRecord: () => session.flushLocalStateForAuthRedirect(),
    restoreByLocalId: (localIdToRestore) => session.restoreByLocalId(localIdToRestore),
    restoreUiState: (uiState) => session.applyUiRestoreState(uiState),
    validateIntent: (intent) => Boolean(intent?.actionId && session.state.draft?.localId),
    replayIntent: (intent) => session.replayProtectedAction(intent),
    onRecoveryMessage: (message) => session.setRecoveryMessage(message),
    redirectToAuth: ({ redirectTo }) => {
      const url = new URL(redirectTo);
      url.searchParams.set('auth', '1');
      window.location.assign(url.toString());
    },
  });

  session.authGate = authGate;
  await authGate.restoreAfterAuthReturn();

  session.persistRestoreMetadata();
  renderEditorShell(session);
  window.editorSession = session;
}

bootstrapEditor().catch((error) => {
  console.error('Failed to bootstrap editor', error);
  if (app) app.textContent = `Editor failed to boot: ${error.message}`;
});

export {
  EditorDraftSession,
  createDraftRecord,
  normalizeBlocks,
  validateWorksheet,
  createDefaultBlock,
  buildViewerUrlFromCurrentLocation,
};
