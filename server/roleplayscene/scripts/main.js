import { Store } from './state.js';
import { renderEditor } from './editor/editor.js';
import { renderPlayer } from './player/player.js';
import { ensureAudioGate } from './player/audio.js';
import {
  applyPreparedProjectImport,
  createProjectArchive,
  exportProject,
  ImportErrorCode,
  prepareProjectImport,
  revokeProjectObjectUrls,
  setupPersistence,
} from './storage.js';
import { validateProject } from './editor/validators.js';
import { renderValidation } from './editor/inspector.js';
import { translate, onLocaleChange, getAvailableLocales } from './i18n.js';
import { createServerApiClient } from '../../app/api/server-api-client.js';
import { probeSession } from '../../app/auth/session-readiness.js';
import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from '../../app/auth/auth-popup-flow.js';
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
const serverStatus = document.getElementById('server-status');
const serverSignInButton = document.getElementById('server-signin-btn');
const serverSaveButton = document.getElementById('server-save-btn');
const serverManageButton = document.getElementById('server-manage-btn');
const fileInput = document.getElementById('file-input');
const topbarTitle = document.querySelector('.topbar h1');
const localeSelect = document.getElementById('locale-select');
const localeLabel = document.querySelector('.toolbar__locale-label');
const importConfirmOverlay = document.getElementById('import-confirm-overlay');
const importConfirmTitle = document.getElementById('import-confirm-title');
const importConfirmBody = document.getElementById('import-confirm-body');
const importConfirmAccept = document.getElementById('import-confirm-accept');
const importConfirmCancel = document.getElementById('import-confirm-cancel');
const serverModalOverlay = document.getElementById('server-modal-overlay');
const serverModalDialog = serverModalOverlay?.querySelector('.server-modal') || null;
const serverModalTitle = document.getElementById('server-modal-title');
const serverModalBody = document.getElementById('server-modal-body');
const serverModalActions = document.getElementById('server-modal-actions');
const serverModalClose = document.getElementById('server-modal-close');

const store = new Store();
const apiClient = createServerApiClient();

let mode = 'edit'; // 'edit' | 'play'
let teardown = null;
let persistenceCleanup = () => {};
let lastMessagePayload = null;
let activeImportConfirmation = null;
let activeServerModal = null;
let activeAuthFlow = null;
let serverSession = { status: 'checking', user: null, error: null };
let uploadedDrafts = [];
let uploadedDraftSlotLimit = 3;
let isLoadingUploadedDrafts = false;
let isUploadingDraft = false;

const LOCALE_STORAGE_KEY = 'roleplayscene:locale';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getRolePlaySceneDraftId(draft) {
  return String(draft?.roleplayscene_uploaded_draft_id || '').trim();
}

function sanitizeFilename(name, fallback = 'roleplayscene-draft') {
  const normalized = String(name || '').trim() || fallback;
  return normalized
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 128) || fallback;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return translate('server.values.unknownSize');
  if (value < 1024) return translate('server.values.bytes', { value });
  if (value < 1024 * 1024) return translate('server.values.kb', { value: (value / 1024).toFixed(1) });
  return translate('server.values.mb', { value: (value / (1024 * 1024)).toFixed(1) });
}

