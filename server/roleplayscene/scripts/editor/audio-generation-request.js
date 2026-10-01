// Bound each network wait, including the session probe. No automatic retries:
// the server may have processed a request even when its response is lost.
export const AUDIO_REQUEST_TIMEOUT_MS = 120000;

export function waitForAudioRequest(operation, controller, timeoutMs = AUDIO_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const { signal } = controller;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => { cleanup(); callback(value); };
    const onAbort = () => finish(reject, signal.reason || new Error('Audio request cancelled'));
    // Attach handlers even after cancellation so a late rejection is consumed.
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(Object.assign(new Error('Audio request timed out'), { code: 'AUDIO_TIMEOUT' })), timeoutMs);
  });
}
