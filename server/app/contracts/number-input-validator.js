const DEFAULT_ALLOWED_KINDS = ['integer', 'decimal'];

function normalizeNumberRules(numberRules = {}) {
  const source = numberRules && typeof numberRules === 'object' ? numberRules : {};
  const allowedKinds = Array.isArray(source.allowedKinds)
    ? source.allowedKinds.filter((kind) => kind === 'integer' || kind === 'decimal')
    : DEFAULT_ALLOWED_KINDS;

  return {
    allowedKinds: allowedKinds.length > 0 ? Array.from(new Set(allowedKinds)) : [...DEFAULT_ALLOWED_KINDS],
    allowSigned: source.allowSigned !== false,
    decimalPlacesAllowed:
      Number.isInteger(source.decimalPlacesAllowed) && source.decimalPlacesAllowed >= 0
        ? source.decimalPlacesAllowed
        : null,
  };
}

function countDecimalPlaces(value) {
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();

  if (!text.includes('e') && !text.includes('E')) {
    const decimalPart = text.split('.')[1];
    return decimalPart ? decimalPart.length : 0;
  }

  const [mantissa, exponentPart] = text.toLowerCase().split('e');
  const exponent = Number(exponentPart);
  if (!Number.isFinite(exponent)) return 0;

  const decimalIndex = mantissa.indexOf('.');
  const decimalDigitsInMantissa = decimalIndex === -1 ? 0 : mantissa.length - decimalIndex - 1;
  if (exponent >= 0) {
    return Math.max(decimalDigitsInMantissa - exponent, 0);
  }
  return decimalDigitsInMantissa + (-exponent);
}

function getNumberKind(value) {
  return Number.isInteger(value) ? 'integer' : 'decimal';
}

function getNumberCorrectAnswerConfigViolation(value, config = {}) {
  if (!Number.isFinite(value)) return 'not_finite';
  const rules = normalizeNumberRules(config.numberRules);

  if (!rules.allowSigned && value < 0) {
    return 'sign_not_allowed';
  }

  const kind = getNumberKind(value);
  const kindAllowed =
    rules.allowedKinds.includes(kind)
    || (kind === 'integer' && rules.allowedKinds.includes('decimal'));
  if (!kindAllowed) {
    return 'kind_not_allowed';
  }

  if (
    kind === 'decimal'
    && rules.decimalPlacesAllowed !== null
    && countDecimalPlaces(value) > rules.decimalPlacesAllowed
  ) {
    return 'decimal_places_exceeded';
  }

  if (Number.isFinite(config.min) && value < Number(config.min)) {
    return 'below_min';
  }

  if (Number.isFinite(config.max) && value > Number(config.max)) {
    return 'above_max';
  }

  return null;
}

function validateNumberInputFormat(rawInput, numberRules = {}) {
  const rules = normalizeNumberRules(numberRules);
  if (rawInput === '' || rawInput === null || rawInput === undefined) {
    return { ok: false, errorCode: 'empty' };
  }

  const text = String(rawInput).trim();
  if (!text) {
    return { ok: false, errorCode: 'empty' };
  }
  if (text.includes('/')) {
    return { ok: false, errorCode: 'fraction_not_allowed' };
  }
  if (!rules.allowSigned && (text.startsWith('+') || text.startsWith('-'))) {
    return { ok: false, errorCode: 'sign_not_allowed' };
  }

  const integerPattern = rules.allowSigned ? /^[+-]?\d+$/ : /^\d+$/;
  const decimalPattern = rules.allowSigned ? /^[+-]?\d+\.\d+$/ : /^\d+\.\d+$/;

  const isInteger = integerPattern.test(text);
  const isDecimal = decimalPattern.test(text);
  if (!isInteger && !isDecimal) {
    return { ok: false, errorCode: 'invalid_syntax' };
  }

  const kind = isDecimal ? 'decimal' : 'integer';
  if (!rules.allowedKinds.includes(kind)) {
    return { ok: false, errorCode: 'kind_not_allowed' };
  }

  if (isDecimal && rules.decimalPlacesAllowed !== null) {
    const [, decimalPart = ''] = text.split('.');
    if (decimalPart.length > rules.decimalPlacesAllowed) {
      return { ok: false, errorCode: 'decimal_places_exceeded' };
    }
  }

  const normalizedValue = Number(text);
  if (!Number.isFinite(normalizedValue)) {
    return { ok: false, errorCode: 'invalid_syntax' };
  }

  return { ok: true, normalizedValue, kind };
}

export {
  normalizeNumberRules,
  countDecimalPlaces,
  getNumberKind,
  getNumberCorrectAnswerConfigViolation,
  validateNumberInputFormat,
};