function formatTimestamp(value) {
  if (!isNonEmptyString(value)) return translate('server.values.unknownTime');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return translate('server.values.unknownTime');
  try {
    return new Intl.DateTimeFormat(store.get().locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(parsed);
  } catch (err) {
    return parsed.toLocaleString();
  }
}

function createZipFileFromBytes(bytes, name) {
  if (typeof File === 'function') {
    return new File([bytes], name, { type: 'application/zip' });
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  Object.defineProperty(blob, 'name', {
    value: name,
    configurable: true,
  });
  return blob;
}

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
  if (serverSignInButton) {
    serverSignInButton.textContent = translate('server.signIn');
  }
  if (serverSaveButton) {
    serverSaveButton.textContent = isUploadingDraft
      ? translate('server.saving')
      : translate('server.save');
  }
  if (serverManageButton) {
    serverManageButton.textContent = isLoadingUploadedDrafts
      ? translate('server.refreshing')
      : translate('server.manage');
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
  if (importConfirmTitle) {
    importConfirmTitle.textContent = translate('messages.importConfirmTitle');
  }
  if (importConfirmBody) {
    importConfirmBody.textContent = translate('messages.importConfirmBody');
  }
  if (importConfirmAccept) {
    importConfirmAccept.textContent = translate('messages.importConfirmAccept');
  }
  if (importConfirmCancel) {
    importConfirmCancel.textContent = translate('messages.importConfirmCancel');
  }
  if (serverModalClose) {
    serverModalClose.setAttribute('aria-label', translate('server.close'));
  }
  updateServerSessionUi();
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

function updateServerSessionUi() {
  if (serverStatus) {
    const status = serverSession.status;
    if (status === 'ready') {
      const userLabel = serverSession.user?.email || serverSession.user?.name || translate('server.signedInUserFallback');
      serverStatus.textContent = translate('server.statusReady', { user: userLabel });
      serverStatus.className = 'server-status server-status--ready';
    } else if (status === 'checking') {
      serverStatus.textContent = translate('server.statusChecking');
      serverStatus.className = 'server-status';
    } else {
      serverStatus.textContent = translate('server.statusNotReady');
      serverStatus.className = 'server-status server-status--not-ready';
    }
  }
  if (serverSignInButton) {
    serverSignInButton.hidden = serverSession.status === 'ready';
  }
  if (serverSaveButton) {
    serverSaveButton.disabled = isUploadingDraft;
    serverSaveButton.textContent = isUploadingDraft ? translate('server.saving') : translate('server.save');
  }
  if (serverManageButton) {
    serverManageButton.disabled = isLoadingUploadedDrafts;
    serverManageButton.textContent = isLoadingUploadedDrafts ? translate('server.refreshing') : translate('server.manage');
  }
}

function createButton(label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  return button;
}

function setServerModalActions(actions = []) {
  if (!serverModalActions) return;
  serverModalActions.innerHTML = '';
  actions.forEach((action) => {
    const button = createButton(action.label, action.className || '');
    if (action.disabled) button.disabled = true;
    button.addEventListener('click', action.onClick);
    serverModalActions.appendChild(button);
  });
}

function getFocusableElements(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    return element.offsetParent !== null || element === document.activeElement;
  });
}

function handleServerModalKeydown(event) {
  if (!activeServerModal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeServerModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = getFocusableElements(serverModalDialog || serverModalOverlay);
  if (!focusable.length) {
    event.preventDefault();
    serverModalDialog?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openServerModal({ title, bodyRenderer, actions = [], onClose = null }) {
  if (!serverModalOverlay || !serverModalTitle || !serverModalBody) return;
  if (activeServerModal) {
    closeServerModal('replace');
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  activeServerModal = { onClose, previousFocus };
  serverModalTitle.textContent = title;
  serverModalBody.innerHTML = '';
  if (typeof bodyRenderer === 'function') {
    bodyRenderer(serverModalBody);
  }
  setServerModalActions(actions);
  serverModalOverlay.hidden = false;
  serverModalOverlay.removeAttribute('hidden');
  document.addEventListener('keydown', handleServerModalKeydown);
  requestAnimationFrame(() => {
    const focusable = getFocusableElements(serverModalDialog || serverModalOverlay);
    (focusable[0] || serverModalDialog)?.focus();
  });
}

function closeServerModal(reason = 'close') {
  if (!serverModalOverlay) return;
  const current = activeServerModal;
  activeServerModal = null;
  serverModalOverlay.hidden = true;
  serverModalOverlay.setAttribute('hidden', '');
  if (serverModalBody) serverModalBody.innerHTML = '';
  if (serverModalActions) serverModalActions.innerHTML = '';
  document.removeEventListener('keydown', handleServerModalKeydown);
  if (current?.previousFocus?.isConnected && typeof current.previousFocus.focus === 'function') {
    current.previousFocus.focus();
  }
  if (current?.onClose) current.onClose(reason);
}

function chooseFromServerModal({ title, message, actions }) {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    openServerModal({
      title,
      bodyRenderer: (body) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = message;
        body.appendChild(paragraph);
      },
      actions: actions.map(action => ({
        ...action,
        onClick: () => {
          const value = Object.prototype.hasOwnProperty.call(action, 'value') ? action.value : null;
          settle(value);
          closeServerModal('choose');
        },
      })),
      onClose: () => settle(null),
    });
  });
}

function getServerErrorMessage(result, fallbackId = 'server.actionFailed') {
  return result?.error?.message || translate(fallbackId);
}

async function probeServerSessionSilently({ force = false } = {}) {
  serverSession = { status: 'checking', user: null, error: null };
  updateServerSessionUi();
  const result = await probeSession({ apiClient, force });
  if (result.ok && result.status === 'ready') {
    serverSession = { status: 'ready', user: result.user || null, error: null };
  } else {
    serverSession = {
      status: result.status === 'error' ? 'error' : 'not_ready',
      user: null,
      error: result.error?.message || translate('server.signInRequired'),
    };
  }
  updateServerSessionUi();
  return result;
}

async function ensureServerSessionReady() {
  const result = await probeServerSessionSilently({ force: true });
  if (result.ok && result.status === 'ready') {
    return { ok: true, result };
  }
  showMessage({
    textId: result.status === 'not_ready' ? 'server.signInRequired' : 'server.sessionCheckFailed',
  });
  return { ok: false, result };
}

function startServerSignIn() {
  if (activeAuthFlow) {
    activeAuthFlow.cancel?.();
    activeAuthFlow = null;
  }
  const authFlowId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `roleplayscene_${Date.now()}`;
  activeAuthFlow = startAuthPopupFlow({
    apiClient,
    source: 'roleplayscene',
    authFlowId,
    pollIntervalMs: AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs,
    pollTimeoutMs: AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs,
    onPopupBlocked: () => showMessage({ textId: 'server.popupBlocked' }),
    onStatusMessage: () => showMessage({ textId: 'server.signInPending' }),
    onSessionReady: (result) => {
      serverSession = { status: 'ready', user: result.user || null, error: null };
      updateServerSessionUi();
      showMessage({ textId: 'server.signedIn' });
      activeAuthFlow = null;
    },
    onSessionNotReady: (result) => {
      if (result?.waitingForCallback) {
        showMessage({ textId: 'server.signInPending' });
        return;
      }
      serverSession = { status: 'not_ready', user: null, error: result?.error?.message || translate('server.signInRequired') };
      updateServerSessionUi();
      showMessage({ text: serverSession.error });
      activeAuthFlow = null;
    },
  });
}

function getUploadWarnings(data) {
  const warnings = [];
  const missingMediaCount = Number(data?.missing_media_count || 0);
  const validationWarningCount = Number(data?.validation_warning_count || 0);
  if (missingMediaCount > 0) {
    warnings.push(translate('server.missingMediaCount', { count: missingMediaCount }));
  }
  if (validationWarningCount > 0) {
    warnings.push(translate('server.validationWarningCount', { count: validationWarningCount }));
  }
  if (Array.isArray(data?.warnings)) {
    data.warnings.forEach((warning) => {
      if (typeof warning === 'string' && warning.trim()) {
        warnings.push(warning.trim());
      } else if (isRecord(warning) && isNonEmptyString(warning.message)) {
        warnings.push(warning.message.trim());
      }
    });
  }
  return warnings;
}

function showImportError(err) {
  const errors = Array.isArray(err?.errors) ? err.errors : [];
  const warnings = Array.isArray(err?.warnings) ? err.warnings : [];
  const codeToTextId = {
    [ImportErrorCode.INVALID_ZIP]: 'messages.importInvalidZip',
    [ImportErrorCode.MISSING_PROJECT_JSON]: 'messages.importMissingProjectJson',
    [ImportErrorCode.MISSING_PACKAGE_MANIFEST]: 'messages.importMissingPackageManifest',
    [ImportErrorCode.MISSING_PACKAGE_PROJECT]: 'messages.importMissingPackageProject',
    [ImportErrorCode.UNSUPPORTED_PACKAGE]: 'messages.importUnsupportedPackage',
    [ImportErrorCode.INVALID_JSON]: 'messages.importInvalidJson',
    [ImportErrorCode.INVALID_PROJECT]: 'messages.importInvalidProject',
  };
  showMessage({
    textId: codeToTextId[err?.code] ?? 'messages.importFailedSafe',
    errors,
    warnings,
  });
}

function closeImportConfirmation(result) {
  if (!activeImportConfirmation) return;
  const { resolve, previousFocus } = activeImportConfirmation;
  activeImportConfirmation = null;
  importConfirmOverlay.hidden = true;
  importConfirmOverlay.setAttribute('hidden', '');
  document.removeEventListener('keydown', handleImportConfirmationKeydown);
  if (previousFocus && typeof previousFocus.focus === 'function') {
    previousFocus.focus();
  }
  resolve(result);
}

function handleImportConfirmationKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeImportConfirmation(false);
    return;
  }
  if (event.key === 'Tab' && importConfirmAccept && importConfirmCancel) {
    const controls = [importConfirmCancel, importConfirmAccept];
    const currentIndex = controls.indexOf(document.activeElement);
    if (currentIndex === -1) return;
    event.preventDefault();
    const nextIndex = event.shiftKey
      ? (currentIndex + controls.length - 1) % controls.length
      : (currentIndex + 1) % controls.length;
    controls[nextIndex].focus();
  }
}

