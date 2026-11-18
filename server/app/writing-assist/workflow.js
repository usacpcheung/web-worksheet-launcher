// Loaded only on first use. All imports refer to the existing same-origin release.
import { createVoiceWorkflow } from '../../viewer/answer-voice-workflow.js';
import { requestVoiceSignIn } from '../../viewer/voice-sign-in.js';
import { createServerApiClient } from '../api/server-api-client.js';
import { createReadAuthFlow } from '../auth/read-auth-flow.js';
import { startAuthPopupFlow } from '../auth/auth-popup-flow.js';
import { probeSession } from '../auth/session-readiness.js';
import { setLocale, t } from '../i18n/index.js';

export function createLessonWorkflow(fields, render) {
  setLocale(document.documentElement.lang, { persist: false });
  const api = createServerApiClient();
  const page = {};
  const state = { localAttemptId: crypto.randomUUID(), viewerPayload: page, voiceRecovery: Object.create(null) };
  let subject = null;
  let popup = null;

  const auth = createReadAuthFlow({
    subject: () => subject,
    async probe({ isCurrent }) {
      const result = await probeSession({ apiClient: api, force: true, timeoutMs: 10000 });
      if (!isCurrent()) return { ok: false, skipped: true, status: 'superseded' };
      if (result.ok && !result.user?.sub) return { ok: false, error: { code: 'SESSION_PROBE_FAILED' } };
      if (result.ok) subject = result.user.sub;
      return result;
    },
    invalidate(reason) {
      if (reason === 'signed_out') subject = null;
      if (reason !== 'account_changed') return;
      voice.cancel({ discard: true });
      for (const field of fields.values()) {
        voice.discard(field.input.id);
        field.undo = null;
      }
    },
  });

  const editable = id => {
    const field = fields.get(id);
    return field?.input.isConnected && document.getElementById(id) === field.input
      && !field.input.disabled && !field.input.readOnly;
  };

  const voice = createVoiceWorkflow({
    api, getProviderAuth: () => auth,
    checkSession: () => auth.ensure({ recoverAuth: false }),
    context(id) {
      const field = fields.get(id);
      if (!field) return { editable: false };
      return {
        attemptId: state.localAttemptId, contextKey: field, editable: editable(id),
        block: { kind: 'question', responseConfig: { inputType: 'text', maxLength: field.input.maxLength < 0 ? Number.MAX_SAFE_INTEGER : field.input.maxLength } },
        answer: field.input.value, recovery: state.voiceRecovery[id],
      };
    },
    recover(id, record) {
      if (record) state.voiceRecovery[id] = record;
      else delete state.voiceRecovery[id];
      render();
    },
    apply(id, value, before, caret) {
      const field = fields.get(id);
      if (field.input instanceof HTMLInputElement) value = value.replace(/[\r\n]+/g, ' ');
      field.write(value, Math.min(caret, value.length));
      field.undo = value !== before && field.input.value === value ? { before, after: value } : null;
    },
    changed: render,
  });

  const session = {
    voice, state, canEditVoiceTarget: editable,
    async beginServerSignIn() {
      popup = startAuthPopupFlow({ apiClient: api, source: 'teaching-material', authFlowId: crypto.randomUUID() });
      try {
        const result = await popup.promise;
        if (result.ok) subject = result.user?.sub || null;
        auth.observe(result);
        return result;
      } finally { popup = null; }
    },
  };
  return {
    voice, records: state.voiceRecovery, t,
    signIn(id, confirm, isCurrent) { return requestVoiceSignIn(session, { blockId: id, confirm, isCurrent }); },
    discard(id) {
      // The shared workflow owns one audio blob. Clearing an unrelated text
      // recovery must not release another field's retained recording.
      const record = state.voiceRecovery[id];
      if (record?.phase === 'capture' && (record.code === 'AUTH_REQUIRED' || record.authenticated)) voice.discard(id);
      else delete state.voiceRecovery[id];
    },
    cancelPopup() { popup?.cancel(); popup?.popupWindow?.close(); },
    clear() { popup?.cancel(); voice.teardown(); },
  };
}
