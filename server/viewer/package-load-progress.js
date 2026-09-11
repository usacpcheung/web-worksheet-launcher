// UI-only progress; never persisted in an attempt or package.
export class PackageLoadProgress {
  current = null;
  listeners = new Set();
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of this.listeners) {
      try { listener(this.current); } catch { /* Feedback must not interrupt loading. */ }
    }
  }
  start(id) {
    const token = { id, stage: 'checking', percent: null };
    this.current = token;
    this.emit();
    return token;
  }
  update(token, stage, progress) {
    if (this.current !== token) return;
    token.stage = stage;
    token.percent = null;
    if (progress?.lengthComputable && Number.isSafeInteger(progress.total) && progress.total > 0
      && Number.isFinite(progress.loaded) && progress.loaded >= 0 && progress.loaded <= progress.total) {
      token.percent = Math.floor(progress.loaded / progress.total * 100);
    }
    this.emit();
  }
  finish(token) {
    if (this.current !== token) return;
    this.current = null;
    this.emit();
  }
}

export function packageLoadLabel(progress, t, { announce = false } = {}) {
  if (!progress) return '';
  const key = progress.stage === 'downloading' && progress.percent !== null && !announce
    ? 'downloadingPercent' : progress.stage;
  return t(`viewer.packageLoad.${key}`, { percent: progress.percent });
}