function confirmProjectImport() {
  if (!importConfirmOverlay || !importConfirmAccept || !importConfirmCancel) {
    return Promise.resolve(globalThis.confirm?.(translate('messages.importConfirmBody')) ?? false);
  }
  if (activeImportConfirmation) {
    closeImportConfirmation(false);
  }
  updateToolbarText();
  importConfirmOverlay.hidden = false;
  importConfirmOverlay.removeAttribute('hidden');
  document.addEventListener('keydown', handleImportConfirmationKeydown);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  requestAnimationFrame(() => {
    importConfirmAccept.focus();
  });
  return new Promise((resolve) => {
    activeImportConfirmation = { resolve, previousFocus };
  });
}

async function showUploadConflictModal(existingDraft) {
  const existingTitle = existingDraft?.title || translate('server.values.untitledDraft');
  return chooseFromServerModal({
    title: translate('server.conflictTitle'),
    message: translate('server.conflictBody', { title: existingTitle }),
    actions: [
      { label: translate('server.conflictReplace'), value: 'replace', className: 'confirm-actions__primary' },
      { label: translate('server.conflictCopy'), value: 'copy' },
      { label: translate('server.cancel'), value: null, className: 'confirm-actions__secondary' },
    ],
  });
}

async function showDeleteDraftConfirmation(draft) {
  const title = draft?.title || translate('server.values.untitledDraft');
  return chooseFromServerModal({
    title: translate('server.deleteTitle'),
    message: translate('server.deleteBody', { title }),
    actions: [
      { label: translate('server.deleteConfirm'), value: 'delete', className: 'confirm-actions__primary server-danger-action' },
      { label: translate('server.cancel'), value: null, className: 'confirm-actions__secondary' },
    ],
  });
}

