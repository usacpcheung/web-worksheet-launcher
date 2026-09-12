import { createVoiceWorkflow, normalizeVoiceRecovery, REWRITE_INPUT_LIMIT, hasPendingRecovery } from '../../../viewer/answer-voice-workflow.js';
export const DISCUSSION_REWRITE_MAX_CHARS = REWRITE_INPUT_LIMIT;

const STORAGE_KEY = 'roleplayscene:discussion:v1';

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeDiscussionProjectFingerprint(project = {}) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const payload = {
    title: project?.meta?.title || '',
    version: project?.meta?.version || 1,
    scenes: scenes.map(scene => ({
      id: scene?.id || '',
      type: scene?.type || '',
      imageName: scene?.image?.name || '',
      dialogue: (scene?.dialogue || []).map(line => ({
        speakerId: line?.speakerId || null,
        text: line?.text || '',
      })),
      choices: (scene?.choices || []).map(choice => ({
        id: choice?.id || '',
        label: choice?.label || '',
        nextSceneId: choice?.nextSceneId || null,
        cueCardText: choice?.cueCardText || '',
      })),
      autoNextSceneId: scene?.autoNextSceneId || null,
    })),
  };
  return hashString(stableStringify(payload));
}

function getStorage(storage = globalThis?.sessionStorage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}

function normalizeText(value) {
  return String(value ?? '');
}

export class RolePlaySceneDiscussionSession {
  constructor({ storage = globalThis?.sessionStorage, apiClient = null, checkSession = async () => ({ ok: true }), beginSignIn = () => {}, recording } = {}) {
    this.storage = getStorage(storage);
    this.apiClient = apiClient;
    this.projectFingerprint = '';
    this.generation = 0;
    this.project = null;
    this.listeners = new Set();
    this.recovery = {};
    this.saveFailed = false;
    this.state = { attemptRevision: 0, voiceRecovery: this.recovery, voiceApplied: null, answers: {}, viewerPayload: { blocks: [] }, lastActiveBlockId: null };
    this.beginServerSignIn = beginSignIn;
    this.scheduleAutosave = () => this.persist();
    this.voice = createVoiceWorkflow({
      api: apiClient, checkSession, recording,
      context: id => ({ attemptId: String(this.generation), contextKey: this.projectFingerprint,
        block: this.state.viewerPayload.blocks.find(b => b.blockId === id),
        editable: Boolean(this.project), answer: this.getText(id), recovery: this.recovery[id] }),
      apply: (id, text, previous, caret) => {
        this.undoBySceneId[id] = previous;
        this.setText(id, text, { manual: false });
        this.state.voiceApplied = { id: ++this.appliedSequence, blockId: id, text, caret };
      },
      recover: (id, record) => {
        if (record) this.recovery[id] = record; else delete this.recovery[id];
        this.persist();
        this.emit();
      },
      changed: () => {
        this.isRewriting = Boolean(this.voice?.active);
        this.rewritingSceneId = this.voice?.active?.blockId || null;
        this.emit();
      },
    });
    this.appliedSequence = 0;
    this.discussionBySceneId = {};
    this.undoBySceneId = {};
    this.messageBySceneId = {};
    this.isRewriting = false;
    this.rewritingSceneId = null;
  }

  bindProject(project) {
    const nextFingerprint = computeDiscussionProjectFingerprint(project);
    if (nextFingerprint === this.projectFingerprint) {
      if (project !== this.project) {
        this.teardown();
        this.project = project;
      }
      return;
    }
    this.voice.teardown();
    this.generation++;
    this.project = project;
    this.projectFingerprint = nextFingerprint;
    this.recovery = {};
    this.state.voiceRecovery = this.recovery;
    this.state.voiceApplied = null;
    this.state.viewerPayload.blocks = (project.scenes || []).map(scene => ({ blockId: scene.id, kind: 'question', responseConfig: { inputType: 'text', maxLength: Number.MAX_SAFE_INTEGER } }));
    this.discussionBySceneId = {};
    this.undoBySceneId = {};
    this.messageBySceneId = {};
    this.isRewriting = false;
    this.rewritingSceneId = null;
    this.restore();
  }

