import { BubbleMode, SceneType } from '../model.js';
import { translate } from '../i18n.js';

const SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS = 1;
const SPEECH_BUBBLE_CHARACTER_PAGE_UNITS = 36;
const SPEECH_BUBBLE_NARRATION_PAGE_UNITS = 80;
const SPEECH_BUBBLE_NO_AUDIO_MIN_SECONDS = 2;
const SPEECH_BUBBLE_NO_AUDIO_MAX_SECONDS = 8;

function getWeightedTextLength(text) {
  return Array.from(String(text || '')).reduce((total, char) => {
    if (/\s/.test(char) || /[，、,.:;；。！？!?]/.test(char)) return total + 0.25;
    if (/[\x00-\x7F]/.test(char)) return total + 0.55;
    return total + 1;
  }, 0);
}

function splitByLimit(text, limit) {
  const source = String(text || '').trim();
  if (!source) return [''];
  if (getWeightedTextLength(source) <= limit) return [source];

  const breakPatterns = [/\n+/, /(?<=[。！？!?；;])/, /(?<=[，、,:])/, /\s+/];
  for (const pattern of breakPatterns) {
    const chunks = source.split(pattern).map(chunk => chunk.trim()).filter(Boolean);
    if (chunks.length <= 1) continue;
    const pages = [];
    let current = '';
    for (const chunk of chunks) {
      const candidate = current ? `${current}${pattern.source === '\\s+' ? ' ' : ''}${chunk}` : chunk;
      if (current && getWeightedTextLength(candidate) > limit) {
        pages.push(current);
        current = chunk;
      } else {
        current = candidate;
      }
    }
    if (current) pages.push(current);
    if (pages.every(page => getWeightedTextLength(page) <= limit * 1.2)) {
      return pages;
    }
  }

  const pages = [];
  let current = '';
  for (const char of Array.from(source)) {
    const candidate = current + char;
    if (current && getWeightedTextLength(candidate) > limit) {
      pages.push(current.trim());
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pages.push(current.trim());
  return pages.length ? pages : [source];
}

export function splitSpeechBubbleText(text, mode = BubbleMode.ANCHOR) {
  const limit = mode === BubbleMode.CENTER
    ? SPEECH_BUBBLE_NARRATION_PAGE_UNITS
    : SPEECH_BUBBLE_CHARACTER_PAGE_UNITS;
  return splitByLimit(text, limit);
}

function estimateReadingSeconds(page) {
  const units = getWeightedTextLength(page);
  return Math.max(
    SPEECH_BUBBLE_NO_AUDIO_MIN_SECONDS,
    Math.min(SPEECH_BUBBLE_NO_AUDIO_MAX_SECONDS, 1.4 + units * 0.08),
  );
}

function getLineAudioDurationSeconds(line, pages) {
  const direct = Number(line?.audio?.durationSeconds ?? line?.audio?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Math.max(pages.length * SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS, pages.reduce((total, page) => total + estimateReadingSeconds(page), 0));
}

function getSpeechBubbleAnchor(scene, line) {
  if (line?.bubble?.mode !== BubbleMode.ANCHOR) return null;
  const anchors = Array.isArray(scene?.speechBubble?.anchors) ? scene.speechBubble.anchors : [];
  return anchors.find(anchor => anchor.id === line?.bubble?.anchorId) || null;
}

function clampPercent(value, min = 12, max = 88) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.max(min, Math.min(max, number * 100));
}

function hasSpeechLineContent(line) {
  return Boolean(String(line?.text || '').trim() || line?.audio?.objectUrl);
}

function createDialogueBoost(element) {
  const AudioContextCtor = globalThis?.AudioContext || globalThis?.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  let context = null;
  let sourceNode = null;
  let gainNode = null;
  let connected = false;

  const ensureNodes = () => {
    if (!context) {
      try {
        context = new AudioContextCtor();
      } catch (err) {
        console.warn('Failed to initialise dialogue audio context', err);
        return null;
      }
    }

    if (context?.state === 'suspended' && typeof context.resume === 'function') {
      context.resume().catch(() => {});
    }

    if (!sourceNode) {
      try {
        sourceNode = context.createMediaElementSource(element);
      } catch (err) {
        console.warn('Failed to create dialogue media source', err);
        return null;
      }
    }

    if (!gainNode) {
      try {
        gainNode = context.createGain();
        if (gainNode?.gain) {
          gainNode.gain.value = 1.3;
        }
      } catch (err) {
        console.warn('Failed to create dialogue gain node', err);
        return null;
      }
    }

    if (!connected && sourceNode && gainNode) {
      try {
        sourceNode.connect(gainNode);
        gainNode.connect(context.destination);
        connected = true;
      } catch (err) {
        console.warn('Failed to connect dialogue audio nodes', err);
      }
    }

    return { context, gainNode };
  };

  return {
    ensure: () => ensureNodes(),
  };
}

function createDialogueAudioController() {
  let audio = null;
  let activeMode = null;
  let endedHandler = null;
  let errorHandler = null;
  let boostController = null;

  const ensureAudio = () => {
    if (!audio) {
      audio = new Audio();
      boostController = createDialogueBoost(audio);
    }
    return audio;
  };

  const detachListeners = () => {
    if (!audio) {
      return;
    }
    if (endedHandler) {
      audio.removeEventListener('ended', endedHandler);
      endedHandler = null;
    }
    if (errorHandler) {
      audio.removeEventListener('error', errorHandler);
      errorHandler = null;
    }
  };

  const resetElement = () => {
    if (!audio) {
      return;
    }
    detachListeners();
    try {
      audio.pause();
    } catch (err) {
      // Ignore pause failures.
    }
    try {
      audio.currentTime = 0;
    } catch (err) {
      // Ignore reset failures (e.g., when audio is not seekable yet).
    }
    // Clearing the src releases resources without destroying the element.
    if (audio.src) {
      if (typeof audio.removeAttribute === 'function') {
        audio.removeAttribute('src');
      } else {
        audio.src = '';
      }
      if (typeof audio.load === 'function') {
        audio.load();
      }
    }
  };

  const stop = ({ reason = 'cancel', error = null } = {}) => {
    if (!activeMode) {
      return;
    }

    const mode = activeMode;

    if (mode.type === 'sequence') {
      if (mode.cancelPendingTimer) {
        try {
          mode.cancelPendingTimer();
        } catch (err) {
          // Ignore timer cancellation errors.
        }
      }
      if (mode.currentEntry) {
        mode.handlers?.onLineEnd?.(mode.currentEntry, mode.currentIndex);
        mode.currentEntry = null;
      }
    }

    activeMode = null;
    resetElement();

    if (reason === 'complete') {
      mode.handlers?.onComplete?.();
    } else if (reason === 'error') {
      mode.handlers?.onError?.(error);
    } else {
      mode.handlers?.onCancel?.();
    }
  };

  const playClip = ({ src, onComplete, onCancel, onError }) => {
    if (!src) {
      return;
    }

    stop();

    const handlers = {
      onComplete,
      onCancel,
      onError,
    };

    const mode = {
      type: 'clip',
      handlers,
    };

    activeMode = mode;

    const element = ensureAudio();

    endedHandler = () => {
      stop({ reason: 'complete' });
    };

    errorHandler = (event) => {
      const err = event?.error ?? event;
      stop({ reason: 'error', error: err });
    };

    element.addEventListener('ended', endedHandler);
    element.addEventListener('error', errorHandler);

    element.src = src;

    try {
      element.currentTime = 0;
    } catch (err) {
      // Ignore reset failures.
    }

    boostController?.ensure?.();

    try {
      const playAttempt = element.play();
      if (playAttempt?.catch) {
        playAttempt.catch(err => {
          if (activeMode === mode) {
            stop({ reason: 'error', error: err });
          }
        });
      }
    } catch (err) {
      stop({ reason: 'error', error: err });
    }
  };

  const playSequence = (entries, handlers = {}) => {
    stop();

    if (!entries?.length) {
      handlers.onComplete?.();
      return;
    }

    const mode = {
      type: 'sequence',
      handlers,
      currentIndex: 0,
      currentEntry: null,
      entries,
      nextTimer: null,
      cancelPendingTimer: null,
    };

    activeMode = mode;

    const element = ensureAudio();

    const cancelPendingTimer = () => {
      if (mode.nextTimer != null && typeof globalThis.clearTimeout === 'function') {
        try {
          globalThis.clearTimeout(mode.nextTimer);
        } catch (err) {
          // Ignore timer cancellation failures.
        }
      }
      mode.nextTimer = null;
    };

    mode.cancelPendingTimer = cancelPendingTimer;

    const scheduleNext = () => {
      cancelPendingTimer();

      if (typeof globalThis.setTimeout === 'function') {
        mode.nextTimer = globalThis.setTimeout(() => {
          mode.nextTimer = null;
          playCurrent();
        }, 500);
        return;
      }

      // Fallback for environments without setTimeout.
      playCurrent();
    };

    const playCurrent = () => {
      if (activeMode !== mode) {
        return;
      }

      cancelPendingTimer();

      if (mode.currentIndex >= mode.entries.length) {
        stop({ reason: 'complete' });
        return;
      }

      const entry = mode.entries[mode.currentIndex];
      mode.currentEntry = entry;
      handlers.onLineStart?.(entry, mode.currentIndex);

      detachListeners();

      endedHandler = () => {
        handlers.onLineEnd?.(entry, mode.currentIndex);
        mode.currentEntry = null;
        mode.currentIndex += 1;
        scheduleNext();
      };

      errorHandler = (event) => {
        const err = event?.error ?? event;
        handlers.onLineEnd?.(entry, mode.currentIndex);
        mode.currentEntry = null;
        stop({ reason: 'error', error: err });
      };

      element.addEventListener('ended', endedHandler);
      element.addEventListener('error', errorHandler);

      element.src = entry.src;

      try {
        element.currentTime = 0;
      } catch (err) {
        // Ignore reset failures.
      }

      boostController?.ensure?.();

      try {
        const playAttempt = element.play();
        if (playAttempt?.catch) {
          playAttempt.catch(err => {
            if (activeMode === mode) {
              handlers.onLineEnd?.(entry, mode.currentIndex);
              mode.currentEntry = null;
              stop({ reason: 'error', error: err });
            }
          });
        }
      } catch (err) {
        handlers.onLineEnd?.(entry, mode.currentIndex);
        mode.currentEntry = null;
        stop({ reason: 'error', error: err });
      }
    };

    playCurrent();
  };

  return {
    playClip,
    playSequence,
    stop: () => stop(),
  };
}

export function renderPlayerUI({
  stageEl,
  uiEl,
  project,
  scene,
  onChoice,
  backgroundAudioControls = null,
  duckBackgroundAudio = null,
  restoreBackgroundAudio = null,
  historyControls = null,
}) {
  stageEl.innerHTML = '';
  uiEl.innerHTML = '';

  const dialogueAudio = createDialogueAudioController();
  const cueOverlayId = `player-cue-overlay-title-${Math.random().toString(36).slice(2, 8)}`;
  const cueOverlay = document.createElement('div');
  cueOverlay.className = 'player-cue-overlay';
  cueOverlay.hidden = true;

  const cueDialog = document.createElement('div');
  cueDialog.className = 'player-cue-dialog';
  cueDialog.setAttribute('role', 'dialog');
  cueDialog.setAttribute('aria-modal', 'true');
  cueDialog.setAttribute('aria-labelledby', cueOverlayId);

  const cueHeader = document.createElement('div');
  cueHeader.className = 'player-cue-header';

  const cueTitle = document.createElement('h3');
  cueTitle.id = cueOverlayId;
  cueTitle.textContent = translate('player.choices.cueCardTitle');

  const cueClose = document.createElement('button');
  cueClose.type = 'button';
  cueClose.className = 'player-cue-close';
  cueClose.textContent = '×';
  cueClose.setAttribute('aria-label', translate('player.choices.cueCardCloseLabel'));

  cueHeader.appendChild(cueTitle);
  cueHeader.appendChild(cueClose);

  const cueBody = document.createElement('p');
  cueBody.className = 'player-cue-body';

  cueDialog.appendChild(cueHeader);
  cueDialog.appendChild(cueBody);
  cueOverlay.appendChild(cueDialog);
  uiEl.appendChild(cueOverlay);

  let activeCueTrigger = null;

  const closeCueCard = ({ returnFocus = false } = {}) => {
    cueOverlay.hidden = true;
    cueBody.textContent = '';
    if (activeCueTrigger) {
      activeCueTrigger.setAttribute('aria-expanded', 'false');
      if (returnFocus && typeof activeCueTrigger.focus === 'function') {
        activeCueTrigger.focus();
      }
    }
    activeCueTrigger = null;
  };

  const openCueCard = (trigger, text) => {
    if (!text) {
      return;
    }
    if (activeCueTrigger && activeCueTrigger !== trigger) {
      activeCueTrigger.setAttribute('aria-expanded', 'false');
    }
    activeCueTrigger = trigger;
    activeCueTrigger.setAttribute('aria-expanded', 'true');
    cueBody.textContent = text;
    cueOverlay.hidden = false;
  };

  cueClose.addEventListener('click', () => closeCueCard({ returnFocus: true }));
  cueOverlay.addEventListener('click', (event) => {
    if (event.target === cueOverlay) {
      closeCueCard();
    }
  });

  const handleDocumentKeydown = (event) => {
    if (event.key === 'Escape' && !cueOverlay.hidden) {
      closeCueCard({ returnFocus: true });
    }
  };

  const handleDocumentPointerDown = (event) => {
    if (cueOverlay.hidden) {
      return;
    }
    if (cueDialog.contains(event.target) || activeCueTrigger?.contains?.(event.target)) {
      return;
    }
    closeCueCard();
  };

  if (typeof document?.addEventListener === 'function') {
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('pointerdown', handleDocumentPointerDown);
  }

  const requestDuck = () => {
    try {
      duckBackgroundAudio?.();
    } catch (err) {
      console.warn(translate('player.background.duckFailed'), err);
    }
  };

  const releaseDuck = () => {
    try {
      restoreBackgroundAudio?.();
    } catch (err) {
      console.warn(translate('player.background.restoreFailed'), err);
    }
  };

  const stopDialoguePlayback = () => {
    dialogueAudio.stop();
    releaseDuck();
  };

  const lineButtons = new Map();
  let activeLineIndex = null;

  const setBubblePlayingState = (bubble, active) => {
    if (bubble.classList?.toggle) {
      bubble.classList.toggle('is-playing', active);
      return;
    }

    if (typeof bubble.className === 'string') {
      const current = bubble.className.split(/\s+/).filter(Boolean);
      const classes = new Set(current);
      if (active) {
        classes.add('is-playing');
      } else {
        classes.delete('is-playing');
      }
      bubble.className = Array.from(classes).join(' ');
    }
  };

  const setLineButtonState = (index, active) => {
    const entry = lineButtons.get(index);
    if (!entry) {
      return;
    }

    const { button, bubble } = entry;

    if (active) {
      if (activeLineIndex !== null && activeLineIndex !== index) {
        setLineButtonState(activeLineIndex, false);
      }
      activeLineIndex = index;
      button.textContent = translate('player.dialogue.stopLine');
      button.setAttribute('aria-pressed', 'true');
      setBubblePlayingState(bubble, true);
    } else {
      if (activeLineIndex === index) {
        activeLineIndex = null;
      }
      button.textContent = translate('player.dialogue.playLine');
      button.setAttribute('aria-pressed', 'false');
      setBubblePlayingState(bubble, false);
    }
  };

  const resetAllLines = () => {
    activeLineIndex = null;
    lineButtons.forEach(({ button, bubble }) => {
      button.textContent = translate('player.dialogue.playLine');
      button.setAttribute('aria-pressed', 'false');
      setBubblePlayingState(bubble, false);
    });
  };

  if (!scene) {
    const placeholder = document.createElement('p');
    placeholder.textContent = translate('player.noSceneSelected');
    uiEl.appendChild(placeholder);
    return () => stopDialoguePlayback();
  }

  const speechBubbleEnabled = scene.speechBubble?.enabled === true;
  let speechBubbleOverlay = null;

  if (speechBubbleEnabled) {
    const stageFrame = document.createElement('div');
    stageFrame.className = scene.image?.objectUrl
      ? 'player-stage-frame'
      : 'player-stage-frame player-stage-frame--empty';

    if (scene.image?.objectUrl) {
      const img = document.createElement('img');
      img.src = scene.image.objectUrl;
      img.alt = translate('player.stageImageAlt', { sceneId: scene.id });
      stageFrame.appendChild(img);
    } else {
      const emptyStage = document.createElement('div');
      emptyStage.className = 'stage-empty';
      emptyStage.textContent = translate('player.stageImageEmpty');
      stageFrame.appendChild(emptyStage);
    }

    speechBubbleOverlay = document.createElement('div');
    speechBubbleOverlay.className = 'speech-play-overlay';
    stageFrame.appendChild(speechBubbleOverlay);
    stageEl.appendChild(stageFrame);
  } else if (scene.image?.objectUrl) {
    const img = document.createElement('img');
    img.src = scene.image.objectUrl;
    img.alt = translate('player.stageImageAlt', { sceneId: scene.id });
    stageEl.appendChild(img);
  } else {
    const emptyStage = document.createElement('div');
    emptyStage.className = 'stage-empty';
    emptyStage.textContent = translate('player.stageImageEmpty');
    stageEl.appendChild(emptyStage);
  }

  if (backgroundAudioControls) {
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
    volumeSlider.value = String(backgroundAudioControls.volume ?? 0);
    volumeSlider.setAttribute('aria-label', translate('player.background.volumeLabel'));
    volumeSlider.disabled = Boolean(backgroundAudioControls.muted);

    const volumeValue = document.createElement('span');
    volumeValue.className = 'background-volume-value';
    const initialVolume = Number(backgroundAudioControls.volume ?? 0);
    volumeValue.textContent = `${Math.round(initialVolume * 100)}%`;

    volumeSlider.addEventListener('input', event => {
      const value = Number(event.target.value);
      backgroundAudioControls.volume = value;
      volumeValue.textContent = `${Math.round(value * 100)}%`;
      backgroundAudioControls.onVolumeChange?.(value);
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

    updateMuteLabel(Boolean(backgroundAudioControls.muted));

    muteButton.addEventListener('click', () => {
      const nextMuted = backgroundAudioControls.onToggleMute?.();
      const resolved = typeof nextMuted === 'boolean' ? nextMuted : !backgroundAudioControls.muted;
      backgroundAudioControls.muted = resolved;
      updateMuteLabel(resolved);
    });

    bgControls.appendChild(muteButton);
    uiEl.appendChild(bgControls);
  }

  if (historyControls?.entries?.length) {
    const historyWrapper = document.createElement('div');
    historyWrapper.className = 'player-history';

    const historyTitle = document.createElement('h4');
    historyTitle.className = 'player-history-title';
    historyTitle.textContent = translate('player.history.title');
    historyWrapper.appendChild(historyTitle);

    const navControls = document.createElement('div');
    navControls.className = 'player-history-nav';

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'player-history-back';
    backButton.textContent = translate('player.history.back');
    backButton.disabled = !historyControls.canGoBack;
    backButton.setAttribute('aria-label', translate('player.history.backLabel'));
    if (historyControls.onBack) {
      backButton.addEventListener('click', () => historyControls.onBack());
    }

    const forwardButton = document.createElement('button');
    forwardButton.type = 'button';
    forwardButton.className = 'player-history-forward';
    forwardButton.textContent = translate('player.history.forward');
    forwardButton.disabled = !historyControls.canGoForward;
    forwardButton.setAttribute('aria-label', translate('player.history.forwardLabel'));
    if (historyControls.onForward) {
      forwardButton.addEventListener('click', () => historyControls.onForward());
    }

    navControls.appendChild(backButton);
    navControls.appendChild(forwardButton);
    historyWrapper.appendChild(navControls);

    const historyList = document.createElement('ol');
    historyList.className = 'player-history-list';
    historyList.setAttribute('aria-label', translate('player.history.listLabel'));

    historyControls.entries.forEach((entry, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-history-entry';
      const displayLabel = entry.label ?? entry.fullLabel ?? entry.sceneId;
      const accessibleLabel = entry.fullLabel ?? entry.label ?? entry.sceneId;
      button.textContent = displayLabel || '';
      if (accessibleLabel) {
        button.setAttribute('title', accessibleLabel);
        button.setAttribute('aria-label', accessibleLabel);
      }
      if (button.dataset) {
        button.dataset.sceneId = entry.sceneId;
      }

      if (index === historyControls.index) {
        button.disabled = true;
        button.setAttribute('aria-current', 'step');
      } else if (historyControls.onJump) {
        button.addEventListener('click', () => historyControls.onJump(index));
      }

      item.appendChild(button);
      historyList.appendChild(item);
    });

    historyWrapper.appendChild(historyList);
    uiEl.appendChild(historyWrapper);
  }

  const renderNavigationControls = (host) => {
    const choiceBox = document.createElement('div');
    choiceBox.className = 'player-choices';

    if (scene.type === SceneType.END) {
      const endMessage = document.createElement('p');
      endMessage.className = 'the-end';
      endMessage.textContent = translate('player.choices.endMessage');
      choiceBox.appendChild(endMessage);
      host.appendChild(choiceBox);
      return choiceBox;
    }

    const sceneChoices = scene.choices || [];
    const autoNextId = scene.autoNextSceneId ?? null;
    const autoNextValid = Boolean(autoNextId)
      && project.scenes.some(s => s.id === autoNextId);

    if (!sceneChoices.length) {
      if (autoNextId) {
        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.textContent = translate('player.choices.continue');
        continueButton.disabled = !autoNextValid;
        if (!autoNextValid) {
          continueButton.title = translate('player.choices.autoNextMissing');
        }
        continueButton.addEventListener('click', () => {
          stopDialoguePlayback();
          if (autoNextValid && autoNextId) {
            onChoice?.(autoNextId);
          }
        });
        choiceBox.appendChild(continueButton);
      } else {
        const noChoices = document.createElement('p');
        noChoices.className = 'empty';
        noChoices.textContent = translate('player.choices.noneAvailable');
        choiceBox.appendChild(noChoices);
      }
    }

    sceneChoices.forEach(choice => {
      const cueCardText = typeof choice.cueCardText === 'string'
        ? choice.cueCardText.trim()
        : '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-choice-button';

      const choiceLabel = choice.label || translate('player.choices.continue');
      const labelText = document.createElement('span');
      labelText.className = 'player-choice-label';
      labelText.textContent = choiceLabel;

      button.appendChild(labelText);

      button.disabled = !choice.nextSceneId || !project.scenes.some(s => s.id === choice.nextSceneId);
      button.addEventListener('click', () => {
        stopDialoguePlayback();
        if (choice.nextSceneId) {
          onChoice?.(choice.nextSceneId);
        }
      });

      if (!cueCardText) {
        choiceBox.appendChild(button);
        return;
      }

      const row = document.createElement('div');
      row.className = 'player-choice-row';

      const cueTrigger = document.createElement('button');
      cueTrigger.type = 'button';
      cueTrigger.className = 'player-choice-cue-trigger';
      cueTrigger.setAttribute('aria-expanded', 'false');
      cueTrigger.setAttribute('aria-label', translate('player.choices.cueCardTriggerLabel', { label: choiceLabel }));

      const cueIcon = document.createElement('span');
      cueIcon.className = 'player-choice-cue-icon';
      cueIcon.textContent = '?';
      cueIcon.setAttribute('aria-hidden', 'true');
      cueTrigger.appendChild(cueIcon);

      cueTrigger.addEventListener('click', () => openCueCard(cueTrigger, cueCardText));

      row.appendChild(cueTrigger);
      row.appendChild(button);
      choiceBox.appendChild(row);
    });

    host.appendChild(choiceBox);
    return choiceBox;
  };

  if (speechBubbleEnabled) {
    const visibleEntries = (scene.dialogue || [])
      .map((line, index) => ({ line, index }))
      .filter(entry => hasSpeechLineContent(entry.line) && entry.line.bubble?.mode !== BubbleMode.HIDDEN);

    const speechPanel = document.createElement('div');
    speechPanel.className = 'speech-play-panel';
    uiEl.appendChild(speechPanel);

    let activeVisibleIndex = -1;
    let activePageIndex = 0;
    let speechAudioActive = false;
    let speechPlayAllActive = false;
    const speechTimers = new Set();

    const clearSpeechTimers = () => {
      speechTimers.forEach(timer => {
        try {
          globalThis.clearTimeout?.(timer);
        } catch {
          // Ignore timer cleanup failures.
        }
      });
      speechTimers.clear();
    };

    const scheduleSpeechTimer = (callback, delayMs) => {
      if (typeof globalThis.setTimeout !== 'function') return null;
      const timer = globalThis.setTimeout(() => {
        speechTimers.delete(timer);
        callback();
      }, delayMs);
      speechTimers.add(timer);
      return timer;
    };

    const stopSpeechPlayback = ({ keepActive = true } = {}) => {
      clearSpeechTimers();
      speechPlayAllActive = false;
      speechAudioActive = false;
      dialogueAudio.stop();
      releaseDuck();
      if (!keepActive) {
        activeVisibleIndex = -1;
        activePageIndex = 0;
      }
      renderSpeechState();
    };

    const advanceSpeechPage = (pages, pageIndex, onDone) => {
      if (pageIndex >= pages.length) {
        onDone?.();
        return;
      }
      activePageIndex = pageIndex;
      renderSpeechState();
    };

    const getPresentationSeconds = (pages, audioSeconds = 0) => {
      if (pages.length <= 1) {
        return Math.max(audioSeconds, estimateReadingSeconds(pages[0] || ''));
      }
      if (audioSeconds > 0 && audioSeconds / pages.length >= SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS) {
        return audioSeconds;
      }
      const lastPageStartsAt = (pages.length - 1) * SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS;
      return Math.max(audioSeconds, lastPageStartsAt + estimateReadingSeconds(pages[pages.length - 1] || ''));
    };

    const schedulePaging = ({ pages, totalSeconds }) => {
      if (pages.length <= 1) return;
      const totalMs = Math.max(0, totalSeconds * 1000);
      const canFitInAudio = totalSeconds / pages.length >= SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS;
      if (canFitInAudio) {
        pages.slice(1).forEach((_, pageOffset) => {
          const pageNumber = pageOffset + 1;
          scheduleSpeechTimer(() => advanceSpeechPage(pages, pageNumber), (totalMs / pages.length) * pageNumber);
        });
        return;
      }

      pages.slice(1).forEach((_, pageOffset) => {
        const pageNumber = pageOffset + 1;
        const delay = SPEECH_BUBBLE_MIN_AUDIO_PAGE_SECONDS * 1000 * pageNumber;
        scheduleSpeechTimer(() => advanceSpeechPage(pages, pageNumber), delay);
      });
    };

    const completeCurrentSpeechLine = () => {
      speechAudioActive = false;
      if (!speechPlayAllActive) {
        renderSpeechState();
        return;
      }
      const nextIndex = activeVisibleIndex + 1;
      if (nextIndex >= visibleEntries.length) {
        speechPlayAllActive = false;
        renderSpeechState();
        return;
      }
      activeVisibleIndex = nextIndex;
      activePageIndex = 0;
      playActiveSpeechLine({ autoAdvance: true });
    };

    const playActiveSpeechLine = ({ autoAdvance = false } = {}) => {
      const entry = visibleEntries[activeVisibleIndex];
      if (!entry) return;
      clearSpeechTimers();
      activePageIndex = 0;
      speechPlayAllActive = speechPlayAllActive || autoAdvance;
      const mode = entry.line.bubble?.mode || BubbleMode.CENTER;
      const pages = splitSpeechBubbleText(entry.line.text || translate('player.dialogue.lineFallback', { index: entry.index + 1 }), mode);
      renderSpeechState();

      if (entry.line.audio?.objectUrl) {
        speechAudioActive = true;
        requestDuck();
        const audioSeconds = getLineAudioDurationSeconds(entry.line, pages);
        schedulePaging({
          pages,
          totalSeconds: audioSeconds,
        });
        if (speechPlayAllActive) {
          scheduleSpeechTimer(() => completeCurrentSpeechLine(), getPresentationSeconds(pages, audioSeconds) * 1000);
        }
        dialogueAudio.playClip({
          src: entry.line.audio.objectUrl,
          onComplete: () => {
            releaseDuck();
            speechAudioActive = false;
            renderSpeechState();
          },
          onCancel: () => {
            releaseDuck();
            speechAudioActive = false;
            renderSpeechState();
          },
          onError: (error) => {
            console.warn(translate('player.dialogue.playbackError'), error);
            releaseDuck();
            speechAudioActive = false;
            renderSpeechState();
          },
        });
        renderSpeechState();
        return;
      }

      speechAudioActive = false;
      if (speechPlayAllActive && pages.length > 1) {
        let cumulativeMs = 0;
        pages.slice(1).forEach((page, pageOffset) => {
          cumulativeMs += estimateReadingSeconds(pages[pageOffset]) * 1000;
          const pageNumber = pageOffset + 1;
          scheduleSpeechTimer(() => advanceSpeechPage(pages, pageNumber), cumulativeMs);
        });
        cumulativeMs += estimateReadingSeconds(pages[pages.length - 1]) * 1000;
        scheduleSpeechTimer(() => completeCurrentSpeechLine(), cumulativeMs);
      } else if (speechPlayAllActive) {
        scheduleSpeechTimer(() => completeCurrentSpeechLine(), estimateReadingSeconds(pages[0]) * 1000);
      }
      renderSpeechState();
    };

    const setActiveSpeechLine = (nextIndex, { autoplay = false } = {}) => {
      clearSpeechTimers();
      dialogueAudio.stop();
      releaseDuck();
      speechAudioActive = false;
      speechPlayAllActive = false;
      activeVisibleIndex = Math.max(0, Math.min(nextIndex, visibleEntries.length - 1));
      activePageIndex = 0;
      if (autoplay) {
        playActiveSpeechLine();
      } else {
        renderSpeechState();
      }
    };

    const changeSpeechPage = (delta) => {
      const entry = visibleEntries[activeVisibleIndex];
      if (!entry) return;
      clearSpeechTimers();
      speechPlayAllActive = false;
      const mode = entry.line.bubble?.mode || BubbleMode.CENTER;
      const pages = splitSpeechBubbleText(entry.line.text || translate('player.dialogue.lineFallback', { index: entry.index + 1 }), mode);
      activePageIndex = Math.max(0, Math.min(pages.length - 1, activePageIndex + delta));
      renderSpeechState();
    };

    function renderSpeechState() {
      speechPanel.innerHTML = '';
      if (speechBubbleOverlay) speechBubbleOverlay.innerHTML = '';

      const activeEntry = visibleEntries[activeVisibleIndex] || null;
      const activeMode = activeEntry?.line?.bubble?.mode || BubbleMode.CENTER;
      const pages = activeEntry
        ? splitSpeechBubbleText(activeEntry.line.text || translate('player.dialogue.lineFallback', { index: activeEntry.index + 1 }), activeMode)
        : [];
      const page = pages[Math.max(0, Math.min(activePageIndex, pages.length - 1))] || '';

      if (activeEntry && speechBubbleOverlay) {
        const anchor = getSpeechBubbleAnchor(scene, activeEntry.line);
        const bubble = document.createElement('div');
        bubble.className = activeMode === BubbleMode.ANCHOR
          ? 'speech-play-bubble speech-play-bubble--anchor'
          : 'speech-play-bubble speech-play-bubble--center';
        bubble.classList.toggle('is-playing', speechAudioActive);
        if (anchor || activeEntry.line.bubble?.x != null) {
          const x = anchor?.x ?? activeEntry.line.bubble?.x;
          const y = anchor?.y ?? activeEntry.line.bubble?.y;
          bubble.style.left = `${clampPercent(x)}%`;
          bubble.style.top = `${clampPercent(y)}%`;
        }
        const text = document.createElement('p');
        text.textContent = page;
        bubble.appendChild(text);
        if (pages.length > 1) {
          const pageStatus = document.createElement('span');
          pageStatus.className = 'speech-play-page-status';
          pageStatus.textContent = translate('player.speechBubble.pageStatus', {
            current: activePageIndex + 1,
            total: pages.length,
          });
          bubble.appendChild(pageStatus);
        }
        speechBubbleOverlay.appendChild(bubble);
      }

      const controls = document.createElement('div');
      controls.className = 'speech-play-controls';

      if (!visibleEntries.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = translate('player.speechBubble.noDialogue');
        controls.appendChild(empty);
      } else if (!activeEntry) {
        const startButton = document.createElement('button');
        startButton.type = 'button';
        startButton.className = 'confirm-actions__primary';
        startButton.textContent = translate('player.speechBubble.startDialogue');
        startButton.addEventListener('click', () => setActiveSpeechLine(0, { autoplay: true }));
        controls.appendChild(startButton);

        const playAllButton = document.createElement('button');
        playAllButton.type = 'button';
        playAllButton.textContent = translate('player.speechBubble.playAll');
        playAllButton.addEventListener('click', () => {
          activeVisibleIndex = 0;
          activePageIndex = 0;
          speechPlayAllActive = true;
          playActiveSpeechLine({ autoAdvance: true });
        });
        controls.appendChild(playAllButton);
      } else {
        const prevButton = document.createElement('button');
        prevButton.type = 'button';
        prevButton.textContent = translate('player.speechBubble.previous');
        prevButton.disabled = activeVisibleIndex <= 0;
        prevButton.addEventListener('click', () => setActiveSpeechLine(activeVisibleIndex - 1, { autoplay: false }));

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.textContent = activeEntry.line.audio?.objectUrl
          ? (speechAudioActive ? translate('player.speechBubble.stop') : translate('player.speechBubble.play'))
          : translate('player.speechBubble.noAudio');
        playButton.disabled = !activeEntry.line.audio?.objectUrl;
        playButton.setAttribute('aria-pressed', speechAudioActive ? 'true' : 'false');
        playButton.addEventListener('click', () => {
          if (speechAudioActive) {
            stopSpeechPlayback({ keepActive: true });
          } else {
            playActiveSpeechLine();
          }
        });

        const nextButton = document.createElement('button');
        nextButton.type = 'button';
        nextButton.textContent = translate('player.speechBubble.next');
        nextButton.disabled = activeVisibleIndex >= visibleEntries.length - 1;
        nextButton.addEventListener('click', () => setActiveSpeechLine(activeVisibleIndex + 1, { autoplay: true }));

        const playAllButton = document.createElement('button');
        playAllButton.type = 'button';
        playAllButton.textContent = speechPlayAllActive
          ? translate('player.speechBubble.stopAll')
          : translate('player.speechBubble.playAll');
        playAllButton.setAttribute('aria-pressed', speechPlayAllActive ? 'true' : 'false');
        playAllButton.addEventListener('click', () => {
          if (speechPlayAllActive) {
            stopSpeechPlayback({ keepActive: true });
            return;
          }
          speechPlayAllActive = true;
          playActiveSpeechLine({ autoAdvance: true });
        });

        controls.append(prevButton, playButton, nextButton, playAllButton);

        if (pages.length > 1) {
          const pageControls = document.createElement('div');
          pageControls.className = 'speech-play-page-controls';
          const pagePrev = document.createElement('button');
          pagePrev.type = 'button';
          pagePrev.textContent = translate('player.speechBubble.previousPage');
          pagePrev.disabled = activePageIndex <= 0;
          pagePrev.addEventListener('click', () => changeSpeechPage(-1));
          const pageNext = document.createElement('button');
          pageNext.type = 'button';
          pageNext.textContent = translate('player.speechBubble.nextPage');
          pageNext.disabled = activePageIndex >= pages.length - 1;
          pageNext.addEventListener('click', () => changeSpeechPage(1));
          const pageStatus = document.createElement('span');
          pageStatus.textContent = translate('player.speechBubble.pageStatus', {
            current: activePageIndex + 1,
            total: pages.length,
          });
          pageControls.append(pagePrev, pageStatus, pageNext);
          controls.appendChild(pageControls);
        }
      }

      speechPanel.appendChild(controls);
      renderNavigationControls(speechPanel);
    }

    renderSpeechState();

    return () => {
      clearSpeechTimers();
      closeCueCard();
      stopDialoguePlayback();
    };
  }

  const dialogueBox = document.createElement('div');
  dialogueBox.className = 'player-dialogue';

  const audioEntries = scene.dialogue
    .map((line, index) => ({ line, index }))
    .filter(entry => entry.line.audio?.objectUrl);

  let playAllActive = false;

  const setPlayAllState = (active) => {
    playAllActive = active;
    if (!playAllButton) {
      return;
    }
    playAllButton.textContent = active
      ? translate('player.dialogue.stopAll')
      : translate('player.dialogue.playAll');
    playAllButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    playAllButton.disabled = false;
  };

  let playAllButton = null;

  if (audioEntries.length) {
    playAllButton = document.createElement('button');
    playAllButton.type = 'button';
    playAllButton.className = 'audio-play-all';
    playAllButton.textContent = translate('player.dialogue.playAll');
    playAllButton.setAttribute('aria-label', translate('player.dialogue.playAllAria'));
    playAllButton.setAttribute('aria-pressed', 'false');

    const revertPlayAll = () => {
      setPlayAllState(false);
      resetAllLines();
    };

    playAllButton.addEventListener('click', () => {
      const wasActive = playAllActive;
      stopDialoguePlayback();
      if (wasActive) {
        return;
      }

      setPlayAllState(true);

      requestDuck();

      dialogueAudio.playSequence(
        audioEntries.map(entry => ({
          src: entry.line.audio.objectUrl,
          index: entry.index,
        })),
        {
          onLineStart: (entry) => {
            setLineButtonState(entry.index, true);
          },
          onLineEnd: (entry) => {
            setLineButtonState(entry.index, false);
          },
          onComplete: () => {
            revertPlayAll();
            releaseDuck();
          },
          onCancel: () => {
            revertPlayAll();
            releaseDuck();
          },
          onError: (error) => {
            console.warn(translate('player.dialogue.playbackError'), error);
            revertPlayAll();
            releaseDuck();
          },
        },
      );
    });

    dialogueBox.appendChild(playAllButton);
  }

  scene.dialogue.forEach((line, index) => {
    const lineContainer = document.createElement('div');
    lineContainer.className = 'player-dialogue-line';

    const bubble = document.createElement('div');
    bubble.className = 'player-dialogue-bubble';
    lineContainer.appendChild(bubble);

    const text = document.createElement('p');
    text.textContent = line.text || translate('player.dialogue.lineFallback', { index: index + 1 });
    bubble.appendChild(text);

    if (line.audio?.objectUrl) {
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'dialogue-bubble-play';
      playButton.textContent = translate('player.dialogue.playLine');
      playButton.setAttribute('aria-pressed', 'false');

      lineButtons.set(index, { button: playButton, bubble });

      playButton.addEventListener('click', () => {
        const wasActive = activeLineIndex === index;
        stopDialoguePlayback();
        if (wasActive) {
          return;
        }

        setLineButtonState(index, true);

        requestDuck();

        dialogueAudio.playClip({
          src: line.audio.objectUrl,
          onComplete: () => {
            setLineButtonState(index, false);
            releaseDuck();
          },
          onCancel: () => {
            setLineButtonState(index, false);
            releaseDuck();
          },
          onError: (error) => {
            console.warn(translate('player.dialogue.playbackError'), error);
            setLineButtonState(index, false);
            releaseDuck();
          },
        });
      });
      bubble.appendChild(playButton);
    }

    dialogueBox.appendChild(lineContainer);
  });

  uiEl.appendChild(dialogueBox);

  const choiceBox = document.createElement('div');
  choiceBox.className = 'player-choices';

  if (scene.type === SceneType.END) {
    const endMessage = document.createElement('p');
    endMessage.className = 'the-end';
    endMessage.textContent = translate('player.choices.endMessage');
    choiceBox.appendChild(endMessage);
  } else {
    const sceneChoices = scene.choices || [];
    const autoNextId = scene.autoNextSceneId ?? null;
    const autoNextValid = Boolean(autoNextId)
      && project.scenes.some(s => s.id === autoNextId);

    if (!sceneChoices.length) {
      if (autoNextId) {
        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.textContent = translate('player.choices.continue');
        continueButton.disabled = !autoNextValid;
        if (!autoNextValid) {
          continueButton.title = translate('player.choices.autoNextMissing');
        }
        continueButton.addEventListener('click', () => {
          if (autoNextValid && autoNextId) {
            onChoice?.(autoNextId);
          }
        });
        choiceBox.appendChild(continueButton);
      } else {
        const noChoices = document.createElement('p');
        noChoices.className = 'empty';
        noChoices.textContent = translate('player.choices.noneAvailable');
        choiceBox.appendChild(noChoices);
      }
    }

    sceneChoices.forEach(choice => {
      const cueCardText = typeof choice.cueCardText === 'string'
        ? choice.cueCardText.trim()
        : '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-choice-button';

      const choiceLabel = choice.label || translate('player.choices.continue');
      const labelText = document.createElement('span');
      labelText.className = 'player-choice-label';
      labelText.textContent = choiceLabel;

      button.appendChild(labelText);

      button.disabled = !choice.nextSceneId || !project.scenes.some(s => s.id === choice.nextSceneId);
      button.addEventListener('click', () => {
        if (choice.nextSceneId) {
          onChoice?.(choice.nextSceneId);
        }
      });

      if (!cueCardText) {
        choiceBox.appendChild(button);
        return;
      }

      const row = document.createElement('div');
      row.className = 'player-choice-row';

      const cueTrigger = document.createElement('button');
      cueTrigger.type = 'button';
      cueTrigger.className = 'player-choice-cue-trigger';
      cueTrigger.setAttribute('aria-expanded', 'false');
      cueTrigger.setAttribute('aria-label', translate('player.choices.cueCardTriggerLabel', { label: choiceLabel }));

      const cueIcon = document.createElement('span');
      cueIcon.className = 'player-choice-cue-icon';
      cueIcon.textContent = '💡';
      cueIcon.setAttribute('aria-hidden', 'true');
      cueTrigger.appendChild(cueIcon);

      const showCue = () => openCueCard(cueTrigger, cueCardText);

      cueTrigger.addEventListener('click', showCue);

      row.appendChild(cueTrigger);
      row.appendChild(button);
      choiceBox.appendChild(row);
    });
  }

  uiEl.appendChild(choiceBox);

  return () => {
    if (typeof document?.removeEventListener === 'function') {
      document.removeEventListener('keydown', handleDocumentKeydown);
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
    }
    closeCueCard();
    stopDialoguePlayback();
  };
}