function renderDraftMetadata(container, draft) {
  const metadata = document.createElement('dl');
  metadata.className = 'server-draft-meta';
  const rows = [
    [translate('server.meta.id'), getRolePlaySceneDraftId(draft) || '-'],
    [translate('server.meta.publishState'), translate(`server.publishState.${draft?.publish_state || 'draft_only'}`, { default: draft?.publish_state || 'draft_only' })],
    [translate('server.meta.size'), formatBytes(draft?.artifact_size_bytes)],
    [translate('server.meta.missingMedia'), String(Number(draft?.missing_media_count || 0))],
    [translate('server.meta.validationWarnings'), String(Number(draft?.validation_warning_count || 0))],
    [translate('server.meta.created'), formatTimestamp(draft?.created_at)],
    [translate('server.meta.updated'), formatTimestamp(draft?.updated_at)],
  ];
  rows.forEach(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    metadata.append(dt, dd);
  });
  container.appendChild(metadata);
}

function appendDraftWarningBadges(container, draft) {
  const missingMediaCount = Number(draft?.missing_media_count || 0);
  const validationWarningCount = Number(draft?.validation_warning_count || 0);
  if (missingMediaCount <= 0 && validationWarningCount <= 0) return;
  const badges = document.createElement('div');
  badges.className = 'server-draft-badges';
  if (missingMediaCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'server-draft-badge server-draft-badge--warn';
    badge.textContent = translate('server.missingMediaBadge', { count: missingMediaCount });
    badges.appendChild(badge);
  }
  if (validationWarningCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'server-draft-badge server-draft-badge--warn';
    badge.textContent = translate('server.validationWarningBadge', { count: validationWarningCount });
    badges.appendChild(badge);
  }
  container.appendChild(badges);
}

