import en from './locales/en.js';
import zhHant from './locales/zh-Hant.js';

export const LOCALE_STORAGE_KEY = 'worksheetLauncher.locale';
export const DEFAULT_LOCALE = 'en';

const locales = Object.freeze({
  en,
  'zh-Hant': zhHant,
});

let currentLocale = DEFAULT_LOCALE;

function getGlobalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readSavedLocale(storage = getGlobalStorage()) {
  try {
    return storage?.getItem?.(LOCALE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeSavedLocale(locale, storage = getGlobalStorage()) {
  try {
    storage?.setItem?.(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Locale preference should not block app startup if storage is unavailable.
  }
}

export function normalizeLocale(locale) {
  const value = String(locale || '').trim();
  if (value === 'zh-Hant' || value === 'zh-HK' || value === 'zh-TW') return 'zh-Hant';
  if (value.toLowerCase().startsWith('zh-hant')) return 'zh-Hant';
  if (value.toLowerCase().startsWith('zh-hk')) return 'zh-Hant';
  if (value.toLowerCase().startsWith('zh-tw')) return 'zh-Hant';
  if (value.toLowerCase().startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

function getBrowserLanguage(navigatorLike = globalThis.navigator) {
  const languages = Array.isArray(navigatorLike?.languages) ? navigatorLike.languages : [];
  return languages.find(Boolean) || navigatorLike?.language || '';
}

export function resolveInitialLocale(options = {}) {
  const storage = Object.hasOwn(options, 'storage') ? options.storage : getGlobalStorage();
  const navigatorLike = Object.hasOwn(options, 'navigator') ? options.navigator : globalThis.navigator;
  const saved = readSavedLocale(storage);
  if (saved) return normalizeLocale(saved);
  return normalizeLocale(getBrowserLanguage(navigatorLike));
}

export function setLocale(locale, options = {}) {
  const nextLocale = normalizeLocale(locale);
  currentLocale = nextLocale;
  if (options.persist !== false) {
    const storage = Object.hasOwn(options, 'storage') ? options.storage : getGlobalStorage();
    writeSavedLocale(nextLocale, storage);
  }
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function getAvailableLocales() {
  return Object.keys(locales);
}

function readPath(source, key) {
  return String(key || '').split('.').reduce((value, part) => (
    value && Object.hasOwn(value, part) ? value[part] : undefined
  ), source);
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ));
}

export function t(key, params = {}) {
  const activeMessages = locales[currentLocale] || locales[DEFAULT_LOCALE];
  const message = readPath(activeMessages, key) ?? readPath(locales[DEFAULT_LOCALE], key) ?? key;
  return interpolate(message, params);
}

currentLocale = resolveInitialLocale();
