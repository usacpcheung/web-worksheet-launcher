import { viewerStorage } from './storage/index.js';
import { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';
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
    return {
      ...base,
      prompt: {
        text: String(safeBlock?.prompt?.text || ''),
        format: safeBlock?.prompt?.format || 'plain_text',
      },
      responseConfig: {
        inputType: safeBlock?.responseConfig?.inputType || 'plain_text',
        maxLength: Number.isFinite(safeBlock?.responseConfig?.maxLength)
          ? safeBlock.responseConfig.maxLength
          : 1000,
      },
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
      source: 'unknown',
      attemptRevision: 0,
      lastSavedRevision: 0,
      recoveryMessage: null,
      lastProtectedAction: null,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
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

    this.state.answers = {
      ...this.state.answers,
      [blockId]: {
        value,
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
      label.htmlFor = `answer-${block.blockId}`;

      const textarea = document.createElement('textarea');
      textarea.id = `answer-${block.blockId}`;
      textarea.rows = 5;
      textarea.maxLength = block.responseConfig?.maxLength || 1000;
      textarea.value = String(session.state.answers?.[block.blockId]?.value || '');
      textarea.disabled = session.state.status === 'completed';
      textarea.addEventListener('input', () => {
        session.setAnswer(block.blockId, textarea.value);
        updateSummary();
      });

      form.append(label, textarea);
    }
  });

  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.textContent = 'Complete Local Attempt';

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
    Array.from(form.querySelectorAll('textarea')).forEach((textarea) => {
      textarea.disabled = true;
    });
    updateSummary();
  });

  const summary = document.createElement('pre');
  summary.id = 'viewer-state-summary';

  const updateSummary = () => {
    summary.textContent = JSON.stringify(
      {
        localAttemptId: session.state.localAttemptId,
        worksheetId: session.state.viewerPayload?.worksheetId || null,
        snapshotId: session.state.viewerPayload?.snapshotId || null,
        status: session.state.status,
        autosavePending: session.state.autosavePending,
        lastSavedAt: session.state.lastSavedAt,
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

  syncResumeBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeAttemptSyncAfterLogin');
    updateSummary();
  });

  rewriteAssistBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeViewerRewriteAfterLogin');
    updateSummary();
  });

  app.innerHTML = '';
  app.append(heading, form, completeBtn, syncResumeBtn, rewriteAssistBtn, summary);
  updateSummary();
  setInterval(updateSummary, 500);
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
