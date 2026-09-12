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
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };

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

  function play(src) {
    desiredSrc = src ?? null;
    if (!src) {
      stop();
      return;
    }
    if (suspended) {
      if (activeSrc !== src) stop({ preserveDesired: true });
      return;
    }
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
    teardown() { suspended = false; resumeWanted = false; stop(); listeners.clear(); },
    suspendForCapture() {
      if (suspended) return;
      resumeWanted = Boolean(activeAudio && !activeAudio.paused && !muted && !playbackBlocked);
      suspended = true;
      playbackGeneration += 1;
      activeAudio?.pause();
    },
    resumeAfterCapture() {
      if (!suspended) return;
      suspended = false;
      const resume = resumeWanted; resumeWanted = false;
      if (resume && !muted && desiredSrc) play(desiredSrc);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isPlaybackBlocked: () => playbackBlocked,
    setVolume,
    setMuted,
    getCurrentSource,
    enterDuckedState,
    exitDuckedState,
    isDucked: () => ducked,
    getPreferredVolume: () => preferredVolume,
  };
}
