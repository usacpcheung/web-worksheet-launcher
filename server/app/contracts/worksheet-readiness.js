import { validateDraftSchema } from './validators.js';
import { textConfigError } from '../text-answer.js';
import { optionHasContent } from '../option-images.js';

// Distribution must satisfy the reader contract. Keep parsing legacy packages and
// saving unfinished local drafts separate from this gate. Prompt length is a
// publishing-only restriction; it does not make a worksheet unreadable.
export function validateWorksheetReadiness(worksheet, { authoring = false } = {}) {
  const errors = validateDraftSchema({ ...worksheet, draftWorksheetId: 'readiness' }).errors;
  const ids = new Set();
  for (const [index, block] of (Array.isArray(worksheet?.blocks) ? worksheet.blocks : []).entries()) {
    if (!block || typeof block !== 'object') continue;
    const path = `draft.blocks[${index}]`;
    if (!['content', 'question'].includes(block.kind)) errors.push(`${path}.kind must be content or question`);
    if (ids.has(block.blockId)) errors.push(`${path}.blockId must be unique`);
    ids.add(block.blockId);
    if (block.kind !== 'question') continue;
    const config = block.responseConfig;
    if (!config || typeof config !== 'object') continue;
    if (authoring) {
      const textError = textConfigError(config, { authoring: true });
      if (textError && !textConfigError(config)) errors.push(`${path}.responseConfig: ${textError}`);
    }
    if (config.inputType === 'multiple_choice') {
      if (!Array.isArray(config.options) || config.options.length === 0) {
        errors.push(`${path}.responseConfig.options must be a non-empty array`);
      } else {
        const values = new Set();
        for (const option of config.options) {
          const value = String(option && typeof option === 'object' ? (option.value ?? option.label ?? '') : (option ?? ''));
          if (!optionHasContent(option)) errors.push(`${path}.responseConfig.options: Each option needs text or an image.`);
          if (!value.trim()) errors.push(`${path}.responseConfig.options require non-empty answer values`);
          if (values.has(value.trim())) errors.push(`${path}.responseConfig.options contains duplicate values: ${value.trim()}`);
          values.add(value.trim());
        }
      }
      if (config.selectionMode !== undefined && !['single', 'multi'].includes(config.selectionMode)) {
        errors.push(`${path}.responseConfig.selectionMode must be single or multi`);
      }
    }
    if (config.inputType === 'number') {
      for (const key of ['min', 'max']) {
        if (config[key] != null && !Number.isFinite(config[key])) errors.push(`${path}.responseConfig.${key} must be a finite number`);
      }
      if (Number.isFinite(config.min) && Number.isFinite(config.max) && config.min > config.max) {
        errors.push(`${path}.responseConfig.min must not exceed max`);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertWorksheetReady(worksheet, options) {
  const validation = validateWorksheetReadiness(worksheet, options);
  if (!validation.valid) {
    const error = new Error(`Worksheet is not ready: ${validation.errors.join('; ')}`);
    error.code = 'WORKSHEET_NOT_READY';
    error.validationErrors = validation.errors;
    throw error;
  }
}
