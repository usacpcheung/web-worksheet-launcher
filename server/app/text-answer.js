// Limits use JavaScript/HTML UTF-16 code units, matching existing answer counters.
// Rewrite provider input has its own, unchanged Unicode-code-point ceiling.
export const STANDARD_TEXT_LIMIT = 1200;
export const LONG_TEXT_LIMIT = 20000;
export const isLongText = (config) => config?.inputType === 'text' && config.textMode === 'long';
export const textLimitCeiling = (config) => (isLongText(config) ? LONG_TEXT_LIMIT : STANDARD_TEXT_LIMIT);
export const textAnswerLimit = (config) =>
  Number.isFinite(config?.maxLength) && config.maxLength > 0
    ? Math.trunc(config.maxLength)
    : isLongText(config)
      ? LONG_TEXT_LIMIT
      : 200;
export const hasLongText = (blocks) => (blocks || []).some((block) => isLongText(block?.responseConfig));

export function textConfigError(config, { authoring = false } = {}) {
  if (
    config?.textMode !== undefined &&
    (!['standard', 'long'].includes(config.textMode) || config.inputType !== 'text')
  ) {
    return 'Invalid textMode: use standard or long for text questions only.';
  }
  if (config?.inputType !== 'text' || (!authoring && config.textMode === undefined)) return '';
  const limit = config.maxLength ?? (isLongText(config) ? LONG_TEXT_LIMIT : 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > textLimitCeiling(config)) {
    return `Text maxLength must be an integer from 1 to ${textLimitCeiling(config)}. Choose long text for longer answers.`;
  }
  if (isLongText(config) && config.displayMode !== undefined && config.displayMode !== 'multi_line') {
    return 'Long text requires multi_line displayMode.';
  }
  return '';
}
export function assertTextQuestions(blocks, options) {
  for (const block of blocks || []) {
    const error = textConfigError(block?.responseConfig, options);
    if (error) throw new Error(`${block.blockId || 'Question'}: ${error}`);
  }
}
// Existing oversized answers remain readable and may be shortened in stages.
export function acceptsTextEdit(previous, next, config) {
  return (
    String(next ?? '').length <= textAnswerLimit(config) ||
    String(next ?? '').length < String(previous ?? '').length
  );
}
