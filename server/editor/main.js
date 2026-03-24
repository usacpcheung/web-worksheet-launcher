import { editorStorage } from './storage/index.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix = 'local') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
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
    const base = {
      blockId: block.blockId || createLocalId('blk'),
      kind: block.kind || 'content',
      position: Number.isFinite(block.position) ? block.position : index,
    };

    if (block.prompt) {
      return {
        ...base,
        prompt: {
          text: String(block.prompt.text || ''),
          format: block.prompt.format || 'plain_text',
        },
      };
    }

    return {
      ...base,
      content: {
        text: String(block?.content?.text || ''),
        format: block?.content?.format || 'plain_text',
      },
    };
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
    };

    this.autosaveTimer = null;
  }

  async createOrOpenByLocalDraftId(localDraftId) {
    if (!localDraftId) {
      this.state.draft = createDraftRecord();
      this.state.selectedBlockId = this.state.draft.blocks[0]?.blockId || null;
      await this.autosave();
      this.persistRestoreMetadata();
      return this.state.draft;
    }

    const existing = await this.storage.drafts.get(localDraftId);
    if (existing) {
      this.state.draft = {
        ...existing,
        blocks: normalizeBlocks(existing.blocks),
      };
      this.state.selectedBlockId = this.state.draft.blocks[0]?.blockId || null;
      this.persistRestoreMetadata();
      return this.state.draft;
    }

    this.state.draft = createDraftRecord({ localId: localDraftId });
    this.state.selectedBlockId = this.state.draft.blocks[0]?.blockId || null;
    await this.autosave();
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

    const updatedAt = nowIso();
    this.state.draft = {
      ...this.state.draft,
      metadata: {
        ...this.state.draft.metadata,
        localId: this.state.draft.localId,
        updatedAt,
      },
    };

    const persisted = await this.storage.drafts.put(this.state.draft);
    this.state.draft = persisted;
    this.state.lastSavedAt = updatedAt;
    this.state.autosavePending = false;
    this.persistRestoreMetadata();
    return persisted;
  }

  async importWorksheetJson(jsonInput, options = {}) {
    const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
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
      await this.autosave();
      this.persistRestoreMetadata();
      return { importedRecord, draftRecord: this.state.draft };
    }

    return { importedRecord, draftRecord: null };
  }

  exportCurrentDraftToFile() {
    if (!this.state.draft) {
      throw new Error('No active draft to export.');
    }

    const timestampToken = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worksheet-draft-${this.state.draft.localId}-${timestampToken}.json`;
    downloadJson(this.state.draft, filename);
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
    this.scheduleAutosave();
    this.persistRestoreMetadata();
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
      hash: this.state.hash || (typeof window !== 'undefined' ? window.location.hash || '' : ''),
      scrollToken:
        this.state.scrollToken ||
        (typeof window !== 'undefined' ? String(window.scrollY || 0) : null),
      updatedAt: nowIso(),
    });
  }
}

function renderEditorShell(session) {
  if (!app) return;

  const restore = session.getRouteUiRestoreMetadata();
  const summary = document.createElement('pre');
  summary.id = 'editor-state-summary';

  const titleInput = document.createElement('input');
  titleInput.placeholder = 'Worksheet title';

  const blockEditor = document.createElement('textarea');
  blockEditor.rows = 8;
  blockEditor.placeholder = 'Selected block text';

  const modeSelect = document.createElement('select');
  ['edit', 'preview'].forEach((mode) => {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    modeSelect.appendChild(option);
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export draft JSON';

  const updateSummary = () => {
    const selectedBlock = session.state.draft?.blocks?.find(
      (block) => block.blockId === session.state.selectedBlockId
    );

    titleInput.value = session.state.draft?.title || '';
    blockEditor.value = selectedBlock?.prompt?.text || selectedBlock?.content?.text || '';
    modeSelect.value = session.state.mode;

    summary.textContent = JSON.stringify(
      {
        localDraftId: session.state.draft?.localId || null,
        lastSavedAt: session.state.lastSavedAt,
        autosavePending: session.state.autosavePending,
        mode: session.state.mode,
        selectedBlockId: session.state.selectedBlockId,
        restore,
      },
      null,
      2
    );
  };

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });

  blockEditor.addEventListener('input', () => {
    session.updateBlockContent(session.state.selectedBlockId, blockEditor.value);
    updateSummary();
  });

  modeSelect.addEventListener('change', () => {
    session.setMode(modeSelect.value);
    updateSummary();
  });

  exportBtn.addEventListener('click', () => {
    session.exportCurrentDraftToFile();
    updateSummary();
  });

  app.innerHTML = '';
  app.append(titleInput, modeSelect, blockEditor, exportBtn, summary);
  updateSummary();

  setInterval(updateSummary, 500);
}

async function bootstrapEditor() {
  const session = new EditorDraftSession(editorStorage);
  const params = new URLSearchParams(window.location.search);
  const localDraftId = params.get('localDraftId') || session.getRouteUiRestoreMetadata()?.localId || null;

  await session.createOrOpenByLocalDraftId(localDraftId);

  const restored = session.getRouteUiRestoreMetadata();
  if (restored?.mode) {
    session.setMode(restored.mode);
  }
  if (restored?.selectedBlockId) {
    session.selectBlock(restored.selectedBlockId);
  }
  session.setRouteUiRestoreMetadata({
    hash: restored?.hash || window.location.hash || '',
    scrollToken: restored?.scrollToken || null,
  });

  renderEditorShell(session);

  window.editorSession = session;
}

bootstrapEditor().catch((error) => {
  console.error('Failed to bootstrap editor', error);
  if (app) {
    app.textContent = `Editor failed to boot: ${error.message}`;
  }
});

export { EditorDraftSession, createDraftRecord };
