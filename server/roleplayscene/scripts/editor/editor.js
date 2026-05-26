import { renderGraph } from './graph.js';
import { renderInspector } from './inspector.js';
import { renderScenePreview } from './scene-preview.js';
import { validateProject } from './validators.js';
import { BubbleMode, MAX_SPEECH_BUBBLE_ANCHORS, canAddDialogueLine, createScene, SceneType } from '../model.js';
import { translate } from '../i18n.js';
import {
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  createRolePlaySceneT2AAudioFilename,
  getRolePlaySceneT2APresetById,
  getRolePlaySceneT2ATextState,
} from '../t2a-presets.js';
import { newId } from '../utils/id.js';

export function renderEditor(store, leftEl, rightEl, showMessage, options = {}) {
  leftEl.innerHTML = '';
  rightEl.innerHTML = '';

  const leftToolbar = document.createElement('div');
  leftToolbar.className = 'editor-view-switch';
  leftEl.appendChild(leftToolbar);

  const leftContent = document.createElement('div');
  leftContent.className = 'editor-left-content';
  leftEl.appendChild(leftContent);

  const inspectorHost = document.createElement('div');
  rightEl.appendChild(inspectorHost);

  let selectedId = options.initialSelectedSceneId ?? store.get().project.scenes[0]?.id ?? null;
  let leftView = ['storyMap', 'scenePreview'].includes(options.initialLeftView)
    ? options.initialLeftView
    : 'storyMap';
  const apiClient = options.apiClient || null;
  const ensureServerSessionReady = options.ensureServerSessionReady || null;
  const onEditorContextChange = typeof options.onEditorContextChange === 'function'
    ? options.onEditorContextChange
    : null;
  const onPreviewCurrentScene = typeof options.onPreviewCurrentScene === 'function'
    ? options.onPreviewCurrentScene
    : null;
  const dialogueT2AInFlightKeys = new Set();
  let activeDialoguePreview = null;
  let disposed = false;
  let selectedSpeechBubbleAnchorId = options.initialSelectedSpeechBubbleAnchorId ?? null;
  let speakerDraftContext = null;

  const unsubscribe = store.subscribe(() => {
    syncSelection();
    update();
  });

  function cleanup() {
    disposed = true;
    stopDialoguePreview({ refresh: false });
    unsubscribe();
  }

  function syncSelection() {
    const { project } = store.get();
    if (!project.scenes.some(scene => scene.id === selectedId)) {
      stopDialoguePreview({ refresh: false });
      selectedId = project.scenes[0]?.id ?? null;
    }
    const scene = project.scenes.find(item => item.id === selectedId);
    const selectedAnchorExists = Boolean(selectedSpeechBubbleAnchorId)
      && scene?.speechBubble?.anchors?.some(anchor => anchor.id === selectedSpeechBubbleAnchorId);
    if (!selectedAnchorExists) {
      selectedSpeechBubbleAnchorId = null;
    }
  }

  function notifyEditorContextChange() {
    onEditorContextChange?.({
      selectedSceneId: selectedId,
      leftView,
      selectedSpeechBubbleAnchorId,
    });
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
        speakerId: line.speakerId ?? null,
        audio: line.audio ? { ...line.audio } : null,
        bubble: line.bubble ? { ...line.bubble } : undefined,
      })),
      choices: scene.choices.map(choice => ({ ...choice })),
      autoNextSceneId: scene.autoNextSceneId ?? null,
      speechBubble: scene.speechBubble
        ? {
          enabled: scene.speechBubble.enabled === true,
          anchors: Array.isArray(scene.speechBubble.anchors)
            ? scene.speechBubble.anchors.map(anchor => ({ ...anchor }))
            : [],
        }
        : undefined,
    };
  }

  function update() {
    if (disposed) return;
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

    renderLeftPane(project, scene);

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
      onUpdateDialogueSpeaker: updateDialogueSpeaker,
      onStartCreateSpeakerForDialogue: startCreateSpeakerForDialogue,
      onUpdateSpeakerDraftForDialogue: updateSpeakerDraftForDialogue,
      onCommitSpeakerForDialogue: commitSpeakerForDialogue,
      onCancelCreateSpeakerForDialogue: cancelCreateSpeakerForDialogue,
      getSpeakerDraftForDialogue: getSpeakerDraftForDialogue,
      onSetDialogueAudio: setDialogueAudio,
      onGenerateDialogueAudio: generateDialogueAudio,
      isDialogueAudioGenerating: (sceneId, index) => dialogueT2AInFlightKeys.has(getDialogueT2AKey(sceneId, index)),
      onPreviewDialogueAudio: previewDialogueAudio,
      isDialogueAudioPreviewing: (sceneId, index) => activeDialoguePreview?.key === getDialogueT2AKey(sceneId, index),
      onToggleSpeechBubble: toggleSpeechBubble,
      onAddOrMoveSpeechBubbleAnchor: addOrMoveSpeechBubbleAnchor,
      onSelectSpeechBubbleAnchor: selectSpeechBubbleAnchor,
      onDeleteSpeechBubbleAnchor: deleteSpeechBubbleAnchor,
      isSpeechBubbleAnchorSelected: (anchorId) => selectedSpeechBubbleAnchorId === anchorId,
      onUpdateDialogueBubble: updateDialogueBubble,
      onAddChoice: addChoice,
      onRemoveChoice: removeChoice,
      onUpdateChoice: updateChoice,
      onSetAutoNext: setAutoNext,
      onPreviewCurrentScene: previewCurrentScene,
      canDeleteScene,
      validationResults,
    });
    notifyEditorContextChange();

    if (focusKey) {
      const nextFocus = Array.from(inspectorHost.querySelectorAll('[data-focus-key]'))
        .find(element => element.dataset?.focusKey === focusKey);
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
    selectedSpeechBubbleAnchorId = null;
    showMessage({
      textId: 'inspector.notifications.sceneAdded',
      textArgs: { id: newScene.id },
    });
    update();
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
    selectedSpeechBubbleAnchorId = null;
    showMessage({
      textId: 'inspector.notifications.sceneDeleted',
      textArgs: { id: sceneId },
    });
    update();
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

  function renderLeftPane(project, scene) {
    leftToolbar.innerHTML = '';
    const views = [
      { id: 'storyMap', label: translate('editor.views.storyMap') },
      { id: 'scenePreview', label: translate('editor.views.scenePreview') },
    ];
    views.forEach((view) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = view.label;
      button.className = 'editor-view-switch__button';
      if (leftView === view.id) {
        button.classList.add('is-active');
      }
      button.setAttribute('aria-pressed', leftView === view.id ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (leftView === view.id) return;
        leftView = view.id;
        update();
      });
      leftToolbar.appendChild(button);
    });

    leftContent.innerHTML = '';
    leftContent.className = leftView === 'scenePreview'
      ? 'editor-left-content editor-left-content--scene-preview'
      : 'editor-left-content editor-left-content--story-map';
    if (leftView === 'scenePreview') {
      renderScenePreview(leftContent, scene, {
        onAddOrMoveSpeechBubbleAnchor: addOrMoveSpeechBubbleAnchor,
        onSelectSpeechBubbleAnchor: selectSpeechBubbleAnchor,
        isSpeechBubbleAnchorSelected: (anchorId) => selectedSpeechBubbleAnchorId === anchorId,
      });
      return;
    }

    const graphHost = document.createElement('div');
    graphHost.className = 'graph-container';
    leftContent.appendChild(graphHost);
    renderGraph(graphHost, project, selectedId, (id) => {
      if (id !== selectedId) {
        stopDialoguePreview({ refresh: false });
      }
      selectedId = id;
      selectedSpeechBubbleAnchorId = null;
      update();
    });
  }

  function previewCurrentScene(sceneId) {
    const scene = store.get().project.scenes.find(item => item.id === sceneId);
    if (!scene) return;
    notifyEditorContextChange();
    onPreviewCurrentScene?.({
      sceneId: scene.id,
      leftView,
      selectedSpeechBubbleAnchorId,
    });
  }

  function getNextAnchorLabel(anchors = []) {
    const used = new Set(anchors.map(anchor => anchor.label));
    for (const label of ['A', 'B', 'C', 'D']) {
      if (!used.has(label)) return label;
    }
    return String(anchors.length + 1);
  }

  function getAnchorUsage(scene, anchorId) {
    return (scene?.dialogue || []).filter(line => (
      line.bubble?.mode === BubbleMode.ANCHOR && line.bubble.anchorId === anchorId
    )).length;
  }

  function toggleSpeechBubble(sceneId, enabled) {
    if (enabled === true) {
      leftView = 'scenePreview';
    }
    mutateProject(prev => ({
      ...prev,
      scenes: prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        draft.speechBubble = {
          enabled: enabled === true,
          anchors: Array.isArray(draft.speechBubble?.anchors)
            ? draft.speechBubble.anchors.map(anchor => ({ ...anchor }))
            : [],
        };
        return draft;
      }),
    }));
  }

  function selectSpeechBubbleAnchor(sceneId, anchorId) {
    const scene = store.get().project.scenes.find(item => item.id === sceneId);
    const exists = scene?.speechBubble?.anchors?.some(anchor => anchor.id === anchorId);
    selectedSpeechBubbleAnchorId = exists && selectedSpeechBubbleAnchorId !== anchorId ? anchorId : null;
    if (exists) {
      leftView = 'scenePreview';
    }
    update();
  }

  function addOrMoveSpeechBubbleAnchor(sceneId, point) {
    const x = Math.max(0, Math.min(1, Number(point?.x)));
    const y = Math.max(0, Math.min(1, Number(point?.y)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    mutateProject(prev => ({
      ...prev,
      scenes: prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        const anchors = Array.isArray(draft.speechBubble?.anchors)
          ? draft.speechBubble.anchors.map(anchor => ({ ...anchor }))
          : [];
        const selectedIndex = selectedSpeechBubbleAnchorId
          ? anchors.findIndex(anchor => anchor.id === selectedSpeechBubbleAnchorId)
          : -1;
        if (selectedIndex >= 0) {
          anchors[selectedIndex] = { ...anchors[selectedIndex], x, y };
          draft.dialogue = draft.dialogue.map(line => {
            if (line.bubble?.mode !== BubbleMode.ANCHOR || line.bubble.anchorId !== selectedSpeechBubbleAnchorId) {
              return line;
            }
            return {
              ...line,
              bubble: {
                ...line.bubble,
                x,
                y,
              },
            };
          });
        } else if (anchors.length < MAX_SPEECH_BUBBLE_ANCHORS) {
          const anchorId = newId('anchor');
          anchors.push({
            id: anchorId,
            label: getNextAnchorLabel(anchors),
            x,
            y,
          });
          selectedSpeechBubbleAnchorId = anchorId;
        } else {
          showMessage({ textId: 'inspector.speechBubble.anchorLimit', textArgs: { max: MAX_SPEECH_BUBBLE_ANCHORS } });
        }
        draft.speechBubble = {
          enabled: draft.speechBubble?.enabled === true,
          anchors,
        };
        return draft;
      }),
    }));
  }

  function deleteSpeechBubbleAnchor(sceneId, anchorId) {
    const scene = store.get().project.scenes.find(item => item.id === sceneId);
    if (!scene) return;
    const anchor = scene.speechBubble?.anchors?.find(item => item.id === anchorId);
    if (!anchor) return;
    const usage = getAnchorUsage(scene, anchorId);
    if (usage > 0) {
      const confirmed = globalThis.confirm?.(translate('inspector.speechBubble.confirmDeleteUsedAnchor', {
        label: anchor.label || anchorId,
        count: usage,
      })) ?? false;
      if (!confirmed) return;
    }
    mutateProject(prev => ({
      ...prev,
      scenes: prev.scenes.map(item => {
        if (item.id !== sceneId) return item;
        const draft = cloneScene(item);
        draft.speechBubble = {
          enabled: draft.speechBubble?.enabled === true,
          anchors: (draft.speechBubble?.anchors || []).filter(candidate => candidate.id !== anchorId),
        };
        draft.dialogue = draft.dialogue.map(line => {
          if (line.bubble?.mode !== BubbleMode.ANCHOR || line.bubble.anchorId !== anchorId) return line;
          return {
            ...line,
            bubble: { mode: BubbleMode.CENTER, anchorId: null },
          };
        });
        return draft;
      }),
    }));
    if (selectedSpeechBubbleAnchorId === anchorId) {
      selectedSpeechBubbleAnchorId = null;
    }
  }

  function addDialogue(sceneId) {
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        if (!canAddDialogueLine(scene.dialogue)) return scene;
        const draft = cloneScene(scene);
        draft.dialogue = [...draft.dialogue, { text: '', speakerId: null, audio: null, bubble: { mode: BubbleMode.CENTER, anchorId: null } }];
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

  function getSpeakerDraftKey(sceneId, index) {
    return `${sceneId}:${index}`;
  }

  function getSpeakerDraftForDialogue(sceneId, index) {
    return speakerDraftContext?.key === getSpeakerDraftKey(sceneId, index)
      ? speakerDraftContext.value
      : null;
  }

  function startCreateSpeakerForDialogue(sceneId, index) {
    speakerDraftContext = { key: getSpeakerDraftKey(sceneId, index), sceneId, index, value: '' };
    update();
  }

  function updateSpeakerDraftForDialogue(sceneId, index, value) {
    if (speakerDraftContext?.key !== getSpeakerDraftKey(sceneId, index)) return;
    speakerDraftContext = { ...speakerDraftContext, value };
    update();
  }

  function cancelCreateSpeakerForDialogue(sceneId, index) {
    if (speakerDraftContext?.key === getSpeakerDraftKey(sceneId, index)) {
      speakerDraftContext = null;
      update();
    }
  }

  function commitSpeakerForDialogue(sceneId, index) {
    if (speakerDraftContext?.key !== getSpeakerDraftKey(sceneId, index)) return;
    const name = String(speakerDraftContext.value || '').trim();
    if (!name) {
      showMessage({ textId: 'inspector.dialogue.speakerNameRequired' });
      return;
    }
    let assignedSpeakerId = null;
    mutateProject(prev => {
      const existingSpeaker = (prev.speakers || []).find(speaker => (
        String(speaker.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()
      ));
      assignedSpeakerId = existingSpeaker?.id || newId('speaker');
      const speakers = existingSpeaker
        ? (prev.speakers || []).map(speaker => ({ ...speaker }))
        : [...(prev.speakers || []).map(speaker => ({ ...speaker })), { id: assignedSpeakerId, name }];
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.dialogue[index]) return draft;
        draft.dialogue[index].speakerId = assignedSpeakerId;
        return draft;
      });
      return { ...prev, speakers, scenes };
    });
    speakerDraftContext = null;
    update();
  }

  function updateDialogueSpeaker(sceneId, index, speakerId) {
    speakerDraftContext = null;
    const speakerIds = new Set((store.get().project.speakers || []).map(speaker => speaker.id));
    const nextSpeakerId = speakerId && speakerIds.has(speakerId) ? speakerId : null;
    mutateProject(prev => {
      const scenes = prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.dialogue[index]) return draft;
        draft.dialogue[index].speakerId = nextSpeakerId;
        return draft;
      });
      return { ...prev, scenes };
    });
  }

  function updateDialogueBubble(sceneId, index, updates = {}) {
    mutateProject(prev => ({
      ...prev,
      scenes: prev.scenes.map(scene => {
        if (scene.id !== sceneId) return scene;
        const draft = cloneScene(scene);
        if (!draft.dialogue[index]) return draft;
        const current = draft.dialogue[index].bubble || { mode: BubbleMode.CENTER, anchorId: null };
        const mode = Object.values(BubbleMode).includes(updates.mode)
          ? updates.mode
          : current.mode;
        const next = {
          mode,
          anchorId: mode === BubbleMode.ANCHOR
            ? (updates.anchorId !== undefined ? updates.anchorId : current.anchorId)
            : null,
        };
        const anchor = next.anchorId
          ? (draft.speechBubble?.anchors || []).find(item => item.id === next.anchorId)
          : null;
        if (anchor) {
          next.x = anchor.x;
          next.y = anchor.y;
        }
        draft.dialogue[index] = {
          ...draft.dialogue[index],
          bubble: next,
        };
        return draft;
      }),
    }));
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

  function getCurrentT2ALine(sceneId, index, expectedText) {
    const currentLine = getDialogueLine(sceneId, index);
    const currentTextState = getRolePlaySceneT2ATextState(currentLine?.text || '');
    if (!currentLine || currentTextState.trimmedText !== expectedText) {
      showMessage({ textId: 'inspector.dialogue.t2aLineChanged' });
      return null;
    }
    return currentLine;
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
    let confirmedAudioSignature = null;
    try {
      const sessionReady = await ensureServerSessionReady();
      if (disposed) {
        return;
      }
      if (!sessionReady?.ok) {
        return;
      }
      const lineBeforeGenerate = getCurrentT2ALine(sceneId, index, textState.trimmedText);
      if (!lineBeforeGenerate) {
        return;
      }
      if (lineBeforeGenerate.audio) {
        const confirmed = globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio')) ?? false;
        if (!confirmed) {
          showMessage({ textId: 'inspector.dialogue.t2aCanceled' });
          return;
        }
        confirmedAudioSignature = getAudioSignature(lineBeforeGenerate.audio);
      }
      const preset = getRolePlaySceneT2APresetById(presetId);
      const result = await apiClient.generateAudioFromText(textState.trimmedText, preset.options || {});
      if (disposed) {
        return;
      }
      if (!result?.ok || !(result.data instanceof Uint8Array) || result.data.byteLength <= 0) {
        const detail = String(result?.error?.message || '').trim();
        showMessage({
          textId: detail ? 'inspector.dialogue.t2aFailedWithDetail' : 'inspector.dialogue.t2aFailed',
          textArgs: { detail },
        });
        return;
      }
      const lineBeforeAttach = getCurrentT2ALine(sceneId, index, textState.trimmedText);
      if (!lineBeforeAttach) {
        return;
      }
      const currentAudioSignature = getAudioSignature(lineBeforeAttach.audio);
      if (currentAudioSignature && currentAudioSignature !== confirmedAudioSignature) {
        const confirmed = globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio')) ?? false;
        if (!confirmed) {
          showMessage({ textId: 'inspector.dialogue.t2aCanceled' });
          return;
        }
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
      if (!disposed) {
        update();
      }
    }
  }

  function getAudioSignature(audio) {
    if (!audio) return null;
    return [
      audio.name || '',
      audio.objectUrl || '',
      typeof audio.blob?.size === 'number' ? audio.blob.size : '',
      audio.blob?.type || '',
    ].join('|');
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
