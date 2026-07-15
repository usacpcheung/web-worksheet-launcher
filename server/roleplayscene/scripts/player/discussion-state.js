export const DISCUSSION_REWRITE_MAX_CHARS = 300;

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
  constructor({ storage = globalThis?.sessionStorage, apiClient = null } = {}) {
    this.storage = getStorage(storage);
    this.apiClient = apiClient;
    this.projectFingerprint = '';
    this.discussionBySceneId = {};
    this.undoBySceneId = {};
    this.messageBySceneId = {};
    this.isRewriting = false;
    this.rewritingSceneId = null;
  }

  bindProject(project) {
    const nextFingerprint = computeDiscussionProjectFingerprint(project);
    if (nextFingerprint === this.projectFingerprint) {
      return;
    }
    this.projectFingerprint = nextFingerprint;
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
    } catch {
      // Ignore invalid recovery data.
    }
  }

  persist() {
    if (!this.storage || !this.projectFingerprint) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.getStoragePayload()));
    } catch {
      // Session backup is best-effort only.
    }
  }

  clear() {
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

  async rewrite(sceneId, textAtClick, { apiClient = this.apiClient } = {}) {
    const sourceText = normalizeText(textAtClick);
    const trimmed = sourceText.trim();
    if (!sceneId || !apiClient || !trimmed || trimmed.length > DISCUSSION_REWRITE_MAX_CHARS || this.isRewriting) {
      return { ok: false, status: 'rewrite_not_available' };
    }
    this.isRewriting = true;
    this.rewritingSceneId = sceneId;
    this.messageBySceneId = { ...this.messageBySceneId, [sceneId]: '' };
    try {
      const result = await apiClient.rewriteText(trimmed);
      if (!result?.ok) {
        const errorMessage = result?.error?.message || 'Rewrite could not be completed.';
        this.messageBySceneId = { ...this.messageBySceneId, [sceneId]: errorMessage };
        return { ok: false, status: 'rewrite_failed', error: result?.error };
      }
      if (this.getText(sceneId) !== sourceText) {
        this.messageBySceneId = {
          ...this.messageBySceneId,
          [sceneId]: 'Your discussion changed before rewrite finished, so we did not apply the rewrite.',
        };
        return { ok: false, status: 'rewrite_stale_context' };
      }
      const rewrittenText = normalizeText(result.data?.text).trim();
      if (rewrittenText === sourceText) {
        const nextUndo = { ...this.undoBySceneId };
        delete nextUndo[sceneId];
        this.undoBySceneId = nextUndo;
      } else {
        this.undoBySceneId = { ...this.undoBySceneId, [sceneId]: sourceText };
      }
      this.setText(sceneId, rewrittenText, { manual: false });
      return { ok: true, status: 'rewrite_applied' };
    } catch (error) {
      this.messageBySceneId = {
        ...this.messageBySceneId,
        [sceneId]: error?.message || 'Rewrite could not be completed.',
      };
      return { ok: false, status: 'rewrite_failed', error };
    } finally {
      this.isRewriting = false;
      this.rewritingSceneId = null;
      this.persist();
    }
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