function renderUploadedDraftRows(container, drafts, { onDraftDeleted = null } = {}) {
  const list = document.createElement('div');
  list.className = 'server-draft-list';
  if (!drafts.length) {
    const empty = document.createElement('p');
    empty.className = 'server-empty';
    empty.textContent = translate('server.noDrafts');
    list.appendChild(empty);
    container.appendChild(list);
    return;
  }

  drafts.forEach((draft) => {
    const row = document.createElement('article');
    row.className = 'server-draft-row';
    const header = document.createElement('div');
    header.className = 'server-draft-row__header';
    const title = document.createElement('h3');
    title.textContent = draft?.title || translate('server.values.untitledDraft');
    header.appendChild(title);
    if (isNonEmptyString(draft?.description)) {
      const description = document.createElement('p');
      description.textContent = draft.description;
      header.appendChild(description);
    }
    row.appendChild(header);
    appendDraftWarningBadges(row, draft);
    renderDraftMetadata(row, draft);

    const actions = document.createElement('div');
    actions.className = 'server-draft-row__actions';
    const openButton = createButton(translate('server.openDraft'));
    openButton.addEventListener('click', () => openUploadedRolePlaySceneDraft(draft));
    const downloadButton = createButton(translate('server.downloadDraft'));
    downloadButton.addEventListener('click', () => downloadUploadedRolePlaySceneDraft(draft));
    const deleteButton = createButton(translate('server.deleteDraft'), 'server-danger-action');
    deleteButton.addEventListener('click', () => deleteUploadedRolePlaySceneDraft(draft, { onDraftDeleted }));
    actions.append(openButton, downloadButton, deleteButton);
    row.appendChild(actions);
    list.appendChild(row);
  });
  container.appendChild(list);
}

function renderUploadedDraftManager({
  drafts = uploadedDrafts,
  slotLimit = uploadedDraftSlotLimit,
  onDraftDeleted = null,
  onClose = null,
} = {}) {
  openServerModal({
    title: translate('server.manageTitle'),
    bodyRenderer: (body) => {
      const slotUsage = document.createElement('p');
      slotUsage.className = 'server-slot-usage';
      slotUsage.textContent = translate('server.slotUsage', {
        used: drafts.length,
        limit: slotLimit || 3,
      });
      body.appendChild(slotUsage);
      renderUploadedDraftRows(body, drafts, { onDraftDeleted });
    },
    actions: [
      {
        label: translate('server.refresh'),
        onClick: async () => {
          const result = await loadUploadedRolePlaySceneDrafts({ preflight: true, showManager: false });
          if (result?.ok) {
            renderUploadedDraftManager({ onDraftDeleted, onClose });
          }
        },
      },
      { label: translate('server.close'), onClick: () => closeServerModal(), className: 'confirm-actions__secondary' },
    ],
    onClose,
  });
}

function showSlotLimitRecoveryModal({ drafts = uploadedDrafts, slotLimit = uploadedDraftSlotLimit } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    renderUploadedDraftManager({
      drafts,
      slotLimit,
      onDraftDeleted: () => {
        closeServerModal('slot-recovery-delete');
        settle({ deleted: true });
      },
      onClose: (reason) => {
        if (reason !== 'slot-recovery-delete' && reason !== 'replace') {
          settle({ deleted: false });
        }
      },
    });
  });
}

async function loadUploadedRolePlaySceneDrafts({ preflight = true, showManager = false } = {}) {
  if (preflight) {
    const sessionReady = await ensureServerSessionReady();
    if (!sessionReady.ok) return sessionReady.result;
  }
  isLoadingUploadedDrafts = true;
  updateServerSessionUi();
  try {
    const result = await apiClient.listRolePlaySceneDrafts();
    if (!result.ok) {
      showMessage({ text: getServerErrorMessage(result, 'server.listFailed') });
      return result;
    }
    uploadedDrafts = Array.isArray(result.data?.items) ? result.data.items : [];
    const slotLimit = Number(result.data?.draftSlotLimit || result.data?.slotLimit);
    if (Number.isFinite(slotLimit) && slotLimit > 0) {
      uploadedDraftSlotLimit = slotLimit;
    }
    if (showManager) {
      renderUploadedDraftManager();
    }
    return result;
  } finally {
    isLoadingUploadedDrafts = false;
    updateServerSessionUi();
  }
}

