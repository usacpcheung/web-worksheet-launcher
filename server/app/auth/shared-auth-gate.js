const AUTH_RETURN_PARAM = 'authReturn';

function nowIso() {
  return new Date().toISOString();
}

function cloneIntentPayload(payload) {
  if (payload == null) return null;
  if (typeof structuredClone === 'function') {
    return structuredClone(payload);
  }
  return JSON.parse(JSON.stringify(payload));
}

function buildReturnUrl(currentUrl, returnQueryParams = null) {
  const url = new URL(currentUrl.href);
  url.searchParams.set(AUTH_RETURN_PARAM, '1');
  if (returnQueryParams && typeof returnQueryParams === 'object') {
    Object.entries(returnQueryParams).forEach(([key, value]) => {
      if (!key) return;
      if (value === null || value === undefined || value === '') {
        url.searchParams.delete(String(key));
        return;
      }
      url.searchParams.set(String(key), String(value));
    });
  }
  return url.toString();
}

function getReturnQueryParamKeys(returnQueryParams = null) {
  if (!returnQueryParams || typeof returnQueryParams !== 'object') {
    return [];
  }
  return Object.keys(returnQueryParams).map((key) => String(key)).filter(Boolean);
}

function cleanupAuthReturnUrlParams(returnQueryParams = null) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete(AUTH_RETURN_PARAM);
  cleanUrl.searchParams.delete('intent');
  getReturnQueryParamKeys(returnQueryParams).forEach((key) => {
    cleanUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, '', cleanUrl.toString());
}

function toUpperCode(value) {
  return String(value || '').toUpperCase();
}

function isAuthLikeErrorCandidate(candidate) {
  const status = Number(candidate?.status);
  const code = toUpperCode(candidate?.code);
  return Boolean(
    candidate?.requiresSignIn
    || status === 401
    || status === 403
    || code === 'AUTH_REQUIRED'
  );
}

function normalizeSessionCheckResult(rawResult) {
  if (rawResult === true) return { ready: true, authNotReady: false, rawResult };
  if (rawResult === false || rawResult == null) return { ready: false, authNotReady: true, rawResult };
  if (typeof rawResult !== 'object') return { ready: false, authNotReady: true, rawResult };

  if (rawResult.ok === true) {
    return { ready: true, authNotReady: false, rawResult };
  }

  const directAuthLike = isAuthLikeErrorCandidate(rawResult);
  const nestedResult = rawResult.result && typeof rawResult.result === 'object' ? rawResult.result : null;
  const nestedError = rawResult.error && typeof rawResult.error === 'object' ? rawResult.error : null;
  const nestedAuthLike = isAuthLikeErrorCandidate(nestedResult?.error)
    || isAuthLikeErrorCandidate(nestedResult)
    || isAuthLikeErrorCandidate(nestedError);
  const nestedNotReady = rawResult.status === 'not_ready' || nestedResult?.status === 'not_ready';
  const authNotReady = directAuthLike || nestedAuthLike || nestedNotReady;
  return { ready: false, authNotReady, rawResult };
}

class SharedAuthGate {
  constructor(options) {
    this.options = {
      appArea: 'app',
      resumeFlagKey: '',
      storage: null,
      checkSessionReady: null,
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
      returnQueryParams: null,
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
    if (!intent || !intent.actionId || !intent.recordStore) {
      return { status: 'invalid_intent' };
    }

    let authState;
    if (typeof this.options.checkSessionReady === 'function') {
      const checkResult = await this.options.checkSessionReady(intent);
      authState = normalizeSessionCheckResult(checkResult);
    } else {
      authState = {
        ready: Boolean(this.options.isAuthenticated()),
        authNotReady: true,
        rawResult: null,
      };
    }

    if (authState.ready) {
      await this.options.replayIntent(intent);
      return { status: 'executed' };
    }
    if (!authState.authNotReady) {
      return { status: 'blocked_session_probe', result: authState.rawResult };
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
      intentPayload: cloneIntentPayload(intent.payload),
      updatedAt: nowIso(),
    });

    const redirectTo = buildReturnUrl(new URL(window.location.href), this.options.returnQueryParams);

    if (typeof this.options.redirectToAuth === 'function') {
      this.options.redirectToAuth({ redirectTo, intent });
    } else {
      window.location.assign(redirectTo);
    }

    return { status: 'redirected' };
  }

  async restoreAfterAuthReturn(restoreOptions = {}) {
    const preserveUrlOnAuthNotReady = restoreOptions?.preserveUrlOnAuthNotReady === true;
    const preservePendingOnAuthNotReady = restoreOptions?.preservePendingOnAuthNotReady !== false;
    const url = new URL(window.location.href);
    const hasAuthReturnFlag = url.searchParams.get(AUTH_RETURN_PARAM) === '1';

    const pendingIntent = this.options.storage.pendingIntent.get();
    const resumeMetadata = this.options.storage.resumeFlags.get(this.options.resumeFlagKey);

    if (!hasAuthReturnFlag || !pendingIntent || pendingIntent.resumeFlagKey !== this.options.resumeFlagKey) {
      return { status: 'no_pending_intent' };
    }

    let authState;
    if (typeof this.options.checkSessionReady === 'function') {
      try {
        authState = normalizeSessionCheckResult(await this.options.checkSessionReady({
          actionId: pendingIntent?.actionId || '',
          recordStore: pendingIntent?.recordStore || '',
          payload: pendingIntent?.intentPayload || null,
        }));
      } catch (error) {
        authState = normalizeSessionCheckResult({
          ok: false,
          result: {
            status: 'error',
            error: {
              code: 'SESSION_PROBE_ERROR',
              message: error?.message || String(error),
            },
          },
        });
      }
    } else {
      authState = {
        ready: Boolean(this.options.isAuthenticated()),
        authNotReady: true,
        rawResult: null,
      };
    }
    if (!authState.ready) {
      if (!authState.authNotReady) {
        this.options.onRecoveryMessage('Unable to verify sign-in due to a temporary session check issue. Please retry when the connection is stable.');
        return { status: 'blocked_session_probe', result: authState.rawResult };
      }
      this.options.onRecoveryMessage('You are not signed in yet. Please complete sign-in and try again.');
      if (!preservePendingOnAuthNotReady) {
        this.clearPending();
      }
      if (!preserveUrlOnAuthNotReady) {
        cleanupAuthReturnUrlParams(this.options.returnQueryParams);
      }
      return { status: 'not_authenticated' };
    }

    const localId = pendingIntent.localId || resumeMetadata?.localId || null;
    if (!localId) {
      this.options.onRecoveryMessage('Sign-in restore metadata was missing a local record reference. Your local data is still available.');
      this.clearPending();
      cleanupAuthReturnUrlParams(this.options.returnQueryParams);
      return { status: 'missing_local_id' };
    }

    const restored = await this.options.restoreByLocalId(localId);
    if (!restored) {
      this.options.onRecoveryMessage('Unable to reload your local record after sign-in. No data was deleted.');
      this.clearPending();
      cleanupAuthReturnUrlParams(this.options.returnQueryParams);
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
      cleanupAuthReturnUrlParams(this.options.returnQueryParams);
      return { status: 'intent_invalid' };
    }

    await this.options.replayIntent(intent);
    this.clearPending();
    cleanupAuthReturnUrlParams(this.options.returnQueryParams);

    return { status: 'replayed' };
  }

  clearPending() {
    this.options.storage.pendingIntent.clear();
  }
}

export { AUTH_RETURN_PARAM, SharedAuthGate };
