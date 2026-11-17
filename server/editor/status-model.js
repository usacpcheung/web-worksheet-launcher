import { getLocale } from '../app/i18n/index.js';

function describeIssue(message, t) {
  const patterns = [
    [/responseConfig.options must be a non-empty array/, 'emptyOptions'],
    [/Each option needs text or an image/, 'emptyOption'],
    [/correctAnswer.*must match an existing options/, 'invalidChoiceAnswer'],
    [/min must not exceed max/, 'invalidNumberRange'],
    [/correctAnswer violates numberRules/, 'invalidNumberAnswer'],
    [/decimalPlacesAllowed must be an integer/, 'invalidDecimals'],
    [/^feedback: enter 1–5 learning targets/, 'feedbackTargets'],
    [/^feedback: text limits must be/, 'feedbackText'],
    [/^feedback: invalid learning target/, 'feedbackTarget'],
    [/^feedback: enable assessment or at least one text field/, 'feedbackEnabled'],
    [/Fill in the blanks: add at least one blank/, 'noBlanks'],
    [/Fill in the blanks: a main answer is required/, 'blankAnswer'],
  ];
  const duplicate = /options contains duplicate values: (.*)$/.exec(message);
  if (duplicate) return t('editorStatus.duplicateOptions', { value: duplicate[1] });
  const match = patterns.find(([pattern]) => pattern.test(message));
  return match ? t(`editorStatus.${match[1]}`) : message.replace(/^draft\.blocks\[\d+\][.:]?\s*/, '');
}

// Presentation adapter only: the session remains the validation and persistence owner.
export function getEditorStatusModel(state, t) {
  const blocks = state.draft?.blocks || [];
  const messages = [...new Set(state.validationErrors || [])];
  const groups = new Map();
  for (const message of messages) {
    const match = /^draft\.blocks\[(\d+)\]/.exec(message);
    const block = match ? blocks[Number(match[1])] : null;
    const unique = block?.blockId && blocks.filter(item => item?.blockId === block.blockId).length === 1;
    const target = unique ? { kind: 'block', blockId: block.blockId }
      : message.startsWith('feedback:') ? { kind: 'feedback' } : null;
    const key = target?.kind === 'block' ? `block:${target.blockId}` : target?.kind || 'general';
    let text = describeIssue(message, t);
    if (match) {
      const number = Number(match[1]) + 1;
      text = message.includes('.content.text is required') ? t('worksheetValidation.emptyReading', { number })
        : message.includes('.prompt.text is required') ? t('worksheetValidation.emptyPrompt', { number })
          : t('worksheetValidation.block', { number, reason: describeIssue(message, t) });
    }
    if (!groups.has(key)) groups.set(key, { key, target, messages: [] });
    groups.get(key).messages.push(text);
  }
  const saveState = state.lastPersistenceError ? 'error' : state.autosavePending ? 'saving'
    : state.draftRevision > state.lastSavedRevision ? 'unsaved' : 'saved';
  const warning = state.lastValidationWarning || '';
  const labelKey = saveState === 'saved' && warning && !messages.length ? 'savedWithWarnings' : saveState;
  const saveLabel = t(`editor.saveState.${labelKey}`);
  const issueLabel = messages.length ? t(messages.length === 1 ? 'editor.validation.issueCountOne' : 'editor.validation.issueCountOther', { count: messages.length }) : '';
  const date = state.lastSavedAt ? new Date(state.lastSavedAt) : null;
  return {
    draftId: state.draft?.localId || '', saveState, groups: [...groups.values()], issueCount: messages.length,
    label: issueLabel ? `${saveLabel} · ${issueLabel}` : saveLabel,
    tone: saveState === 'error' ? 'error' : messages.length || warning ? 'warn' : saveState === 'saved' ? 'ok' : 'info',
    savedTime: date && Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale())
      : t(state.lastSavedRevision > 0 ? 'editor.saveTime.unknown' : 'editor.saveTime.never'),
    error: state.lastPersistenceError || '', warning,
  };
}
