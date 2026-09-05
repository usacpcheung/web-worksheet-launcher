(() => {
  try {
    if (new URLSearchParams(globalThis.location?.search || '').get('publishedSceneId')?.trim()) {
      document.documentElement.classList.add('direct-launch-pending');
    }
  } catch {
    // The main module handles malformed URLs through its normal startup path.
  }
})();
