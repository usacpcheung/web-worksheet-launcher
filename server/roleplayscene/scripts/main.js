import { Store } from './state.js';
import { renderEditor } from './editor/editor.js';
import { renderPlayer } from './player/player.js';
import { ensureAudioGate } from './player/audio.js';
import { importProject, exportProject, setupPersistence } from './storage.js';
import { validateProject } from './editor/validators.js';
import { renderValidation } from './editor/inspector.js';
import { translate, onLocaleChange, getAvailableLocales } from './i18n.js';
import './i18n.zh-TW.js';

const appRoot = document.getElementById('app');
const elLeft = document.getElementById('left-pane');
const elRight = document.getElementById('right-pane');
const messageHost = document.getElementById('app-messages');
const messageText = messageHost?.querySelector('.app-messages__text');
const messageDetails = messageHost?.querySelector('.app-messages__details');
const dismissButton = messageHost?.querySelector('.app-messages__dismiss');

const btnEdit = document.getElementById('mode-edit');
const btnPlay = document.getElementById('mode-play');
const btnImport = document.getElementById('import-btn');
const btnExport = document.getElementById('export-btn');
const fileInput = document.getElementById('file-input');
const topbarTitle = document.querySelector('.topbar h1');
const localeSelect = document.getElementById('locale-select');
const localeLabel = document.querySelector('.toolbar__locale-label');

const store = new Store();

let mode = 'edit'; // 'edit' | 'play'
let teardown = null;
let persistenceCleanup = () => {};
let lastMessagePayload = null;

const LOCALE_STORAGE_KEY = 'roleplayscene:locale';

function updateToolbarText() {
  if (topbarTitle) {
    topbarTitle.textContent = translate('toolbar.appName');
  }
  if (btnEdit) {
    btnEdit.textContent = translate('toolbar.edit');
  }
  if (btnPlay) {
    btnPlay.textContent = translate('toolbar.play');
  }
  if (btnImport) {
    btnImport.textContent = translate('toolbar.import');
    btnImport.title = translate('toolbar.importTitle');
  }
  if (btnExport) {
    btnExport.textContent = translate('toolbar.export');
    btnExport.title = translate('toolbar.exportTitle');
  }
  if (localeLabel) {
    localeLabel.textContent = translate('toolbar.languageLabel');
  }
  if (localeSelect) {
    localeSelect.setAttribute('aria-label', translate('toolbar.languageLabel'));
  }
  if (dismissButton) {
    dismissButton.setAttribute('aria-label', translate('toolbar.dismissMessage'));
  }
}

function populateLocaleOptions() {
  if (!localeSelect) return;
  const locales = getAvailableLocales();
  const currentValue = store.get().locale;
  const previousSelection = localeSelect.value;
  localeSelect.innerHTML = '';
  locales.forEach(localeCode => {
    const option = document.createElement('option');
    option.value = localeCode;
    option.textContent = translate(`toolbar.localeNames.${localeCode}`, { default: localeCode });
    if (localeCode === currentValue) {
      option.selected = true;
    }
    localeSelect.appendChild(option);
  });
  if (locales.includes(previousSelection) && previousSelection !== currentValue) {
    localeSelect.value = currentValue;
  }
}

function refreshLocaleUI(nextLocale) {
  document.documentElement?.setAttribute('lang', nextLocale);
  updateToolbarText();
  populateLocaleOptions();
  if (localeSelect) {
    localeSelect.value = nextLocale;
  }
  if (lastMessagePayload) {
    showMessage(lastMessagePayload);
  }
  setMode(mode);
}

function setMode(next) {
  if (teardown) {
    teardown();
    teardown = null;
  }
  mode = next;
  btnEdit.classList.toggle('active', mode === 'edit');
  btnPlay.classList.toggle('active', mode === 'play');
  if (appRoot) {
    appRoot.classList.toggle('layout--edit', mode === 'edit');
    appRoot.classList.toggle('layout--play', mode === 'play');
  }
  if (mode === 'edit') {
    teardown = renderEditor(store, elLeft, elRight, showMessage);
  } else {
    teardown = renderPlayer(store, elLeft, elRight, showMessage);
  }
}

