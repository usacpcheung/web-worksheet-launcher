import { editorStorage } from './storage/index.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';
const DEFAULT_PUBLISHER_ID = 'local_editor';
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

function createEmptyQuestionBlock(position) {
  return {
    blockId: createLocalId('q'),
    kind: 'question',
    position,
    prompt: {
      text: '',
      format: 'plain_text',
    },
    responseConfig: {
      inputType: 'plain_text',
      maxLength: 500,
    },
  };
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [
      {
        blockId: createLocalId('blk'),
        kind: 'content',
        position: 0,
        content: {
          text: '',
          format: 'plain_text',
        },
      },
    ];
  }

  return blocks.map((block, index) => {
    const source = isRecord(block) ? { ...block } : {};
    const hasPrompt = isRecord(source.prompt);
    const base = {
      blockId: source.blockId || createLocalId('blk'),
      kind: source.kind || (hasPrompt ? 'question' : 'content'),
      position: Number.isFinite(source.position) ? source.position : index,
    };
    const normalized = { ...source, ...base };

    if (normalized.kind === 'question' || hasPrompt) {
      normalized.kind = 'question';
      const promptSource = isRecord(source.prompt) ? source.prompt : {};
      normalized.prompt = {
        ...promptSource,
        text: String(promptSource.text || ''),
        format: promptSource.format || 'plain_text',
      };
      normalized.responseConfig = isRecord(source.responseConfig)
        ? { ...source.responseConfig }
        : { inputType: 'plain_text', maxLength: 500 };
      return normalized;
    }

    const contentSource = isRecord(source.content) ? source.content : {};
    normalized.content = {
      ...contentSource,
      text: String(contentSource.text || ''),
      format: contentSource.format || 'plain_text',
    };
    return normalized;
  });
}


function getQuestionInputTypeHelpText(inputType) {
  const mapping = {
    plain_text: 'Long-form text response.',
    short_text: 'Short single-line text response.',
    number: 'Numeric response (stored as number when possible).',
    boolean: 'True/False response.',
    single_choice: 'Select exactly one option.',
  };
  return mapping[inputType] || '';
}

function createDraftRecord(overrides = {}) {
  const localId = overrides.localId || createLocalId('draft');
  const updatedAt = nowIso();

  return {
    localId,
    title: overrides.title || 'Untitled worksheet',
    blocks: normalizeBlocks(overrides.blocks),
    metadata: {
      localId,
      origin: overrides.origin || 'local_created',
      updatedAt,
      createdAt: overrides.metadata?.createdAt || updatedAt,
      serverLink: overrides.metadata?.serverLink || null,
    },
  };
}

