import { assertFeedbackResponses } from '../app/worksheet-feedback.js';
import { recordStamp, assetStamp } from '../app/storage/local-data-cleanup.js';
import { withAttemptLock, holdAttempt, protectedAttempts, reserveAttempt, retireAttempt, readLocalJson, writeLocalJson, RETIRED_KEY } from '../app/storage/attempt-activity.js';
import { promptForReadSignIn } from '../app/auth/read-auth-prompt.js';
import { t } from '../app/i18n/index.js';
import { attemptDialog } from './attempt-menu.js';

export const NORMAL_RESUME_KEY = 'viewer:lastSession';
export const isPreviewAttempt = record => record?.runtimeMode === 'preview' || record?.sourceType === 'local_draft_preview';
export const openingCancelled = () => Object.assign(new Error(t('attemptLifecycle.cancelled')), { code: 'ATTEMPT_OPEN_CANCELLED', cancelled: true });
const changed = () => Object.assign(new Error('The local attempt changed.'), { code: 'ATTEMPT_REPLACEMENT_CHANGED' });
const confirm = description => attemptDialog({ title: t('attemptLifecycle.replaceTitle'), description,
  confirmLabel: t('attemptLifecycle.replace'), cancelLabel: t('common.actions.cancel') });

export class AttemptLifecycle {
  constructor(session, { confirmReplacement = confirm, loginPrompt = promptForReadSignIn } = {}) {
    this.session = session;
    this.storage = session.storage;
    this.confirm = confirmReplacement;
    this.loginPrompt = loginPrompt;
    this.consent = null;
    this.release = null;
    this.activeId = null;
    this.mode = 'normal';
    this.revision = null; this.disposed = false;
    globalThis.window?.addEventListener?.('pagehide', () => {
      this.disposed = true;
      // Keep auth-return/reload work recoverable while the document is absent.
      try { reserveAttempt(this.activeId); } catch { /* Current attempt is also protected by Resume. */ }
      this.release?.(); this.release = null;
    });
    globalThis.window?.addEventListener?.('pageshow', event => {
      if (event.persisted && this.activeId) { this.disposed = false; void this.attach(this.activeRecord).catch(() => {}); }
    });
  }
  async snapshot() {
    const flag = this.storage.resumeFlags.get(NORMAL_RESUME_KEY);
    const record = flag?.localId ? await this.storage.attempts.get(flag.localId) : null;
    if (!record || isPreviewAttempt(record)) return { id: null, stamp: 'null' };
    return { id: record.localId, stamp: recordStamp(record), edit: readLocalJson(`worksheetLauncher:attemptEdit:${record.localId}`, null) };
  }
  async flush() {
    if (this.session.state.localAttemptId) {
      do { await this.session.flushLocalStateForAuthRedirect(); }
      while (this.session.state.lastSavedRevision < this.session.state.attemptRevision);
    }
  }
  async promptLogin(options) {
    if (!['publication', 'attempt'].includes(options.intent?.kind) || this.mode === 'preview') return this.loginPrompt(options);
    await this.flush();
    const before = await this.snapshot();
    const accepted = await this.loginPrompt({ ...options, warningText: before.id ? t('attemptLifecycle.warning') : '' });
    if (accepted) this.consent = { snapshot: before, key: `${options.intent.kind}:${options.intent.id}` };
    return accepted;
  }
  async permission(isCurrent, key) {
    await this.flush();
    const before = await this.snapshot();
    if (!isCurrent()) throw openingCancelled();
    if (before.id && (this.consent?.key !== key || recordStamp(this.consent?.snapshot) !== recordStamp(before))) {
      if (!await this.confirm(t('attemptLifecycle.warning')) || !isCurrent()) throw openingCancelled();
    }
    this.consent = { snapshot: before, key };
    return before;
  }
  async replace(record, { isCurrent = () => !this.disposed, preview = false, replacementKey = `local:${Math.random()}` } = {}) {
    assertFeedbackResponses(record.viewerPayload?.feedback, record.feedback, record.status);
    record.runtimeMode = preview ? 'preview' : 'normal';
    const previousPreview = this.mode === 'preview' ? this.activeId : null;
    let release;
    for (;;) {
      const expected = preview ? null : await this.permission(isCurrent, replacementKey);
      try {
        await withAttemptLock(async () => {
          if (!isCurrent()) throw openingCancelled();
          const current = preview ? null : await this.snapshot();
          if (!preview && recordStamp(current) !== recordStamp(expected)) throw changed();
          release = await holdAttempt(record.localId);
          try {
            await this.storage.attempts.put(record);
            if (!isCurrent()) throw openingCancelled();
            // Recheck after persistence: another tab may have autosaved A.
            if (!preview && recordStamp(await this.snapshot()) !== recordStamp(expected)) throw changed();
            if (!preview) {
              if (expected.id) retireAttempt(expected.id);
              this.storage.resumeFlags.set(NORMAL_RESUME_KEY, this.flag(record));
            }
          } catch (error) {
            release(); release = null;
            if (error.code !== 'ATTEMPT_REPLACEMENT_CHANGED') await this.storage.attempts.remove(record.localId).catch(() => {});
            throw error;
          }
        });
        break;
      } catch (error) {
        if (error.code !== 'ATTEMPT_REPLACEMENT_CHANGED') throw error;
        this.consent = null;
      }
    }
    this.release?.(); this.release = release;
    this.activeId = record.localId; this.activeRecord = record;
    this.mode = preview ? 'preview' : 'normal';
    this.session.state.runtimeMode = this.mode;
    this.consent = null;
    // Bookkeeping is best-effort after commitment; it must not trigger staging rollback.
    try {
      if (previousPreview) retireAttempt(previousPreview);
      if (preview) retireAttempt(record.localId);
    } catch { /* The start-screen cleanup can still find unreferenced sessions. */ }
    this.remember(record);
    // A cleanup error must never roll back an already committed replacement.
    await this.cleanupRetired().catch(() => {});
    return record;
  }
  flag(record) {
    return { localId: record.localId, store: 'localAttempts', status: record.status,
      worksheetId: record.viewerPayload?.worksheetId || null, snapshotId: record.viewerPayload?.snapshotId || null,
      updatedAt: record.metadata?.updatedAt || new Date().toISOString() };
  }
  async attach(record) {
    await withAttemptLock(async () => {
      if (!await this.storage.attempts.get(record.localId)) throw openingCancelled();
      const release = await holdAttempt(record.localId);
      this.release?.(); this.release = release;
      this.activeId = record.localId; this.activeRecord = record;
      this.mode = isPreviewAttempt(record) ? 'preview' : 'normal';
      if (this.mode === 'normal' && !this.storage.resumeFlags.get(NORMAL_RESUME_KEY)?.localId) this.storage.resumeFlags.set(NORMAL_RESUME_KEY, this.flag(record));
      this.session.state.runtimeMode = this.mode;
    });
    this.remember(record);
  }
  remember(record) {
    if (!globalThis.history?.replaceState) return;
    try { history.replaceState({ ...history.state, worksheetAttempt: record.localId }, '', location.href); }
    catch { /* A history API failure must not undo a saved attempt. */ }
  }
  updateResume() {
    const { localAttemptId: id, attemptRevision: revision } = this.session.state;
    if (!id || this.mode === 'preview' || this.session.state.lastSavedRevision >= revision) return;
    const signature = `${id}:${revision}`;
    if (signature === this.revision) return;
    this.revision = signature;
    // An edit signal includes work not yet flushed by the one-second autosave.
    // It does not change the selected Resume target.
    try { writeLocalJson(`worksheetLauncher:attemptEdit:${id}`, `${Date.now()}:${Math.random()}`); }
    catch { /* Saving still reports storage failures; do not interrupt answer entry. */ }
  }
  async restoreHistory() {
    const navigation = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type;
    if (!['reload', 'back_forward'].includes(navigation)) return false;
    const id = globalThis.history?.state?.worksheetAttempt;
    return id ? this.session.tryResumeAttempt(id) : false;
  }
  async cleanupRetired() {
    const ids = readLocalJson(RETIRED_KEY, []);
    if (!ids.length) return;
    await this.collect({ automatic: true, ids });
  }
  async collect({ automatic = false, ids = null, apply = true, selection } = {}) {
    if (!this.storage.localCleanup) return null;
    return withAttemptLock(async () => {
      const protectedIds = await protectedAttempts();
      if (protectedIds === null) return { unavailable: true, attempts: [], assets: [], worksheets: [], bytes: 0 };
      const currentId = this.storage.resumeFlags.get(NORMAL_RESUME_KEY)?.localId;
      const attempts = await this.storage.attempts.list();
      const candidates = selection?.candidates || Object.fromEntries(attempts.filter(a => !ids || ids.includes(a.localId)).map(a => [a.localId, recordStamp(a)]));
      const options = { candidates, currentId, protectedIds, orphanCutoff: selection?.orphanCutoff ?? (automatic ? 0 : Date.now() - 60 * 60_000),
        approvedAssets: selection?.approvedAssets, approvedWorksheets: selection?.approvedWorksheets };
      const result = await this.storage.localCleanup[apply ? 'collect' : 'inspect'](options);
      if (apply) {
        const removed = new Set(result.attempts.map(a => a.localId));
        writeLocalJson(RETIRED_KEY, readLocalJson(RETIRED_KEY, []).filter(id => !removed.has(id)));
        for (const id of removed) globalThis.localStorage?.removeItem(`worksheetLauncher:attemptEdit:${id}`);
      }
      return { ...result, selection: { candidates: Object.fromEntries(result.attempts.map(a => [a.localId, recordStamp(a)])),
        approvedWorksheets: Object.fromEntries(result.worksheets.map(w => [w.localId, recordStamp(w)])),
        approvedAssets: Object.fromEntries(result.assets.map(a => [a.localId, assetStamp(a)])), orphanCutoff: options.orphanCutoff } };
    });
  }
  authStorage() {
    return { ...this.storage, resumeFlags: { ...this.storage.resumeFlags, set: (key, value) => {
      this.reserveForAuth();
      if (this.mode !== 'preview' && this.storage.resumeFlags.get(key)?.localId === value.localId) this.storage.resumeFlags.set(key, value);
    } } };
  }
  reserveForAuth(intent) {
    reserveAttempt(this.activeId || this.storage.resumeFlags.get(NORMAL_RESUME_KEY)?.localId, 15 * 60_000);
    if (intent && this.consent) sessionStorage.setItem('worksheetLauncher:replacementConsent', JSON.stringify({ intent, consent: this.consent, at: Date.now() }));
  }
  restoreConsent(readReturn) {
    if (!readReturn) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem('worksheetLauncher:replacementConsent') || 'null');
      sessionStorage.removeItem('worksheetLauncher:replacementConsent');
      if (saved && Date.now() - saved.at < 15 * 60_000 && saved.intent.kind === readReturn.readIntent?.kind
        && saved.intent.id === readReturn.readIntent?.id) this.consent = saved.consent;
    } catch { /* No matching confirmation: ask again before replacing. */ }
  }
  async discard(id) {
    await withAttemptLock(async () => {
      retireAttempt(id);
      if (this.storage.resumeFlags.get(NORMAL_RESUME_KEY)?.localId === id) this.storage.resumeFlags.clear(NORMAL_RESUME_KEY);
    });
    await this.cleanupRetired();
  }
  clearConsent(key) { if (this.consent?.key === key) this.consent = null; }
  async restartPreview() {
    const originalId = this.activeId;
    const isCurrent = () => this.mode === 'preview' && this.activeId === originalId && !this.disposed;
    if (this.mode !== 'preview') return false;
    if (!await attemptDialog({ title: t('attemptLifecycle.restart'), description: t('attemptLifecycle.restartHelp'),
      confirmLabel: t('attemptLifecycle.restart'), cancelLabel: t('common.actions.cancel'), isCurrent })) return false;
    const old = this.activeRecord;
    const record = this.session.createLocalAttemptState(structuredClone(this.session.state.viewerPayload), 'local_draft_preview', { sourceLocalDraftId: old.sourceLocalDraftId });
    await this.replace(record, { preview: true, isCurrent });
    this.session.applyAttemptState(record, { markDirty: false });
    return true;
  }
}
