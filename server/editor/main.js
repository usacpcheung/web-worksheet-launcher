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

const TEXT_INPUT_TYPES = new Set(['plain_text', 'short_text']);

function mapOptionsTextToResponseOptions(rawText) {
  if (!rawText) return [];
  return String(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ value: line, label: line }));
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
    const normalizedInputType = ['plain_text', 'short_text', 'number', 'boolean', 'single_choice'].includes(inputType)
      ? inputType
      : 'plain_text';

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = {
        ...(isRecord(block.responseConfig) ? block.responseConfig : {}),
        inputType: normalizedInputType,
      };
      if (TEXT_INPUT_TYPES.has(normalizedInputType) && !Number.isFinite(nextResponseConfig.maxLength)) {
        nextResponseConfig.maxLength = 500;
      }
      if (normalizedInputType !== 'single_choice') {
        delete nextResponseConfig.options;
      } else if (!Array.isArray(nextResponseConfig.options)) {
        nextResponseConfig.options = [];
      }

      return {
        ...block,
        responseConfig: nextResponseConfig,
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
          ...(isRecord(block.responseConfig) ? block.responseConfig : {}),
          inputType: 'single_choice',
          options: normalizedOptions,
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
  const saveErrorEl = document.createElement('p');
  const saveWarningEl = document.createElement('p');
  saveErrorEl.className = 'error-text';
  saveWarningEl.className = 'muted';

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
  ['plain_text', 'short_text', 'number', 'boolean', 'single_choice'].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    questionInputType.appendChild(option);
  });
  const questionMaxLength = document.createElement('input');
  questionMaxLength.id = 'editor-question-max-length';
  questionMaxLength.type = 'number';
  questionMaxLength.min = '1';
  questionMaxLength.className = 'control';
  const questionOptions = document.createElement('textarea');
  questionOptions.id = 'editor-question-options';
  questionOptions.rows = 6;
  questionOptions.className = 'control';
  questionOptions.placeholder = 'One option per line';

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
  const deleteBlockBtn = document.createElement('button');
  deleteBlockBtn.type = 'button';
  deleteBlockBtn.textContent = 'Delete Selected';
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
      const responseConfig = selectedBlock.responseConfig || {};
      if (activeElement !== questionInputType) {
        questionInputType.value = responseConfig.inputType || 'plain_text';
      }
      if (activeElement !== questionMaxLength) {
        questionMaxLength.value = responseConfig.maxLength || 500;
      }
      if (activeElement !== questionOptions) {
        questionOptions.value = (responseConfig.options || [])
          .map((option) => String(option?.value ?? option?.label ?? ''))
          .join('\n');
      }
    }
  };

  const renderBlockList = () => {
    blockList.innerHTML = '';
    const blocks = (session.state.draft?.blocks || []).slice().sort((a, b) => a.position - b.position);
    blocks.forEach((block) => {
      const item = document.createElement('li');
      item.className = `block-item ${block.blockId === session.state.selectedBlockId ? 'selected' : ''}`;
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
      item.appendChild(button);
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
      selectedBlock.responseConfig?.inputType || 'plain_text',
    ].join(':');
  };

  const renderDetailEditor = ({ force = false } = {}) => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
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

    const activeInputType = selectedBlock.responseConfig?.inputType || 'plain_text';
    if (TEXT_INPUT_TYPES.has(activeInputType)) {
      const maxLengthLabel = document.createElement('label');
      maxLengthLabel.textContent = 'Max length';
      maxLengthLabel.htmlFor = 'editor-question-max-length';
      rightPanel.append(maxLengthLabel, questionMaxLength);
    }

    if (activeInputType === 'single_choice') {
      const optionsLabel = document.createElement('label');
      optionsLabel.textContent = 'Options';
      optionsLabel.htmlFor = 'editor-question-options';
      rightPanel.append(optionsLabel, questionOptions);
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
    lastSavedEl.textContent = `Last saved: ${session.state.lastSavedAt || 'Not yet saved'}`;
    const validationIssues = session.state.lastSavedLocalValidationIssueCount + session.state.lastContractValidationIssueCount;
    validationEl.innerHTML = `<span class="editor-pill ${validationIssues > 0 ? 'editor-pill--warn' : 'editor-pill--ok'}">Validation: ${validationIssues} issue${validationIssues === 1 ? '' : 's'}</span>`;
    localDraftIdEl.innerHTML = `<span class="editor-label">localDraftId:</span> <span class="editor-id-value">${session.state.draft?.localId || 'n/a'}</span>`;
    saveErrorEl.textContent = session.state.lastPersistenceError ? `Error: ${session.state.lastPersistenceError}` : '';
    saveWarningEl.textContent = session.state.lastValidationWarning ? `Warning: ${session.state.lastValidationWarning}` : '';
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
  deleteBlockBtn.addEventListener('click', () => {
    session.deleteBlock(session.state.selectedBlockId);
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
  questionOptions.addEventListener('input', () => {
    session.updateQuestionOptionsFromText(session.state.selectedBlockId, questionOptions.value);
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
  metaRow.append(saveBtn, exportBtn, importBtn);
  if (isDebugMode) {
    moreActions.append(localPublishHint, localPublishBtn);
  }
  moreActions.append(syncDraftBtn, publishBtn, rewriteBtn, t2aBtn, deleteBlockBtn);
  leftPanel.append(leftHeading, titleInput, controlsRow, blockList, moreActions, metaRow, importFileInput, openViewerBtn);
  rightPanel.append(rightHeading, statusRow);
  layout.append(leftPanel, rightPanel);
  topBar.append(saveStateEl, validationEl, lastSavedEl, localDraftIdEl);
  shell.append(topBar, saveErrorEl, saveWarningEl, layout);
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