function showMessage(msg) {
  if (!messageHost || !messageText || !messageDetails) return;
  if (!msg) {
    lastMessagePayload = null;
    clearMessage();
    return;
  }

  const payload = typeof msg === 'string' ? { text: msg } : msg;
  const textId = payload.textId ?? null;
  const textArgs = payload.textArgs ?? {};
  const resolvedText = textId ? translate(textId, textArgs) : (payload.text ?? '');
  const preparedPayload = {
    ...payload,
    text: resolvedText,
    textId,
    textArgs,
  };
  lastMessagePayload = preparedPayload;
  const text = resolvedText;
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  messageText.textContent = text;

  if (hasErrors || hasWarnings) {
    renderValidation({ errors, warnings }, messageDetails, { showEmptyState: false });
    messageDetails.hidden = false;
  } else {
    messageDetails.innerHTML = '';
    messageDetails.hidden = true;
  }

  if (text || hasErrors || hasWarnings) {
    messageHost.hidden = false;
    messageHost.removeAttribute('hidden');
  } else {
    messageHost.hidden = true;
    messageHost.setAttribute('hidden', '');
  }
}

function clearMessage() {
  if (!messageHost || !messageText || !messageDetails) return;
  messageText.textContent = '';
  messageDetails.innerHTML = '';
  messageDetails.hidden = true;
  messageHost.hidden = true;
  messageHost.setAttribute('hidden', '');
}

if (dismissButton) {
  dismissButton.addEventListener('click', () => {
    clearMessage();
  });
}

btnEdit.addEventListener('click', () => setMode('edit'));
btnPlay.addEventListener('click', () => {
  const result = validateProject(store.get().project);
  if (result.errors.length) {
    showMessage({
      textId: 'messages.validationBeforePlay',
      errors: result.errors,
      warnings: result.warnings,
    });
    if (mode !== 'edit') {
      setMode('edit');
    }
    requestAnimationFrame(() => {
      const panel = elRight.querySelector('.validation-results');
      if (panel instanceof HTMLElement) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!panel.hasAttribute('tabindex')) {
          panel.setAttribute('tabindex', '-1');
        }
        if (typeof panel.focus === 'function') {
          panel.focus({ preventScroll: true });
        }
      }
    });
    return;
  }
  ensureAudioGate(store);
  setMode('play');
  clearMessage();
});

btnImport.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    showMessage({ textId: 'messages.importingProject' });
    await importProject(store, file);
    showMessage({ textId: 'messages.importedProject' });
    setMode('edit');
  } catch (err) {
    console.error(err);
    showMessage({ textId: 'messages.importFailed' });
  } finally {
    fileInput.value = '';
  }
});

btnExport.addEventListener('click', async () => {
  try {
    showMessage({ textId: 'messages.preparingExport' });
    await exportProject(store);
    showMessage({ textId: 'messages.exportedProject' });
  } catch (err) {
    console.error(err);
    showMessage({ textId: 'messages.exportFailed' });
  }
});

async function bootstrap() {
  const storedLocale = (() => {
    try {
      return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
    } catch (err) {
      return null;
    }
  })();
  if (storedLocale) {
    store.setLocale(storedLocale);
  }
  refreshLocaleUI(store.get().locale);
  try {
    persistenceCleanup = await setupPersistence(store, { showMessage });
  } catch (err) {
    console.error('Failed to initialise persistence', err);
    persistenceCleanup = () => {};
  }
  setMode('edit');
}

bootstrap();

if (localeSelect) {
  localeSelect.addEventListener('change', (event) => {
    const selected = event.target.value;
    store.setLocale(selected);
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, store.get().locale);
    } catch (err) {
      // Ignore storage failures for locale preference.
    }
  });
}

onLocaleChange((nextLocale) => {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, nextLocale);
  } catch (err) {
    // Ignore storage failures.
  }
  refreshLocaleUI(nextLocale);
});

window.addEventListener('beforeunload', () => {
  if (typeof teardown === 'function') {
    teardown();
  }
  if (typeof persistenceCleanup === 'function') {
    persistenceCleanup();
  }
});
