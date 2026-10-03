// Bound both headers and body consumption, even if a transport ignores abort.
export function waitForDraftRequest(request, controller, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const { signal } = controller;
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    Promise.resolve(request).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(Object.assign(new Error('Draft download timed out'), {
      code: 'DRAFT_TIMEOUT',
    })), timeoutMs);
  });
}