async function uploadCurrentProjectToServer({ conflictAction = '', preflight = true } = {}) {
  if (isUploadingDraft) return { ok: false, skipped: true };
  if (preflight !== false) {
    const sessionReady = await ensureServerSessionReady();
    if (!sessionReady.ok) return sessionReady.result;
  }
  isUploadingDraft = true;
  updateServerSessionUi();
  try {
    showMessage({ textId: 'server.uploading' });
    const { archiveData, payload } = await createProjectArchive(store.get().project);
    const title = store.get().project?.meta?.title || payload?.manifest?.project?.title || '';
    const description = payload?.manifest?.project?.description || '';
    const result = await apiClient.uploadRolePlaySceneDraftPackage(archiveData, {
      title,
      description,
      conflictAction,
    });
    if (!result.ok) {
      const code = String(result.error?.code || '').toUpperCase();
      if (code === 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT') {
        const choice = await showUploadConflictModal(result.error?.details?.existingDraft);
        if (choice === 'replace' || choice === 'copy') {
          isUploadingDraft = false;
          updateServerSessionUi();
          return await uploadCurrentProjectToServer({ conflictAction: choice, preflight: false });
        }
        showMessage({ textId: 'server.uploadCanceled' });
        return result;
      }
      if (code === 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED') {
        const slotLimit = Number(result.error?.details?.slotLimit);
        if (Number.isFinite(slotLimit) && slotLimit > 0) {
          uploadedDraftSlotLimit = slotLimit;
        }
        uploadedDrafts = Array.isArray(result.error?.details?.uploadedDrafts)
          ? result.error.details.uploadedDrafts
          : uploadedDrafts;
        showMessage({ textId: 'server.slotLimitReached' });
        const recovery = await showSlotLimitRecoveryModal({ drafts: uploadedDrafts, slotLimit: uploadedDraftSlotLimit });
        if (recovery?.deleted) {
          isUploadingDraft = false;
          updateServerSessionUi();
          return await uploadCurrentProjectToServer({ conflictAction, preflight: false });
        }
        return result;
      }
      showMessage({ text: getServerErrorMessage(result, 'server.uploadFailed') });
      return result;
    }
    const warnings = getUploadWarnings(result.data);
    showMessage({
      textId: warnings.length ? 'server.uploadedWithWarnings' : 'server.uploaded',
      textArgs: { id: result.data?.roleplayscene_uploaded_draft_id || '' },
      warnings,
    });
    await loadUploadedRolePlaySceneDrafts({ preflight: false });
    return result;
  } catch (err) {
    console.error(err);
    showMessage({ textId: 'server.uploadFailed' });
    return { ok: false, error: { message: err?.message || String(err) } };
  } finally {
    isUploadingDraft = false;
    updateServerSessionUi();
  }
}

async function openUploadedRolePlaySceneDraft(draft) {
  const uploadedDraftId = getRolePlaySceneDraftId(draft);
  if (!uploadedDraftId) return;
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) return;
  let preparedImport = null;
  try {
    showMessage({ textId: 'server.openingDraft' });
    const artifact = await apiClient.fetchRolePlaySceneDraftArtifact(uploadedDraftId);
    if (!artifact.ok) {
      showMessage({ text: getServerErrorMessage(artifact, 'server.openFailed') });
      return;
    }
    preparedImport = await prepareProjectImport(createZipFileFromBytes(
      artifact.data,
      `${sanitizeFilename(draft?.title, 'roleplayscene-draft')}.zip`,
    ));
    closeServerModal('import-confirm');
    const shouldImport = await confirmProjectImport();
    if (!shouldImport) {
      revokeProjectObjectUrls(preparedImport.project);
      showMessage({ textId: 'messages.importCanceled' });
      return;
    }
    await applyPreparedProjectImport(store, preparedImport);
    const missingMediaWarnings = preparedImport.missingMediaPaths.map(path => (
      translate('messages.importMissingMediaWarning', { path })
    ));
    const validationWarnings = Array.isArray(preparedImport.validation?.warnings)
      ? preparedImport.validation.warnings
      : [];
    showMessage({
      textId: missingMediaWarnings.length || validationWarnings.length
        ? 'server.openedDraftWithWarnings'
        : 'server.openedDraft',
      warnings: [...validationWarnings, ...missingMediaWarnings],
    });
    setMode('edit');
  } catch (err) {
    console.error(err);
    if (preparedImport?.project && store.get().project !== preparedImport.project) {
      revokeProjectObjectUrls(preparedImport.project);
    }
    showImportError(err);
  }
}

