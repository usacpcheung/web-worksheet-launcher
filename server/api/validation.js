const UUID_V4ISH_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_V4ISH_REGEX.test(value.trim());
}

export function assertUuid(value, { code, message }) {
  if (!isUuid(value)) {
    return {
      ok: false,
      error: {
        code,
        message,
      },
    };
  }
  return { ok: true, value: value.trim() };
}

export function parseOptionalPositiveInt(raw, { field, max, defaultValue }) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: defaultValue };
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_QUERY_PARAM',
        message: `${field} must be a non-negative integer.`,
      },
    };
  }

  return { ok: true, value: Math.min(value, max) };
}
