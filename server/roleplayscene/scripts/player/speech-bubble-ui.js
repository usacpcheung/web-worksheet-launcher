import { BubbleMode } from '../model.js';
import { translate } from '../i18n.js';
import {
  DIALOGUE_MIN_AUDIO_PAGE_SECONDS,
  estimateReadingSeconds,
  getDialoguePageText,
  getLineAudioDurationSeconds,
  hasDialogueLineContent,
  splitDialogueText,
} from './dialogue-progression.js';

export const splitSpeechBubbleText = splitDialogueText;

function getSpeechBubbleAnchor(scene, line) {
  if (line?.bubble?.mode !== BubbleMode.ANCHOR) return null;
  const anchors = Array.isArray(scene?.speechBubble?.anchors) ? scene.speechBubble.anchors : [];
  return anchors.find(anchor => anchor.id === line?.bubble?.anchorId) || null;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function createSvgElement(tagName) {
  return document.createElementNS
    ? document.createElementNS('http://www.w3.org/2000/svg', tagName)
    : document.createElement(tagName);
}

function getElementSize(element, fallbackWidth, fallbackHeight) {
  const width = Number(element?.offsetWidth || element?.getBoundingClientRect?.().width);
  const height = Number(element?.offsetHeight || element?.getBoundingClientRect?.().height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
    height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
  };
}

function buildSpeechBubblePath(width, height, tail) {
  const radius = Math.min(26, Math.max(16, Math.min(width, height) * 0.18));
  const baseHalf = Math.min(14, Math.max(9, width * 0.035));
  const attachX = clampNumber(tail.attachX, radius + baseHalf, width - radius - baseHalf);
  const attachY = tail.side === 'top' ? 0 : height;
  const baseY = tail.side === 'top' ? attachY : attachY;
  const dx = tail.tipX - attachX;
  const dy = tail.tipY - attachY;
  const distance = Math.hypot(dx, dy) || 1;
  const maxTailLength = Math.min(54, Math.max(42, width * 0.14));
  const scale = Math.min(1, maxTailLength / distance);
  const tipX = attachX + dx * scale;
  const tipY = attachY + dy * scale;
  const curveX = (attachX + tipX) / 2;
  const curveY = tail.side === 'top'
    ? Math.min(attachY - 4, (attachY + tipY) / 2)
    : Math.max(attachY + 4, (attachY + tipY) / 2);

  if (tail.side === 'top') {
    return [
      `M ${radius} 0`,
      `H ${attachX - baseHalf}`,
      `Q ${curveX} ${curveY} ${tipX} ${tipY}`,
      `Q ${curveX + baseHalf * 0.35} ${curveY} ${attachX + baseHalf} ${baseY}`,
      `H ${width - radius}`,
      `Q ${width} 0 ${width} ${radius}`,
      `V ${height - radius}`,
      `Q ${width} ${height} ${width - radius} ${height}`,
      `H ${radius}`,
      `Q 0 ${height} 0 ${height - radius}`,
      `V ${radius}`,
      `Q 0 0 ${radius} 0`,
      'Z',
    ].join(' ');
  }

  return [
    `M ${radius} 0`,
    `H ${width - radius}`,
    `Q ${width} 0 ${width} ${radius}`,
    `V ${height - radius}`,
    `Q ${width} ${height} ${width - radius} ${height}`,
    `H ${attachX + baseHalf}`,
    `Q ${curveX + baseHalf * 0.35} ${curveY} ${tipX} ${tipY}`,
    `Q ${curveX} ${curveY} ${attachX - baseHalf} ${baseY}`,
    `H ${radius}`,
    `Q 0 ${height} 0 ${height - radius}`,
    `V ${radius}`,
    `Q 0 0 ${radius} 0`,
    'Z',
  ].join(' ');
}

function positionAnchorSpeechBubble(overlay, bubble, path, anchor) {
  const overlaySize = getElementSize(overlay, 640, 360);
  const bubbleSize = getElementSize(bubble, 340, 120);
  const anchorX = clampNumber(Number(anchor?.x), 0, 1) * overlaySize.width;
  const anchorY = clampNumber(Number(anchor?.y), 0, 1) * overlaySize.height;
  const gap = 30;
  const margin = 12;
  const candidates = [
    { name: 'above-right', left: anchorX + gap, top: anchorY - bubbleSize.height - gap, side: 'bottom', attachRatio: 0.2, preference: 0 },
    { name: 'above-left', left: anchorX - bubbleSize.width - gap, top: anchorY - bubbleSize.height - gap, side: 'bottom', attachRatio: 0.8, preference: 1 },
    { name: 'below-right', left: anchorX + gap, top: anchorY + gap, side: 'top', attachRatio: 0.2, preference: 2 },
    { name: 'below-left', left: anchorX - bubbleSize.width - gap, top: anchorY + gap, side: 'top', attachRatio: 0.8, preference: 3 },
  ];

  const scored = candidates.map(candidate => {
    const overflowLeft = Math.max(0, margin - candidate.left);
    const overflowTop = Math.max(0, margin - candidate.top);
    const overflowRight = Math.max(0, candidate.left + bubbleSize.width + margin - overlaySize.width);
    const overflowBottom = Math.max(0, candidate.top + bubbleSize.height + margin - overlaySize.height);
    const overflow = overflowLeft + overflowTop + overflowRight + overflowBottom;
    return {
      ...candidate,
      score: overflow * 100 + candidate.preference,
    };
  }).sort((a, b) => a.score - b.score)[0];

  const left = clampNumber(scored.left, margin, Math.max(margin, overlaySize.width - bubbleSize.width - margin));
  const top = clampNumber(scored.top, margin, Math.max(margin, overlaySize.height - bubbleSize.height - margin));
  const tipX = anchorX - left;
  const tipY = anchorY - top;
  const attachX = bubbleSize.width * scored.attachRatio;

  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.classList.add('speech-play-bubble-wrap--positioned');
  bubble.setAttribute('data-tail-side', scored.side);
  bubble.setAttribute('data-tail-anchor', scored.name);
  path.setAttribute('d', buildSpeechBubblePath(bubbleSize.width, bubbleSize.height, {
    side: scored.side,
    attachX,
    tipX,
    tipY,
  }));
}

function getSpeakerName(project, line) {
  if (!line?.speakerId) return '';
  const speakers = Array.isArray(project?.speakers) ? project.speakers : [];
  const speaker = speakers.find(candidate => candidate.id === line.speakerId);
  return String(speaker?.name || '').trim();
}

function appendSpeechBubbleText(host, page, speakerName = '') {
  if (speakerName) {
    const speaker = document.createElement('p');
    speaker.className = 'speech-play-speaker';
    speaker.textContent = `${speakerName}:`;
    host.appendChild(speaker);
  }
  const text = document.createElement('p');
  text.textContent = page;
  host.appendChild(text);
}

export function renderSpeechBubblePlayerUI({
  speechBubbleOverlay,
  speechPanel,
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
}) {
  const visibleEntries = (scene.dialogue || [])
    .map((line, index) => ({ line, index }))
    .filter(entry => hasDialogueLineContent(entry.line) && entry.line.bubble?.mode !== BubbleMode.HIDDEN);

  let activeVisibleIndex = visibleEntries.length ? 0 : -1;
  let activePageIndex = 0;
  let speechAudioActive = false;
  let speechPlayAllActive = false;
  let speechRunToken = 0;
  let renderedSpeechBubbleKey = null;
  let renderedSpeechBubbleElement = null;
  const speechTimers = new Set();

  const nextSpeechRunToken = () => {
    speechRunToken += 1;
    return speechRunToken;
  };

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
    nextSpeechRunToken();
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
    if (audioSeconds > 0 && audioSeconds / pages.length >= DIALOGUE_MIN_AUDIO_PAGE_SECONDS) {
      return audioSeconds;
    }
    const lastPageStartsAt = (pages.length - 1) * DIALOGUE_MIN_AUDIO_PAGE_SECONDS;
    return Math.max(audioSeconds, lastPageStartsAt + estimateReadingSeconds(pages[pages.length - 1] || ''));
  };

  const schedulePaging = ({ pages, totalSeconds }) => {
    if (pages.length <= 1) return;
    const totalMs = Math.max(0, totalSeconds * 1000);
    const canFitInAudio = totalSeconds / pages.length >= DIALOGUE_MIN_AUDIO_PAGE_SECONDS;
    if (canFitInAudio) {
      pages.slice(1).forEach((_, pageOffset) => {
        const pageNumber = pageOffset + 1;
        scheduleSpeechTimer(() => advanceSpeechPage(pages, pageNumber), (totalMs / pages.length) * pageNumber);
      });
      return;
    }

    pages.slice(1).forEach((_, pageOffset) => {
      const pageNumber = pageOffset + 1;
      const delay = DIALOGUE_MIN_AUDIO_PAGE_SECONDS * 1000 * pageNumber;
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
    const runToken = nextSpeechRunToken();
    activePageIndex = 0;
    speechPlayAllActive = speechPlayAllActive || autoAdvance;
    const mode = entry.line.bubble?.mode || BubbleMode.CENTER;
    const pages = splitSpeechBubbleText(getDialoguePageText(entry.line, entry.index), mode);

    if (entry.line.audio?.objectUrl) {
      speechAudioActive = true;
      let audioDone = false;
      let presentationDone = !speechPlayAllActive;
      const completePlayAllWhenReady = () => {
        if (runToken !== speechRunToken || !speechPlayAllActive) {
          renderSpeechState();
          return;
        }
        if (audioDone && presentationDone) {
          completeCurrentSpeechLine();
        } else {
          renderSpeechState();
        }
      };
      requestDuck();
      const audioSeconds = getLineAudioDurationSeconds(entry.line, pages);
      schedulePaging({
        pages,
        totalSeconds: audioSeconds,
      });
      if (speechPlayAllActive) {
        scheduleSpeechTimer(() => {
          if (runToken !== speechRunToken) return;
          presentationDone = true;
          completePlayAllWhenReady();
        }, getPresentationSeconds(pages, audioSeconds) * 1000);
      }
      dialogueAudio.playClip({
        src: entry.line.audio.objectUrl,
        onComplete: () => {
          releaseDuck();
          if (runToken !== speechRunToken) return;
          speechAudioActive = false;
          audioDone = true;
          completePlayAllWhenReady();
        },
        onCancel: () => {
          releaseDuck();
          if (runToken !== speechRunToken) return;
          speechAudioActive = false;
          renderSpeechState();
        },
        onError: (error) => {
          console.warn(translate('player.speechBubble.playbackError'), error);
          releaseDuck();
          if (runToken !== speechRunToken) return;
          clearSpeechTimers();
          nextSpeechRunToken();
          speechAudioActive = false;
          speechPlayAllActive = false;
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
    nextSpeechRunToken();
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
    nextSpeechRunToken();
    speechPlayAllActive = false;
    const mode = entry.line.bubble?.mode || BubbleMode.CENTER;
    const pages = splitSpeechBubbleText(getDialoguePageText(entry.line, entry.index), mode);
    activePageIndex = Math.max(0, Math.min(pages.length - 1, activePageIndex + delta));
    renderSpeechState();
  };

  const clearRenderedSpeechBubble = () => {
    if (speechBubbleOverlay) speechBubbleOverlay.innerHTML = '';
    renderedSpeechBubbleKey = null;
    renderedSpeechBubbleElement = null;
  };

  const updateRenderedSpeechBubbleState = () => {
    if (!renderedSpeechBubbleElement?.classList?.toggle) return;
    renderedSpeechBubbleElement.classList.toggle('is-playing', speechAudioActive);
  };

  function renderSpeechState() {
    speechPanel.innerHTML = '';

    const activeEntry = visibleEntries[activeVisibleIndex] || null;
    const activeMode = activeEntry?.line?.bubble?.mode || BubbleMode.CENTER;
    const pages = activeEntry
      ? splitSpeechBubbleText(getDialoguePageText(activeEntry.line, activeEntry.index), activeMode)
      : [];
    const page = pages[Math.max(0, Math.min(activePageIndex, pages.length - 1))] || '';

    if (!activeEntry || !speechBubbleOverlay) {
      clearRenderedSpeechBubble();
    } else {
      const speakerName = getSpeakerName(project, activeEntry.line);
      const anchor = getSpeechBubbleAnchor(scene, activeEntry.line);
      const fallbackAnchor = activeEntry.line.bubble?.x != null || activeEntry.line.bubble?.y != null
        ? { x: activeEntry.line.bubble?.x ?? 0.5, y: activeEntry.line.bubble?.y ?? 0.5 }
        : null;
      const anchorPoint = anchor || fallbackAnchor;
      const bubbleKey = [
        activeEntry.index,
        activePageIndex,
        activeMode,
        speakerName,
        page,
        anchorPoint?.id || '',
        anchorPoint?.x ?? '',
        anchorPoint?.y ?? '',
      ].join('|');

      if (bubbleKey === renderedSpeechBubbleKey && renderedSpeechBubbleElement) {
        updateRenderedSpeechBubbleState();
      } else if (activeMode === BubbleMode.ANCHOR && anchorPoint) {
        clearRenderedSpeechBubble();
        const bubble = document.createElement('div');
        bubble.className = 'speech-play-bubble-wrap speech-play-bubble-wrap--anchor';
        bubble.classList.toggle('is-playing', speechAudioActive);

        const svg = createSvgElement('svg');
        svg.classList.add('speech-play-bubble-svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        const shape = createSvgElement('path');
        shape.classList.add('speech-play-bubble-shape');
        svg.appendChild(shape);
        bubble.appendChild(svg);

        const textLayer = document.createElement('div');
        textLayer.className = 'speech-play-bubble-text';
        appendSpeechBubbleText(textLayer, page, speakerName);
        if (pages.length > 1) {
          const pageStatus = document.createElement('span');
          pageStatus.className = 'speech-play-page-status';
          pageStatus.textContent = translate('player.speechBubble.pageStatus', {
            current: activePageIndex + 1,
            total: pages.length,
          });
          textLayer.appendChild(pageStatus);
        }
        bubble.appendChild(textLayer);
        speechBubbleOverlay.appendChild(bubble);
        positionAnchorSpeechBubble(speechBubbleOverlay, bubble, shape, anchorPoint);
        renderedSpeechBubbleKey = bubbleKey;
        renderedSpeechBubbleElement = bubble;
      } else {
        clearRenderedSpeechBubble();
        const bubble = document.createElement('div');
        bubble.className = 'speech-play-bubble speech-play-bubble--center';
        bubble.classList.toggle('is-playing', speechAudioActive);
        appendSpeechBubbleText(bubble, page, speakerName);
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
        renderedSpeechBubbleKey = bubbleKey;
        renderedSpeechBubbleElement = bubble;
      }
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
      prevButton.disabled = activeVisibleIndex <= 0 && activePageIndex <= 0;
      prevButton.addEventListener('click', () => {
        if (activePageIndex > 0) {
          changeSpeechPage(-1);
          return;
        }
        setActiveSpeechLine(activeVisibleIndex - 1, { autoplay: false });
      });

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
      nextButton.disabled = activeVisibleIndex >= visibleEntries.length - 1 && activePageIndex >= pages.length - 1;
      nextButton.addEventListener('click', () => {
        if (activePageIndex < pages.length - 1) {
          changeSpeechPage(1);
          return;
        }
        setActiveSpeechLine(activeVisibleIndex + 1, { autoplay: true });
      });

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
    renderNavigationControls(speechPanel, {
      project,
      scene,
      onChoice,
      openCueCard,
      beforeChoice: stopDialoguePlayback,
      cueIconText: '?',
    });
  }

  renderSpeechState();

  return () => {
    clearSpeechTimers();
    nextSpeechRunToken();
    cleanupCueCardListeners();
    closeCueCard();
    stopDialoguePlayback();
  };
}