async function downloadUploadedRolePlaySceneDraft(draft) {
  const uploadedDraftId = getRolePlaySceneDraftId(draft);
  if (!uploadedDraftId) return;
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) return;
  const artifact = await apiClient.fetchRolePlaySceneDraftArtifact(uploadedDraftId);
  if (!artifact.ok) {
    showMessage({ text: getServerErrorMessage(artifact, 'server.downloadFailed') });
    return;
  }
  const blob = new Blob([artifact.data], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sanitizeFilename(draft?.title, 'roleplayscene-draft')}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showMessage({ textId: 'server.downloadedDraft' });
}

async function deleteUploadedRolePlaySceneDraft(draft, { onDraftDeleted = null } = {}) {
  const uploadedDraftId = getRolePlaySceneDraftId(draft);
  if (!uploadedDraftId) return;
  const choice = await showDeleteDraftConfirmation(draft);
  if (choice !== 'delete') return;
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) return;
  const result = await apiClient.deleteRolePlaySceneDraft(uploadedDraftId);
  if (!result.ok) {
    showMessage({ text: getServerErrorMessage(result, 'server.deleteFailed') });
    return;
  }
  showMessage({ textId: 'server.deletedDraft' });
  if (typeof onDraftDeleted === 'function') {
    onDraftDeleted(result);
    return result;
  }
  const refreshResult = await loadUploadedRolePlaySceneDrafts({ preflight: false });
  if (refreshResult?.ok) {
    renderUploadedDraftManager();
  }
}

if (importConfirmAccept) {
  importConfirmAccept.addEventListener('click', () => closeImportConfirmation(true));
}

if (importConfirmCancel) {
  importConfirmCancel.addEventListener('click', () => closeImportConfirmation(false));
}

if (importConfirmOverlay) {
  importConfirmOverlay.addEventListener('click', (event) => {
    if (event.target === importConfirmOverlay) {
      closeImportConfirmation(false);
    }
  });
}

if (serverModalClose) {
  serverModalClose.addEventListener('click', () => closeServerModal());
}

if (serverModalOverlay) {
  serverModalOverlay.addEventListener('click', (event) => {
    if (event.target === serverModalOverlay) {
      closeServerModal();
    }
  });
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
serverSignInButton?.addEventListener('click', () => startServerSignIn());
serverSaveButton?.addEventListener('click', () => {
  uploadCurrentProjectToServer().catch((err) => {
    console.error(err);
    showMessage({ textId: 'server.uploadFailed' });
  });
});
serverManageButton?.addEventListener('click', () => {
  loadUploadedRolePlaySceneDrafts({ preflight: true, showManager: true }).catch((err) => {
    console.error(err);
    showMessage({ textId: 'server.listFailed' });
  });
});
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let preparedImport = null;
  try {
    showMessage({ textId: 'messages.importingProject' });
    preparedImport = await prepareProjectImport(file);
    const shouldImport = await confirmProjectImport();
    if (!shouldImport) {
      revokeProjectObjectUrls(preparedImport.project);
      showMessage({ textId: 'messages.importCanceled' });
      return;
    }
    await applyPreparedProjectImport(store, preparedImport);
    const missingMediaWarnings = preparedImport.missingMediaPaths.map(path => (
      translate('messages.importMissingMediaWarning', { path })
    ));
    const validationWarnings = Array.isArray(preparedImport.validation?.warnings)
      ? preparedImport.validation.warnings
      : [];
    const warnings = [...validationWarnings, ...missingMediaWarnings];
    showMessage({
      textId: warnings.length ? 'messages.importedProjectWithWarnings' : 'messages.importedProject',
      warnings,
    });
    setMode('edit');
  } catch (err) {
    console.error(err);
    if (preparedImport?.project && store.get().project !== preparedImport.project) {
      revokeProjectObjectUrls(preparedImport.project);
    }
    showImportError(err);
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
  probeServerSessionSilently().catch((err) => {
    console.error('Failed to probe server session', err);
    serverSession = { status: 'error', user: null, error: err?.message || String(err) };
    updateServerSessionUi();
  });
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
  if (activeAuthFlow?.cancel) {
    activeAuthFlow.cancel();
  }
});
