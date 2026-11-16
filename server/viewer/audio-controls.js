import { normalizeAudioTracks } from '../editor/audio-tracks.js';

export function resolveViewerAudioSources(audioTracks, legacyAudioRef = null) {
  const tracks = normalizeAudioTracks(audioTracks);
  if (tracks.length > 0) {
    return tracks.map((track) => ({
      assetId: track.assetId,
      language: track.language,
      legacy: false,
    }));
  }
  if (legacyAudioRef?.assetId) {
    return [{ assetId: legacyAudioRef.assetId, language: null, legacy: true }];
  }
  return [];
}

// Instantiate once per viewer page, not once per question or shell render.
// All question/option controls share one open-menu owner and one document
// dismissal listener. Each control's signal owns its listeners and positioning.
// Playback, resource cleanup and navigation decisions remain with the session.
export function createViewerAudioControls({ createIcon, t }) {
  let openViewerAudioMenu = null;
  let viewerAudioMenuDismissListenerAttached = false;

  function closeOpenViewerAudioMenu({ restoreFocus = false } = {}) {
    const current = openViewerAudioMenu;
    if (!current) return;
    openViewerAudioMenu = null;
    current.close?.();
    if (restoreFocus) current.trigger?.focus?.();
  }

  function ensureViewerAudioMenuDismissListener() {
    if (viewerAudioMenuDismissListenerAttached || typeof document?.addEventListener !== 'function') return;
    viewerAudioMenuDismissListenerAttached = true;
    document.addEventListener('pointerdown', (event) => {
      const current = openViewerAudioMenu;
      if (!current || current.root?.contains?.(event.target)) return;
      closeOpenViewerAudioMenu();
    });
  }

  function getViewerAudioLanguageLabel(language) {
    if (!language) return '';
    return t(`viewer.audio.languages.${language}`);
  }

  // Own positioning only while a language menu is open. Keep the menu inside its
  // control so keyboard focus and section ownership retain their existing meaning.
  function positionViewerAudioMenu(root, menu, kind) {
    const controller = new AbortController();
    const { signal } = controller;
    let frame = 0;
    const place = () => {
      frame = 0;
      const visual = window.visualViewport;
      const left = (visual?.offsetLeft || 0) + 8;
      const top = (visual?.offsetTop || 0) + 8;
      const right = Math.min(document.documentElement.clientWidth,
        (visual?.offsetLeft || 0) + (visual?.width || innerWidth)) - 8;
      const bottom = Math.min(innerHeight,
        (visual?.offsetTop || 0) + (visual?.height || innerHeight)) - 8;
      const anchor = root.getBoundingClientRect();
      const above = Math.max(0, anchor.top - 8 - top);
      const below = Math.max(0, bottom - anchor.bottom - 8);
      menu.style.maxWidth = `${Math.max(1, right - left)}px`;
      menu.style.minWidth = `${Math.min(184, Math.max(1, right - left))}px`;
      const desiredHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const upwards = desiredHeight > below && above > below;
      menu.style.maxHeight = `${Math.max(1, upwards ? above : below)}px`;
      const rect = menu.getBoundingClientRect();
      const x = Math.max(left, Math.min(kind === 'question' ? anchor.left : anchor.right - rect.width, right - rect.width));
      const y = Math.max(top, Math.min(upwards ? anchor.top - 8 - rect.height : anchor.bottom + 8, bottom - rect.height));
      menu.style.left = `${x - anchor.left}px`;
      menu.style.top = `${y - anchor.top}px`;
      menu.style.right = 'auto';
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    window.addEventListener('scroll', event => {
      if (!menu.contains(event.target)) schedule();
    }, { capture: true, passive: true, signal });
    window.addEventListener('resize', schedule, { signal });
    window.visualViewport?.addEventListener('resize', schedule, { signal });
    window.visualViewport?.addEventListener('scroll', schedule, { signal });
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(menu);
    document.fonts?.ready.then(() => { if (!signal.aborted) schedule(); });
    place();
    return () => { controller.abort(); observer.disconnect(); cancelAnimationFrame(frame); };
  }

  function createViewerAudioControl({
    audioTracks,
    legacyAudioRef = null,
    kind,
    session,
    reportMediaFeedback,
    signal,
  } = {}) {
    const sources = resolveViewerAudioSources(audioTracks, legacyAudioRef);
    if (sources.length === 0 || !session?.playAssetAudio) return null;

    const normalizedKind = kind === 'option' ? 'option' : 'question';
    const hasMenu = sources.length > 1;
    const root = document.createElement('div');
    root.className = `viewer-audio-control viewer-audio-control--${normalizedKind}`;
    root.dataset.viewerAudioControl = normalizedKind;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'viewer-header-icon-btn question-card__prompt-audio-btn viewer-audio-control__trigger';
    if (normalizedKind === 'option') trigger.classList.add('choice-audio-btn');
    root.appendChild(trigger);

    let menu = null;
    let menuButtons = [];
    let stopMenuPositioning = null;
    let activeSource = null;
    let isStarting = false;

    const getPlayLabel = (source) => {
      if (!source?.language) {
        return normalizedKind === 'option'
          ? t('viewer.audio.playOptionAudioAriaLabel')
          : t('viewer.audio.playQuestionAudioAriaLabel');
      }
      return normalizedKind === 'option'
        ? t('viewer.audio.playLanguageOptionAudioAriaLabel', { language: getViewerAudioLanguageLabel(source.language) })
        : t('viewer.audio.playLanguageQuestionAudioAriaLabel', { language: getViewerAudioLanguageLabel(source.language) });
    };

    const getStopLabel = (source) => {
      if (!source?.language) {
        return normalizedKind === 'option'
          ? t('viewer.audio.stopOptionAudioAriaLabel')
          : t('viewer.audio.stopQuestionAudioAriaLabel');
      }
      return normalizedKind === 'option'
        ? t('viewer.audio.stopLanguageOptionAudioAriaLabel', { language: getViewerAudioLanguageLabel(source.language) })
        : t('viewer.audio.stopLanguageQuestionAudioAriaLabel', { language: getViewerAudioLanguageLabel(source.language) });
    };

    const setMenuOpen = (open, { restoreFocus = false } = {}) => {
      if (!menu) return;
      stopMenuPositioning?.();
      stopMenuPositioning = null;
      menu.hidden = !open;
      if (open) stopMenuPositioning = positionViewerAudioMenu(root, menu, normalizedKind);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      root.classList.toggle('is-menu-open', open);
      if (!open && openViewerAudioMenu?.root === root) openViewerAudioMenu = null;
      if (restoreFocus) trigger.focus?.();
    };

    const setIdle = () => {
      if (signal?.aborted) return;
      activeSource = null;
      isStarting = false;
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      root.classList.remove('is-playing', 'is-starting');
      menuButtons.forEach((button) => { button.disabled = false; });
      if (hasMenu) {
        const label = normalizedKind === 'option'
          ? t('viewer.audio.chooseOptionAudioLanguageAriaLabel')
          : t('viewer.audio.chooseQuestionAudioLanguageAriaLabel');
        trigger.innerHTML = `${createIcon('audio')}<span class="viewer-audio-control__chevron">${createIcon('chevronDown')}</span>`;
        trigger.setAttribute('aria-label', label);
        trigger.title = label;
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', menu?.hidden === false ? 'true' : 'false');
      } else {
        const label = getPlayLabel(sources[0]);
        trigger.innerHTML = createIcon('audio');
        trigger.setAttribute('aria-label', label);
        trigger.title = label;
        trigger.removeAttribute('aria-haspopup');
        trigger.removeAttribute('aria-expanded');
      }
    };

    const setStarting = () => {
      isStarting = true;
      trigger.disabled = true;
      trigger.setAttribute('aria-busy', 'true');
      root.classList.add('is-starting');
      menuButtons.forEach((button) => { button.disabled = true; });
    };

    const setPlaying = (source) => {
      if (signal?.aborted) return;
      activeSource = source;
      isStarting = false;
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      root.classList.remove('is-starting');
      root.classList.add('is-playing');
      menuButtons.forEach((button) => { button.disabled = false; });
      trigger.innerHTML = createIcon('stop');
      const label = getStopLabel(source);
      trigger.setAttribute('aria-label', label);
      trigger.title = label;
      trigger.removeAttribute('aria-haspopup');
      trigger.removeAttribute('aria-expanded');
    };

    const playSource = async (source) => {
      if (signal?.aborted || !source || isStarting) return;
      closeOpenViewerAudioMenu();
      setMenuOpen(false);
      setStarting();
      if (typeof reportMediaFeedback === 'function') reportMediaFeedback('');
      const result = await session.playAssetAudio(source.assetId, {
        onStart: () => {
          setPlaying(source);
          if (typeof reportMediaFeedback === 'function') reportMediaFeedback('');
        },
        onEnded: setIdle,
        onError: setIdle,
        onInterrupted: setIdle,
      });
      if (signal?.aborted) return;
      if (!result?.ok) {
        setIdle();
        if (result?.reason !== 'superseded' && typeof reportMediaFeedback === 'function') {
          reportMediaFeedback(
            normalizedKind === 'option'
              ? t('viewer.audio.playOptionAudioFailed')
              : t('viewer.audio.unableToPlayQuestionAudio')
          );
        }
      }
    };

    if (hasMenu) {
      ensureViewerAudioMenuDismissListener();
      menu = document.createElement('div');
      menu.className = 'viewer-audio-control__menu';
      menu.hidden = true;
      menu.setAttribute('role', 'group');
      menu.setAttribute(
        'aria-label',
        normalizedKind === 'option'
          ? t('viewer.audio.chooseOptionAudioLanguageAriaLabel')
          : t('viewer.audio.chooseQuestionAudioLanguageAriaLabel')
      );
      menuButtons = sources.map((source) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'viewer-audio-control__menu-item';
        button.dataset.audioLanguage = source.language || '';
        const icon = document.createElement('span');
        icon.className = 'viewer-audio-control__menu-item-icon';
        icon.innerHTML = createIcon('audio');
        const label = document.createElement('span');
        label.textContent = getViewerAudioLanguageLabel(source.language);
        button.append(icon, label);
        button.setAttribute('aria-label', getPlayLabel(source));
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          playSource(source);
        }, { signal });
        menu.appendChild(button);
        return button;
      });
      root.appendChild(menu);
      root.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || menu.hidden) return;
        event.preventDefault();
        setMenuOpen(false, { restoreFocus: true });
      }, { signal });
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isStarting) return;
      if (activeSource) {
        session.stopActiveAudio?.('interrupted');
        return;
      }
      if (!hasMenu) {
        playSource(sources[0]);
        return;
      }
      const shouldOpen = menu.hidden;
      closeOpenViewerAudioMenu();
      setMenuOpen(shouldOpen);
      if (shouldOpen) {
        openViewerAudioMenu = {
          root,
          trigger,
          close: () => setMenuOpen(false),
        };
        menuButtons[0]?.focus?.({ preventScroll: true });
      }
    }, { signal });

    signal?.addEventListener('abort', () => {
      stopMenuPositioning?.();
      if (openViewerAudioMenu?.root === root) openViewerAudioMenu = null;
    }, { once: true });
    setIdle();
    return root;
  }

  return { createViewerAudioControl, closeOpenViewerAudioMenu };
}
