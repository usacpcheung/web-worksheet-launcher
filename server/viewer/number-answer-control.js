import { normalizeNumberRules, validateNumberInputFormat } from '../app/contracts/number-input-validator.js';

export function getNumberInputErrorMessage(rawValue, responseConfig = {}) {
  const trimmed = String(rawValue ?? '').trim();
  if (trimmed === '') {
    return { message: '', normalizedValue: '' };
  }

  const normalizedRules = normalizeNumberRules(responseConfig.numberRules);
  const formatValidation = validateNumberInputFormat(trimmed, {
    allowedKinds: ['integer', 'decimal'],
    allowSigned: true,
    decimalPlacesAllowed: null,
  });
  if (!formatValidation.ok) {
    const messageByCode = {
      fraction_not_allowed: 'Fractions are not supported (for example, 2/3).',
      invalid_syntax: 'Enter a valid integer or decimal number.',
    };
    return {
      message: messageByCode[formatValidation.errorCode] || 'Enter a valid integer or decimal number.',
      normalizedValue: '',
    };
  }

  const numericValue = formatValidation.normalizedValue;
  const min = Number.isFinite(responseConfig.min) ? Number(responseConfig.min) : null;
  const max = Number.isFinite(responseConfig.max) ? Number(responseConfig.max) : null;
  if (min !== null && numericValue < min) {
    return { message: `Value is below minimum (${min}).`, normalizedValue: '' };
  }
  if (max !== null && numericValue > max) {
    return { message: `Value is above maximum (${max}).`, normalizedValue: '' };
  }

  if (!normalizedRules.allowSigned && (/^[+-]/).test(trimmed)) {
    return { message: 'Signed values are not allowed for this question.', normalizedValue: '' };
  }

  const strictValidation = validateNumberInputFormat(trimmed, normalizedRules);
  if (!strictValidation.ok) {
    const messageByCode = {
      kind_not_allowed: 'Only the configured number format is allowed.',
      decimal_places_exceeded: 'Too many decimal places for this question.',
      sign_not_allowed: 'Signed values are not allowed for this question.',
      fraction_not_allowed: 'Fractions are not supported (for example, 2/3).',
      invalid_syntax: 'Enter a valid integer or decimal number.',
    };
    return { message: messageByCode[strictValidation.errorCode] || 'Invalid number format.', normalizedValue: '' };
  }

  return { message: '', normalizedValue: strictValidation.normalizedValue };
}

// DOM and validation only. The shell owns raw-input caching, answer saving and
// rendering; each input event reports both the typed text and validated result.
export function createNumberAnswerControl({ responseConfig, signal, onInput }) {
  const control = document.createElement('input');
  control.type = 'text';
  control.inputMode = 'decimal';
  const numberRules = normalizeNumberRules(responseConfig?.numberRules);
  const allowSignedPrefix = numberRules.allowSigned ? '[+-]?' : '';
  let decimalPattern;
  if (numberRules.allowedKinds.includes('decimal') && typeof numberRules.decimalPlacesAllowed === 'number') {
    decimalPattern = numberRules.decimalPlacesAllowed > 0
      ? `\\d+\\.\\d{1,${numberRules.decimalPlacesAllowed}}`
      : '\\d+';
  } else {
    decimalPattern = '\\d+\\.\\d+';
  }
  const kindPattern = numberRules.allowedKinds.includes('integer') && numberRules.allowedKinds.includes('decimal')
    ? '\\d+(\\.\\d+)?'
    : numberRules.allowedKinds.includes('decimal')
      ? decimalPattern
      : '\\d+';
  control.pattern = `${allowSignedPrefix}${kindPattern}`;
  const kinds = numberRules.allowedKinds;
  let kindDescription;
  if (kinds.includes('integer') && kinds.includes('decimal')) {
    kindDescription = 'integer or decimal number';
  } else if (kinds.includes('integer')) {
    kindDescription = 'integer';
  } else if (kinds.includes('decimal')) {
    kindDescription = 'decimal number';
  } else {
    kindDescription = 'number';
  }
  const constraints = [];
  if (!numberRules.allowSigned) {
    constraints.push('without a leading + or - sign');
  }
  if (kinds.includes('decimal') && typeof numberRules.decimalPlacesAllowed === 'number') {
    if (numberRules.decimalPlacesAllowed === 1) {
      constraints.push('with at most 1 digit after the decimal point');
    } else if (numberRules.decimalPlacesAllowed > 1) {
      constraints.push(`with at most ${numberRules.decimalPlacesAllowed} digits after the decimal point`);
    }
  }
  let title = `Enter a valid ${kindDescription}`;
  if (constraints.length > 0) {
    title += ` (${constraints.join(', ')}).`;
  } else {
    title += '.';
  }
  control.title = title;
  control.addEventListener('input', () => {
    const rawValue = control.value;
    const result = getNumberInputErrorMessage(rawValue, responseConfig || {});
    onInput({ rawValue, ...result });
  }, { signal });
  return control;
}

export function updateNumberAnswerControl(control, {
  storedValue, cachedRawValue, completed, errorNode, errorMessage, cacheRawValue,
}) {
  const stateValue = storedValue === '' || storedValue === null || storedValue === undefined ? '' : String(storedValue);
  const isControlFocused = control === document.activeElement;
  const nextValue = isControlFocused && cachedRawValue !== undefined ? String(cachedRawValue) : stateValue;
  if (!isControlFocused && control.value !== nextValue) control.value = nextValue;
  if (!isControlFocused && cachedRawValue !== undefined && String(cachedRawValue) !== stateValue) cacheRawValue(stateValue);
  control.disabled = completed;
  if (errorNode) errorNode.textContent = errorMessage || '';
}
