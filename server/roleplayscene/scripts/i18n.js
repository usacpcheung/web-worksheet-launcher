import {
  getAvailableLocales as getSharedAvailableLocales,
  getLocale,
  normalizeLocale,
  onLocaleChange,
  setLocale,
  t,
} from '../../app/i18n/index.js';

const ROLEPLAYSCENE_NAMESPACE = 'roleplayscene';

function formatFallback(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value == null ? '' : String(value);
    }
    return match;
  });
}

export function getAvailableLocales() {
  return getSharedAvailableLocales();
}

export function getActiveLocale() {
  return getLocale();
}

export function setActiveLocale(locale) {
  return setLocale(locale);
}

export function ensureLocale(locale) {
  return normalizeLocale(locale);
}

export { onLocaleChange };

export function translate(id, vars = {}) {
  if (!id) {
    return '';
  }
  const key = `${ROLEPLAYSCENE_NAMESPACE}.${id}`;
  const value = t(key, vars);
  if (value === key && Object.prototype.hasOwnProperty.call(vars, 'default')) {
    return formatFallback(vars.default, vars);
  }
  return value;
}