  getStoragePayload() {
    return {
      fingerprint: this.projectFingerprint,
      discussionBySceneId: this.discussionBySceneId,
      recovery: normalizeVoiceRecovery(this.recovery, this.state.viewerPayload.blocks),
    };
  }

  restore() {
    if (!this.storage || !this.projectFingerprint) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.fingerprint !== this.projectFingerprint || !parsed?.discussionBySceneId) {
        return;
      }
      this.discussionBySceneId = { ...parsed.discussionBySceneId };
      this.recovery = normalizeVoiceRecovery(parsed.recovery, this.state.viewerPayload.blocks);
      this.state.voiceRecovery = this.recovery;
      this.syncAnswers();
    } catch {
      // Ignore invalid recovery data.
    }
  }

  persist() {
    if (!this.storage || !this.projectFingerprint) { this.saveFailed = true; return; }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.getStoragePayload()));
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
    }
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { this.syncAnswers(); for (const listener of this.listeners) listener(); }
  syncAnswers() { this.state.answers = Object.fromEntries(Object.keys(this.discussionBySceneId).map(id => [id, { value: this.getText(id) }])); }
  hasPendingWork() { return Boolean(this.voice.active) || Object.values(this.recovery).some(hasPendingRecovery); }
  teardown() { this.voice.teardown(); this.generation++; this.state.lastActiveBlockId = null; }

  clear() {
    this.voice.teardown();
    this.generation++;
    this.recovery = {};
    this.state.voiceRecovery = this.recovery;
    this.discussionBySceneId = {};
    this.undoBySceneId = {};
    this.messageBySceneId = {};
    this.isRewriting = false;
    this.rewritingSceneId = null;
    this.persist();
  }

  hasAnyText() {
    return Object.values(this.discussionBySceneId)
      .some(entry => normalizeText(entry?.text).trim().length > 0);
  }

  getText(sceneId) {
    return normalizeText(this.discussionBySceneId?.[sceneId]?.text);
  }

  getMessage(sceneId) {
    return normalizeText(this.messageBySceneId?.[sceneId]);
  }

  hasUndo(sceneId) {
    return Object.prototype.hasOwnProperty.call(this.undoBySceneId, sceneId);
  }

  setText(sceneId, text, { manual = true } = {}) {
    if (!sceneId) return;
    this.discussionBySceneId = {
      ...this.discussionBySceneId,
      [sceneId]: {
        text: normalizeText(text),
        updatedAt: Date.now(),
      },
    };
    if (manual && this.hasUndo(sceneId)) {
      const nextUndo = { ...this.undoBySceneId };
      delete nextUndo[sceneId];
      this.undoBySceneId = nextUndo;
    }
    this.messageBySceneId = {
      ...this.messageBySceneId,
      [sceneId]: '',
    };
    this.persist();
    this.syncAnswers();
  }

  undo(sceneId) {
    if (!sceneId || this.isRewriting || !this.hasUndo(sceneId)) return false;
    const previousText = this.undoBySceneId[sceneId];
    const nextUndo = { ...this.undoBySceneId };
    delete nextUndo[sceneId];
    this.undoBySceneId = nextUndo;
    this.setText(sceneId, previousText, { manual: false });
    return true;
  }

  async rewrite(sceneId) {
    return this.voice.run(sceneId, { mode: 'rewrite' });
  }

  snapshot() {
    return {
      fingerprint: this.projectFingerprint,
      discussionBySceneId: { ...this.discussionBySceneId },
      undoBySceneId: { ...this.undoBySceneId },
      messageBySceneId: { ...this.messageBySceneId },
      isRewriting: this.isRewriting,
      rewritingSceneId: this.rewritingSceneId,
    };
  }
}
