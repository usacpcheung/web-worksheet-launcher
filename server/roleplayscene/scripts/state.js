// Simple store with pub/sub
import { createProject } from './model.js';
import { ensureLocale, setActiveLocale, getActiveLocale } from './i18n.js';
import { seedIdSequencesFromProject } from './utils/id.js';

export class Store {
  constructor() {
    this.state = defaultState();
    setActiveLocale(this.state.locale);
    this.listeners = new Set();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(partial) {
    if (Object.prototype.hasOwnProperty.call(partial ?? {}, 'locale')) {
      this.setLocale(partial.locale);
    }
    const entries = Object.entries(partial ?? {}).filter(([key]) => key !== 'locale');
    if (!entries.length) {
      return;
    }
    const nextPartial = Object.fromEntries(entries);
    this.state = { ...this.state, ...nextPartial };
    for (const fn of this.listeners) fn(this.state);
  }
  get() { return this.state; }
  setLocale(locale) {
    const resolved = ensureLocale(locale ?? getActiveLocale());
    if (resolved === this.state.locale) {
      return;
    }
    this.state = { ...this.state, locale: resolved };
    setActiveLocale(resolved);
    for (const fn of this.listeners) fn(this.state);
  }
}

function defaultState() {
  const project = createProject();
  seedIdSequencesFromProject(project);
  return {
    project,
    audioGate: false, // set to true after user gesture
    locale: ensureLocale(getActiveLocale()),
  };
}
