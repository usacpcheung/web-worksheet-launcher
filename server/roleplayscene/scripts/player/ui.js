import { translate } from '../i18n.js';
import { renderPlayerChoices } from './choice-controls.js';
import { createPlayerIcon } from './icons.js';
import { renderSpeechBubblePlayerUI, splitSpeechBubbleText } from './speech-bubble-ui.js';
import { DISCUSSION_REWRITE_MAX_CHARS } from './discussion-state.js';
import {
  DIALOGUE_MIN_AUDIO_PAGE_SECONDS,
  estimateReadingSeconds,
  getDialoguePageText,
  getLineAudioDurationSeconds,
  hasDialogueLineContent,
  splitDialogueText,
} from './dialogue-progression.js';

export { splitSpeechBubbleText };

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

function getSpeakerName(project, line) {
  if (!line?.speakerId) return '';
  const speakers = Array.isArray(project?.speakers) ? project.speakers : [];
  const speaker = speakers.find(candidate => candidate.id === line.speakerId);
  return String(speaker?.name || '').trim();
}

function appendToolbarButtonContent(button, iconName, label) {
  button.textContent = '';
  button.appendChild(createPlayerIcon(iconName));
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  button.appendChild(labelEl);
  button.setAttribute('aria-label', label);
}

function setClassEnabled(element, className, enabled) {
  if (!element?.classList) return;
  if (enabled) {
    element.classList.add?.(className);
  } else {
    element.classList.remove?.(className);
  }
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
  discussionSession = null,
  apiClient = null,
  onDiscussionChange = null,
  onPrintDiscussion = null,
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
  cueTitle.textContent = discussionSession
    ? translate('player.discussion.title')
    : translate('player.choices.cueCardTitle');

  const cueClose = document.createElement('button');
  cueClose.type = 'button';
  cueClose.className = 'player-cue-close theater-icon-button';
  cueClose.appendChild(createPlayerIcon('close'));
  cueClose.setAttribute('aria-label', translate('player.discussion.closeLabel'));

  cueHeader.appendChild(cueTitle);
  cueHeader.appendChild(cueClose);

  const cueBody = document.createElement('div');
  cueBody.className = 'player-cue-body';

  cueDialog.appendChild(cueHeader);
  cueDialog.appendChild(cueBody);
  cueOverlay.appendChild(cueDialog);
  stageEl.appendChild(cueOverlay);

  let activeCueTrigger = null;

  const closeCueCard = ({ returnFocus = false } = {}) => {
    cueOverlay.hidden = true;
    cueBody.innerHTML = '';
    if (activeCueTrigger) {
      activeCueTrigger.setAttribute('aria-expanded', 'false');
      if (returnFocus && typeof activeCueTrigger.focus === 'function') {
        activeCueTrigger.focus();
      }
    }
    activeCueTrigger = null;
  };

  const notifyDiscussionChange = () => {
    try {
      onDiscussionChange?.(discussionSession?.snapshot?.() ?? null);
    } catch {
      // Discussion state updates should not interrupt playback.
    }
  };

  const renderDiscussionForm = ({ cueText = '', choiceLabel = '' } = {}) => {
    cueBody.innerHTML = '';
    const hasCue = Boolean(String(cueText || '').trim());
    setClassEnabled(cueDialog, 'player-cue-dialog--discussion-with-cue', hasCue);
    setClassEnabled(cueDialog, 'player-cue-dialog--discussion-only', !hasCue);

    const layout = document.createElement('div');
    layout.className = hasCue
      ? 'player-discussion-layout player-discussion-layout--with-cue'
      : 'player-discussion-layout player-discussion-layout--solo';

    if (hasCue) {
      const cuePanel = document.createElement('section');
      cuePanel.className = 'player-discussion-cue-panel';
      const cueHeading = document.createElement('h4');
      cueHeading.textContent = translate('player.discussion.cueHeading');
      const cueTextNode = document.createElement('p');
      cueTextNode.className = 'player-discussion-cue-text';
      cueTextNode.textContent = cueText;
      cuePanel.append(cueHeading, cueTextNode);
      if (choiceLabel) {
        const choice = document.createElement('p');
        choice.className = 'player-discussion-choice-label';
        choice.textContent = translate('player.discussion.choiceLabel', { label: choiceLabel });
        cuePanel.appendChild(choice);
      }
      layout.appendChild(cuePanel);
    }

    const inputPanel = document.createElement('section');
    inputPanel.className = 'player-discussion-input-panel';
    const label = document.createElement('label');
    label.className = 'player-discussion-label';
    label.textContent = translate('player.discussion.inputLabel');
    const textarea = document.createElement('textarea');
    textarea.className = 'player-discussion-textarea';
    textarea.rows = hasCue ? 8 : 9;
    textarea.value = discussionSession?.getText?.(scene.id) || '';
    textarea.placeholder = translate('player.discussion.placeholder');
    label.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'player-discussion-footer';
    const note = document.createElement('p');
    note.className = 'player-discussion-note';
    note.textContent = translate('player.discussion.keptNote');
    const hint = document.createElement('p');
    hint.className = 'player-discussion-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'player-discussion-actions';

    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'theater-panel-action';
    undoButton.textContent = translate('player.discussion.undo');

    const rewriteButton = document.createElement('button');
    rewriteButton.type = 'button';
    rewriteButton.className = 'theater-panel-action theater-panel-action--primary';
    rewriteButton.textContent = translate('player.discussion.rewrite');

    actions.append(undoButton, rewriteButton);
    footer.append(note, actions);
    inputPanel.append(label, footer, hint);
    layout.appendChild(inputPanel);
    cueBody.appendChild(layout);

    const syncControls = () => {
      const text = textarea.value || '';
      const trimmedLength = text.trim().length;
      const isRewriting = Boolean(
        discussionSession?.isRewriting
        && discussionSession?.rewritingSceneId === scene.id
      );
      rewriteButton.textContent = isRewriting
        ? translate('player.discussion.rewriting')
        : translate('player.discussion.rewrite');
      rewriteButton.disabled = isRewriting || trimmedLength === 0 || trimmedLength > DISCUSSION_REWRITE_MAX_CHARS;
      undoButton.disabled = isRewriting || !discussionSession?.hasUndo?.(scene.id);
      const message = discussionSession?.getMessage?.(scene.id) || '';
      if (message) {
        hint.textContent = message;
      } else if (trimmedLength === 0) {
        hint.textContent = translate('player.discussion.hintEnterText');
      } else if (trimmedLength > DISCUSSION_REWRITE_MAX_CHARS) {
        hint.textContent = translate('player.discussion.hintTooLong', { max: DISCUSSION_REWRITE_MAX_CHARS });
      } else {
        hint.textContent = '';
      }
    };

    textarea.addEventListener('input', () => {
      discussionSession?.setText?.(scene.id, textarea.value, { manual: true });
      notifyDiscussionChange();
      syncControls();
    });

    undoButton.addEventListener('click', () => {
      if (discussionSession?.undo?.(scene.id)) {
        textarea.value = discussionSession.getText(scene.id);
        notifyDiscussionChange();
        syncControls();
      }
    });

    rewriteButton.addEventListener('click', async () => {
      if (rewriteButton.disabled) return;
      const textAtClick = textarea.value || '';
      syncControls();
      await discussionSession?.rewrite?.(scene.id, textAtClick, { apiClient });
      textarea.value = discussionSession?.getText?.(scene.id) || textarea.value;
      notifyDiscussionChange();
      syncControls();
      textarea.focus();
    });

    syncControls();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => textarea.focus?.());
    }
  };

  const openCueCard = (trigger, text, cueOptions = {}) => {
    if (activeCueTrigger && activeCueTrigger !== trigger) {
      activeCueTrigger.setAttribute('aria-expanded', 'false');
    }
    activeCueTrigger = trigger;
    activeCueTrigger?.setAttribute('aria-expanded', 'true');
    if (discussionSession) {
      cueTitle.textContent = translate('player.discussion.title');
      cueClose.setAttribute('aria-label', translate('player.discussion.closeLabel'));
      renderDiscussionForm({
        cueText: text,
        choiceLabel: cueOptions.choiceLabel || '',
      });
    } else {
      cueTitle.textContent = translate('player.choices.cueCardTitle');
      cueClose.setAttribute('aria-label', translate('player.choices.cueCardCloseLabel'));
      cueBody.textContent = text;
    }
    cueOverlay.hidden = false;
  };

  const openDiscussion = () => {
    if (!discussionSession) return;
    if (activeCueTrigger) {
      activeCueTrigger.setAttribute('aria-expanded', 'false');
    }
    activeCueTrigger = null;
    cueTitle.textContent = translate('player.discussion.title');
    cueClose.setAttribute('aria-label', translate('player.discussion.closeLabel'));
    renderDiscussionForm();
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

  const cleanupCueCardListeners = () => {
    if (typeof document?.removeEventListener === 'function') {
      document.removeEventListener('keydown', handleDocumentKeydown);
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
    }
  };

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

  if (!scene) {
    const placeholder = document.createElement('p');
    placeholder.textContent = translate('player.noSceneSelected');
    uiEl.appendChild(placeholder);
    return () => {
      cleanupCueCardListeners();
      stopDialoguePlayback();
    };
  }

  const speechBubbleEnabled = scene.speechBubble?.enabled === true;
  const stageFrame = document.createElement('div');
  stageFrame.className = scene.image?.objectUrl
    ? 'player-stage-frame player-stage-frame--theater'
    : 'player-stage-frame player-stage-frame--empty player-stage-frame--theater';
  const theaterOverlay = document.createElement('div');
  theaterOverlay.className = 'theater-overlay';
  let speechBubbleOverlay = null;
  const theaterControlRail = document.createElement('div');
  theaterControlRail.className = 'theater-side-rail theater-side-rail--right';

  const theaterUtilityRail = document.createElement('div');
  theaterUtilityRail.className = 'theater-side-rail theater-side-rail--left';

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

  if (speechBubbleEnabled) {
    speechBubbleOverlay = document.createElement('div');
    speechBubbleOverlay.className = 'speech-play-overlay';
    stageFrame.appendChild(speechBubbleOverlay);
  }
  stageFrame.appendChild(theaterOverlay);
  stageEl.appendChild(stageFrame);
  stageEl.appendChild(theaterUtilityRail);
  stageEl.appendChild(theaterControlRail);

  const appendUtilitiesPanel = () => {
    const hasMusic = Boolean(backgroundAudioControls);
    const hasHistory = Boolean(historyControls?.entries?.length);
    const hasDiscussionTools = Boolean(discussionSession);
    if (!hasMusic && !hasHistory && !hasDiscussionTools) return;

    const utilitiesWrapper = document.createElement('div');
    utilitiesWrapper.className = 'theater-utilities';

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
    const panelIdSafeSuffix = String(scene?.id || 'scene').replace(/[^a-zA-Z0-9_-]/g, '-');
    const panelId = `theater-utilities-panel-${panelIdSafeSuffix}`;
    panel.setAttribute('id', panelId);
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', translate('player.utilities.panelLabel'));
    toggleButton.setAttribute('aria-controls', panelId);

    const panelHeader = document.createElement('div');
    panelHeader.className = 'theater-utilities-header';

    const utilitiesTitle = document.createElement('h4');
    utilitiesTitle.textContent = translate('player.utilities.title');

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'theater-icon-button';
    closeButton.appendChild(createPlayerIcon('close'));
    closeButton.setAttribute('aria-label', translate('player.utilities.closeLabel'));

    panelHeader.append(utilitiesTitle, closeButton);
    panel.appendChild(panelHeader);

    const panelContent = document.createElement('div');
    panelContent.className = 'theater-utilities-content';

    if (hasDiscussionTools) {
      const discussionSection = document.createElement('section');
      discussionSection.className = 'theater-utilities-section theater-utilities-section--discussion';

      const heading = document.createElement('h4');
      heading.textContent = translate('player.discussion.utilityHeading');
      discussionSection.appendChild(heading);

      const discussionButton = document.createElement('button');
      discussionButton.type = 'button';
      discussionButton.className = 'theater-panel-action';
      discussionButton.appendChild(createPlayerIcon('pencil'));
      const discussionLabel = document.createElement('span');
      discussionLabel.textContent = translate('player.discussion.button');
      discussionButton.appendChild(discussionLabel);
      discussionButton.setAttribute('aria-label', translate('player.discussion.button'));
      discussionButton.addEventListener('click', () => {
        setOpen(false);
        openDiscussion();
      });

      const printButton = document.createElement('button');
      printButton.type = 'button';
      printButton.className = 'theater-panel-action';
      printButton.appendChild(createPlayerIcon('print'));
      const printLabel = document.createElement('span');
      printLabel.textContent = translate('player.discussion.printButton');
      printButton.appendChild(printLabel);
      printButton.setAttribute('aria-label', translate('player.discussion.printButton'));
      printButton.disabled = !discussionSession.hasAnyText?.();
      printButton.addEventListener('click', () => {
        setOpen(false);
        onPrintDiscussion?.();
      });

      discussionSection.append(discussionButton, printButton);
      panelContent.appendChild(discussionSection);
    }

    if (hasMusic) {
      const musicSection = document.createElement('section');
      musicSection.className = 'theater-utilities-section theater-utilities-section--music';

      const heading = document.createElement('h4');
      heading.textContent = translate('player.background.title');
      musicSection.appendChild(heading);

      const volumeWrapper = document.createElement('div');
      volumeWrapper.className = 'theater-music-volume';

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
      musicSection.appendChild(volumeWrapper);

      const muteButton = document.createElement('button');
      muteButton.type = 'button';
      muteButton.className = 'theater-panel-action';

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

      musicSection.appendChild(muteButton);
      panelContent.appendChild(musicSection);
    }

    if (hasHistory) {
      const historySection = document.createElement('section');
      historySection.className = 'theater-utilities-section theater-utilities-section--history';

      const historyTitle = document.createElement('h4');
      historyTitle.textContent = translate('player.history.title');
      historySection.appendChild(historyTitle);

      const navControls = document.createElement('div');
      navControls.className = 'theater-history-nav';

      const backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.className = 'theater-panel-action';
      backButton.textContent = translate('player.history.back');
      backButton.disabled = !historyControls.canGoBack;
      backButton.setAttribute('aria-label', translate('player.history.backLabel'));
      if (historyControls.onBack) {
        backButton.addEventListener('click', () => historyControls.onBack());
      }

      const forwardButton = document.createElement('button');
      forwardButton.type = 'button';
      forwardButton.className = 'theater-panel-action';
      forwardButton.textContent = translate('player.history.forward');
      forwardButton.disabled = !historyControls.canGoForward;
      forwardButton.setAttribute('aria-label', translate('player.history.forwardLabel'));
      if (historyControls.onForward) {
        forwardButton.addEventListener('click', () => historyControls.onForward());
      }

      navControls.append(backButton, forwardButton);
      historySection.appendChild(navControls);

      const historyList = document.createElement('ol');
      historyList.className = 'theater-history-list';
      historyList.setAttribute('aria-label', translate('player.history.listLabel'));

      historyControls.entries.forEach((entry, index) => {
        const item = document.createElement('li');
        item.className = 'theater-history-item';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'theater-history-entry';
        const step = document.createElement('span');
        step.className = 'theater-history-step';
        step.textContent = String(index + 1);
        const label = document.createElement('span');
        label.className = 'theater-history-label';
        const displayLabel = entry.label ?? entry.fullLabel ?? entry.sceneId;
        const accessibleLabel = entry.fullLabel ?? entry.label ?? entry.sceneId;
        label.textContent = displayLabel || '';
        button.append(step, label);
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

      historySection.appendChild(historyList);
      panelContent.appendChild(historySection);
    }

    panel.appendChild(panelContent);

    const setOpen = (open) => {
      panel.hidden = !open;
      toggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    toggleButton.addEventListener('click', () => setOpen(panel.hidden));
    closeButton.addEventListener('click', () => setOpen(false));

    utilitiesWrapper.append(toggleButton, panel);
    theaterUtilityRail.appendChild(utilitiesWrapper);
  };

  appendUtilitiesPanel();

  const renderNavigationControls = (host, options = {}) => renderPlayerChoices({
    host,
    project,
    scene,
    onChoice,
    openCueCard,
    ...options,
  });

  if (speechBubbleEnabled) {
    return renderSpeechBubblePlayerUI({
      speechBubbleOverlay,
      theaterOverlay,
      theaterControlRail,
      theaterUtilityRail,
      project,
      scene,
      onChoice,
      openCueCard,
      dialogueAudio,
      requestDuck,
      releaseDuck,
      stopDialoguePlayback,
      cleanupCueCardListeners,
      closeCueCard,
      renderNavigationControls,
    });
  }

  const visibleEntries = (scene.dialogue || [])
    .map((line, index) => ({ line, index }))
    .filter(entry => hasDialogueLineContent(entry.line));

  const timers = new Set();
  let activeVisibleIndex = visibleEntries.length ? 0 : -1;
  let activePageIndex = 0;
  let currentAudioActive = false;
  let playAllActive = false;
  let choicesOpen = false;
  let endOverlayOpen = !visibleEntries.length;
  let runToken = 0;

  const nextRunToken = () => {
    runToken += 1;
    return runToken;
  };

  const clearTimers = () => {
    timers.forEach(timer => {
      try {
        globalThis.clearTimeout?.(timer);
      } catch {
        // Ignore timer cleanup failures.
      }
    });
    timers.clear();
  };

  const scheduleTimer = (callback, delayMs) => {
    if (typeof globalThis.setTimeout !== 'function') return null;
    const timer = globalThis.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
    return timer;
  };

  const stopTheaterPlayback = () => {
    clearTimers();
    nextRunToken();
    playAllActive = false;
    currentAudioActive = false;
    dialogueAudio.stop();
    releaseDuck();
  };

  const getEntryPages = (entry) => {
    if (!entry) return [];
    return splitDialogueText(getDialoguePageText(entry.line, entry.index));
  };

  const getCurrentEntry = () => visibleEntries[activeVisibleIndex] || null;

  const getCurrentPages = () => getEntryPages(getCurrentEntry());

  const clampActivePage = () => {
    const pages = getCurrentPages();
    activePageIndex = Math.max(0, Math.min(activePageIndex, Math.max(0, pages.length - 1)));
  };

  const openEndOverlay = ({ choicesMenu = false } = {}) => {
    stopTheaterPlayback();
    choicesOpen = choicesMenu;
    endOverlayOpen = true;
    renderTheaterState();
  };

  const advanceTheater = ({ fromAuto = false } = {}) => {
    const pages = getCurrentPages();
    if (!fromAuto) {
      stopTheaterPlayback();
    }
    if (pages.length && activePageIndex < pages.length - 1) {
      activePageIndex += 1;
      choicesOpen = false;
      endOverlayOpen = false;
      renderTheaterState();
      return;
    }
    if (activeVisibleIndex < visibleEntries.length - 1) {
      activeVisibleIndex += 1;
      activePageIndex = 0;
      choicesOpen = false;
      endOverlayOpen = false;
      renderTheaterState();
      return;
    }
    openEndOverlay({ choicesMenu: true });
  };

  const retreatTheater = () => {
    stopTheaterPlayback();
    if (choicesOpen || endOverlayOpen) {
      choicesOpen = false;
      endOverlayOpen = false;
      activeVisibleIndex = Math.max(0, activeVisibleIndex);
      clampActivePage();
      renderTheaterState();
      return;
    }
    if (activePageIndex > 0) {
      activePageIndex -= 1;
      renderTheaterState();
      return;
    }
    if (activeVisibleIndex > 0) {
      activeVisibleIndex -= 1;
      activePageIndex = Math.max(0, getCurrentPages().length - 1);
      renderTheaterState();
    }
  };

  const toggleChoicesMenu = () => {
    if (choicesOpen) {
      stopTheaterPlayback();
      choicesOpen = false;
      endOverlayOpen = false;
      renderTheaterState();
      return;
    }
    openEndOverlay({ choicesMenu: true });
  };

  const theaterChoicesDock = document.createElement('div');
  theaterChoicesDock.className = 'theater-choices-dock';

  const choicesDockButton = document.createElement('button');
  choicesDockButton.type = 'button';
  choicesDockButton.className = 'theater-floating-button theater-floating-button--choices';
  choicesDockButton.appendChild(createPlayerIcon('list'));
  const choicesDockLabel = document.createElement('span');
  choicesDockLabel.textContent = translate('player.toolbar.choices');
  choicesDockButton.appendChild(choicesDockLabel);
  choicesDockButton.setAttribute('aria-label', translate('player.toolbar.choices'));
  choicesDockButton.setAttribute('aria-expanded', 'false');
  choicesDockButton.addEventListener('click', toggleChoicesMenu);

  theaterChoicesDock.appendChild(choicesDockButton);
  theaterUtilityRail.appendChild(theaterChoicesDock);

  const schedulePageSteps = ({ pages, totalSeconds, token }) => {
    if (pages.length <= 1) return;
    const totalMs = Math.max(0, totalSeconds * 1000);
    const canFitInAudio = totalSeconds / pages.length >= DIALOGUE_MIN_AUDIO_PAGE_SECONDS;
    pages.slice(1).forEach((_, pageOffset) => {
      const pageNumber = pageOffset + 1;
      const delay = canFitInAudio
        ? (totalMs / pages.length) * pageNumber
        : DIALOGUE_MIN_AUDIO_PAGE_SECONDS * 1000 * pageNumber;
      scheduleTimer(() => {
        if (token !== runToken) return;
        activePageIndex = pageNumber;
        renderTheaterState();
      }, delay);
    });
  };

  const getPresentationSeconds = (pages, audioSeconds = 0) => {
    if (pages.length <= 1) {
      return Math.max(audioSeconds, estimateReadingSeconds(pages[0] || ''));
    }
    if (audioSeconds > 0 && audioSeconds / pages.length >= DIALOGUE_MIN_AUDIO_PAGE_SECONDS) {
      return audioSeconds;
    }
    const lastPageStartsAt = (pages.length - 1) * DIALOGUE_MIN_AUDIO_PAGE_SECONDS;
    return Math.max(audioSeconds, lastPageStartsAt + estimateReadingSeconds(pages[pages.length - 1] || ''));
  };

  const completePlayAllLine = () => {
    currentAudioActive = false;
    if (!playAllActive) {
      renderTheaterState();
      return;
    }
    if (activeVisibleIndex >= visibleEntries.length - 1) {
      openEndOverlay({ choicesMenu: true });
      return;
    }
    activeVisibleIndex += 1;
    activePageIndex = 0;
    playCurrentTheaterLine({ autoAdvance: true });
  };

  function playCurrentTheaterLine({ autoAdvance = false } = {}) {
    const entry = getCurrentEntry();
    if (!entry) return;
    clearTimers();
    const token = nextRunToken();
    activePageIndex = 0;
    endOverlayOpen = false;
    choicesOpen = false;
    playAllActive = playAllActive || autoAdvance;
    const pages = getEntryPages(entry);

    if (entry.line.audio?.objectUrl) {
      currentAudioActive = true;
      let audioDone = false;
      let presentationDone = !playAllActive;
      const completeWhenReady = () => {
        if (token !== runToken || !playAllActive) {
          renderTheaterState();
          return;
        }
        if (audioDone && presentationDone) {
          completePlayAllLine();
        } else {
          renderTheaterState();
        }
      };

      requestDuck();
      const audioSeconds = getLineAudioDurationSeconds(entry.line, pages);
      schedulePageSteps({ pages, totalSeconds: audioSeconds, token });
      if (playAllActive) {
        scheduleTimer(() => {
          if (token !== runToken) return;
          presentationDone = true;
          completeWhenReady();
        }, getPresentationSeconds(pages, audioSeconds) * 1000);
      }
      dialogueAudio.playClip({
        src: entry.line.audio.objectUrl,
        onComplete: () => {
          releaseDuck();
          if (token !== runToken) return;
          if (!playAllActive) {
            clearTimers();
          }
          currentAudioActive = false;
          audioDone = true;
          completeWhenReady();
        },
        onCancel: () => {
          releaseDuck();
          if (token !== runToken) return;
          if (!playAllActive) {
            clearTimers();
          }
          currentAudioActive = false;
          renderTheaterState();
        },
        onError: (error) => {
          console.warn(translate('player.dialogue.playbackError'), error);
          releaseDuck();
          if (token !== runToken) return;
          clearTimers();
          nextRunToken();
          currentAudioActive = false;
          playAllActive = false;
          renderTheaterState();
        },
      });
      renderTheaterState();
      return;
    }

    currentAudioActive = false;
    if (playAllActive) {
      let cumulativeMs = 0;
      pages.slice(1).forEach((_, pageOffset) => {
        cumulativeMs += estimateReadingSeconds(pages[pageOffset]) * 1000;
        const pageNumber = pageOffset + 1;
        scheduleTimer(() => {
          if (token !== runToken) return;
          activePageIndex = pageNumber;
          renderTheaterState();
        }, cumulativeMs);
      });
      cumulativeMs += estimateReadingSeconds(pages[pages.length - 1] || '') * 1000;
      scheduleTimer(() => {
        if (token !== runToken) return;
        completePlayAllLine();
      }, cumulativeMs);
    }
    renderTheaterState();
  }

  function renderTheaterState() {
    if (!theaterOverlay) return;
    theaterOverlay.innerHTML = '';
    theaterOverlay.classList?.remove?.('theater-overlay--dialogue', 'theater-overlay--choices');
    if (theaterControlRail) {
      theaterControlRail.innerHTML = '';
    }
    clampActivePage();
    const activeEntry = getCurrentEntry();
    const pages = getEntryPages(activeEntry);
    const page = pages[activePageIndex] || '';

    const toolbar = document.createElement('div');
    toolbar.className = 'theater-toolbar';

    choicesDockButton.setAttribute('aria-expanded', choicesOpen ? 'true' : 'false');

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'theater-toolbar__button theater-toolbar__button--previous';
    appendToolbarButtonContent(prevButton, 'previous', translate('player.speechBubble.previous'));
    prevButton.disabled = !visibleEntries.length || (!choicesOpen && !endOverlayOpen && activeVisibleIndex <= 0 && activePageIndex <= 0);
    prevButton.addEventListener('click', retreatTheater);

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'theater-toolbar__button theater-toolbar__button--next';
    appendToolbarButtonContent(nextButton, 'next', translate('player.speechBubble.next'));
    nextButton.disabled = !visibleEntries.length || endOverlayOpen || choicesOpen;
    nextButton.addEventListener('click', () => advanceTheater());

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'theater-toolbar__button dialogue-bubble-play';
    appendToolbarButtonContent(
      playButton,
      currentAudioActive ? 'stop' : 'play',
      currentAudioActive
        ? translate('player.toolbar.stopAudio')
        : translate('player.toolbar.playAudio'),
    );
    playButton.disabled = !activeEntry?.line?.audio?.objectUrl || choicesOpen || endOverlayOpen;
    playButton.setAttribute('aria-pressed', currentAudioActive ? 'true' : 'false');
    playButton.addEventListener('click', () => {
      if (currentAudioActive) {
        stopTheaterPlayback();
        renderTheaterState();
        return;
      }
      playCurrentTheaterLine();
    });

    const playAllButton = document.createElement('button');
    playAllButton.type = 'button';
    playAllButton.className = 'theater-toolbar__button audio-play-all';
    appendToolbarButtonContent(
      playAllButton,
      playAllActive ? 'stop' : 'play',
      playAllActive
        ? translate('player.speechBubble.stopAll')
        : translate('player.speechBubble.playAll'),
    );
    playAllButton.disabled = !visibleEntries.length || choicesOpen || endOverlayOpen;
    playAllButton.setAttribute('aria-pressed', playAllActive ? 'true' : 'false');
    playAllButton.addEventListener('click', () => {
      if (playAllActive) {
        stopTheaterPlayback();
        renderTheaterState();
        return;
      }
      stopTheaterPlayback();
      activeVisibleIndex = 0;
      activePageIndex = 0;
      playAllActive = true;
      playCurrentTheaterLine({ autoAdvance: true });
    });

    const choicesButton = document.createElement('button');
    choicesButton.type = 'button';
    choicesButton.className = 'theater-toolbar__button theater-toolbar__button--choices';
    appendToolbarButtonContent(choicesButton, 'list', translate('player.toolbar.choices'));
    choicesButton.setAttribute('aria-expanded', choicesOpen ? 'true' : 'false');
    choicesButton.addEventListener('click', toggleChoicesMenu);

    toolbar.appendChild(prevButton);
    toolbar.appendChild(nextButton);
    toolbar.appendChild(playButton);
    toolbar.appendChild(playAllButton);
    toolbar.appendChild(choicesButton);
    if (theaterControlRail) {
      theaterControlRail.appendChild(toolbar);
    } else {
      theaterOverlay.appendChild(toolbar);
    }

    if (!choicesOpen && !endOverlayOpen && activeEntry) {
      theaterOverlay.classList?.add?.('theater-overlay--dialogue');
      const dialogueCard = document.createElement('div');
      dialogueCard.className = 'theater-dialogue-card';
      const speakerName = getSpeakerName(project, activeEntry.line);
      if (speakerName) {
        const speaker = document.createElement('p');
        speaker.className = 'theater-dialogue-speaker';
        speaker.textContent = `${speakerName}:`;
        dialogueCard.appendChild(speaker);
      }
      const text = document.createElement('p');
      text.className = 'theater-dialogue-text';
      text.textContent = page;
      dialogueCard.appendChild(text);
      if (pages.length > 1) {
        const pageStatus = document.createElement('span');
        pageStatus.className = 'theater-page-status';
        pageStatus.textContent = translate('player.speechBubble.pageStatus', {
          current: activePageIndex + 1,
          total: pages.length,
        });
        dialogueCard.appendChild(pageStatus);
      }
      theaterOverlay.appendChild(dialogueCard);
      return;
    }

    const choicesPanel = document.createElement('div');
    theaterOverlay.classList?.add?.('theater-overlay--choices');
    choicesPanel.className = choicesOpen
      ? 'theater-choice-panel theater-choice-panel--menu'
      : 'theater-choice-panel';
    renderNavigationControls(choicesPanel, {
      beforeChoice: stopTheaterPlayback,
    });
    theaterOverlay.appendChild(choicesPanel);
  }

  renderTheaterState();

  return () => {
    clearTimers();
    nextRunToken();
    cleanupCueCardListeners();
    closeCueCard();
    stopDialoguePlayback();
  };
}
