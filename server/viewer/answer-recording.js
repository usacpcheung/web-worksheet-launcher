// Dormant, single-use recording session. No document listeners or persisted audio.
export const MAX_RECORDING_MS = 60_000;
export const RECORDING_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus',
]);

export function selectRecordingMimeType(Recorder = globalThis.MediaRecorder) {
  return RECORDING_MIME_TYPES.find((type) => {
    try { return Recorder?.isTypeSupported?.(type) === true; } catch { return false; }
  }) || '';
}

export function supportsAnswerRecording({ mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder } = {}) {
  return typeof mediaDevices?.getUserMedia === 'function' && typeof Recorder === 'function';
}

const messages = {
  PERMISSION_DENIED: 'Microphone permission was denied.',
  DEVICE_UNAVAILABLE: 'No available microphone was found.',
  RECORDING_UNSUPPORTED: 'Audio recording is not supported.',
  RECORDER_ERROR: 'Audio recording failed.',
  EMPTY_RECORDING: 'The recording contains no audio.',
  CANCELED: 'Recording was canceled.',
};
const failure = (code) => ({ ok: false, error: { code, message: messages[code] } });

/**
 * start() resolves when recording begins (or with a structured failure).
 * result and stop() resolve with {ok:true, data:{audioBlob,durationSeconds}}
 * or {ok:false,error:{code,message}}. Cancel/teardown discard audio. Stop while
 * permission is pending cancels. Create a new session for each recording.
 * Timers may be throttled by browsers: the backend's decoded limit is authoritative.
 */
export function createAnswerRecording({
  mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let state = 'idle';
  let stream, recorder, timer, startPromise, startedAt, stoppedAt, terminal;
  let chunks = [];
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const stopTracks = (value) => {
    for (const track of value?.getTracks() || []) {
      try { track.stop(); } catch { /* Continue cleaning up the remaining tracks. */ }
    }
  };
  const releaseTracks = () => { stopTracks(stream); stream = null; };
  const elapsed = () => startedAt === undefined ? 0 : Math.max(0, (stoppedAt ?? now()) - startedAt);
  const finish = (value) => {
    if (terminal) return terminal;
    terminal = value;
    stoppedAt ??= now();
    state = 'finished';
    clearTimer(timer);
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Tracks still close. */ }
    }
    releaseTracks();
    chunks = [];
    resolveResult(value);
    return value;
  };
  function stop() {
    if (terminal || state === 'stopping') return result;
    if (state !== 'recording') { finish(failure('CANCELED')); return result; }
    state = 'stopping';
    stoppedAt = now();
    clearTimer(timer);
    try { recorder.stop(); } catch { finish(failure('RECORDER_ERROR')); }
    // stop() queues final dataavailable followed by stop; retain handlers until then.
    releaseTracks();
    return result;
  }
  const deadline = () => {
    if (state !== 'recording') return;
    const remaining = MAX_RECORDING_MS - elapsed();
    if (remaining <= 0) stop();
    else timer = setTimer(deadline, remaining);
  };
  function start() {
    if (startPromise) return startPromise;
    if (terminal) return Promise.resolve(terminal);
    startPromise = (async () => {
      if (!supportsAnswerRecording({ mediaDevices, Recorder })) return finish(failure('RECORDING_UNSUPPORTED'));
      state = 'acquiring';
      try {
        const acquired = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (terminal) { stopTracks(acquired); return terminal; }
        stream = acquired;
      } catch (error) {
        const code = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)
          ? 'PERMISSION_DENIED'
          : ['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'AbortError'].includes(error?.name)
            ? 'DEVICE_UNAVAILABLE' : 'RECORDER_ERROR';
        return terminal || finish(failure(code));
      }
      try {
        const mimeType = selectRecordingMimeType(Recorder);
        recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
      } catch { return finish(failure('RECORDING_UNSUPPORTED')); }
      recorder.ondataavailable = (event) => {
        if (!terminal && event.data?.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => finish(failure('RECORDER_ERROR'));
      recorder.onstop = () => {
        stoppedAt ??= now();
        const type = chunks.find((chunk) => chunk.type)?.type || recorder.mimeType || '';
        const audioBlob = new Blob(chunks, { type });
        finish(audioBlob.size ? { ok: true, data: { audioBlob, durationSeconds: elapsed() / 1000 } }
          : failure('EMPTY_RECORDING'));
      };
      try {
        startedAt = now();
        state = 'recording';
        recorder.start();
        if (terminal) return terminal;
        deadline();
        return { ok: true };
      } catch { return finish(failure('RECORDER_ERROR')); }
    })();
    return startPromise;
  }
  const cancel = () => { finish(failure('CANCELED')); return result; };
  return { start, stop, cancel, teardown: cancel, result,
    get state() { return state; }, get elapsedSeconds() { return elapsed() / 1000; } };
}
