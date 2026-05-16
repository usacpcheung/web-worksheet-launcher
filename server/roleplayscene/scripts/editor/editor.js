import { renderGraph } from './graph.js';
import { renderInspector } from './inspector.js';
import { validateProject } from './validators.js';
import { canAddDialogueLine, createScene, SceneType } from '../model.js';
import { translate } from '../i18n.js';
import {
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  createRolePlaySceneT2AAudioFilename,
  getRolePlaySceneT2APresetById,
  getRolePlaySceneT2ATextState,
} from '../t2a-presets.js';

export function renderEditor(store, leftEl, rightEl, showMessage, options = {}) {
  leftEl.innerHTML = '';
  rightEl.innerHTML = '';

  const graphHost = document.createElement('div');
  graphHost.className = 'graph-container';
  leftEl.appendChild(graphHost);

  const inspectorHost = document.createElement('div');
  rightEl.appendChild(inspectorHost);

  let selectedId = store.get().project.scenes[0]?.id ?? null;
  const apiClient = options.apiClient || null;
  const ensureServerSessionReady = options.ensureServerSessionReady || null;
  const dialogueT2AInFlightKeys = new Set();
  let activeDialoguePreview = null;

  const unsubscribe = store.subscribe(() => {
    syncSelection();
    update();
  });

  function cleanup() {
    stopDialoguePreview({ refresh: false });
    unsubscribe();
  }

  function syncSelection() {
    const { project } = store.get();
    if (!project.scenes.some(scene => scene.id === selectedId)) {
      stopDialoguePreview({ refresh: false });
      selectedId = project.scenes[0]?.id ?? null;
    }
  }

  function mutateProject(mutator) {
    const project = store.get().project;
    const next = mutator(project);
    store.set({ project: next });
  }

  function cloneScene(scene) {
    return {
      ...scene,
      backgroundAudio: scene.backgroundAudio ? { ...scene.backgroundAudio } : null,
      dialogue: scene.dialogue.map(line => ({
        text: line.text,
        audio: line.audio ? { ...line.audio } : null,
      })),
      choices: scene.choices.map(choice => ({ ...choice })),
      autoNextSceneId: scene.autoNextSceneId ?? null,
    };
  }

  function update() {
    const { project } = store.get();
    const scene = project.scenes.find(s => s.id === selectedId) ?? null;
    stopDialoguePreviewIfStale(project);
    const otherStarts = scene
      ? project.scenes.filter(s => s.id !== scene.id && s.type === SceneType.START).length
      : 0;
    const canDeleteScene = Boolean(scene)
      && project.scenes.length > 1
      && (scene.type !== SceneType.START || otherStarts > 0);

    const activeElement = document.activeElement;
    const shouldRestoreFocus = Boolean(activeElement)
      && inspectorHost.contains(activeElement)
      && activeElement.dataset?.focusKey;
    const focusKey = shouldRestoreFocus ? activeElement.dataset.focusKey : null;
    const selectionStart = shouldRestoreFocus && typeof activeElement.selectionStart === 'number'
      ? activeElement.selectionStart
      : null;
    const selectionEnd = shouldRestoreFocus && typeof activeElement.selectionEnd === 'number'
      ? activeElement.selectionEnd
      : null;

    renderGraph(graphHost, project, selectedId, (id) => {
      if (id !== selectedId) {
        stopDialoguePreview({ refresh: false });
      }
      selectedId = id;
      update();
    });

    const validationResults = validateProject(project);

    renderInspector(inspectorHost, project, scene, {
      onUpdateProjectTitle: updateProjectTitle,
      onAddScene: addScene,
      onDeleteScene: deleteScene,
      onSetSceneType: setSceneType,
      onSetSceneImage: setSceneImage,
      onSetSceneBackgroundAudio: setSceneBackgroundAudio,
      onAddDialogue: addDialogue,
      onRemoveDialogue: removeDialogue,
      onUpdateDialogueText: updateDialogueText,
      onSetDialogueAudio: setDialogueAudio,
      onGenerateDialogueAudio: generateDialogueAudio,
      isDialogueAudioGenerating: (sceneId, index) => dialogueT2AInFlightKeys.has(getDialogueT2AKey(sceneId, index)),
      onPreviewDialogueAudio: previewDialogueAudio,
      isDialogueAudioPreviewing: (sceneId, index) => activeDialoguePreview?.key === getDialogueT2AKey(sceneId, index),
      onAddChoice: addChoice,
      onRemoveChoice: removeChoice,
      onUpdateChoice: updateChoice,
      onSetAutoNext: setAutoNext,
      canDeleteScene,
      validationResults,
    });

    if (focusKey) {
      const nextFocus = inspectorHost.querySelector(`[data-focus-key="${focusKey}"]`);
      if (nextFocus && typeof nextFocus.focus === 'function') {
        nextFocus.focus();
        if (
          selectionStart !== null
          && selectionEnd !== null
          && typeof nextFocus.setSelectionRange === 'function'
          && typeof nextFocus.value === 'string'
        ) {
          const max = nextFocus.value.length;
          const start = Math.max(0, Math.min(selectionStart, max));
          const end = Math.max(0, Math.min(selectionEnd, max));
          nextFocus.setSelectionRange(start, end);
        }
      }
    }
  }

  function updateProjectTitle(title) {
    const value = typeof title === 'string' ? title : '';
    mutateProject(prev => ({
      ...prev,
      meta: {
        ...(prev.meta || {}),
        title: value,
      },
    }));
  }

  function addScene() {
    const { project } = store.get();
    if (project.scenes.length >= 20) {
      showMessage({ textId: 'inspector.notifications.sceneLimit' });
      return;
    }
    const newScene = createScene();
    mutateProject(prev => ({
      ...prev,
      scenes: [...prev.scenes, newScene],
    }));
    selectedId = newScene.id;
    showMessage({
      textId: 'inspector.notifications.sceneAdded',
      textArgs: { id: newScene.id },
    });
  }

  function deleteScene(sceneId) {
    const { project } = store.get();
    const scene = project.scenes.find(s => s.id === sceneId);
    if (!scene) return;
    const startScenes = project.scenes.filter(s => s.type === SceneType.START);
    if (scene.type === SceneType.START && startScenes.length <= 1) {
      showMessage({ textId: 'inspector.notifications.cannotDeleteStart' });
      return;
    }
    if (scene.image?.objectUrl) {
      URL.revokeObjectURL(scene.image.objectUrl);
    }
    if (scene.backgroundAudio?.objectUrl) {
      URL.revokeObjectURL(scene.backgroundAudio.objectUrl);
    }
    scene.dialogue.forEach(line => {
      if (line.audio?.objectUrl) {
        URL.revokeObjectURL(line.audio.objectUrl);
      }
    });
    mutateProject(prev => {
      const remaining = prev.scenes.filter(s => s.id !== sceneId);
      const cleaned = remaining.map(s => ({
        ...s,
        choices: s.choices.map(choice => (
          choice.nextSceneId === sceneId ? { ...choice, nextSceneId: null } : choice
        )),
        autoNextSceneId: s.autoNextSceneId === sceneId ? null : s.autoNextSceneId ?? null,
      }));
      return {
        ...prev,
        scenes: cleaned,
      };
    });
    const nextProject = store.get().project;
    selectedId = nextProject.scenes[0]?.id ?? null;
    showMessage({
      textId: 'inspector.notifications.sceneDeleted',
      textArgs: { id: sceneId },
    });
  }

  function setSceneType(sceneId, type) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id === sceneId) {
          const draft = cloneScene(scene);
          draft.type = type;
          if (type === SceneType.END) {
            draft.choices = [];
            draft.autoNextSceneId = null;
          }
          return draft;
        }
        if (type === SceneType.START && scene.type === SceneType.START) {
          return { ...scene, type: SceneType.INTERMEDIATE };
        }
        return scene;
      });
      return { ...prev, scenes };
    });
    const typeLabel = translate(`inspector.sceneTypes.${type}`, { default: type });
    showMessage({
      textId: 'inspector.notifications.sceneTypeUpdated',
      textArgs: { id: sceneId, type: typeLabel },
    });
  }

  function setSceneImage(sceneId, file) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (draft.image?.objectUrl) {
          URL.revokeObjectURL(draft.image.objectUrl);
        }
        if (!file) {
          draft.image = null;
        } else {
          draft.image = {
            name: file.name,
            objectUrl: URL.createObjectURL(file),
            blob: file,
          };
        }
        return draft;
      });
      return { ...prev, scenes };
    });
    if (file) {
      showMessage({
        textId: 'inspector.notifications.imageUpdated',
        textArgs: { id: sceneId },
      });
    } else {
      showMessage({
        textId: 'inspector.notifications.imageRemoved',
        textArgs: { id: sceneId },
      });
    }
  }

  function setSceneBackgroundAudio(sceneId, file) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (draft.backgroundAudio?.objectUrl) {
          URL.revokeObjectURL(draft.backgroundAudio.objectUrl);
        }
        if (!file) {
          draft.backgroundAudio = null;
        } else {
          draft.backgroundAudio = {
            name: file.name,
            objectUrl: URL.createObjectURL(file),
            blob: file,
          };
        }
        return draft;
      });
      return { ...prev, scenes };
    });
    if (file) {
      showMessage({
        textId: 'inspector.notifications.backgroundUpdated',
        textArgs: { id: sceneId },
      });
    } else {
      showMessage({
        textId: 'inspector.notifications.backgroundRemoved',
        textArgs: { id: sceneId },
      });
    }
  }

  function addDialogue(sceneId) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        if (!canAddDialogueLine(scene.dialogue)) return scene;
        const draft = cloneScene(scene);
        draft.dialogue = [...draft.dialogue, { text: '', audio: null }];
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function removeDialogue(sceneId, index) {
    if (activeDialoguePreview?.sceneId === sceneId && index <= activeDialoguePreview.index) {
      stopDialoguePreview();
    }
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        if (scene.dialogue.length <= 1) return scene;
        const draft = cloneScene(scene);
        const [removed] = draft.dialogue.splice(index, 1);
        if (removed?.audio?.objectUrl) {
          URL.revokeObjectURL(removed.audio.objectUrl);
        }
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function updateDialogueText(sceneId, index, text) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.dialogue[index]) return draft;
        draft.dialogue[index].text = text;
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function setDialogueAudio(sceneId, index, file) {
    if (activeDialoguePreview?.key === getDialogueT2AKey(sceneId, index)) {
      stopDialoguePreview();
    }
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.dialogue[index]) return draft;
        if (draft.dialogue[index].audio?.objectUrl) {
          URL.revokeObjectURL(draft.dialogue[index].audio.objectUrl);
        }
        if (!file) {
          draft.dialogue[index].audio = null;
        } else {
          draft.dialogue[index].audio = {
            name: file.name,
            objectUrl: URL.createObjectURL(file),
            blob: file,
          };
        }
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function getDialogueT2AKey(sceneId, index) {
    return `${sceneId}:${index}`;
  }

  function getDialogueLine(sceneId, index, project = store.get().project) {
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    return scene?.dialogue?.[index] || null;
  }

  function stopDialoguePreview({ refresh = true } = {}) {
    const preview = activeDialoguePreview;
    if (!preview) return;
    activeDialoguePreview = null;
    try {
      preview.audio.pause();
      preview.audio.currentTime = 0;
    } catch (error) {
      console.warn('Failed to stop dialogue audio preview', error);
    }
    if (refresh) {
      update();
    }
  }

  function stopDialoguePreviewIfStale(project) {
    if (!activeDialoguePreview) return;
    const line = getDialogueLine(activeDialoguePreview.sceneId, activeDialoguePreview.index, project);
    if (line?.audio?.objectUrl !== activeDialoguePreview.src) {
      stopDialoguePreview({ refresh: false });
    }
  }

  function previewDialogueAudio(sceneId, index) {
    const key = getDialogueT2AKey(sceneId, index);
    if (activeDialoguePreview?.key === key) {
      stopDialoguePreview();
      return;
    }
    const line = getDialogueLine(sceneId, index);
    const src = line?.audio?.objectUrl || null;
    if (!src || typeof Audio !== 'function') {
      showMessage({ textId: 'inspector.dialogue.audioPreviewFailed' });
      return;
    }
    stopDialoguePreview({ refresh: false });
    const audio = new Audio(src);
    activeDialoguePreview = { key, sceneId, index, src, audio };
    audio.addEventListener('ended', () => {
      if (activeDialoguePreview?.audio === audio) {
        stopDialoguePreview();
      }
    });
    audio.addEventListener('error', () => {
      if (activeDialoguePreview?.audio === audio) {
        stopDialoguePreview();
        showMessage({ textId: 'inspector.dialogue.audioPreviewFailed' });
      }
    });
    try {
      const playAttempt = audio.play();
      if (playAttempt && typeof playAttempt.catch === 'function') {
        playAttempt.catch((error) => {
          if (activeDialoguePreview?.audio === audio) {
            console.warn('Dialogue audio preview failed', error);
            stopDialoguePreview();
            showMessage({ textId: 'inspector.dialogue.audioPreviewFailed' });
          }
        });
      }
      update();
    } catch (error) {
      console.warn('Dialogue audio preview failed', error);
      if (activeDialoguePreview?.audio === audio) {
        stopDialoguePreview();
      }
      showMessage({ textId: 'inspector.dialogue.audioPreviewFailed' });
    }
  }

  function createAudioFileFromBytes(bytes, name = 'generated-dialogue-audio.mp3') {
    if (typeof File === 'function') {
      return new File([bytes], name, { type: 'audio/mpeg' });
    }
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    Object.defineProperty(blob, 'name', {
      value: String(name || 'generated-dialogue-audio.mp3'),
      configurable: true,
    });
    return blob;
  }

  async function generateDialogueAudio(sceneId, index, presetId) {
    const key = getDialogueT2AKey(sceneId, index);
    if (dialogueT2AInFlightKeys.has(key)) return;
    const scene = store.get().project.scenes.find((candidate) => candidate.id === sceneId);
    const line = scene?.dialogue?.[index] || null;
    const textState = getRolePlaySceneT2ATextState(line?.text || '');
    if (!textState.hasText) {
      showMessage({ textId: 'inspector.dialogue.t2aTextRequired' });
      return;
    }
    if (textState.exceedsLimit) {
      showMessage({
        textId: 'inspector.dialogue.t2aTextTooLong',
        textArgs: { max: ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH },
      });
      return;
    }
    if (!apiClient?.generateAudioFromText || typeof ensureServerSessionReady !== 'function') {
      showMessage({ textId: 'inspector.dialogue.t2aUnavailable' });
      return;
    }
    dialogueT2AInFlightKeys.add(key);
    update();
    try {
      const sessionReady = await ensureServerSessionReady();
      if (!sessionReady?.ok) {
        return;
      }
      if (line?.audio) {
        const confirmed = globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio')) ?? false;
        if (!confirmed) {
          showMessage({ textId: 'inspector.dialogue.t2aCanceled' });
          return;
        }
      }
      const preset = getRolePlaySceneT2APresetById(presetId);
      const result = await apiClient.generateAudioFromText(textState.trimmedText, preset.options || {});
      if (!result?.ok || !(result.data instanceof Uint8Array) || result.data.byteLength <= 0) {
        const detail = String(result?.error?.message || '').trim();
        showMessage({
          textId: detail ? 'inspector.dialogue.t2aFailedWithDetail' : 'inspector.dialogue.t2aFailed',
          textArgs: { detail },
        });
        return;
      }
      const safeSceneId = String(sceneId).replace(/[^a-z0-9_-]+/gi, '-');
      const generatedFile = createAudioFileFromBytes(
        result.data,
        createRolePlaySceneT2AAudioFilename(safeSceneId, index, preset.id),
      );
      setDialogueAudio(sceneId, index, generatedFile);
      showMessage({
        textId: 'inspector.dialogue.t2aGenerated',
        textArgs: { index: index + 1 },
      });
    } catch (error) {
      const detail = String(error?.message || '').trim();
      showMessage({
        textId: detail ? 'inspector.dialogue.t2aFailedWithDetail' : 'inspector.dialogue.t2aFailed',
        textArgs: { detail },
      });
    } finally {
      dialogueT2AInFlightKeys.delete(key);
      update();
    }
  }

  function addChoice(sceneId, choice) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        if (scene.choices.length >= 3) return scene;
        const draft = cloneScene(scene);
        draft.choices = [...draft.choices, choice];
        draft.autoNextSceneId = null;
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function removeChoice(sceneId, index) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        draft.choices = draft.choices.filter((_, idx) => idx !== index);
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function updateChoice(sceneId, index, updates) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.choices[index]) return draft;
        draft.choices[index] = { ...draft.choices[index], ...updates };
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function setAutoNext(sceneId, nextSceneId) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        draft.autoNextSceneId = draft.type === SceneType.END ? null : (nextSceneId ?? null);
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  syncSelection();
  update();
  return cleanup;
}
