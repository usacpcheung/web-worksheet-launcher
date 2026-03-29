import { viewerStorage } from './storage/index.js';
import { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';
import { validateViewerPayloadSchema } from '../app/contracts/validators.js';
import { normalizeNumberRules, validateNumberInputFormat } from '../app/contracts/number-input-validator.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const RESUME_FLAG_KEY = 'viewer:lastSession';
const DEFAULT_LEARNER_ID = 'local_learner';

function nowIso() {
  return new Date().toISOString();
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
    const legacyInputType = responseConfigSource.inputType || 'text';
    const inputType = legacyInputType === 'plain_text' || legacyInputType === 'short_text'
      ? 'text'
      : legacyInputType === 'single_choice'
        ? 'multiple_choice'
        : legacyInputType;
    const normalizedResponseConfig = {
      inputType,
    };

    if (inputType === 'text') {
      normalizedResponseConfig.maxLength = Number.isFinite(responseConfigSource.maxLength)
        ? responseConfigSource.maxLength
        : 200;
      normalizedResponseConfig.displayMode = responseConfigSource.displayMode === 'single_line'
        ? 'single_line'
        : 'multi_line';
    }

    if (inputType === 'number') {
      normalizedResponseConfig.numberRules = normalizeNumberRules(responseConfigSource.numberRules);
      if (Number.isFinite(responseConfigSource.min)) {
        normalizedResponseConfig.min = Number(responseConfigSource.min);
      }
      if (Number.isFinite(responseConfigSource.max)) {
        normalizedResponseConfig.max = Number(responseConfigSource.max);
      }
      if (Number.isFinite(responseConfigSource.step) && Number(responseConfigSource.step) > 0) {
        normalizedResponseConfig.step = Number(responseConfigSource.step);
      }
    }

    if (inputType === 'multiple_choice') {
      normalizedResponseConfig.selectionMode = legacyInputType === 'single_choice'
        ? 'single'
        : responseConfigSource.selectionMode === 'multi'
          ? 'multi'
          : 'single';
      normalizedResponseConfig.shuffleOptions = Boolean(responseConfigSource.shuffleOptions);
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

function clampToNumberConfig(value, responseConfig = {}) {
  if (!Number.isFinite(value)) return '';
  let nextValue = value;
  const min = Number.isFinite(responseConfig.min) ? Number(responseConfig.min) : null;
  const max = Number.isFinite(responseConfig.max) ? Number(responseConfig.max) : null;
  const step = Number.isFinite(responseConfig.step) && Number(responseConfig.step) > 0
    ? Number(responseConfig.step)
    : null;

  if (min !== null) nextValue = Math.max(min, nextValue);
  if (max !== null) nextValue = Math.min(max, nextValue);
  if (step !== null) {
    const base = min !== null ? min : 0;
    nextValue = Math.round((nextValue - base) / step) * step + base;
    if (min !== null) nextValue = Math.max(min, nextValue);
    if (max !== null) nextValue = Math.min(max, nextValue);
    const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    if (decimals > 0) {
      nextValue = Number(nextValue.toFixed(decimals));
    }
  }
  return nextValue;
}

function coerceAnswerValueForQuestion(questionBlock, rawValue) {
  const inputType = questionBlock?.responseConfig?.inputType || 'text';
  const responseConfig = isRecord(questionBlock?.responseConfig) ? questionBlock.responseConfig : {};
  if (inputType === 'number') {
    const validation = validateNumberInputFormat(rawValue, responseConfig.numberRules);
    if (!validation.ok) return '';
    return clampToNumberConfig(validation.normalizedValue, responseConfig);
  }
  if (inputType === 'multiple_choice') {
    const options = Array.isArray(responseConfig.options)
      ? responseConfig.options.map((opt) => String(opt?.value ?? opt?.label ?? ''))
      : [];
    if (responseConfig.selectionMode === 'multi') {
      const values = Array.isArray(rawValue) ? rawValue.map((v) => String(v)) : [];
      return values.filter((value, idx) => options.includes(value) && values.indexOf(value) === idx);
    }
    const single = String(rawValue ?? '');
    return options.includes(single) ? single : '';
  }
  return coerceAnswerValueByInputType(inputType, rawValue);
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

function partitionBlocksForDisplay(blocks = []) {
  const ordered = [...blocks].sort((a, b) => a.position - b.position);
  return {
    contentBlocks: ordered.filter((block) => block.kind === 'content'),
    questionBlocks: ordered.filter((block) => block.kind === 'question'),
  };
}

function computeAnswerSummary(viewerPayload, answers) {
  const questions = (viewerPayload?.blocks || []).filter((block) => block.kind === 'question');

  function isAnsweredValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') {
      return value.trim() !== '';
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }

  const answered = questions.filter((block) => {
    const value = answers?.[block.blockId]?.value;
    return isAnsweredValue(value);
  }).length;
  return { answered, total: questions.length };
}

function getInputHelperText(inputType) {
  if (inputType === 'text') return 'Text response.';
  if (inputType === 'number') return 'Enter integer/decimal only (fractions like 2/3 are not supported).';
  if (inputType === 'boolean') return 'Choose True / False.';
  if (inputType === 'multiple_choice') return 'Choose one or more options.';
  return 'Text response.';
}

function deterministicShuffle(items, seedText) {
  const list = [...items];
  const seedSource = String(seedText ?? '');
  let seed = 0;
  for (let i = 0; i < seedSource.length; i += 1) {
    seed = (seed * 31 + seedSource.charCodeAt(i)) >>> 0;
  }
  for (let i = list.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
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
    this.onStateChange = null;
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  async validateViewerPayload(payload) {
    const validation = validateViewerPayloadSchema(payload);
    this.state.payloadValidationErrors = validation.errors;
    if (!validation.valid) {
      throw new Error(`Viewer payload validation failed: ${validation.errors.join('; ')}`);
    }
    return validation;
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
                inputType: 'text',
                maxLength: 200,
                displayMode: 'multi_line',
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
    const coercedValue = coerceAnswerValueForQuestion(questionBlock, value);

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
    this.notifyStateChange();
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
    };

    this.inFlightSaveCount += 1;
    this.state.autosavePending = true;
    this.notifyStateChange();

    try {
      const persisted = await this.storage.attempts.put(attemptRecord);
      const shouldApplySaveStatus =
        this.state.localAttemptId === attemptRecord.localId && revisionAtSaveStart >= this.state.lastSavedRevision;
      if (shouldApplySaveStatus) {
        this.state.lastSavedRevision = revisionAtSaveStart;
        this.state.lastSavedAt = persisted?.metadata?.updatedAt || updatedAt;
        this.state.lastSaveError = null;
        this.persistResumeMetadata();
        this.notifyStateChange();
      }
      return persisted;
    } catch (error) {
      const shouldApplyErrorStatus =
        this.state.localAttemptId === attemptRecord.localId && revisionAtSaveStart > this.state.lastSavedRevision;
      if (shouldApplyErrorStatus) {
        this.state.lastSaveError = error?.message || String(error);
        this.notifyStateChange();
      }
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.attemptRevision;
      this.notifyStateChange();
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

  const shell = document.createElement('div');
  shell.className = 'viewer-shell';

  const header = document.createElement('header');
  header.className = 'viewer-header';
  const heading = document.createElement('h1');
  heading.textContent = session.state.viewerPayload.title;
  const metadata = document.createElement('p');
  metadata.className = 'muted';

  const answerSummary = document.createElement('p');
  answerSummary.className = 'answer-summary';
  const status = document.createElement('p');

  const contentSection = document.createElement('section');
  contentSection.className = 'viewer-section';
  const contentHeading = document.createElement('h2');
  contentHeading.textContent = 'Content';
  const questionSection = document.createElement('section');
  questionSection.className = 'viewer-section';
  const questionHeading = document.createElement('h2');
  questionHeading.textContent = 'Questions';

  const contentList = document.createElement('div');
  const questionList = document.createElement('div');
  questionList.id = 'viewer-answer-form';
  const answerControls = new Map();
  let contentSignature = null;
  let questionSignature = null;
  const numberInputErrors = new Map();

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save Now';
  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.textContent = 'Submit / Finalize';

  const syncResumeBtn = document.createElement('button');
  syncResumeBtn.type = 'button';
  syncResumeBtn.textContent = 'Sync/Resume (Sign-in required)';

  const rewriteAssistBtn = document.createElement('button');
  rewriteAssistBtn.type = 'button';
  rewriteAssistBtn.textContent = 'Rewrite Assist (Sign-in required)';

  const stickyActions = document.createElement('div');
  stickyActions.className = 'sticky-action-row';
  const secondaryActions = document.createElement('div');
  secondaryActions.className = 'secondary-actions';
  secondaryActions.append(syncResumeBtn, rewriteAssistBtn);

  completeBtn.disabled = session.state.status === 'completed';
  completeBtn.addEventListener('click', async () => {
    await session.completeLocalAttempt();
    completeBtn.disabled = true;
    Array.from(questionList.querySelectorAll('textarea, input, select')).forEach((control) => {
      control.disabled = true;
    });
    updateSummary();
  });
  stickyActions.append(saveBtn, completeBtn, secondaryActions);

  const renderContentCards = (contentBlocks) => {
    const nextSignature = JSON.stringify(contentBlocks.map((block) => [block.blockId, block.content?.text || '']));
    if (nextSignature === contentSignature) {
      return;
    }
    contentSignature = nextSignature;
    contentList.innerHTML = '';

    contentBlocks.forEach((block) => {
      const card = document.createElement('article');
      card.className = 'content-card';
      card.textContent = block.content?.text || '';
      contentList.appendChild(card);
    });
  };

  const renderQuestionCards = (questionBlocks) => {
    const nextSignature = JSON.stringify(questionBlocks.map((block) => ({
      blockId: block.blockId,
      prompt: block.prompt?.text || '',
      inputType: block.responseConfig?.inputType || 'text',
      maxLength: block.responseConfig?.maxLength || null,
      options: Array.isArray(block.responseConfig?.options)
        ? block.responseConfig.options.map((opt) => [opt?.value ?? '', opt?.label ?? ''])
        : [],
    })));
    if (nextSignature === questionSignature) {
      return;
    }
    questionSignature = nextSignature;
    answerControls.clear();
    questionList.innerHTML = '';

    questionBlocks.forEach((block, index) => {
      const card = document.createElement('article');
      card.className = 'question-card';
      const label = document.createElement('label');
      const inputType = block.responseConfig?.inputType || 'text';
      const controlId = `answer-${block.blockId}`;
      label.textContent = `${index + 1}. ${block.prompt?.text || 'Question'}`;
      label.htmlFor = controlId;

      const helper = document.createElement('p');
      helper.className = 'muted';
      helper.textContent = getInputHelperText(inputType);
      const inputError = document.createElement('p');
      inputError.className = 'input-error';
      inputError.textContent = '';

      let control;
      if (inputType === 'text' && block.responseConfig?.displayMode === 'single_line') {
        control = document.createElement('input');
        control.type = 'text';
        control.maxLength = block.responseConfig?.maxLength || 200;
        control.addEventListener('input', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      } else if (inputType === 'number') {
        control = document.createElement('input');
        control.type = 'text';
        control.inputMode = 'decimal';
        if (Number.isFinite(block.responseConfig?.min)) control.min = String(block.responseConfig.min);
        if (Number.isFinite(block.responseConfig?.max)) control.max = String(block.responseConfig.max);
        control.addEventListener('input', () => {
          const trimmed = control.value.trim();
          if (trimmed === '') {
            numberInputErrors.set(block.blockId, '');
            session.setAnswer(block.blockId, '');
            updateSummary();
            return;
          }
          const validation = validateNumberInputFormat(trimmed, block.responseConfig?.numberRules);
          if (!validation.ok) {
            const messageByCode = {
              fraction_not_allowed: 'Fractions are not supported (for example, 2/3).',
              sign_not_allowed: 'Signed values are not allowed for this question.',
              kind_not_allowed: 'Only the configured number format is allowed.',
              decimal_places_exceeded: 'Too many decimal places for this question.',
              invalid_syntax: 'Enter a valid integer or decimal number.',
            };
            numberInputErrors.set(block.blockId, messageByCode[validation.errorCode] || 'Invalid number format.');
            updateSummary();
            return;
          }
          numberInputErrors.set(block.blockId, '');
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
      } else if (inputType === 'multiple_choice' && Array.isArray(block.responseConfig?.options)) {
        const optionSource = block.responseConfig.shuffleOptions
          ? deterministicShuffle(
            block.responseConfig.options,
            `${session.state.localAttemptId || 'attempt'}:${block.blockId}`
          )
          : block.responseConfig.options;

        if (block.responseConfig.selectionMode === 'multi') {
          const container = document.createElement('div');
          container.className = 'choice-list';
          optionSource.forEach((opt, optionIndex) => {
            const wrapper = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.choiceValue = String(opt.value ?? opt.label ?? '');
            checkbox.id = `${controlId}-${optionIndex}`;
            checkbox.addEventListener('change', () => {
              const checkedValues = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
                .map((input) => input.dataset.choiceValue || '');
              session.setAnswer(block.blockId, checkedValues);
              updateSummary();
            });
            const text = document.createElement('span');
            text.textContent = String(opt.label ?? opt.value ?? '');
            wrapper.append(checkbox, text);
            container.appendChild(wrapper);
          });
          control = container;
        } else {
          control = document.createElement('select');
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = 'Select…';
          control.appendChild(blank);
          optionSource.forEach((opt) => {
            const option = document.createElement('option');
            option.value = String(opt.value ?? opt.label ?? '');
            option.textContent = String(opt.label ?? opt.value ?? '');
            control.appendChild(option);
          });
          control.addEventListener('change', () => {
            session.setAnswer(block.blockId, control.value);
            updateSummary();
          });
        }
      } else {
        control = document.createElement('textarea');
        control.rows = 5;
        control.maxLength = block.responseConfig?.maxLength || 200;
        control.addEventListener('input', () => {
          session.setAnswer(block.blockId, control.value);
          updateSummary();
        });
      }

      if (typeof HTMLElement !== 'undefined' && control instanceof HTMLElement) {
        control.id = controlId;
      }
      answerControls.set(block.blockId, control);
      card.append(label, helper, control, inputError);
      questionList.appendChild(card);
    });
  };

  const syncAnswerControlValues = (questionBlocks) => {
    const activeElement = document.activeElement;
    questionBlocks.forEach((block) => {
      const control = answerControls.get(block.blockId);
      if (!control) {
        return;
      }
      const inputType = block.responseConfig?.inputType || 'text';
      const storedValue = session.state.answers?.[block.blockId]?.value;
      const nextValue = inputType === 'number'
        ? (storedValue === '' || storedValue === null || storedValue === undefined ? '' : String(storedValue))
        : inputType === 'boolean'
          ? (storedValue === true ? 'true' : storedValue === false ? 'false' : '')
          : String(storedValue || '');
      if (inputType === 'multiple_choice' && block.responseConfig?.selectionMode === 'multi') {
        const selectedSet = new Set(Array.isArray(storedValue) ? storedValue.map((v) => String(v)) : []);
        Array.from(control.querySelectorAll('input[type="checkbox"]')).forEach((checkbox) => {
          checkbox.checked = selectedSet.has(checkbox.dataset.choiceValue || '');
          checkbox.disabled = session.state.status === 'completed';
        });
      } else if (control !== activeElement && control.value !== nextValue) {
        control.value = nextValue;
      }
      if (!(inputType === 'multiple_choice' && block.responseConfig?.selectionMode === 'multi')) {
        control.disabled = session.state.status === 'completed';
      }
      const card = control.closest('.question-card');
      const errorNode = card?.querySelector('.input-error');
      if (errorNode) {
        errorNode.textContent = inputType === 'number' ? (numberInputErrors.get(block.blockId) || '') : '';
      }
    });
  };

  const updateSummary = () => {
    const { contentBlocks, questionBlocks } = partitionBlocksForDisplay(session.state.viewerPayload.blocks || []);
    renderContentCards(contentBlocks);
    renderQuestionCards(questionBlocks);
    syncAnswerControlValues(questionBlocks);

    const summary = computeAnswerSummary(session.state.viewerPayload, session.state.answers);
    status.textContent = session.state.lastSaveError
      ? `⚠️ ${session.state.lastSaveError}`
      : session.state.autosavePending
        ? 'Saving…'
        : `Saved${session.state.lastSavedAt ? ` at ${session.state.lastSavedAt}` : ''}`;
    metadata.textContent =
      `worksheetId: ${session.state.viewerPayload?.worksheetId || 'n/a'} · `
      + `snapshotId: ${session.state.viewerPayload?.snapshotId || 'n/a'} · `
      + `source: ${session.state.source} · status: ${session.state.status}`;
    answerSummary.textContent = `Answered ${summary.answered}/${summary.total} · ${status.textContent}`;
  };

  session.setOnStateChange(() => {
    updateSummary();
  });

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

  header.append(heading, metadata, answerSummary);
  contentSection.append(contentHeading, contentList);
  questionSection.append(questionHeading, questionList);
  shell.append(header, contentSection, questionSection, stickyActions);
  app.innerHTML = '';
  app.append(shell);
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

export {
  ViewerAttemptSession,
  normalizeViewerPayload,
  resolveImportedWorksheetPayload,
  normalizeViewerBlock,
  computeAnswerSummary,
  partitionBlocksForDisplay,
  getInputHelperText,
  coerceAnswerValueForQuestion,
  deterministicShuffle,
};
