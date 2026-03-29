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

export { normalizeNumberRules, validateNumberInputFormat };
