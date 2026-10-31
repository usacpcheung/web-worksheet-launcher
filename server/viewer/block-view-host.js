// A presentation host only: disposing a card must not cancel its answer operation.
// The shell still decides which block to show and owns navigation side effects.
export function createBlockViewHost({ container, createView, beforeReplace, signal }) {
  let current = null;
  let disposed = false;

  const clear = () => {
    const previous = current;
    current = null;
    previous?.view.dispose();
    container.replaceChildren();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    clear();
  };
  if (signal?.aborted) dispose();
  else signal?.addEventListener('abort', dispose, { once: true });

  return {
    update(block, presentation) {
      if (disposed || signal?.aborted) return;
      if (!current || current.blockId !== block?.blockId || current.signature !== presentation.signature) {
        beforeReplace();
        clear();
        if (!block) return;
        const view = createView(block, presentation);
        current = { blockId: block.blockId, signature: presentation.signature, view };
        container.replaceChildren(view.element);
      }
      current?.view.update();
    },
    dispose,
  };
}

// UI resources have a shorter lifetime than session-owned transcription/rewrite.
export function createBlockViewScope() {
  const controller = new AbortController();
  const urls = new Set();
  return {
    signal: controller.signal,
    createObjectURL(blob) {
      if (controller.signal.aborted) return null;
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return url;
    },
    releaseObjectURL(url) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    dispose() {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
