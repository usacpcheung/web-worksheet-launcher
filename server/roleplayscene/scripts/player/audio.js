export function ensureAudioGate(store) {
  if (!store.get().audioGate) store.set({ audioGate: true });
}

const DUCKED_VOLUME = 0.05;

function clampVolume(value, fallback = 0.4) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

export function createBackgroundAudioController({ defaultVolume = 0.4 } = {}) {
  let activeAudio = null;
  let activeSrc = null;
  let desiredSrc = null;
  let preferredVolume = clampVolume(defaultVolume);
  let muted = false;
  let ducked = false;
  let suspended = false;
  let resumeWanted = false;
  let playbackBlocked = false;
  let playbackGeneration = 0;
  let interrupted = false;
  let removeAudioListeners = () => {};
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const refreshPlayback = () => {
    // Browser history restoration can pause media without changing our preference.
    // Latch that interruption so ordinary scene redraws cannot restart it.
    if (!suspended && activeAudio) interrupted = Boolean(activeAudio.paused || activeAudio.ended);
    notify();
  };
  const lifecycleTarget = typeof window === 'undefined' ? null : window;
  const leavePage = () => {
    interrupted = true;
    resumeWanted = false;
    playbackGeneration += 1;
    activeAudio?.pause();
    notify();
  };
  lifecycleTarget?.addEventListener?.('pageshow', refreshPlayback);
  lifecycleTarget?.addEventListener?.('pagehide', leavePage);

  const getEffectiveVolume = () => {
    if (muted) {
      return 0;
    }
    if (ducked) {
      return Math.min(preferredVolume, DUCKED_VOLUME);
    }
    return preferredVolume;
  };

  function applyAudioSettings(audio) {
    if (!audio) return;
    try {
      audio.volume = getEffectiveVolume();
    } catch (err) {
      console.warn('Failed to apply background audio volume', err);
    }
  }

  function stop({ preserveDesired = false } = {}) {
    playbackGeneration += 1;
    removeAudioListeners();
    removeAudioListeners = () => {};
    if (!preserveDesired) {
      desiredSrc = null;
    }
    if (!activeAudio) {
      activeSrc = null;
      return;
    }
    try {
      if (typeof activeAudio.pause === 'function') {
        activeAudio.pause();
      }
    } catch (err) {
      console.warn('Failed to pause background audio', err);
    }
    try {
      activeAudio.currentTime = 0;
    } catch (err) {
      // ignore inability to reset currentTime
    }
    activeAudio = null;
    activeSrc = null;
  }

  function play(src, { userInitiated = false } = {}) {
    if (userInitiated) interrupted = false;
    desiredSrc = src ?? null;
    if (!src) {
      stop();
      return;
    }
    if (suspended) {
      if (activeSrc !== src) stop({ preserveDesired: true });
      return;
    }
    if (interrupted) return;
    if (muted) {
      stop({ preserveDesired: true });
      return;
    }
    if (activeSrc === src && activeAudio) {
      if (activeAudio.paused && typeof activeAudio.play === 'function') {
        const audioAtResume = activeAudio;
        const generation = ++playbackGeneration;
        playbackBlocked = false;
        try {
          const attempt = activeAudio.play();
          if (attempt?.catch) {
            attempt.catch(() => {
              if (activeAudio !== audioAtResume || playbackGeneration !== generation) return;
              playbackBlocked = true;
              notify();
            });
          }
        } catch (err) {
          console.warn('Background audio resume failed', err);
          playbackBlocked = true;
          notify();
        }
      }
      return;
    }

    stop({ preserveDesired: true });

    const audio = new Audio(src);
    playbackBlocked = false;
    audio.loop = true;
    applyAudioSettings(audio);

    activeAudio = audio;
    activeSrc = src;
    const syncAudio = () => { if (activeAudio === audio) refreshPlayback(); };
    for (const event of ['pause', 'playing', 'ended']) audio.addEventListener?.(event, syncAudio);
    removeAudioListeners = () => {
      for (const event of ['pause', 'playing', 'ended']) audio.removeEventListener?.(event, syncAudio);
    };
    const generation = ++playbackGeneration;

    try {
      const playAttempt = audio.play();
      if (playAttempt?.catch) {
        playAttempt.catch((err) => {
          console.warn('Background audio playback failed', err);
          if (activeAudio === audio && playbackGeneration === generation) {
            stop({ preserveDesired: true });
            playbackBlocked = true;
            notify();
          }
        });
      }
    } catch (err) {
      console.warn('Background audio playback failed', err);
      if (activeAudio === audio) {
        stop({ preserveDesired: true });
        playbackBlocked = true;
        notify();
      }
    }
  }

  function setVolume(nextVolume) {
    preferredVolume = clampVolume(nextVolume, preferredVolume);
    if (!muted && !ducked) {
      applyAudioSettings(activeAudio);
    }
  }

  function setMuted(nextMuted, { userInitiated = false } = {}) {
    const desiredMuted = Boolean(nextMuted);
    if (suspended && userInitiated) resumeWanted = !desiredMuted;
    if (desiredMuted === muted) {
      return;
    }
    muted = desiredMuted;
    if (muted) {
      stop({ preserveDesired: true });
      return;
    }
    if (desiredSrc) {
      play(desiredSrc);
    }
  }

  function enterDuckedState() {
    if (ducked) {
      return;
    }
    ducked = true;
    applyAudioSettings(activeAudio);
  }

  function exitDuckedState() {
    if (!ducked) {
      return;
    }
    ducked = false;
    if (!muted) {
      applyAudioSettings(activeAudio);
    }
  }

  function getCurrentSource() {
    return activeSrc;
  }

  return {
    play,
    stop,
    teardown() {
      lifecycleTarget?.removeEventListener?.('pageshow', refreshPlayback);
      lifecycleTarget?.removeEventListener?.('pagehide', leavePage);
      suspended = false; resumeWanted = false; stop(); listeners.clear();
    },
    suspendForCapture() {
      if (suspended) return;
      resumeWanted = Boolean(activeAudio && !activeAudio.paused && !muted && !playbackBlocked && !interrupted);
      suspended = true;
      playbackGeneration += 1;
      activeAudio?.pause();
      notify();
    },
    resumeAfterCapture() {
      if (!suspended) return;
      suspended = false;
      const resume = resumeWanted; resumeWanted = false;
      if (resume && !muted && desiredSrc) play(desiredSrc);
      notify();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isPlaybackBlocked: () => playbackBlocked || interrupted,
    isSuspended: () => suspended,
    setVolume,
    setMuted,
    getCurrentSource,
    enterDuckedState,
    exitDuckedState,
    isDucked: () => ducked,
    getPreferredVolume: () => preferredVolume,
  };
}