function cloneDraftForPersistence(draft) {
  if (typeof structuredClone === 'function') {
    return structuredClone(draft);
  }

  return JSON.parse(JSON.stringify(draft));
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
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
      lastSaveError: null,
      validationErrors: [],
      blockValidation: {},
      lastManualSaveAt: null,
      lastExportedAt: null,
      lastImportedAt: null,
      publishPreview: null,
      draftRevision: 0,
      lastSavedRevision: 0,
      recoveryMessage: null,
      lastProtectedAction: null,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  normalizeDraftForContracts(draft) {
    return {
      draftWorksheetId: draft.localId,
      title: String(draft.title || '').trim() || 'Untitled worksheet',
      blocks: normalizeBlocks(draft.blocks).map((block, index) => {
        const base = {
          blockId: block.blockId || createLocalId('blk'),
          kind: block.kind === 'question' ? 'question' : 'content',
          position: Number.isInteger(block.position) ? block.position : index,
        };

        if (base.kind === 'question') {
          return {
            ...base,
            prompt: {
              text: String(block?.prompt?.text || ''),
              format: block?.prompt?.format || 'plain_text',
            },
            responseConfig: isRecord(block.responseConfig)
              ? { ...block.responseConfig }
              : { inputType: 'plain_text', maxLength: 500 },
          };
        }

        return {
          ...base,
          content: {
            text: String(block?.content?.text || ''),
            format: block?.content?.format || 'plain_text',
          },
        };
      }),
    };
  }

  validateCurrentDraft() {
    if (!this.state.draft) {
      return { valid: false, errors: ['No active draft.'], blockValidation: {} };
    }

    const normalizedDraft = this.normalizeDraftForContracts(this.state.draft);
    const errors = [];
    if (!normalizedDraft.draftWorksheetId) errors.push('draft.draftWorksheetId must be a non-empty string');
    if (!normalizedDraft.title?.trim()) errors.push('draft.title must be a non-empty string');
    if (!Array.isArray(normalizedDraft.blocks) || normalizedDraft.blocks.length === 0) {
      errors.push('draft.blocks must be a non-empty array');
    }

    normalizedDraft.blocks.forEach((block, index) => {
      if (!block.blockId) errors.push(`draft.blocks[${index}].blockId must be a non-empty string`);
      if (!Number.isInteger(block.position) || block.position < 0) {
        errors.push(`draft.blocks[${index}].position must be a non-negative integer`);
      }
      if (block.kind === 'question') {
        if (!block?.prompt?.text?.trim()) errors.push(`draft.blocks[${index}].prompt.text is required for question blocks`);
        if (!isRecord(block.responseConfig)) errors.push(`draft.blocks[${index}].responseConfig is required for question blocks`);
      } else if (!block?.content?.text?.trim()) {
        errors.push(`draft.blocks[${index}].content.text is required for content blocks`);
      }
    });

    const validation = { valid: errors.length === 0, errors };
    const blockValidation = {};

    validation.errors.forEach((message) => {
      const blockMatch = message.match(/draft\.blocks\[(\d+)\]/);
      if (!blockMatch) return;
      const index = Number.parseInt(blockMatch[1], 10);
      const blockId = normalizedDraft.blocks[index]?.blockId || `index_${index}`;
      blockValidation[blockId] = blockValidation[blockId] || [];
      blockValidation[blockId].push(message);
    });

    this.state.validationErrors = validation.errors;
    this.state.blockValidation = blockValidation;

    return { ...validation, blockValidation, normalizedDraft };
  }

  async createOrOpenByLocalDraftId(localDraftId, options = {}) {
    const draftId = localDraftId || createLocalId('draft');
    const initialMode = options?.initialMode || DEFAULT_MODE;
    const initialSelectedBlockId = options?.selectedBlockId;
    const initialHash = options?.hash;
    const initialScrollToken = options?.scrollToken;

    let existing = null;
    if (localDraftId) {
      try {
        existing = await this.storage.drafts.get(localDraftId);
      } catch (error) {
        console.warn('Unable to read draft from IndexedDB, continuing in-memory only.', error);
      }
    }

    if (existing) {
      this.state.draft = {
        ...existing,
        blocks: normalizeBlocks(existing.blocks),
      };
    } else {
      this.state.draft = createDraftRecord({ localId: draftId });
      this.scheduleAutosave();
    }

    this.state.mode = initialMode;
    this.state.hash = initialHash ?? this.state.hash;
    this.state.scrollToken = initialScrollToken ?? this.state.scrollToken;

    this.state.selectedBlockId = this.state.draft.blocks[0]?.blockId || null;
    if (initialSelectedBlockId) {
      const hasSelectedBlock = this.state.draft.blocks.some((block) => block.blockId === initialSelectedBlockId);
      if (hasSelectedBlock) {
        this.state.selectedBlockId = initialSelectedBlockId;
      }
    }

    this.state.draftRevision = 1;
    this.state.lastSavedRevision = existing ? 1 : 0;
    this.validateCurrentDraft();
    this.persistRestoreMetadata();
    return this.state.draft;
  }

  updateTitle(nextTitle) {
    if (!this.state.draft) return;
    this.state.draft.title = String(nextTitle || '');
    this.touchDraft();
  }

  updateBlockContent(blockId, nextText) {
    if (!this.state.draft || !blockId) return;

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId) {
        return block;
      }

      if (block.prompt) {
        return {
          ...block,
          prompt: {
            ...block.prompt,
            text: String(nextText || ''),
          },
        };
      }

      return {
        ...block,
        content: {
          ...(block.content || {}),
          text: String(nextText || ''),
        },
      };
    });


    this.touchDraft();
  }

  updateSelectedQuestionInputType(nextInputType) {
    if (!this.state.draft || !this.state.selectedBlockId) return;

    const allowedInputTypes = new Set(['plain_text', 'short_text', 'number', 'boolean', 'single_choice']);
    const inputType = allowedInputTypes.has(nextInputType) ? nextInputType : 'plain_text';

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== this.state.selectedBlockId || block.kind !== 'question') {
        return block;
      }

      const responseConfig = isRecord(block.responseConfig) ? { ...block.responseConfig } : {};
      responseConfig.inputType = inputType;

      if (inputType === 'plain_text' || inputType === 'short_text') {
        const parsedMaxLength = Number.parseInt(responseConfig.maxLength, 10);
        responseConfig.maxLength = Number.isFinite(parsedMaxLength) && parsedMaxLength > 0 ? parsedMaxLength : 500;
      } else {
        delete responseConfig.maxLength;
      }

      if (inputType === 'single_choice') {
        responseConfig.options = Array.isArray(responseConfig.options) ? [...responseConfig.options] : [];
      } else {
        delete responseConfig.options;
      }

      return {
        ...block,
        responseConfig,
      };
    });

    this.touchDraft();
  }

  updateSelectedQuestionMaxLength(nextMaxLength) {
    if (!this.state.draft || !this.state.selectedBlockId) return;

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== this.state.selectedBlockId || block.kind !== 'question') {
        return block;
      }

      const responseConfig = isRecord(block.responseConfig) ? { ...block.responseConfig } : { inputType: 'plain_text' };
      const parsed = Number.parseInt(nextMaxLength, 10);
      responseConfig.maxLength = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

      return {
        ...block,
        responseConfig,
      };
    });

    this.touchDraft();
  }

  updateSelectedQuestionOptions(optionsText) {
    if (!this.state.draft || !this.state.selectedBlockId) return;

    const options = String(optionsText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ value: line, label: line }));

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== this.state.selectedBlockId || block.kind !== 'question') {
        return block;
      }

      return {
        ...block,
        responseConfig: {
          ...(isRecord(block.responseConfig) ? block.responseConfig : {}),
          inputType: 'single_choice',
          options,
        },
      };
    });

    this.touchDraft();
  }

  createBlock(kind = 'content') {
    if (!this.state.draft) return null;

    const position = this.state.draft.blocks.length;
    const block =
      kind === 'question'
        ? createEmptyQuestionBlock(position)
        : {
            blockId: createLocalId('blk'),
            kind: 'content',
            position,
            content: {
              text: '',
              format: 'plain_text',
            },
          };

    this.state.draft.blocks = [...this.state.draft.blocks, block];
    this.state.selectedBlockId = block.blockId;
    this.touchDraft();
    return block;
  }

  deleteBlock(blockId) {
    if (!this.state.draft || !blockId) return;
    const nextBlocks = this.state.draft.blocks
      .filter((block) => block.blockId !== blockId)
      .map((block, index) => ({ ...block, position: index }));

    if (nextBlocks.length === 0) {
      nextBlocks.push({
        blockId: createLocalId('blk'),
        kind: 'content',
        position: 0,
        content: { text: '', format: 'plain_text' },
      });
    }

    this.state.draft.blocks = nextBlocks;
    if (!nextBlocks.some((block) => block.blockId === this.state.selectedBlockId)) {
      this.state.selectedBlockId = nextBlocks[0].blockId;
    }
    this.touchDraft();
  }

  setSelectedBlockKind(kind) {
    if (!this.state.draft || !this.state.selectedBlockId) return;

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== this.state.selectedBlockId) {
        return block;
      }

      if (kind === 'question') {
        return {
          ...block,
          kind: 'question',
          prompt: {
            text: String(block?.prompt?.text || block?.content?.text || ''),
            format: block?.prompt?.format || 'plain_text',
          },
          responseConfig: isRecord(block.responseConfig)
            ? { ...block.responseConfig }
            : { inputType: 'plain_text', maxLength: 500 },
          content: undefined,
        };
      }

      return {
        ...block,
        kind: 'content',
        content: {
          text: String(block?.content?.text || block?.prompt?.text || ''),
          format: block?.content?.format || 'plain_text',
        },
        prompt: undefined,
        responseConfig: undefined,
      };
    });

    this.touchDraft();
  }

  selectBlock(blockId) {
    this.state.selectedBlockId = blockId || null;
    this.persistRestoreMetadata();
  }

  setMode(mode) {
    this.state.mode = mode || DEFAULT_MODE;
    this.persistRestoreMetadata();
  }

  setRouteUiRestoreMetadata(partial = {}) {
    this.state.hash = partial.hash ?? this.state.hash;
    this.state.scrollToken = partial.scrollToken ?? this.state.scrollToken;
    if (partial.selectedBlockId !== undefined) {
      this.state.selectedBlockId = partial.selectedBlockId;
    }
    if (partial.mode) {
      this.state.mode = partial.mode;
    }
    this.persistRestoreMetadata();
  }

  getRouteUiRestoreMetadata() {
    return this.storage.resumeFlags.get(RESUME_FLAG_KEY);
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.state.autosavePending = true;
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  async autosave() {
    if (!this.state.draft) return null;

    const revisionAtSaveStart = this.state.draftRevision;
    const updatedAt = nowIso();
    const validation = this.validateCurrentDraft();
    const normalizedDraft = validation.normalizedDraft;
    const { validateDraftSchema } = await loadContracts();
    const contractValidation = validateDraftSchema(normalizedDraft);

    const snapshotToPersist = cloneDraftForPersistence({
      ...this.state.draft,
      metadata: {
        ...this.state.draft.metadata,
        localId: this.state.draft.localId,
        origin: this.state.draft.metadata?.origin || 'local_created',
        updatedAt,
      },
      contractDraft: normalizedDraft,
      contractValidation: {
        valid: contractValidation.valid,
        errors: contractValidation.errors,
      },
    });

    this.inFlightSaveCount += 1;
    this.state.autosavePending = true;

    try {
      const persisted = await this.storage.drafts.put(snapshotToPersist);

      if (this.state.draft?.localId === persisted.localId && this.state.draftRevision === revisionAtSaveStart) {
        this.state.draft = persisted;
      }

      if (this.state.lastSavedRevision < revisionAtSaveStart) {
        this.state.lastSavedRevision = revisionAtSaveStart;
      }

      if (!this.state.lastSavedAt || this.state.lastSavedAt < updatedAt) {
        this.state.lastSavedAt = updatedAt;
      }

      this.state.lastSaveError = contractValidation.valid
        ? null
        : `Draft saved locally with validation errors (${contractValidation.errors.length}).`;
      this.persistRestoreMetadata();
      return persisted;
    } catch (error) {
      this.state.lastSaveError = error?.message || String(error);
      this.notifyStateChange();
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.draftRevision;
      this.notifyStateChange();
    }
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

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Imported worksheet JSON must be an object.');
    }

    const importedLocalId = createLocalId('imported');
    const importedRecord = {
      localId: importedLocalId,
      worksheet: parsed,
      metadata: {
        localId: importedLocalId,
        origin: 'imported_file',
        updatedAt: nowIso(),
      },
    };

    await this.storage.importedWorksheets.put(importedRecord);

    if (options.convertToEditableDraft) {
      const draft = createDraftRecord({
        title: parsed.title || 'Imported worksheet',
        blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
        origin: 'imported_file',
      });
      this.state.draft = draft;
      this.state.selectedBlockId = draft.blocks[0]?.blockId || null;
      this.state.draftRevision += 1;
      this.state.lastImportedAt = nowIso();
      this.validateCurrentDraft();
      this.autosave().catch((error) => {
        console.warn('Initial autosave after import failed; draft remains in-memory.', error);
      });
      this.persistRestoreMetadata();
      return { importedRecord, draftRecord: this.state.draft };
    }

    return { importedRecord, draftRecord: null };
  }

  async saveNow() {
    const persisted = await this.autosave();
    this.state.lastManualSaveAt = nowIso();
    return persisted;
  }

  async simulateLocalPublish() {
    if (!this.state.draft) {
      throw new Error('No active draft to publish.');
    }

    const validation = this.validateCurrentDraft();
    if (!validation.valid) {
      throw new Error(`Draft validation failed: ${validation.errors.join('; ')}`);
    }

    const { mapDraftToSnapshot, validateDraftSchema } = await loadContracts();
    const contractValidation = validateDraftSchema(validation.normalizedDraft);
    if (!contractValidation.valid) {
      throw new Error(`Draft validation failed: ${contractValidation.errors.join('; ')}`);
    }

    const localWorksheetId = `ws_${this.state.draft.localId}`;
    const localSnapshotId = `snapshot_${createLocalId('pub')}`;

    const snapshot = mapDraftToSnapshot(validation.normalizedDraft, {
      // Do not assign client-generated IDs to server-owned identity fields.
      worksheetId: null,
      snapshotId: null,
      schemaVersion: 1,
      snapshotVersion: Math.max(this.state.draftRevision, 1),
      publishedAt: nowIso(),
      publishedByUserId: DEFAULT_PUBLISHER_ID,
      sourceDraftRevision: String(this.state.draftRevision),
      integrity: {
        source: 'local_publish_simulation',
        // Local-only identifiers for simulation purposes; replaced by server-issued UUIDs on real publish.
        localWorksheetId,
        localSnapshotId,
      },
    });

    // Note: validateSnapshotSchema is intentionally skipped here because worksheetId/snapshotId
    // are null pending server sync. The snapshot structure is otherwise valid.

    this.state.publishPreview = snapshot;
    return snapshot;
  }

  exportCurrentDraftToFile() {
    if (!this.state.draft) {
      throw new Error('No active draft to export.');
    }

    const timestampToken = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worksheet-draft-${this.state.draft.localId}-${timestampToken}.json`;
    downloadJson(this.state.draft, filename);
    this.state.lastExportedAt = nowIso();
    return filename;
  }

  touchDraft() {
    if (!this.state.draft) return;
    this.state.draft = {
      ...this.state.draft,
      metadata: {
        ...this.state.draft.metadata,
        updatedAt: nowIso(),
      },
    };
    this.state.draftRevision += 1;
    this.validateCurrentDraft();
    this.scheduleAutosave();
    this.persistRestoreMetadata();
    this.notifyStateChange();
  }


  async flushLocalStateForAuthRedirect() {
    if (!this.state.draft) return null;

    if (this.state.lastSavedRevision < this.state.draftRevision) {
      return this.autosave();
    }

    return this.state.draft;
  }

  getUiRestoreState() {
    return {
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken:
        this.state.scrollToken ??
        (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
    };
  }

  async restoreByLocalId(localId) {
    if (!localId) return false;
    const restored = await this.createOrOpenByLocalDraftId(localId, this.getUiRestoreState());
    return Boolean(restored);
  }

  applyUiRestoreState(ui = {}) {
    this.setRouteUiRestoreMetadata({
      mode: ui.mode ?? this.state.mode,
      selectedBlockId: ui.selectedBlockId ?? this.state.selectedBlockId,
      hash: ui.hash ?? this.state.hash,
      scrollToken: ui.scrollToken ?? this.state.scrollToken,
    });
  }

  setRecoveryMessage(message) {
    this.state.recoveryMessage = message || null;
  }

  async replayProtectedAction(intent) {
    this.state.lastProtectedAction = intent.actionId;
    this.setRecoveryMessage(null);
  }

  async triggerProtectedAction(actionId) {
    if (!this.authGate) {
      throw new Error('Auth gate is not configured for editor session.');
    }

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localDrafts',
      payload: {
        localDraftId: this.state.draft?.localId || null,
      },
    });
  }

  persistRestoreMetadata() {
    if (!this.state.draft?.localId) {
      return;
    }

    this.storage.resumeFlags.set(RESUME_FLAG_KEY, {
      localId: this.state.draft.localId,
      store: 'localDrafts',
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken:
        this.state.scrollToken ??
        (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
      updatedAt: nowIso(),
    });
  }
}


function renderEditorShell(session) {
  if (!app) return;

  const shell = document.createElement('div');
  shell.className = 'editor-shell';

  const statusBar = document.createElement('div');
  statusBar.className = 'editor-status-bar';
  const statusText = document.createElement('span');
  const validationText = document.createElement('span');
  const localIdText = document.createElement('span');

  const layout = document.createElement('div');
  layout.className = 'editor-layout';
  const leftPanel = document.createElement('section');
  leftPanel.className = 'editor-panel';
  const rightPanel = document.createElement('section');
  rightPanel.className = 'editor-panel';

  const blockList = document.createElement('div');
  blockList.className = 'editor-block-list';

  const titleInput = document.createElement('input');
  titleInput.placeholder = 'Worksheet title';
  const modeSelect = document.createElement('select');
  ['edit', 'preview'].forEach((mode) => {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    modeSelect.appendChild(option);
  });

  const blockKind = document.createElement('select');
  ['content', 'question'].forEach((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    blockKind.appendChild(option);
  });

  const blockTextEditor = document.createElement('textarea');
  blockTextEditor.rows = 8;

  const questionInputType = document.createElement('select');
  ['plain_text', 'short_text', 'number', 'boolean', 'single_choice'].forEach((inputType) => {
    const option = document.createElement('option');
    option.value = inputType;
    option.textContent = inputType;
    questionInputType.appendChild(option);
  });

  const questionInputTypeHelp = document.createElement('p');
  questionInputTypeHelp.className = 'editor-help-text';

  const maxLengthInput = document.createElement('input');
  maxLengthInput.type = 'number';
  maxLengthInput.min = '1';

  const optionsEditor = document.createElement('textarea');
  optionsEditor.rows = 6;
  optionsEditor.placeholder = 'One option per line';

  const importInput = document.createElement('textarea');
  importInput.rows = 8;
  importInput.placeholder = 'Paste draft JSON here to import';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save now';
  const openViewerBtn = document.createElement('button');
  openViewerBtn.type = 'button';
  openViewerBtn.textContent = 'Open in Viewer';
  const addContentBtn = document.createElement('button');
  addContentBtn.type = 'button';
  addContentBtn.textContent = 'Add Content';
  const addQuestionBtn = document.createElement('button');
  addQuestionBtn.type = 'button';
  addQuestionBtn.textContent = 'Add Question';
  const deleteBlockBtn = document.createElement('button');
  deleteBlockBtn.type = 'button';
  deleteBlockBtn.textContent = 'Delete';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = 'Import pasted JSON';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export draft JSON';
  const localPublishBtn = document.createElement('button');
  localPublishBtn.type = 'button';
  localPublishBtn.textContent = 'Simulate local publish';
  const rewriteBtn = document.createElement('button');
  rewriteBtn.type = 'button';
  rewriteBtn.textContent = 'Rewrite (Sign-in required)';
  const t2aBtn = document.createElement('button');
  t2aBtn.type = 'button';
  t2aBtn.textContent = 'T2A (Sign-in required)';
  const syncDraftBtn = document.createElement('button');
  syncDraftBtn.type = 'button';
  syncDraftBtn.textContent = 'Sync Draft (Sign-in required)';
  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.textContent = 'Publish (Sign-in required)';

  const validation = document.createElement('pre');
  const summary = document.createElement('pre');

  const blockTypeLabel = document.createElement('label');
  blockTypeLabel.textContent = 'Block kind';
  const blockTextLabel = document.createElement('label');
  const questionTypeLabel = document.createElement('label');
  questionTypeLabel.textContent = 'Input type';
  const maxLengthLabel = document.createElement('label');
  maxLengthLabel.textContent = 'Max length';
  const optionsLabel = document.createElement('label');
  optionsLabel.textContent = 'Options';

  const refreshBlockList = () => {
    blockList.innerHTML = '';
    (session.state.draft?.blocks || [])
      .sort((a, b) => a.position - b.position)
      .forEach((block) => {
        const itemButton = document.createElement('button');
        itemButton.type = 'button';
        itemButton.className = `editor-block-item${block.blockId === session.state.selectedBlockId ? ' is-selected' : ''}`;
        const preview = String((block.kind === 'question' ? block.prompt?.text : block.content?.text) || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || '(empty)';
        itemButton.textContent = `${block.position}. ${block.kind} — ${preview}`;
        itemButton.addEventListener('click', () => {
          session.selectBlock(block.blockId);
          updateSummary();
        });
        blockList.appendChild(itemButton);
      });
  };

  const syncFormControls = () => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const activeElement = document.activeElement;

    if (activeElement !== titleInput) titleInput.value = session.state.draft?.title || '';
    if (activeElement !== modeSelect) modeSelect.value = session.state.mode;
    if (selectedBlock && activeElement !== blockKind) blockKind.value = selectedBlock.kind;

    const selectedText = selectedBlock?.kind === 'question' ? selectedBlock?.prompt?.text : selectedBlock?.content?.text;
    if (activeElement !== blockTextEditor) blockTextEditor.value = selectedText || '';

    blockTextLabel.textContent = selectedBlock?.kind === 'question' ? 'Prompt text' : 'Content text';

    const questionVisible = selectedBlock?.kind === 'question';
    questionTypeLabel.style.display = questionVisible ? '' : 'none';
    questionInputType.style.display = questionVisible ? '' : 'none';
    questionInputTypeHelp.style.display = questionVisible ? '' : 'none';

    if (questionVisible) {
      const inputType = selectedBlock.responseConfig?.inputType || 'plain_text';
      if (activeElement !== questionInputType) questionInputType.value = inputType;
      questionInputTypeHelp.textContent = getQuestionInputTypeHelpText(inputType);

      const textType = inputType === 'plain_text' || inputType === 'short_text';
      maxLengthLabel.style.display = textType ? '' : 'none';
      maxLengthInput.style.display = textType ? '' : 'none';
      if (textType && activeElement !== maxLengthInput) {
        const maxLength = selectedBlock.responseConfig?.maxLength;
        maxLengthInput.value = maxLength === undefined || maxLength === null ? '' : String(maxLength);
      }

      const showOptions = inputType === 'single_choice';
      optionsLabel.style.display = showOptions ? '' : 'none';
      optionsEditor.style.display = showOptions ? '' : 'none';
      if (showOptions && activeElement !== optionsEditor) {
        const optionLines = Array.isArray(selectedBlock.responseConfig?.options)
          ? selectedBlock.responseConfig.options.map((option) => String(option?.label ?? option?.value ?? option)).join('\n')
          : '';
        optionsEditor.value = optionLines;
      }
    } else {
      maxLengthLabel.style.display = 'none';
      maxLengthInput.style.display = 'none';
      optionsLabel.style.display = 'none';
      optionsEditor.style.display = 'none';
    }

    refreshBlockList();
  };

  const updateSummary = () => {
    const restore = session.getRouteUiRestoreMetadata();
    const draftValidation = session.validateCurrentDraft();
    syncFormControls();

    statusText.textContent = session.state.lastSaveError
      ? `⚠️ ${session.state.lastSaveError}`
      : session.state.autosavePending
        ? 'Saving…'
        : `Saved${session.state.lastSavedAt ? ` at ${session.state.lastSavedAt}` : ''}`;
    validationText.textContent = `${draftValidation.errors.length} validation issue${draftValidation.errors.length === 1 ? '' : 's'}`;
    localIdText.textContent = `localDraftId: ${session.state.draft?.localId || 'n/a'}`;

    validation.textContent = JSON.stringify(
      {
        valid: draftValidation.valid,
        errors: draftValidation.errors,
        byBlock: draftValidation.blockValidation,
      },
      null,
      2
    );

    summary.textContent = JSON.stringify(
      {
        localDraftId: session.state.draft?.localId || null,
        lastSavedAt: session.state.lastSavedAt,
        lastManualSaveAt: session.state.lastManualSaveAt,
        autosavePending: session.state.autosavePending,
        mode: session.state.mode,
        selectedBlockId: session.state.selectedBlockId,
        restore,
        source: session.state.draft?.metadata?.origin || null,
      },
      null,
      2
    );
  };

  session.onStateChange = () => {
    updateSummary();
  };

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });
  modeSelect.addEventListener('change', () => {
    session.setMode(modeSelect.value);
    updateSummary();
  });
  blockKind.addEventListener('change', () => {
    session.setSelectedBlockKind(blockKind.value);
    updateSummary();
  });
  blockTextEditor.addEventListener('input', () => {
    session.updateBlockContent(session.state.selectedBlockId, blockTextEditor.value);
    updateSummary();
  });
  questionInputType.addEventListener('change', () => {
    session.updateSelectedQuestionInputType(questionInputType.value);
    updateSummary();
  });
  maxLengthInput.addEventListener('input', () => {
    session.updateSelectedQuestionMaxLength(maxLengthInput.value);
    updateSummary();
  });
  optionsEditor.addEventListener('input', () => {
    session.updateSelectedQuestionOptions(optionsEditor.value);
    updateSummary();
  });

  saveBtn.addEventListener('click', async () => {
    await session.saveNow();
    updateSummary();
  });
  openViewerBtn.addEventListener('click', () => {
    if (!session.state.draft?.localId) return;
    const viewerUrl = `/viewer/?localDraftId=${encodeURIComponent(session.state.draft.localId)}`;
    window.open(viewerUrl, '_blank', 'noopener');
  });
  addContentBtn.addEventListener('click', () => {
    session.createBlock('content');
    updateSummary();
  });
  addQuestionBtn.addEventListener('click', () => {
    session.createBlock('question');
    updateSummary();
  });
  deleteBlockBtn.addEventListener('click', () => {
    session.deleteBlock(session.state.selectedBlockId);
    updateSummary();
  });
  importBtn.addEventListener('click', async () => {
    await session.importWorksheetJson(importInput.value, { convertToEditableDraft: true });
    importInput.value = '';
    updateSummary();
  });
  exportBtn.addEventListener('click', () => {
    session.exportCurrentDraftToFile();
    updateSummary();
  });
  localPublishBtn.addEventListener('click', async () => {
    await session.simulateLocalPublish();
    updateSummary();
  });
  rewriteBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeRewriteAfterLogin');
    updateSummary();
  });
  t2aBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeT2AAfterLogin');
    updateSummary();
  });
  syncDraftBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeDraftSyncAfterLogin');
    updateSummary();
  });
  publishBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumePublishAfterLogin');
    updateSummary();
  });

  const blockActions = document.createElement('div');
  blockActions.className = 'editor-actions';
  blockActions.append(addContentBtn, addQuestionBtn, deleteBlockBtn);

  const detailActions = document.createElement('div');
  detailActions.className = 'editor-actions';
  detailActions.append(saveBtn, openViewerBtn, exportBtn, localPublishBtn);

  blockTypeLabel.append(blockKind);
  blockTextLabel.append(blockTextEditor);
  questionTypeLabel.append(questionInputType);
  maxLengthLabel.append(maxLengthInput);
  optionsLabel.append(optionsEditor);

  const leftHeading = document.createElement('h2');
  leftHeading.textContent = 'Blocks';
  const rightHeading = document.createElement('h2');
  rightHeading.textContent = 'Block Detail';

  leftPanel.append(leftHeading, blockList, blockActions);
  rightPanel.append(
    titleInput,
    modeSelect,
    rightHeading,
    blockTypeLabel,
    blockTextLabel,
    questionTypeLabel,
    questionInputTypeHelp,
    maxLengthLabel,
    optionsLabel,
    detailActions,
    importInput,
    importBtn,
    rewriteBtn,
    t2aBtn,
    syncDraftBtn,
    publishBtn,
    validation,
    summary
  );

  statusBar.append(statusText, validationText, localIdText);
  layout.append(leftPanel, rightPanel);
  shell.append(statusBar, layout);

  app.innerHTML = '';
  app.append(shell);
  updateSummary();
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
  if (app) {
    app.textContent = `Editor failed to boot: ${error.message}`;
  }
});

export { EditorDraftSession, createDraftRecord, normalizeBlocks };
