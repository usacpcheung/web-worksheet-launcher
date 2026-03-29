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
      inputType: 'text',
      maxLength: 200,
      displayMode: 'multi_line',
    },
  };
}

const TEXT_INPUT_TYPES = new Set(['text']);

function mapOptionsTextToResponseOptions(rawText) {
  if (!rawText) return [];
  return String(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ value: line, label: line }));
}

function normalizeResponseOption(option, fallback = '') {
  if (isRecord(option)) {
    const value = String(option.value ?? option.label ?? fallback);
    const label = String(option.label ?? option.value ?? fallback);
    return { value, label };
  }
  const normalized = String(option ?? fallback);
  return { value: normalized, label: normalized };
}


function buildViewerUrlFromCurrentLocation(currentHref, localDraftId) {
  const viewerUrl = new URL('../viewer/', currentHref);
  viewerUrl.searchParams.set('localDraftId', localDraftId);
  return viewerUrl;
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
      normalized.responseConfig = normalizeQuestionResponseConfig(source.responseConfig);
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
      lastPersistenceError: null,
      lastValidationWarning: null,
      lastSavedLocalValidationIssueCount: 0,
      lastContractValidationIssueCount: 0,
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
      isPristineDraft: false,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
    this.transientQuestionBlockIds = new Set();
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
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
              ? normalizeQuestionResponseConfig(block.responseConfig)
              : { inputType: 'text', maxLength: 200, displayMode: 'multi_line' },
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
      this.state.isPristineDraft = false;
      const existingContractErrors = existing?.contractValidation?.errors;
      this.state.lastContractValidationIssueCount = Array.isArray(existingContractErrors)
        ? existingContractErrors.length
        : 0;
      this.state.lastSavedLocalValidationIssueCount = this.validateCurrentDraft().errors.length;
      this.state.lastValidationWarning = existing?.contractValidation?.valid === false
        ? `Draft saved locally with validation warnings (${this.state.lastContractValidationIssueCount}).`
        : null;
      this.transientQuestionBlockIds.clear();
    } else {
      this.state.draft = createDraftRecord({ localId: draftId });
      this.state.isPristineDraft = true;
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
        if (String(nextText || '').trim()) {
          this.transientQuestionBlockIds.delete(blockId);
        }
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

  updateQuestionInputType(blockId, inputType) {
    if (!this.state.draft || !blockId) return;
    const normalizedInputType = ['text', 'number', 'boolean', 'multiple_choice'].includes(inputType)
      ? inputType
      : 'text';

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = {
        ...normalizeQuestionResponseConfig(block.responseConfig),
        inputType: normalizedInputType,
      };
      if (TEXT_INPUT_TYPES.has(normalizedInputType) && !Number.isFinite(nextResponseConfig.maxLength)) {
        nextResponseConfig.maxLength = 200;
      }
      if (normalizedInputType !== 'multiple_choice') {
        delete nextResponseConfig.options;
        delete nextResponseConfig.selectionMode;
        delete nextResponseConfig.shuffleOptions;
      } else if (!Array.isArray(nextResponseConfig.options)) {
        nextResponseConfig.options = [];
      }

      if (normalizedInputType !== 'number') {
        delete nextResponseConfig.min;
        delete nextResponseConfig.max;
        delete nextResponseConfig.step;
      }

      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(nextResponseConfig),
      };
    });
    this.touchDraft();
  }

  updateQuestionMaxLength(blockId, maxLength) {
    if (!this.state.draft || !blockId) return;
    const parsed = Number.parseInt(maxLength, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Preserve existing maxLength when input is empty, non-numeric, or non-positive.
      return;
    }
    const normalized = parsed;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      return {
        ...block,
        responseConfig: {
          ...(isRecord(block.responseConfig) ? block.responseConfig : {}),
          maxLength: normalized,
        },
      };
    });
    this.touchDraft();
  }

  updateQuestionTextDisplayMode(blockId, displayMode) {
    if (!this.state.draft || !blockId) return;
    const normalizedDisplayMode = displayMode === 'single_line' ? 'single_line' : 'multi_line';
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          inputType: 'text',
          displayMode: normalizedDisplayMode,
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionNumberConfig(blockId, key, rawValue) {
    if (!this.state.draft || !blockId || !['min', 'max', 'step'].includes(key)) return;
    const parsed = Number(rawValue);
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'number') {
        return block;
      }

      const updated = { ...nextResponseConfig };
      if (rawValue === '' || rawValue === null || rawValue === undefined || !Number.isFinite(parsed) || (key === 'step' && parsed <= 0)) {
        delete updated[key];
      } else {
        updated[key] = parsed;
      }

      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionSelectionMode(blockId, selectionMode) {
    if (!this.state.draft || !blockId) return;
    const normalizedSelectionMode = selectionMode === 'multi' ? 'multi' : 'single';
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice') return block;
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          selectionMode: normalizedSelectionMode,
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionShuffleOptions(blockId, enabled) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice') return block;
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          shuffleOptions: Boolean(enabled),
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionOptionsFromText(blockId, rawText) {
    if (!this.state.draft || !blockId) return;
    const normalizedOptions = mapOptionsTextToResponseOptions(rawText);
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      return {
        ...block,
        responseConfig: {
          ...normalizeQuestionResponseConfig(block.responseConfig),
          inputType: 'multiple_choice',
          selectionMode: block.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single',
          shuffleOptions: Boolean(block.responseConfig?.shuffleOptions),
          options: normalizedOptions,
        },
      };
    });
    this.touchDraft();
  }

  updateQuestionOptionAtIndex(blockId, index, nextLabel) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) return;
    const normalizedLabel = String(nextLabel ?? '');
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      if (!options[index]) return block;
      options[index] = { value: normalizedLabel, label: normalizedLabel };
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    this.touchDraft();
  }

  addQuestionOption(blockId) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      options.push({ value: '', label: '' });
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    this.touchDraft();
  }

  removeQuestionOption(blockId, index) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      options.splice(index, 1);
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
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

    if (kind === 'question') {
      this.transientQuestionBlockIds.add(block.blockId);
    }
    this.state.draft.blocks = [...this.state.draft.blocks, block];
    this.state.selectedBlockId = block.blockId;
    this.touchDraft();
    return block;
  }

  deleteBlock(blockId) {
    if (!this.state.draft || !blockId) return;
    this.transientQuestionBlockIds.delete(blockId);
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
        this.transientQuestionBlockIds.add(block.blockId);
        return {
          ...block,
          kind: 'question',
          prompt: {
            text: String(block?.prompt?.text || block?.content?.text || ''),
            format: block?.prompt?.format || 'plain_text',
          },
          responseConfig: isRecord(block.responseConfig)
            ? normalizeQuestionResponseConfig(block.responseConfig)
            : { inputType: 'text', maxLength: 200, displayMode: 'multi_line' },
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

    if (kind !== 'question') {
      this.transientQuestionBlockIds.delete(this.state.selectedBlockId);
    }

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
    this.notifyStateChange();
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  shouldSuppressTransientQuestionWarning(contractErrors, normalizedDraft) {
    if (!Array.isArray(contractErrors) || contractErrors.length === 0) return false;
    return contractErrors.every((errorMessage) => {
      const match = errorMessage.match(/^draft\.blocks\[(\d+)\]\.prompt\.text is required for question blocks$/);
      if (!match) return false;
      const index = Number.parseInt(match[1], 10);
      const blockId = normalizedDraft?.blocks?.[index]?.blockId;
      return !!blockId && this.transientQuestionBlockIds.has(blockId);
    });
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
      const shouldApplySaveStatus =
        this.state.draft?.localId === persisted.localId && revisionAtSaveStart >= this.state.lastSavedRevision;

      if (this.state.draft?.localId === persisted.localId && this.state.draftRevision === revisionAtSaveStart) {
        this.state.draft = persisted;
      }

      if (shouldApplySaveStatus) {
        const wasNeverSavedBefore = this.state.lastSavedRevision === 0;
        this.state.lastSavedRevision = revisionAtSaveStart;
        this.state.lastPersistenceError = null;
        this.state.lastSavedLocalValidationIssueCount = validation.errors.length;
        this.state.lastContractValidationIssueCount = contractValidation.errors.length;

        if (!this.state.lastSavedAt || this.state.lastSavedAt < updatedAt) {
          this.state.lastSavedAt = updatedAt;
        }

        const shouldSuppressPristineWarning = this.state.isPristineDraft && wasNeverSavedBefore;
        const shouldSuppressTransientQuestionWarning =
          this.shouldSuppressTransientQuestionWarning(contractValidation.errors, normalizedDraft);
        this.state.lastValidationWarning =
          contractValidation.valid || shouldSuppressPristineWarning || shouldSuppressTransientQuestionWarning
          ? null
          : `Draft saved locally with validation warnings (${contractValidation.errors.length}).`;
        this.persistRestoreMetadata();
        this.notifyStateChange();
      }
      return persisted;
    } catch (error) {
      const shouldApplyErrorStatus =
        this.state.draft?.localId === snapshotToPersist.metadata?.localId &&
        revisionAtSaveStart > this.state.lastSavedRevision;
      if (shouldApplyErrorStatus) {
        this.state.lastPersistenceError = error?.message || String(error);
        this.notifyStateChange();
      }
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
    this.state.isPristineDraft = false;
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
  const isDebugMode = new URLSearchParams(window.location.search).get('debug') === '1';

  const shell = document.createElement('div');
  shell.className = 'editor-shell';

  const topBar = document.createElement('section');
  topBar.className = 'editor-topbar';
  const saveStateEl = document.createElement('p');
  saveStateEl.className = 'editor-topbar-item';
  const lastSavedEl = document.createElement('p');
  lastSavedEl.className = 'editor-topbar-item';
  const validationEl = document.createElement('p');
  validationEl.className = 'editor-topbar-item';
  const localDraftIdEl = document.createElement('p');
  localDraftIdEl.className = 'editor-topbar-item';
  const localDraftIdLabel = document.createElement('span');
  localDraftIdLabel.className = 'editor-label';
  localDraftIdLabel.textContent = 'localDraftId:';
  const localDraftIdValue = document.createElement('span');
  localDraftIdValue.className = 'editor-id-value';
  localDraftIdEl.append(localDraftIdLabel, localDraftIdValue);

  const layout = document.createElement('section');
  layout.className = 'editor-layout';

  const leftPanel = document.createElement('aside');
  leftPanel.className = 'editor-panel left';
  const rightPanel = document.createElement('section');
  rightPanel.className = 'editor-panel right';

  const leftHeading = document.createElement('h2');
  leftHeading.textContent = 'Blocks';
  const rightHeading = document.createElement('h2');
  rightHeading.textContent = 'Block Details';

  const blockList = document.createElement('ul');
  blockList.className = 'block-list';

  const controlsRow = document.createElement('div');
  controlsRow.className = 'button-row';

  const metaRow = document.createElement('div');
  metaRow.className = 'button-row';
  metaRow.classList.add('stacked-actions');

  const statusRow = document.createElement('p');
  statusRow.className = 'muted';
  const moreActions = document.createElement('details');
  moreActions.className = 'editor-more-actions';
  const moreActionsSummary = document.createElement('summary');
  moreActionsSummary.textContent = 'More Actions';
  moreActions.appendChild(moreActionsSummary);

  const blockKind = document.createElement('select');
  blockKind.id = 'editor-block-kind';
  blockKind.className = 'control';
  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'application/json,.json';
  importFileInput.style.display = 'none';
  const titleInput = document.createElement('input');
  titleInput.placeholder = 'Worksheet title';
  titleInput.className = 'control';
  const blockEditor = document.createElement('textarea');
  blockEditor.id = 'editor-block-editor';
  blockEditor.rows = 8;
  blockEditor.className = 'control';

  const questionInputType = document.createElement('select');
  questionInputType.id = 'editor-question-input-type';
  questionInputType.className = 'control';
  [
    { value: 'text', label: 'text' },
    { value: 'number', label: 'number' },
    { value: 'boolean', label: 'True / False' },
    { value: 'multiple_choice', label: 'multiple_choice' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionInputType.appendChild(option);
  });
  const questionTextDisplayMode = document.createElement('select');
  questionTextDisplayMode.id = 'editor-question-text-display-mode';
  questionTextDisplayMode.className = 'control';
  [
    { value: 'single_line', label: 'single_line' },
    { value: 'multi_line', label: 'multi_line' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionTextDisplayMode.appendChild(option);
  });
  const questionMaxLength = document.createElement('input');
  questionMaxLength.id = 'editor-question-max-length';
  questionMaxLength.type = 'number';
  questionMaxLength.min = '1';
  questionMaxLength.className = 'control';
  const questionOptions = document.createElement('textarea');
  questionOptions.id = 'editor-question-options';
  questionOptions.style.display = 'none';
  const questionOptionsList = document.createElement('div');
  questionOptionsList.className = 'question-options-list';
  const addOptionBtn = document.createElement('button');
  addOptionBtn.type = 'button';
  addOptionBtn.className = 'option-add-btn';
  addOptionBtn.textContent = '+ Add option';
  const questionSelectionMode = document.createElement('select');
  questionSelectionMode.id = 'editor-question-selection-mode';
  questionSelectionMode.className = 'control';
  [
    { value: 'single', label: 'single' },
    { value: 'multi', label: 'multi' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionSelectionMode.appendChild(option);
  });
  const questionShuffleOptions = document.createElement('input');
  questionShuffleOptions.id = 'editor-question-shuffle-options';
  questionShuffleOptions.type = 'checkbox';
  questionShuffleOptions.className = 'control';
  const questionMin = document.createElement('input');
  questionMin.id = 'editor-question-min';
  questionMin.type = 'number';
  questionMin.className = 'control';
  const questionMax = document.createElement('input');
  questionMax.id = 'editor-question-max';
  questionMax.type = 'number';
  questionMax.className = 'control';
  const questionStep = document.createElement('input');
  questionStep.id = 'editor-question-step';
  questionStep.type = 'number';
  questionStep.min = '0.0000001';
  questionStep.step = 'any';
  questionStep.className = 'control';

  ['content', 'question'].forEach((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    blockKind.appendChild(option);
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save Now';
  const addContentBtn = document.createElement('button');
  addContentBtn.type = 'button';
  addContentBtn.textContent = 'Add Content';
  const addQuestionBtn = document.createElement('button');
  addQuestionBtn.type = 'button';
  addQuestionBtn.textContent = 'Add Question';
  const openViewerBtn = document.createElement('button');
  openViewerBtn.type = 'button';
  openViewerBtn.textContent = 'Open in Viewer (same tab)';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = 'Import draft JSON file';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export draft JSON';
  const localPublishBtn = document.createElement('button');
  localPublishBtn.type = 'button';
  localPublishBtn.textContent = 'Generate publish payload (debug)';
  const localPublishHint = document.createElement('p');
  localPublishHint.className = 'muted';
  localPublishHint.textContent = 'Debug only: generates a local snapshot preview and does not call server publish APIs.';
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
  const protectedActionsColumn = document.createElement('div');
  protectedActionsColumn.className = 'action-column';
  let detailSignature = null;

  const syncFormControls = () => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const selectedText = selectedBlock?.prompt?.text || selectedBlock?.content?.text || '';
    const activeElement = document.activeElement;

    if (activeElement !== titleInput) {
      titleInput.value = session.state.draft?.title || '';
    }
    if (activeElement !== blockEditor) {
      blockEditor.value = selectedText;
    }
    if (selectedBlock && activeElement !== blockKind) {
      blockKind.value = selectedBlock.kind;
    }
    if (selectedBlock?.kind === 'question') {
      const responseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
      if (activeElement !== questionInputType) {
        questionInputType.value = responseConfig.inputType || 'text';
      }
      if (activeElement !== questionMaxLength) {
        questionMaxLength.value = responseConfig.maxLength || 200;
      }
      if (activeElement !== questionTextDisplayMode) {
        questionTextDisplayMode.value = responseConfig.displayMode || 'multi_line';
      }
      if (activeElement !== questionOptions) {
        questionOptions.value = (responseConfig.options || [])
          .map((option) => String(option?.value ?? option?.label ?? ''))
          .join('\n');
      }
      if (activeElement !== questionSelectionMode) {
        questionSelectionMode.value = responseConfig.selectionMode || 'single';
      }
      if (activeElement !== questionShuffleOptions) {
        questionShuffleOptions.checked = Boolean(responseConfig.shuffleOptions);
      }
      if (activeElement !== questionMin) questionMin.value = responseConfig.min ?? '';
      if (activeElement !== questionMax) questionMax.value = responseConfig.max ?? '';
      if (activeElement !== questionStep) questionStep.value = responseConfig.step ?? '';
    }
  };

  const renderBlockList = () => {
    blockList.innerHTML = '';
    const blocks = (session.state.draft?.blocks || []).slice().sort((a, b) => a.position - b.position);
    blocks.forEach((block) => {
      const item = document.createElement('li');
      item.className = `block-item ${block.blockId === session.state.selectedBlockId ? 'selected' : ''}`;
      const row = document.createElement('div');
      row.className = 'block-item-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'block-select';
      const previewSource = block.kind === 'question' ? block?.prompt?.text : block?.content?.text;
      const preview = String(previewSource || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '—';
      button.textContent = `${block.position + 1}. ${block.kind} — ${preview}`;
      button.addEventListener('click', () => {
        session.selectBlock(block.blockId);
        updateSummary();
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'icon-btn danger';
      deleteBtn.title = 'Delete this block';
      deleteBtn.setAttribute('aria-label', `Delete block ${block.position + 1}`);
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        session.deleteBlock(block.blockId);
        updateSummary();
      });
      row.append(button, deleteBtn);
      item.appendChild(row);
      blockList.appendChild(item);
    });
  };

  const computeDetailSignature = (selectedBlock) => {
    if (!selectedBlock) {
      return 'none';
    }
    return [
      selectedBlock.blockId,
      selectedBlock.kind,
      selectedBlock.responseConfig?.inputType || 'text',
      selectedBlock.responseConfig?.displayMode || '',
      selectedBlock.responseConfig?.min ?? '',
      selectedBlock.responseConfig?.max ?? '',
      selectedBlock.responseConfig?.step ?? '',
      selectedBlock.responseConfig?.selectionMode || '',
      selectedBlock.responseConfig?.shuffleOptions ? '1' : '0',
      JSON.stringify((selectedBlock.responseConfig?.options || []).map((opt) => [
        String(opt?.value ?? ''),
        String(opt?.label ?? ''),
      ])),
    ].join(':');
  };

  const renderDetailEditor = ({ force = false } = {}) => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const isOptionInputActive =
      typeof HTMLInputElement !== 'undefined' &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.dataset.optionInput === '1';
    if (
      !force &&
      isOptionInputActive &&
      selectedBlock?.responseConfig?.inputType === 'multiple_choice' &&
      questionOptionsList.contains(document.activeElement)
    ) {
      return;
    }
    const nextSignature = computeDetailSignature(selectedBlock);
    if (!force && nextSignature === detailSignature) {
      return;
    }
    detailSignature = nextSignature;
    rightPanel.innerHTML = '';
    rightPanel.append(rightHeading, statusRow);
    if (!selectedBlock) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a block to edit.';
      rightPanel.appendChild(empty);
      return;
    }

    const kindLabel = document.createElement('label');
    kindLabel.textContent = 'Block kind';
    kindLabel.htmlFor = 'editor-block-kind';
    rightPanel.append(kindLabel, blockKind);

    if (selectedBlock.kind === 'content') {
      const contentLabel = document.createElement('label');
      contentLabel.textContent = 'Content text';
      contentLabel.htmlFor = 'editor-block-editor';
      blockEditor.placeholder = 'Content block text';
      rightPanel.append(contentLabel, blockEditor);
      return;
    }

    const promptLabel = document.createElement('label');
    promptLabel.textContent = 'Question prompt';
    promptLabel.htmlFor = 'editor-block-editor';
    blockEditor.placeholder = 'Question prompt';
    rightPanel.append(promptLabel, blockEditor);

    const inputTypeLabel = document.createElement('label');
    inputTypeLabel.textContent = 'Answer input type';
    inputTypeLabel.htmlFor = 'editor-question-input-type';
    rightPanel.append(inputTypeLabel, questionInputType);

    const activeInputType = selectedBlock.responseConfig?.inputType || 'text';
    if (TEXT_INPUT_TYPES.has(activeInputType)) {
      const maxLengthLabel = document.createElement('label');
      maxLengthLabel.textContent = 'Max length';
      maxLengthLabel.htmlFor = 'editor-question-max-length';
      rightPanel.append(maxLengthLabel, questionMaxLength);

      const displayModeLabel = document.createElement('label');
      displayModeLabel.textContent = 'Text display mode';
      displayModeLabel.htmlFor = 'editor-question-text-display-mode';
      rightPanel.append(displayModeLabel, questionTextDisplayMode);
    }

    if (activeInputType === 'number') {
      const minLabel = document.createElement('label');
      minLabel.textContent = 'Min';
      minLabel.htmlFor = 'editor-question-min';
      const maxLabel = document.createElement('label');
      maxLabel.textContent = 'Max';
      maxLabel.htmlFor = 'editor-question-max';
      const stepLabel = document.createElement('label');
      stepLabel.textContent = 'Step';
      stepLabel.htmlFor = 'editor-question-step';
      rightPanel.append(minLabel, questionMin, maxLabel, questionMax, stepLabel, questionStep);
    }

    if (activeInputType === 'multiple_choice') {
      const selectionModeLabel = document.createElement('label');
      selectionModeLabel.textContent = 'Selection mode';
      selectionModeLabel.htmlFor = 'editor-question-selection-mode';
      rightPanel.append(selectionModeLabel, questionSelectionMode);

      const shuffleRow = document.createElement('label');
      shuffleRow.className = 'inline-toggle';
      shuffleRow.htmlFor = 'editor-question-shuffle-options';
      const shuffleText = document.createElement('span');
      shuffleText.textContent = 'Shuffle options';
      shuffleRow.append(shuffleText, questionShuffleOptions);
      rightPanel.append(shuffleRow);

      const optionsLabel = document.createElement('label');
      optionsLabel.textContent = 'Options';
      optionsLabel.htmlFor = 'editor-question-options';
      rightPanel.append(optionsLabel);

      questionOptionsList.innerHTML = '';
      const optionList = Array.isArray(selectedBlock.responseConfig?.options) && selectedBlock.responseConfig.options.length > 0
        ? selectedBlock.responseConfig.options
        : [{ value: '', label: '' }];
      optionList.forEach((option, optionIndex) => {
        const row = document.createElement('div');
        row.className = 'option-row';
        const optionInput = document.createElement('input');
        optionInput.type = 'text';
        optionInput.dataset.optionInput = '1';
        optionInput.className = 'control';
        optionInput.placeholder = `Option ${optionIndex + 1}`;
        optionInput.value = String(option?.label ?? option?.value ?? '');
        optionInput.addEventListener('input', () => {
          session.updateQuestionOptionAtIndex(selectedBlock.blockId, optionIndex, optionInput.value);
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn';
        removeBtn.title = `Remove option ${optionIndex + 1}`;
        removeBtn.setAttribute('aria-label', `Remove option ${optionIndex + 1}`);
        removeBtn.textContent = '−';
        removeBtn.addEventListener('click', () => {
          session.removeQuestionOption(selectedBlock.blockId, optionIndex);
          updateSummary();
        });
        row.append(optionInput, removeBtn);
        questionOptionsList.appendChild(row);
      });

      rightPanel.append(questionOptionsList, addOptionBtn, questionOptions);
    }
  };

  const updateSummary = () => {
    session.validateCurrentDraft();
    syncFormControls();
    renderBlockList();
    renderDetailEditor();

    const saveState = session.state.lastPersistenceError
      ? 'Save error'
      : session.state.autosavePending
        ? 'Saving…'
        : session.state.lastValidationWarning
          ? 'Saved (warnings)'
        : 'Saved';

    const isSaved = saveState === 'Saved';
    saveStateEl.innerHTML = `<span class="editor-label">State:</span> <span class="editor-pill ${isSaved ? 'editor-pill--ok' : 'editor-pill--warn'}"><span class="editor-dot"></span>${isSaved ? 'Saved' : saveState}</span>`;
    saveStateEl.title = session.state.lastPersistenceError || session.state.lastValidationWarning || '';
    lastSavedEl.textContent = `Last saved: ${session.state.lastSavedAt || 'Not yet saved'}`;
    const validationIssues = session.state.lastSavedLocalValidationIssueCount + session.state.lastContractValidationIssueCount;
    validationEl.innerHTML = `<span class="editor-pill ${validationIssues > 0 ? 'editor-pill--warn' : 'editor-pill--ok'}">Validation: ${validationIssues} issue${validationIssues === 1 ? '' : 's'}</span>`;
    const validationTooltip = [];
    if (session.state.lastValidationWarning) {
      validationTooltip.push(session.state.lastValidationWarning);
    }
    if (session.state.validationErrors.length > 0) {
      validationTooltip.push(...session.state.validationErrors);
    }
    validationEl.title = validationIssues > 0 ? validationTooltip.join('\n') : '';
    localDraftIdValue.textContent = session.state.draft?.localId || 'n/a';
    statusRow.textContent = `Selected block: ${session.state.selectedBlockId || 'none'}`;
  };

  session.setOnStateChange(() => {
    updateSummary();
  });

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });
  blockKind.addEventListener('change', () => {
    session.setSelectedBlockKind(blockKind.value);
    updateSummary();
  });
  blockEditor.addEventListener('input', () => {
    session.updateBlockContent(session.state.selectedBlockId, blockEditor.value);
    updateSummary();
  });
  saveBtn.addEventListener('click', async () => {
    await session.saveNow();
    updateSummary();
  });
  addContentBtn.addEventListener('click', () => {
    session.createBlock('content');
    updateSummary();
  });
  addQuestionBtn.addEventListener('click', () => {
    session.createBlock('question');
    updateSummary();
  });
  openViewerBtn.addEventListener('click', async () => {
    const localDraftId = session.state.draft?.localId;
    if (!localDraftId) return;
    await session.saveNow();
    updateSummary();
    const viewerUrl = buildViewerUrlFromCurrentLocation(window.location.href, localDraftId);
    window.location.assign(viewerUrl);
  });
  questionInputType.addEventListener('change', () => {
    session.updateQuestionInputType(session.state.selectedBlockId, questionInputType.value);
    updateSummary();
  });
  questionMaxLength.addEventListener('input', () => {
    session.updateQuestionMaxLength(session.state.selectedBlockId, questionMaxLength.value);
    updateSummary();
  });
  questionTextDisplayMode.addEventListener('change', () => {
    session.updateQuestionTextDisplayMode(session.state.selectedBlockId, questionTextDisplayMode.value);
    updateSummary();
  });
  questionMin.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'min', questionMin.value);
    updateSummary();
  });
  questionMax.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'max', questionMax.value);
    updateSummary();
  });
  questionStep.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'step', questionStep.value);
    updateSummary();
  });
  questionSelectionMode.addEventListener('change', () => {
    session.updateQuestionSelectionMode(session.state.selectedBlockId, questionSelectionMode.value);
    updateSummary();
  });
  questionShuffleOptions.addEventListener('change', () => {
    session.updateQuestionShuffleOptions(session.state.selectedBlockId, questionShuffleOptions.checked);
    updateSummary();
  });
  questionOptions.addEventListener('input', () => {
    session.updateQuestionOptionsFromText(session.state.selectedBlockId, questionOptions.value);
    updateSummary();
  });
  addOptionBtn.addEventListener('click', () => {
    session.addQuestionOption(session.state.selectedBlockId);
    updateSummary();
  });
  importBtn.addEventListener('click', () => {
    importFileInput.click();
  });
  importFileInput.addEventListener('change', async () => {
    const [file] = importFileInput.files || [];
    if (!file) return;
    const fileText = await file.text();
    await session.importWorksheetJson(fileText, { convertToEditableDraft: true });
    importFileInput.value = '';
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

  addContentBtn.textContent = '+ Add Content';
  addQuestionBtn.textContent = '+ Add Question';
  controlsRow.append(addContentBtn, addQuestionBtn);
  metaRow.append(saveBtn, exportBtn, importBtn, openViewerBtn);
  if (isDebugMode) {
    moreActions.append(localPublishHint, localPublishBtn);
  }
  protectedActionsColumn.append(syncDraftBtn, publishBtn, rewriteBtn, t2aBtn);
  moreActions.append(protectedActionsColumn);
  leftPanel.append(leftHeading, titleInput, controlsRow, blockList, moreActions, metaRow, importFileInput);
  rightPanel.append(rightHeading, statusRow);
  layout.append(leftPanel, rightPanel);
  topBar.append(saveStateEl, validationEl, lastSavedEl, localDraftIdEl);
  shell.append(topBar, layout);
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
    initialMode: DEFAULT_MODE,
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

export { EditorDraftSession, createDraftRecord, normalizeBlocks, mapOptionsTextToResponseOptions, buildViewerUrlFromCurrentLocation };
function normalizeQuestionResponseConfig(responseConfig) {
  const source = isRecord(responseConfig) ? { ...responseConfig } : {};
  const legacyInputType = source.inputType || 'text';
  const inputType = legacyInputType === 'plain_text' || legacyInputType === 'short_text'
    ? 'text'
    : legacyInputType === 'single_choice'
      ? 'multiple_choice'
      : legacyInputType;

  const normalized = {
    ...source,
    inputType,
  };

  if (inputType === 'text') {
    normalized.maxLength = Number.isFinite(source.maxLength) ? Number(source.maxLength) : 200;
    normalized.displayMode = source.displayMode === 'single_line' ? 'single_line' : 'multi_line';
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
  } else if (inputType === 'number') {
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    if (Number.isFinite(source.min)) normalized.min = Number(source.min); else delete normalized.min;
    if (Number.isFinite(source.max)) normalized.max = Number(source.max); else delete normalized.max;
    if (Number.isFinite(source.step) && Number(source.step) > 0) normalized.step = Number(source.step); else delete normalized.step;
    delete normalized.maxLength;
    delete normalized.displayMode;
  } else if (inputType === 'multiple_choice') {
    normalized.selectionMode = source.selectionMode === 'multi' ? 'multi' : 'single';
    normalized.shuffleOptions = Boolean(source.shuffleOptions);
    normalized.options = Array.isArray(source.options) ? source.options : [];
    delete normalized.maxLength;
    delete normalized.displayMode;
    delete normalized.min;
    delete normalized.max;
    delete normalized.step;
  } else {
    delete normalized.maxLength;
    delete normalized.displayMode;
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    delete normalized.min;
    delete normalized.max;
    delete normalized.step;
  }

  return normalized;
}
