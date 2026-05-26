import { ensureAudioGate, createBackgroundAudioController } from './audio.js';
import { renderPlayerUI } from './ui.js';
import { createPlayerIcon } from './icons.js';
import { SceneType } from '../model.js';
import { translate } from '../i18n.js';

export function renderPlayer(store, leftEl, rightEl, showMessage, options = {}) {
  leftEl.innerHTML = '';
  rightEl.innerHTML = '';

  const stage = document.createElement('div');
  stage.className = 'stage';
  leftEl.appendChild(stage);

  const uiPanel = document.createElement('div');
  uiPanel.className = 'player-panel';
  rightEl.appendChild(uiPanel);

  let currentSceneId = null;
  let sceneHistory = [];
  let historyIndex = -1;
  let backgroundVolume = 0.4;
  let backgroundMuted = false;
  let backgroundDucked = false;
  let defaultBackgroundSource = null;
  let activeDialogueCleanup = null;
  const backgroundTrack = createBackgroundAudioController({ defaultVolume: backgroundVolume });
  backgroundVolume = backgroundTrack.getPreferredVolume();
  backgroundTrack.setVolume(backgroundVolume);

  const duckBackgroundAudio = () => {
    backgroundDucked = true;
    backgroundTrack.enterDuckedState();
  };

  const restoreBackgroundAudio = () => {
    backgroundDucked = false;
    backgroundTrack.exitDuckedState();
  };

  const unsubscribe = store.subscribe(() => {
    const { project } = store.get();
    if (!currentSceneId) {
      renderIntro();
      return;
    }
    syncHistoryWithProject(project);

    if (!sceneHistory.length) {
      return;
    }

    if (!currentSceneId) {
      const start = findStartScene(project);
      if (start) {
        beginRunAt(start.id);
      } else {
        renderIntro();
      }
      return;
    }

    renderCurrentScene();
  });

  function stopActiveDialogue() {
    if (activeDialogueCleanup) {
      const cleanupFn = activeDialogueCleanup;
      activeDialogueCleanup = null;
      cleanupFn();
    }
    if (backgroundDucked) {
      restoreBackgroundAudio();
    }
  }

  function cleanup() {
    stopActiveDialogue();
    unsubscribe();
    backgroundTrack.teardown();
  }

  function findStartScene(project) {
    return project.scenes.find(scene => scene.type === SceneType.START) ?? project.scenes[0] ?? null;
  }

  function findSceneById(project, sceneId) {
    if (!sceneId) {
      return null;
    }
    return project.scenes.find(scene => scene.id === sceneId) ?? null;
  }

  function getEffectiveBackgroundSource(scene) {
    if (!scene) {
      return null;
    }
    return scene.backgroundAudio?.objectUrl ?? defaultBackgroundSource ?? null;
  }

  function maybeStopBeforeScene(nextScene) {
    const currentSource = backgroundTrack.getCurrentSource();
    const nextSource = getEffectiveBackgroundSource(nextScene);
    if (currentSource && nextSource && currentSource === nextSource) {
      return;
    }
    backgroundTrack.stop();
  }

  function createBackgroundAudioControls({ activationSource = null } = {}) {
    return {
      volume: backgroundVolume,
      muted: backgroundMuted,
      onVolumeChange: (value) => {
        backgroundVolume = value;
        backgroundTrack.setVolume(value);
      },
      onToggleMute: () => {
        backgroundMuted = !backgroundMuted;
        if (!backgroundMuted && activationSource && !store.get().audioGate) {
          ensureAudioGate(store);
          backgroundTrack.setVolume(backgroundVolume);
          backgroundTrack.exitDuckedState();
          backgroundTrack.play(activationSource);
        }
        backgroundTrack.setMuted(backgroundMuted);
        return backgroundMuted;
      },
    };
  }

  function appendBackgroundAudioControls(uiEl, controls) {
    const bgControls = document.createElement('div');
    bgControls.className = 'background-audio-controls';

    const heading = document.createElement('h4');
    heading.textContent = translate('player.background.title');
    bgControls.appendChild(heading);

    const volumeWrapper = document.createElement('div');
    volumeWrapper.className = 'background-volume';

    const volumeLabel = document.createElement('label');
    volumeLabel.textContent = translate('player.background.volumeLabel');

    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '1';
    volumeSlider.step = '0.05';
    volumeSlider.value = String(controls.volume ?? 0);
    volumeSlider.setAttribute('aria-label', translate('player.background.volumeLabel'));
    volumeSlider.disabled = Boolean(controls.muted);

    const volumeValue = document.createElement('span');
    volumeValue.className = 'background-volume-value';
    volumeValue.textContent = `${Math.round(Number(controls.volume ?? 0) * 100)}%`;

    volumeSlider.addEventListener('input', event => {
      const value = Number(event.target.value);
      controls.volume = value;
      volumeValue.textContent = `${Math.round(value * 100)}%`;
      controls.onVolumeChange?.(value);
    });

    volumeLabel.appendChild(volumeSlider);
    volumeWrapper.append(volumeLabel, volumeValue);
    bgControls.appendChild(volumeWrapper);

    const muteButton = document.createElement('button');
    muteButton.type = 'button';

    const updateMuteLabel = (muted) => {
      muteButton.textContent = muted
        ? translate('player.background.unmute')
        : translate('player.background.mute');
      muteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteButton.setAttribute('aria-label', muted
        ? translate('player.background.unmute')
        : translate('player.background.mute'));
      volumeSlider.disabled = muted;
    };

    updateMuteLabel(Boolean(controls.muted));

    muteButton.addEventListener('click', () => {
      const nextMuted = controls.onToggleMute?.();
      const resolved = typeof nextMuted === 'boolean' ? nextMuted : !controls.muted;
      controls.muted = resolved;
      updateMuteLabel(resolved);
    });

    bgControls.appendChild(muteButton);
    uiEl.appendChild(bgControls);
  }

  function appendIntroUtilities(host, controls) {
    if (!controls) return;

    const utilitiesWrapper = document.createElement('div');
    utilitiesWrapper.className = 'theater-utilities player-intro-utilities';

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'theater-floating-button theater-utilities-toggle';
    toggleButton.appendChild(createPlayerIcon('list'));
    const toggleLabel = document.createElement('span');
    toggleLabel.textContent = translate('player.utilities.title');
    toggleButton.appendChild(toggleLabel);
    toggleButton.setAttribute('aria-expanded', 'false');
    toggleButton.setAttribute('aria-label', translate('player.utilities.title'));

    const panel = document.createElement('div');
    panel.className = 'theater-utilities-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', translate('player.utilities.panelLabel'));

    const panelHeader = document.createElement('div');
    panelHeader.className = 'theater-utilities-header';

    const title = document.createElement('h4');
    title.textContent = translate('player.utilities.title');

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'theater-icon-button';
    closeButton.appendChild(createPlayerIcon('close'));
    closeButton.setAttribute('aria-label', translate('player.utilities.closeLabel'));
    panelHeader.append(title, closeButton);

    const panelContent = document.createElement('div');
    panelContent.className = 'theater-utilities-content';

    const musicSection = document.createElement('section');
    musicSection.className = 'theater-utilities-section theater-utilities-section--music';
    appendBackgroundAudioControls(musicSection, controls);
    panelContent.appendChild(musicSection);

    panel.append(panelHeader, panelContent);

    const setOpen = (open) => {
      panel.hidden = !open;
      toggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggleButton.addEventListener('click', () => setOpen(panel.hidden));
    closeButton.addEventListener('click', () => setOpen(false));

    utilitiesWrapper.append(toggleButton, panel);
    host.appendChild(utilitiesWrapper);
  }

  function renderIntro() {
    stopActiveDialogue();
    rightEl.classList?.add?.('pane--stage-only');
    const state = store.get();
    const { project } = state;
    const startScene = findStartScene(project);
    const introBackgroundSource = startScene?.backgroundAudio?.objectUrl ?? null;
    maybeStopBeforeScene(null);
    resetHistory();
    stage.innerHTML = '';
    stage.classList?.add?.('stage--intro');
    const introFrame = document.createElement('div');
    introFrame.className = startScene?.image?.objectUrl
      ? 'player-stage-frame player-stage-frame--theater player-intro-frame'
      : 'player-stage-frame player-stage-frame--empty player-stage-frame--theater player-intro-frame';

    if (startScene?.image?.objectUrl) {
      const introImage = document.createElement('img');
      introImage.src = startScene.image.objectUrl;
      introImage.alt = translate('player.stageImageAlt', { sceneId: startScene.id });
      introFrame.appendChild(introImage);
    } else {
      const introStage = document.createElement('div');
      introStage.className = 'stage-empty';
      introStage.textContent = translate('player.ready');
      introFrame.appendChild(introStage);
    }

    if (!state.audioGate && introBackgroundSource) {
      backgroundMuted = true;
    }

    if (state.audioGate && introBackgroundSource) {
      backgroundTrack.setVolume(backgroundVolume);
      backgroundTrack.setMuted(backgroundMuted);
      backgroundTrack.exitDuckedState();
      backgroundTrack.play(introBackgroundSource);
    }

    const introOverlay = document.createElement('div');
    introOverlay.className = 'player-intro-overlay';

    if (introBackgroundSource) {
      appendIntroUtilities(introOverlay, createBackgroundAudioControls({ activationSource: introBackgroundSource }));
    }

    const introCta = document.createElement('div');
    introCta.className = 'player-intro-cta';
    const title = document.createElement('h3');
    title.textContent = project.meta?.title || translate('player.untitled');
    const startBtn = document.createElement('button');
    startBtn.className = 'player-intro-begin';
    startBtn.appendChild(createPlayerIcon('play'));
    const startLabel = document.createElement('span');
    startLabel.textContent = translate('player.begin');
    startBtn.appendChild(startLabel);
    startBtn.setAttribute('aria-label', translate('player.begin'));
    startBtn.addEventListener('click', () => {
      ensureAudioGate(store);
      const activeStartScene = findStartScene(store.get().project);
      if (!activeStartScene) {
        showMessage({ textId: 'player.noStartScene' });
        return;
      }
      beginRunAt(activeStartScene.id);
    });
    introCta.append(title, startBtn);
    introOverlay.appendChild(introCta);
    introFrame.appendChild(introOverlay);
    stage.appendChild(introFrame);

    uiPanel.innerHTML = '';
  }

  function renderCurrentScene() {
    stopActiveDialogue();
    stage.classList?.remove?.('stage--intro');
    rightEl.classList?.add?.('pane--stage-only');
    const { project } = store.get();
    syncHistoryWithProject(project);

    if (!currentSceneId) {
      renderIntro();
      return;
    }

    const scene = findSceneById(project, currentSceneId);
    if (!scene) {
      maybeStopBeforeScene(null);
      showMessage({ textId: 'player.sceneMissing' });
      renderIntro();
      return;
    }

    syncBackgroundAudio(scene);

    const dialogueCleanup = renderPlayerUI({
      stageEl: stage,
      uiEl: uiPanel,
      project,
      scene,
      onChoice: (nextId) => {
        stopActiveDialogue();
        const nextScene = findSceneById(project, nextId);
        maybeStopBeforeScene(nextScene);
        pushSceneToHistory(nextId);
        renderCurrentScene();
      },
      backgroundAudioControls: store.get().audioGate
        ? createBackgroundAudioControls()
        : null,
      duckBackgroundAudio,
      restoreBackgroundAudio,
      historyControls: createHistoryControls(project),
    });

    activeDialogueCleanup = typeof dialogueCleanup === 'function' ? dialogueCleanup : null;
  }

  function syncBackgroundAudio(scene) {
    if (!store.get().audioGate) {
      backgroundTrack.stop();
      return;
    }
    const source = getEffectiveBackgroundSource(scene);
    if (!source) {
      backgroundTrack.stop();
      return;
    }
    backgroundTrack.setVolume(backgroundVolume);
    backgroundTrack.setMuted(backgroundMuted);
    if (backgroundDucked) {
      backgroundTrack.enterDuckedState();
    } else {
      backgroundTrack.exitDuckedState();
    }
    backgroundTrack.play(source);
  }

  function beginRunAt(sceneId) {
    if (!sceneId) return;
    const { project } = store.get();
    const startScene = findStartScene(project);
    defaultBackgroundSource = startScene?.backgroundAudio?.objectUrl ?? null;
    const nextScene = findSceneById(project, sceneId);
    maybeStopBeforeScene(nextScene);
    sceneHistory = [sceneId];
    historyIndex = 0;
    currentSceneId = sceneId;
    renderCurrentScene();
  }

  function resetHistory() {
    sceneHistory = [];
    historyIndex = -1;
    currentSceneId = null;
    defaultBackgroundSource = null;
  }

  function pushSceneToHistory(sceneId) {
    if (!sceneId) {
      return;
    }
    if (historyIndex < sceneHistory.length - 1) {
      sceneHistory = sceneHistory.slice(0, historyIndex + 1);
    }
    if (sceneHistory[sceneHistory.length - 1] !== sceneId) {
      sceneHistory.push(sceneId);
    }
    historyIndex = sceneHistory.length - 1;
    currentSceneId = sceneId;
  }

  function syncHistoryWithProject(project) {
    if (!sceneHistory.length) {
      return;
    }

    const availableIds = new Set(project.scenes.map(scene => scene.id));
    const filtered = sceneHistory.filter(id => availableIds.has(id));

    if (!filtered.length) {
      resetHistory();
      return;
    }

    if (filtered.length !== sceneHistory.length) {
      sceneHistory = filtered;
    }

    if (historyIndex >= sceneHistory.length) {
      historyIndex = sceneHistory.length - 1;
    }

    currentSceneId = sceneHistory[historyIndex] ?? null;
  }

  function goToHistoryIndex(index) {
    if (index < 0 || index >= sceneHistory.length) {
      return;
    }
    stopActiveDialogue();
    const { project } = store.get();
    const nextSceneId = sceneHistory[index];
    const nextScene = findSceneById(project, nextSceneId);
    maybeStopBeforeScene(nextScene);
    historyIndex = index;
    currentSceneId = nextSceneId;
    renderCurrentScene();
  }

  function navigateHistory(delta) {
    goToHistoryIndex(historyIndex + delta);
  }

  const HISTORY_LABEL_MAX_LENGTH = 30;

  const truncateHistoryLabel = (text) => {
    if (!text) {
      return text;
    }
    const glyphs = Array.from(text);
    if (glyphs.length <= HISTORY_LABEL_MAX_LENGTH) {
      return text;
    }
    const sliceLength = Math.max(1, HISTORY_LABEL_MAX_LENGTH - 1);
    return `${glyphs.slice(0, sliceLength).join('')}…`;
  };

  function createHistoryControls(project) {
    if (!sceneHistory.length) {
      return null;
    }

    const entries = sceneHistory
      .map((sceneId) => {
        const scene = project.scenes.find(s => s.id === sceneId);
        if (!scene) {
          return null;
        }
        const fallback = scene.id || sceneId;
        const firstLine = scene.dialogue?.[0]?.text?.trim();
        const fullLabel = firstLine || fallback;
        const label = truncateHistoryLabel(fullLabel);
        return { sceneId, label, fullLabel };
      })
      .filter(Boolean);

    if (!entries.length) {
      return null;
    }

    const clampedIndex = Math.max(0, Math.min(historyIndex, entries.length - 1));
    if (clampedIndex !== historyIndex) {
      historyIndex = clampedIndex;
      currentSceneId = sceneHistory[historyIndex];
    }

    return {
      entries,
      index: historyIndex,
      canGoBack: historyIndex > 0,
      canGoForward: historyIndex < entries.length - 1,
      onBack: () => navigateHistory(-1),
      onForward: () => navigateHistory(1),
      onJump: (index) => goToHistoryIndex(index),
    };
  }

  const initialScene = findSceneById(store.get().project, options.initialSceneId);
  if (initialScene) {
    beginRunAt(initialScene.id);
  } else {
    renderIntro();
  }
  return cleanup;
}
