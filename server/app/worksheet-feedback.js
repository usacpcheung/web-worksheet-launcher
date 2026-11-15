// Feedback belongs to the worksheet snapshot, never to its scored question list.
export const FEEDBACK_ROLES = ['student', 'teacher', 'peer'];
export const FEEDBACK_TEXT_ROLES = ['student', 'teacher'];
export const FEEDBACK_SECTION_ID = 'viewer-feedback-section';
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
export const feedbackEnabled = (config) => config?.enabled === true;
export const cloneFeedback = (config) =>
  config === undefined ? undefined : structuredClone(config);
export function createFeedbackConfig(id = 'target_1') {
  return {
    enabled: false,
    assessment: true,
    targets: [{ id, text: '' }],
    categories: ['student', 'teacher'],
    text: {
      student: { enabled: true, limit: 200, prompt: '' },
      teacher: { enabled: true, limit: 200, prompt: '' },
    },
  };
}
export function assertFeedbackConfig(config) {
  if (config === undefined) return;
  if (!record(config) || typeof config.enabled !== 'boolean')
    throw new Error('feedback: invalid configuration.');
  if (
    typeof config.assessment !== 'boolean' ||
    !Array.isArray(config.targets) ||
    config.targets.length > 5 ||
    !Array.isArray(config.categories) ||
    new Set(config.categories).size !== config.categories.length ||
    config.categories.some((r) => !FEEDBACK_ROLES.includes(r)) ||
    !record(config.text)
  )
    throw new Error('feedback: invalid assessment settings.');
  const ids = new Set();
  for (const target of config.targets) {
    if (
      !record(target) ||
      typeof target.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(target.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(target.id) ||
      ids.has(target.id) ||
      typeof target.text !== 'string' ||
      target.text.length > 200
    )
      throw new Error(
        'feedback: invalid learning target (maximum 200 characters).',
      );
    ids.add(target.id);
  }
  if (
    config.enabled &&
    config.assessment &&
    (!config.targets.length ||
      !config.categories.length ||
      config.targets.some((t) => !t.text.trim()))
  ) {
    throw new Error(
      'feedback: enter 1–5 learning targets and select at least one assessment category.',
    );
  }
  for (const role of FEEDBACK_TEXT_ROLES) {
    const field = config.text[role];
    if (
      !record(field) ||
      typeof field.enabled !== 'boolean' ||
      typeof field.prompt !== 'string' ||
      field.prompt.length > 500 ||
      !Number.isInteger(field.limit) ||
      field.limit < 1 ||
      field.limit > 1200
    )
      throw new Error(
        'feedback: text limits must be 1–1,200; instructions at most 500 characters.',
      );
  }
  if (
    config.enabled &&
    !config.assessment &&
    !FEEDBACK_TEXT_ROLES.some((r) => config.text[r].enabled)
  )
    throw new Error('feedback: enable assessment or at least one text field.');
}
export function emptyFeedbackResponses() {
  return { ratings: {}, text: {} };
}
export function assertFeedbackResponses(config, responses, status) {
  assertFeedbackConfig(config);
  if (responses === undefined) return;
  if (
    !record(responses) ||
    !record(responses.ratings) ||
    !record(responses.text)
  )
    throw new Error('feedback: invalid responses.');
  const hasValues =
    Object.keys(responses.ratings).length || Object.keys(responses.text).length;
  if (
    hasValues &&
    (!feedbackEnabled(config) ||
      !['completed', 'submitted', 'checked'].includes(status))
  )
    throw new Error(
      'feedback: responses require a submitted worksheet with feedback enabled.',
    );
  for (const [id, ratings] of Object.entries(responses.ratings)) {
    if (
      !config?.assessment ||
      !config.targets.some((t) => t.id === id) ||
      !record(ratings)
    )
      throw new Error('feedback: unknown assessment target.');
    for (const [role, value] of Object.entries(ratings)) {
      if (
        !config.categories.includes(role) ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 5
      )
        throw new Error(
          'feedback: ratings must be 1–5 for enabled categories.',
        );
    }
  }
  for (const [role, value] of Object.entries(responses.text)) {
    if (
      !FEEDBACK_TEXT_ROLES.includes(role) ||
      !config?.text[role].enabled ||
      typeof value !== 'string' ||
      value.length > config.text[role].limit
    )
      throw new Error(
        'feedback: invalid text response or character limit exceeded.',
      );
  }
}
export function feedbackVoiceTargets(payload) {
  if (!feedbackEnabled(payload?.feedback)) return [];
  const used = new Set((payload.blocks || []).map((b) => b.blockId));
  return FEEDBACK_TEXT_ROLES.filter(
    (role) => payload.feedback.text[role].enabled,
  ).map((role) => {
    let id = `@feedback/${role}`;
    while (used.has(id)) id = '@' + id;
    return {
      blockId: id,
      kind: 'question',
      responseConfig: {
        inputType: 'text',
        textMode: 'standard',
        maxLength: payload.feedback.text[role].limit,
        feedbackTarget: role,
      },
    };
  });
}
export function resolveFeedbackTarget(payload, id) {
  return feedbackVoiceTargets(payload).find((b) => b.blockId === id);
}
