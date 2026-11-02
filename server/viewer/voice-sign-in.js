import { t } from '../app/i18n/index.js';
import { promptForReadSignIn } from '../app/auth/read-auth-prompt.js';
import { getVoiceRecovery, hasRecoveryText } from './answer-voice-workflow.js';

const pending = new WeakMap();

// Shared learner voice presentation policy (viewer and RolePlayScene). Authentication never replays voice/provider work.
export function requestVoiceSignIn(session, { blockId, signal, isCurrent = () => true,
  prompt = promptForReadSignIn, translate = t,
} = {}) {
  if (pending.has(session)) return pending.get(session);
  const attemptId = session.state.localAttemptId;
  const payload = session.state.viewerPayload;
  const record = getVoiceRecovery(session.state.voiceRecovery, blockId);
  const current = () => record?.code === 'AUTH_REQUIRED' && !signal?.aborted && isCurrent()
    && session.state.localAttemptId === attemptId && session.state.viewerPayload === payload
    && session.state.status !== 'completed' && !session.state.isFinalizing
    && getVoiceRecovery(session.state.voiceRecovery, blockId) === record;
  const rewriting = record?.mode === 'rewrite';
  const descriptionKey = hasRecoveryText(record) || record?.phase === 'capture'
    ? 'viewer.voice.signInPromptRecovery'
    : rewriting ? 'viewer.voice.signInPromptRewrite' : 'viewer.voice.signInPromptVoice';
  const promise = Promise.resolve().then(async () => {
    if (!current()) return false;
    const accepted = await prompt({ isCurrent: current,
      title: translate(rewriting ? 'viewer.voice.signInTitleRewrite' : 'viewer.voice.signInTitleVoice'),
      description: translate(descriptionKey),
    });
    if (!accepted || !current()) return false;
    // Keep the existing popup/session verification and blocked-popup feedback.
    // The learner must explicitly start recording or retry processing afterwards.
    return session.beginServerSignIn();
  }).finally(() => {
    if (pending.get(session) === promise) pending.delete(session);
  });
  pending.set(session, promise);
  return promise;
}
