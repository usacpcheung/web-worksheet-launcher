import { viewerStorage } from './storage/index.js';
import { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const RESUME_FLAG_KEY = 'viewer:lastSession';
const DEFAULT_LEARNER_ID = 'local_learner';
let contractsPromise;

function nowIso() {
  return new Date().toISOString();
}

async function loadContracts() {
  if (!contractsPromise) {
    contractsPromise = import('../app/contracts/index.js');
  }
  return contractsPromise;
}

function createLocalId(prefix = 'local') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function decodeBase64Url(input) {
  if (!input) return null;

  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function parseJsonInput(rawValue) {
  if (!rawValue) return null;

  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function maybeParseEncodedJson(rawValue) {
  if (!rawValue) return null;

  const direct = parseJsonInput(rawValue);
  if (direct) {
    return direct;
  }

  try {
    return parseJsonInput(decodeBase64Url(rawValue));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshotLikeWorksheet(value) {
  return (
    isRecord(value)
    && Array.isArray(value.blocks)
    && typeof value.worksheetId === 'string'
    && typeof value.snapshotId === 'string'
    && Number.isInteger(value.schemaVersion)
    && typeof value.publishedAt === 'string'
  );
}

function normalizeViewerBlock(block, index) {
  const safeBlock = isRecord(block) ? block : {};
  const normalizedKind = safeBlock.kind === 'question' || safeBlock.kind === 'content'
    ? safeBlock.kind
    : 'content';

  const base = {
    blockId: safeBlock.blockId || createLocalId('blk'),
    kind: normalizedKind,
    position: Number.isInteger(safeBlock.position) ? safeBlock.position : index,
  };

  if (base.kind === 'question') {
    const responseConfigSource = isRecord(safeBlock.responseConfig) ? safeBlock.responseConfig : {};
    const inputType = responseConfigSource.inputType || 'plain_text';
    const normalizedResponseConfig = {
      inputType,
      maxLength: Number.isFinite(responseConfigSource.maxLength)
        ? responseConfigSource.maxLength
        : 1000,
    };

    if (inputType === 'single_choice') {
      normalizedResponseConfig.options = Array.isArray(responseConfigSource.options)
        ? responseConfigSource.options
          .filter((option) => option !== null && option !== undefined)
          .map((option) => {
            if (isRecord(option)) {
              const value = option.value ?? option.label ?? '';
              const label = option.label ?? option.value ?? '';
              return {
                value: String(value),
                label: String(label),
              };
            }

            const normalizedOption = String(option);
            return { value: normalizedOption, label: normalizedOption };
          })
        : [];
    }

    return {
      ...base,
      prompt: {
        text: String(safeBlock?.prompt?.text || ''),
        format: safeBlock?.prompt?.format || 'plain_text',
      },
      responseConfig: normalizedResponseConfig,
    };
  }

  return {
    ...base,
    content: {
      text: String(safeBlock?.content?.text || ''),
      format: safeBlock?.content?.format || 'plain_text',
    },
  };
}

function normalizeViewerPayload(payload, fallbackLabel = 'Local worksheet') {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Viewer payload must be an object.');
  }

  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.map((block, index) => normalizeViewerBlock(block, index))
    : [];

  if (blocks.length === 0) {
    throw new Error('Viewer payload must include at least one normalized block.');
  }

  return {
    worksheetId: payload.worksheetId || createLocalId('ws'),
    snapshotId: payload.snapshotId || createLocalId('snapshot_local'),
    snapshotVersion: Number.isInteger(payload.snapshotVersion) ? payload.snapshotVersion : 1,
    title: payload.title || fallbackLabel,
    blocks,
  };
}

function coerceAnswerValueByInputType(inputType, rawValue) {
  if (inputType === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : '';
  }
  if (inputType === 'boolean') {
    if (rawValue === true || rawValue === 'true') return true;
    if (rawValue === false || rawValue === 'false') return false;
    return null;
  }
  return String(rawValue ?? '');
}

function mapDraftRecordToViewerPayload(draftRecord) {
  return normalizeViewerPayload(
    {
      worksheetId: draftRecord.localId,
      snapshotId: `${draftRecord.localId}:local-snapshot`,
      snapshotVersion: 1,
      title: draftRecord.title || 'Local draft worksheet',
      blocks: draftRecord.blocks || [],
    },
    'Local draft worksheet'
  );
}

function resolveImportedWorksheetPayload(importedRecord) {
  const worksheet = importedRecord?.worksheet;
  if (!worksheet || typeof worksheet !== 'object') {
    throw new Error('Imported worksheet record is missing worksheet payload.');
  }

  if (worksheet.blocks && worksheet.worksheetId && worksheet.snapshotId) {
    return normalizeViewerPayload(worksheet, 'Imported worksheet');
  }

  if (isSnapshotLikeWorksheet(worksheet)) {
    try {
      return normalizeViewerPayload(mapSnapshotToViewerPayload(worksheet), 'Imported worksheet');
    } catch (error) {
      console.warn('Imported worksheet looked snapshot-like but failed snapshot validation.', error);
    }
  }

  if (worksheet.blocks) {
    return normalizeViewerPayload(
      {
        worksheetId: importedRecord.localId,
        snapshotId: `${importedRecord.localId}:imported-local`,
        snapshotVersion: 1,
        title: worksheet.title || 'Imported worksheet',
        blocks: worksheet.blocks,
      },
      'Imported worksheet'
    );
  }

  throw new Error('Imported worksheet payload format is not supported for viewer mode.');
}

class ViewerAttemptSession {
  constructor(storage) {
    this.storage = storage;
    this.state = {
      localAttemptId: null,
      viewerPayload: null,
      answers: {},
      status: 'in_progress',
      startedAt: null,
      lastSavedAt: null,
      completedAt: null,
      autosavePending: false,
      lastSaveError: null,
      payloadValidationErrors: [],
      attemptValidationErrors: [],
      lastManualSaveAt: null,
      source: 'unknown',
      attemptRevision: 0,
      lastSavedRevision: 0,
      recoveryMessage: null,
      lastProtectedAction: null,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
  }

  async validateViewerPayload(payload) {
    const { validateViewerPayloadSchema } = await loadContracts();
    const validation = validateViewerPayloadSchema(payload);
    this.state.payloadValidationErrors = validation.errors;
    if (!validation.valid) {
      throw new Error(`Viewer payload validation failed: ${validation.errors.join('; ')}`);
    }
    return validation;
  }

  async buildContractAttemptPayload(nextStatus = this.state.status, persistedAt = nowIso()) {
    const { mapViewerPayloadAndResponsesToAttempt, validateAttemptPayloadSchema } = await loadContracts();
    const attemptPayload = mapViewerPayloadAndResponsesToAttempt(
      this.state.viewerPayload,
      this.state.answers,
      {
        attemptId: this.state.localAttemptId,
        learnerId: DEFAULT_LEARNER_ID,
        status: nextStatus,
        startedAt: this.state.startedAt,
        lastSavedAt: persistedAt,
        submittedAt: nextStatus === 'completed' ? this.state.completedAt || persistedAt : undefined,
      }
    );
    const validation = validateAttemptPayloadSchema(attemptPayload);
    this.state.attemptValidationErrors = validation.errors;
    if (!validation.valid) {
      throw new Error(`Attempt payload validation failed: ${validation.errors.join('; ')}`);
    }
    return attemptPayload;
  }

  async bootstrap() {
    const params = new URLSearchParams(window.location.search);
    const resumeMetadata = this.storage.resumeFlags.get(RESUME_FLAG_KEY);

    const explicitAttemptId = params.get('localAttemptId') || resumeMetadata?.localId || null;
    if (explicitAttemptId) {
      const resumed = await this.tryResumeAttempt(explicitAttemptId);
      if (resumed) {
        this.persistResumeMetadata();
        return this.state;
      }
    }

    const loadedPayload = await this.loadViewerPayloadFromSources(params);
    await this.validateViewerPayload(loadedPayload.payload);
    const attempt = this.createLocalAttemptState(loadedPayload.payload, loadedPayload.source);
    this.applyAttemptState(attempt, { markDirty: true });
    this.persistResumeMetadata();

    return this.state;
  }

  async tryResumeAttempt(localAttemptId) {
    try {
      const attemptRecord = await this.storage.attempts.get(localAttemptId);
      if (!attemptRecord) {
        return false;
      }

      const normalizedPayload = normalizeViewerPayload(
        attemptRecord.viewerPayload,
        attemptRecord.viewerPayload?.title || 'Resumed worksheet'
      );
      await this.validateViewerPayload(normalizedPayload);

      this.applyAttemptState(
        {
          ...attemptRecord,
          viewerPayload: normalizedPayload,
          metadata: {
            ...attemptRecord.metadata,
            localId: localAttemptId,
          },
        },
        { markDirty: false }
      );

      return true;
    } catch (error) {
      console.warn('Unable to resume local attempt from IndexedDB.', error);
      return false;
    }
  }

  async loadViewerPayloadFromSources(params) {
    const inlinePayload =
      maybeParseEncodedJson(params.get('viewerPayload')) ||
      (typeof window !== 'undefined' ? parseJsonInput(window.__VIEWER_PAYLOAD__) : null);

    if (inlinePayload) {
      return {
        source: 'local_source',
        payload: normalizeViewerPayload(inlinePayload, 'Local worksheet'),
      };
    }

    const snapshotPayload = maybeParseEncodedJson(params.get('snapshot'));
    if (snapshotPayload) {
      return {
        source: 'snapshot_derived',
        payload: normalizeViewerPayload(mapSnapshotToViewerPayload(snapshotPayload), 'Snapshot worksheet'),
      };
    }

    const importedWorksheetId = params.get('importedWorksheetId');
    if (importedWorksheetId) {
      const importedRecord = await this.storage.importedWorksheets.get(importedWorksheetId);
      if (!importedRecord) {
        throw new Error(`Imported worksheet not found for localId=${importedWorksheetId}`);
      }

      return {
        source: 'imported_worksheet',
        payload: resolveImportedWorksheetPayload(importedRecord),
      };
    }

    const localDraftId = params.get('localDraftId');
    if (localDraftId) {
      const draftRecord = await this.storage.drafts.get(localDraftId);
      if (!draftRecord) {
        throw new Error(`Local draft not found for localId=${localDraftId}`);
      }

      return {
        source: 'local_draft',
        payload: mapDraftRecordToViewerPayload(draftRecord),
      };
    }

    return {
      source: 'local_source',
      payload: normalizeViewerPayload(
        {
          worksheetId: createLocalId('ws'),
          snapshotId: createLocalId('snapshot_local'),
          snapshotVersion: 1,
          title: 'Local worksheet',
          blocks: [
            {
              blockId: createLocalId('q'),
              kind: 'question',
              position: 0,
              prompt: {
                text: 'Type your answer to start a local attempt.',
                format: 'plain_text',
              },
              responseConfig: {
                inputType: 'plain_text',
                maxLength: 500,
              },
            },
          ],
        },
        'Local worksheet'
      ),
    };
  }

  createLocalAttemptState(viewerPayload, source) {
    const localAttemptId = createLocalId('attempt');
    const startedAt = nowIso();

    return {
      localId: localAttemptId,
      localAttemptId,
      viewerPayload,
      learnerId: DEFAULT_LEARNER_ID,
      status: 'in_progress',
      startedAt,
      lastSavedAt: startedAt,
      completedAt: null,
      answers: {},
      metadata: {
        localId: localAttemptId,
        origin: source || 'local_source',
        updatedAt: startedAt,
      },
    };
  }

  applyAttemptState(attemptRecord, options = {}) {
    this.state.localAttemptId = attemptRecord.localAttemptId || attemptRecord.localId;
    this.state.viewerPayload = attemptRecord.viewerPayload;
    this.state.answers = attemptRecord.answers || {};
    this.state.status = attemptRecord.status || 'in_progress';
    this.state.startedAt = attemptRecord.startedAt || nowIso();
    this.state.lastSavedAt = attemptRecord.lastSavedAt || null;
    this.state.completedAt = attemptRecord.completedAt || attemptRecord.submittedAt || null;
    this.state.source = attemptRecord.metadata?.origin || 'local_source';
    this.state.lastSaveError = null;

    if (options.markDirty) {
      this.state.attemptRevision += 1;
      this.scheduleAutosave();
    } else {
      this.state.attemptRevision = 1;
      this.state.lastSavedRevision = 1;
      this.state.autosavePending = false;
    }
  }

  setAnswer(blockId, value) {
    if (!blockId || this.state.status === 'completed') {
      return;
    }

    const questionBlock = this.state.viewerPayload?.blocks?.find(
      (block) => block.blockId === blockId && block.kind === 'question'
    );
    if (!questionBlock) {
      return;
    }
    const inputType = questionBlock.responseConfig?.inputType || 'plain_text';
    const coercedValue = coerceAnswerValueByInputType(inputType, value);

    this.state.answers = {
      ...this.state.answers,
      [blockId]: {
        value: coercedValue,
        answeredAt: nowIso(),
      },
    };

    this.state.attemptRevision += 1;
    this.scheduleAutosave();
    this.persistResumeMetadata();
  }

  async completeLocalAttempt() {
    if (!this.state.localAttemptId || this.state.status === 'completed') {
      return null;
    }

    this.state.status = 'completed';
    this.state.completedAt = nowIso();
    this.state.attemptRevision += 1;
    this.persistResumeMetadata();

    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;

    return this.autosave();
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.state.autosavePending = true;
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Viewer autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  async autosave() {
    if (!this.state.localAttemptId || !this.state.viewerPayload) {
      return null;
    }

    const revisionAtSaveStart = this.state.attemptRevision;
    const updatedAt = nowIso();
    const contractAttemptPayload = await this.buildContractAttemptPayload(this.state.status, updatedAt);

    const attemptRecord = {
      localId: this.state.localAttemptId,
      localAttemptId: this.state.localAttemptId,
      viewerPayload: this.state.viewerPayload,
      learnerId: DEFAULT_LEARNER_ID,
      status: this.state.status,
      startedAt: this.state.startedAt,
      lastSavedAt: updatedAt,
      completedAt: this.state.completedAt,
      answers: this.state.answers,
      metadata: {
        localId: this.state.localAttemptId,
        origin: this.state.source || 'local_source',
        updatedAt,
      },
      contractAttemptPayload,
    };

    this.inFlightSaveCount += 1;
    this.state.autosavePending = true;

    try {
      const persisted = await this.storage.attempts.put(attemptRecord);
      if (this.state.lastSavedRevision < revisionAtSaveStart) {
        this.state.lastSavedRevision = revisionAtSaveStart;
      }
      this.state.lastSavedAt = persisted?.metadata?.updatedAt || updatedAt;
      this.state.lastSaveError = null;
      this.persistResumeMetadata();
      return persisted;
    } catch (error) {
      this.state.lastSaveError = error?.message || String(error);
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.attemptRevision;
    }
  }

  async saveNow() {
    const persisted = await this.autosave();
    this.state.lastManualSaveAt = nowIso();
    return persisted;
  }


  async flushLocalStateForAuthRedirect() {
    if (!this.state.localAttemptId || !this.state.viewerPayload) return null;

    if (this.state.lastSavedRevision < this.state.attemptRevision) {
      return this.autosave();
    }

    return {
      localAttemptId: this.state.localAttemptId,
      viewerPayload: this.state.viewerPayload,
      answers: this.state.answers,
    };
  }

  getUiRestoreState() {
    return {
      status: this.state.status,
      worksheetId: this.state.viewerPayload?.worksheetId || null,
      snapshotId: this.state.viewerPayload?.snapshotId || null,
    };
  }

  async restoreByLocalId(localId) {
    if (!localId) return false;
    return this.tryResumeAttempt(localId);
  }

  applyUiRestoreState(_ui = {}) {
    this.persistResumeMetadata();
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
      throw new Error('Auth gate is not configured for viewer session.');
    }

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localAttempts',
      payload: {
        localAttemptId: this.state.localAttemptId || null,
      },
    });
  }

  persistResumeMetadata() {
    if (!this.state.localAttemptId) {
      return;
    }

    this.storage.resumeFlags.set(RESUME_FLAG_KEY, {
      localId: this.state.localAttemptId,
      store: 'localAttempts',
      status: this.state.status,
      worksheetId: this.state.viewerPayload?.worksheetId || null,
      snapshotId: this.state.viewerPayload?.snapshotId || null,
      updatedAt: nowIso(),
    });
  }
}

function renderViewerShell(session) {
  if (!app) {
    return;
  }

  const heading = document.createElement('h1');
  heading.textContent = session.state.viewerPayload.title;

  const form = document.createElement('div');
  form.id = 'viewer-answer-form';
  const status = document.createElement('p');
  const validation = document.createElement('pre');

  const blocks = [...session.state.viewerPayload.blocks].sort((a, b) => a.position - b.position);

  blocks.forEach((block) => {
    if (block.kind === 'content') {
      const content = document.createElement('p');
      content.textContent = block.content?.text || '';
      form.appendChild(content);
      return;
    }

    if (block.kind === 'question') {
      const label = document.createElement('label');
      label.textContent = block.prompt?.text || 'Question';
      const inputType = block.responseConfig?.inputType || 'plain_text';
      const controlId = `answer-${block.blockId}`;
      label.htmlFor = controlId;

      let control;
      if (inputType === 'short_text') {
        control = document.createElement('input');
        control.type = 'text';
        control.maxLength = block.responseConfig?.maxLength || 200;
        control.value = String(session.state.answers?.[block.blockId]?.value || '');
        control.addEventListener('input', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      } else if (inputType === 'number') {
        control = document.createElement('input');
        control.type = 'number';
        const priorValue = session.state.answers?.[block.blockId]?.value;
        control.value = priorValue === '' || priorValue === null || priorValue === undefined ? '' : String(priorValue);
        control.addEventListener('input', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      } else if (inputType === 'boolean') {
        control = document.createElement('select');
        [
          { value: '', label: 'Select…' },
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' },
        ].forEach((optionConfig) => {
          const option = document.createElement('option');
          option.value = optionConfig.value;
          option.textContent = optionConfig.label;
          control.appendChild(option);
        });
        const priorValue = session.state.answers?.[block.blockId]?.value;
        control.value = priorValue === true ? 'true' : priorValue === false ? 'false' : '';
        control.addEventListener('change', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      } else if (inputType === 'single_choice' && Array.isArray(block.responseConfig?.options)) {
        control = document.createElement('select');
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Select…';
        control.appendChild(blank);
        block.responseConfig.options.forEach((opt) => {
          const option = document.createElement('option');
          option.value = String(opt.value ?? opt.label ?? '');
          option.textContent = String(opt.label ?? opt.value ?? '');
          control.appendChild(option);
        });
        control.value = String(session.state.answers?.[block.blockId]?.value || '');
        control.addEventListener('change', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      } else {
        control = document.createElement('textarea');
        control.rows = 5;
        control.maxLength = block.responseConfig?.maxLength || 1000;
        control.value = String(session.state.answers?.[block.blockId]?.value || '');
        control.addEventListener('input', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      }

      control.id = controlId;
      control.disabled = session.state.status === 'completed';
      form.append(label, control);
    }
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save now';
  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.textContent = 'Submit / finalize local attempt';

  const syncResumeBtn = document.createElement('button');
  syncResumeBtn.type = 'button';
  syncResumeBtn.textContent = 'Sync/Resume (Sign-in required)';

  const rewriteAssistBtn = document.createElement('button');
  rewriteAssistBtn.type = 'button';
  rewriteAssistBtn.textContent = 'Rewrite Assist (Sign-in required)';
  completeBtn.disabled = session.state.status === 'completed';
  completeBtn.addEventListener('click', async () => {
    await session.completeLocalAttempt();
    completeBtn.disabled = true;
    Array.from(form.querySelectorAll('textarea, input, select')).forEach((control) => {
      control.disabled = true;
    });
    updateSummary();
  });

  const summary = document.createElement('pre');
  summary.id = 'viewer-state-summary';

  const updateSummary = () => {
    status.textContent = session.state.lastSaveError
      ? `⚠️ ${session.state.lastSaveError}`
      : session.state.autosavePending
        ? 'Saving…'
        : `Saved${session.state.lastSavedAt ? ` at ${session.state.lastSavedAt}` : ''}`;

    validation.textContent = JSON.stringify(
      {
        payloadErrors: session.state.payloadValidationErrors,
        attemptErrors: session.state.attemptValidationErrors,
      },
      null,
      2
    );

    summary.textContent = JSON.stringify(
      {
        localAttemptId: session.state.localAttemptId,
        worksheetId: session.state.viewerPayload?.worksheetId || null,
        snapshotId: session.state.viewerPayload?.snapshotId || null,
        status: session.state.status,
        autosavePending: session.state.autosavePending,
        lastSavedAt: session.state.lastSavedAt,
        lastManualSaveAt: session.state.lastManualSaveAt,
        completedAt: session.state.completedAt,
        answerCount: Object.keys(session.state.answers || {}).length,
        source: session.state.source,
        recoveryMessage: session.state.recoveryMessage,
        lastProtectedAction: session.state.lastProtectedAction,
      },
      null,
      2
    );
  };

  saveBtn.addEventListener('click', async () => {
    await session.saveNow();
    updateSummary();
  });
  syncResumeBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeAttemptSyncAfterLogin');
    updateSummary();
  });

  rewriteAssistBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeViewerRewriteAfterLogin');
    updateSummary();
  });

  app.innerHTML = '';
  app.append(heading, status, form, saveBtn, completeBtn, syncResumeBtn, rewriteAssistBtn, validation, summary);
  updateSummary();
}

async function bootstrapViewer() {
  const session = new ViewerAttemptSession(viewerStorage);
  await session.bootstrap();

  const authGate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: RESUME_FLAG_KEY,
    storage: session.storage,
    isAuthenticated: () => new URL(window.location.href).searchParams.get('auth') === '1',
    getCurrentLocalId: () => session.state.localAttemptId || null,
    getCurrentUiState: () => session.getUiRestoreState(),
    persistLocalRecord: () => session.flushLocalStateForAuthRedirect(),
    restoreByLocalId: (localIdToRestore) => session.restoreByLocalId(localIdToRestore),
    restoreUiState: (uiState) => session.applyUiRestoreState(uiState),
    validateIntent: (intent) => Boolean(intent?.actionId && session.state.localAttemptId),
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

  renderViewerShell(session);
  window.viewerSession = session;
}

bootstrapViewer().catch((error) => {
  console.error('Failed to bootstrap viewer', error);
  if (app) {
    app.textContent = `Viewer failed to boot: ${error.message}`;
  }
});

export { ViewerAttemptSession, normalizeViewerPayload, resolveImportedWorksheetPayload, normalizeViewerBlock };
