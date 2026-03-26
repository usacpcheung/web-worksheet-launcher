const AUTH_RETURN_PARAM = 'authReturn';

function nowIso() {
  return new Date().toISOString();
}

function buildReturnUrl(currentUrl, actionId) {
  const url = new URL(currentUrl.href);
  url.searchParams.set(AUTH_RETURN_PARAM, '1');
  url.searchParams.set('intent', actionId);
  return url.toString();
}

class SharedAuthGate {
  constructor(options) {
    this.options = {
      appArea: 'app',
      resumeFlagKey: '',
      storage: null,
      isAuthenticated: () => false,
      getCurrentLocalId: () => null,
      getCurrentUiState: () => ({}),
      persistLocalRecord: async () => {},
      restoreByLocalId: async () => true,
      restoreUiState: async () => {},
      validateIntent: async () => true,
      replayIntent: async () => {},
      onRecoveryMessage: () => {},
      redirectToAuth: null,
      ...options,
    };

    if (!this.options.storage?.pendingIntent || !this.options.storage?.resumeFlags) {
      throw new Error('SharedAuthGate requires storage.pendingIntent and storage.resumeFlags APIs.');
    }

    if (!this.options.resumeFlagKey) {
      throw new Error('SharedAuthGate requires a resumeFlagKey.');
    }
  }

  async runProtectedAction(intent) {
    if (this.options.isAuthenticated()) {
      await this.options.replayIntent(intent);
      return { status: 'executed' };
    }

    const localId = this.options.getCurrentLocalId();
    if (!localId) {
      this.options.onRecoveryMessage('Unable to start sign-in recovery because no local record is active.');
      return { status: 'blocked_no_local_id' };
    }

    await this.options.persistLocalRecord();

    const resume = {
      localId,
      store: intent.recordStore,
      ui: this.options.getCurrentUiState(),
      updatedAt: nowIso(),
    };

    this.options.storage.resumeFlags.set(this.options.resumeFlagKey, resume);
    this.options.storage.pendingIntent.set({
      appArea: this.options.appArea,
      actionId: intent.actionId,
      recordStore: intent.recordStore,
      localId,
      resumeFlagKey: this.options.resumeFlagKey,
      resumeUi: resume.ui,
      intentPayload: intent.payload || null,
      updatedAt: nowIso(),
    });

    const redirectTo = buildReturnUrl(new URL(window.location.href), intent.actionId);

    if (typeof this.options.redirectToAuth === 'function') {
      this.options.redirectToAuth({ redirectTo, intent });
    } else {
      window.location.assign(redirectTo);
    }

    return { status: 'redirected' };
  }

  async restoreAfterAuthReturn() {
    const url = new URL(window.location.href);
    const hasAuthReturnFlag = url.searchParams.get(AUTH_RETURN_PARAM) === '1';

    const pendingIntent = this.options.storage.pendingIntent.get();
    const resumeMetadata = this.options.storage.resumeFlags.get(this.options.resumeFlagKey);

    if (!hasAuthReturnFlag || !pendingIntent || pendingIntent.resumeFlagKey !== this.options.resumeFlagKey) {
      return { status: 'no_pending_intent' };
    }

    const localId = pendingIntent.localId || resumeMetadata?.localId || null;
    if (!localId) {
      this.options.onRecoveryMessage('Sign-in restore metadata was missing a local record reference. Your local data is still available.');
      this.clearPending();
      return { status: 'missing_local_id' };
    }

    const restored = await this.options.restoreByLocalId(localId);
    if (!restored) {
      this.options.onRecoveryMessage('Unable to reload your local record after sign-in. No data was deleted.');
      this.clearPending();
      return { status: 'restore_failed' };
    }

    await this.options.restoreUiState(pendingIntent.resumeUi || resumeMetadata?.ui || {});

    const intent = {
      actionId: pendingIntent.actionId,
      recordStore: pendingIntent.recordStore,
      payload: pendingIntent.intentPayload || null,
    };

    const stillValid = await this.options.validateIntent(intent);
    if (!stillValid) {
      this.options.onRecoveryMessage('We restored your local data, but the original protected action is no longer valid.');
      this.clearPending();
      return { status: 'intent_invalid' };
    }

    await this.options.replayIntent(intent);
    this.clearPending();

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete(AUTH_RETURN_PARAM);
    cleanUrl.searchParams.delete('intent');
    window.history.replaceState({}, '', cleanUrl.toString());

    return { status: 'replayed' };
  }

  clearPending() {
    this.options.storage.pendingIntent.clear();
  }
}

export { AUTH_RETURN_PARAM, SharedAuthGate };
