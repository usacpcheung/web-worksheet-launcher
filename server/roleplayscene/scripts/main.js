import { Store } from './state.js';
import { renderEditor } from './editor/editor.js';
import { renderPlayer } from './player/player.js';
import { RolePlaySceneDiscussionSession, computeDiscussionProjectFingerprint } from './player/discussion-state.js';
import { buildDiscussionPrintHtml, buildDiscussionPrintModel } from './player/discussion-print.js';
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
import { translate, onLocaleChange, getActiveLocale, getAvailableLocales, LOCALE_STORAGE_KEY } from './i18n.js';
import { createServerApiClient } from '../../app/api/server-api-client.js';
import { probeSession } from '../../app/auth/session-readiness.js';
import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from '../../app/auth/auth-popup-flow.js';

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
const serverBrowsePublishedButton = document.getElementById('server-browse-published-btn');
const publishedExitButton = document.getElementById('published-exit-btn');
const fileInput = document.getElementById('file-input');
const topbar = document.querySelector('.topbar');
const topbarTitle = document.querySelector('.topbar h1');
const localeSelect = document.getElementById('locale-select');
const localeLabel = document.querySelector('.toolbar__locale-label');
const toolbar = document.querySelector('.toolbar');
const toolbarFiles = document.querySelector('.toolbar__files');
const toolbarServer = document.querySelector('.toolbar__server');
const toolbarLocale = document.querySelector('.toolbar__locale');
const toolbarOverflow = document.getElementById('toolbar-overflow');
const toolbarMoreButton = document.getElementById('toolbar-more-btn');
const toolbarMoreMenu = document.getElementById('toolbar-more-menu');
const toolbarMoreServerGroup = document.getElementById('toolbar-more-server-group');
const toolbarMoreServerTitle = document.getElementById('toolbar-more-server-title');
const toolbarMoreServerItems = document.getElementById('toolbar-more-server-items');
const toolbarMoreProjectGroup = document.getElementById('toolbar-more-project-group');
const toolbarMoreProjectTitle = document.getElementById('toolbar-more-project-title');
const toolbarMoreProjectItems = document.getElementById('toolbar-more-project-items');
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
const discussionSession = new RolePlaySceneDiscussionSession({ apiClient });

let mode = 'edit'; // 'edit' | 'play'
let teardown = null;
let editorSession = {
  selectedSceneId: null,
  leftView: 'storyMap',
  selectedSpeechBubbleAnchorId: null,
};
let editorPreview = null;
let persistenceCleanup = () => {};
let lastMessagePayload = null;
let activeImportConfirmation = null;
let activeServerModal = null;
let activeAuthFlow = null;
let serverSession = { status: 'checking', user: null, error: null };
let uploadedDrafts = [];
let uploadedDraftSlotLimit = 3;

const ImportConfirmationKind = Object.freeze({
  IMPORT: 'import',
  DISCUSSION_DISCARD: 'discussion-discard',
});
let isLoadingUploadedDrafts = false;
let isUploadingDraft = false;
const publishingDraftIds = new Set();
let publishedScenes = [];
let publishedScenesHasMore = false;
let publishedScenesNextOffset = null;
let publishedScenesFilters = { q: '', title: '', description: '', owner: '' };
let isLoadingPublishedScenes = false;
let publishedScenesRequestId = 0;
let openingPublishedSceneIds = new Set();
let publishedPlay = { active: false, store: null, preparedImport: null, scene: null };
let pendingDirectPublishedSceneId = '';
let discussionPrintDetails = { schoolName: '', schoolNameCustom: false, studentName: '' };
let activePlaybackState = null;

const LEGACY_LOCALE_STORAGE_KEY = 'roleplayscene:locale';
const PLAY_SESSION_STORAGE_KEY = 'roleplayscene:play-session:v1';
const HEADER_TABLET_MIN_WIDTH = 768;
const HEADER_COMPACT_MAX_WIDTH = 1023;
const DEFAULT_TOPBAR_HEIGHT_PX = 64;

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

function getViewportWidth() {
  if (typeof globalThis.innerWidth === 'number' && Number.isFinite(globalThis.innerWidth)) {
    return globalThis.innerWidth;
  }
  const docWidth = Number(document?.documentElement?.clientWidth || 0);
  return Number.isFinite(docWidth) && docWidth > 0 ? docWidth : 1024;
}

function getHeaderLayoutMode() {
  const width = getViewportWidth();
  if (width > HEADER_COMPACT_MAX_WIDTH) return 'desktop';
  if (width >= HEADER_TABLET_MIN_WIDTH) return 'tablet';
  return 'mobile';
}

function syncTopbarHeightVariable() {
  const measuredHeight = Number(
    topbar?.getBoundingClientRect?.().height
    || topbar?.offsetHeight
    || DEFAULT_TOPBAR_HEIGHT_PX
  );
  const height = Number.isFinite(measuredHeight) && measuredHeight > 0
    ? Math.ceil(measuredHeight)
    : DEFAULT_TOPBAR_HEIGHT_PX;
  document.documentElement?.style?.setProperty('--roleplayscene-topbar-height', `${height}px`);
}

function setToolbarOverflowOpen(open) {
  if (!toolbarMoreButton || !toolbarMoreMenu || !toolbarOverflow || toolbarOverflow.hidden) {
    if (toolbarMoreMenu) toolbarMoreMenu.hidden = true;
    if (toolbarMoreButton) toolbarMoreButton.setAttribute('aria-expanded', 'false');
    if (toolbarOverflow?.classList?.remove) toolbarOverflow.classList.remove('is-open');
    return;
  }
  toolbarMoreMenu.hidden = !open;
  toolbarMoreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  toolbarOverflow.classList.toggle('is-open', open);
}

function moveToolbarNode(node, target) {
  if (!node || !target || node.parentElement === target) return;
  target.appendChild(node);
}

function hostHasVisibleItems(host) {
  if (!host) return false;
  return Array.from(host.children || []).some((child) => child instanceof HTMLElement && !child.hidden);
}

function isDesktopToolbarWrapped() {
  if (!toolbar || typeof HTMLElement !== 'function') return false;
  if (getHeaderLayoutMode() !== 'desktop') return false;

  const visibleItems = Array.from(toolbar.children || []).filter((child) => (
    child instanceof HTMLElement && !child.hidden
  ));

  if (visibleItems.length <= 1) return false;

  // Measure against the base layout so wrapped-state classes do not skew detection.
  toolbar.classList.remove('toolbar--wrapped');
  topbar?.classList?.remove?.('topbar--wrapped');

  const tops = visibleItems.map((child) => Number(child?.offsetTop || 0));
  const heights = visibleItems.map((child) => Number(child?.offsetHeight || 0));
  const minTop = Math.min(...tops);
  const maxTop = Math.max(...tops);
  const maxHeight = Math.max(...heights, 0);
  return (maxTop - minTop) > Math.max(12, Math.floor(maxHeight * 0.55));
}

function updateToolbarWrapState() {
  if (!toolbar?.classList) return;

  const clearWrappedState = () => {
    toolbar.classList.remove('toolbar--wrapped');
    topbar?.classList?.remove?.('topbar--wrapped');
  };

  if (getHeaderLayoutMode() !== 'desktop' || typeof HTMLElement !== 'function') {
    clearWrappedState();
    return;
  }

  const wrapped = isDesktopToolbarWrapped();

  toolbar.classList.toggle('toolbar--wrapped', wrapped);
  topbar?.classList?.toggle?.('topbar--wrapped', wrapped);
}

function updateMobileServerBadgeLayout() {
  if (!toolbar?.classList || !toolbarServer) return;

  toolbar.classList.remove('toolbar--server-stacked');
  topbar?.classList?.remove?.('topbar--server-stacked');

  if (getHeaderLayoutMode() !== 'mobile' || typeof HTMLElement !== 'function') {
    return;
  }

  const modeGroup = toolbar.querySelector('.toolbar__mode');
  const overflowGroup = toolbar.querySelector('.toolbar__overflow');
  if (!(modeGroup instanceof HTMLElement) || !(overflowGroup instanceof HTMLElement) || toolbarServer.hidden) {
    return;
  }

  const toolbarWidth = Number(toolbar.clientWidth || 0);
  if (!Number.isFinite(toolbarWidth) || toolbarWidth <= 0) {
    return;
  }

  const computed = typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(toolbar)
    : null;
  const rawGap = computed?.columnGap || computed?.gap || '0';
  const gap = Number.parseFloat(rawGap) || 0;

  const modeWidth = Number(modeGroup.offsetWidth || 0);
  const serverBadge = toolbarServer.querySelector('.server-status');
  const serverWidth = serverBadge instanceof HTMLElement
    ? Number(serverBadge.offsetWidth || 0)
    : Number(toolbarServer.offsetWidth || 0);
  const overflowWidth = overflowGroup.hidden ? 0 : Number(overflowGroup.offsetWidth || 0);
  const visibleGroups = [modeWidth > 0, serverWidth > 0, overflowWidth > 0].filter(Boolean).length;
  const requiredWidth = modeWidth + serverWidth + overflowWidth + Math.max(0, visibleGroups - 1) * gap;
  const rowWrapped = [modeGroup, toolbarServer, overflowGroup]
    .filter((element) => !element.hidden && Number(element.offsetWidth || 0) > 0)
    .some((element) => Math.abs(Number(element.offsetTop || 0) - Number(modeGroup.offsetTop || 0)) > 12);

  if (requiredWidth > toolbarWidth + 2 || rowWrapped) {
    toolbar.classList.add('toolbar--server-stacked');
    topbar?.classList?.add?.('topbar--server-stacked');
  }
}

function applyDesktopWrapOverflowFallback() {
  moveToolbarNode(serverSaveButton, toolbarMoreServerItems);
  moveToolbarNode(serverManageButton, toolbarMoreServerItems);
  moveToolbarNode(serverBrowsePublishedButton, toolbarMoreServerItems);
  moveToolbarNode(publishedExitButton, toolbarMoreServerItems);
  moveToolbarNode(toolbarLocale, toolbarMoreProjectItems);

  if (toolbarLocale) {
    toolbarLocale.hidden = false;
  }

  const showServerGroup = hostHasVisibleItems(toolbarMoreServerItems);
  const showProjectGroup = hostHasVisibleItems(toolbarMoreProjectItems);
  if (toolbarMoreServerGroup) toolbarMoreServerGroup.hidden = !showServerGroup;
  if (toolbarMoreProjectGroup) toolbarMoreProjectGroup.hidden = !showProjectGroup;

  const hasOverflowItems = showServerGroup || showProjectGroup;
  if (toolbarOverflow) {
    toolbarOverflow.hidden = !hasOverflowItems;
  }
  if (toolbarMoreButton) {
    toolbarMoreButton.hidden = !hasOverflowItems;
  }
  if (!hasOverflowItems) {
    setToolbarOverflowOpen(false);
  }
}

function restoreDesktopToolbarLayout() {
  moveToolbarNode(btnImport, toolbarFiles);
  moveToolbarNode(btnExport, toolbarFiles);
  moveToolbarNode(serverSignInButton, toolbarServer);
  moveToolbarNode(serverSaveButton, toolbarServer);
  moveToolbarNode(serverManageButton, toolbarServer);
  moveToolbarNode(serverBrowsePublishedButton, toolbarServer);
  moveToolbarNode(publishedExitButton, toolbarServer);

  if (toolbarLocale && toolbar) {
    moveToolbarNode(toolbarLocale, toolbar);
    if (toolbarOverflow) {
      toolbar.insertBefore(toolbarLocale, toolbarOverflow);
    }
    toolbarLocale.hidden = false;
  }

  if (toolbarFiles) {
    toolbarFiles.hidden = false;
  }

  if (toolbarOverflow) {
    toolbarOverflow.hidden = true;
  }
  if (toolbarMoreServerGroup) toolbarMoreServerGroup.hidden = true;
  if (toolbarMoreProjectGroup) toolbarMoreProjectGroup.hidden = true;
  setToolbarOverflowOpen(false);
}

function applyToolbarOverflowLayout() {
  if (!toolbar || !toolbarOverflow || !toolbarMoreServerItems || !toolbarMoreProjectItems) {
    syncTopbarHeightVariable();
    return;
  }

  const layoutMode = getHeaderLayoutMode();
  if (layoutMode === 'desktop') {
    restoreDesktopToolbarLayout();
    if (isDesktopToolbarWrapped()) {
      applyDesktopWrapOverflowFallback();
    }
    updateToolbarWrapState();
    updateMobileServerBadgeLayout();
    syncTopbarHeightVariable();
    return;
  }

  moveToolbarNode(btnImport, toolbarMoreProjectItems);
  moveToolbarNode(btnExport, toolbarMoreProjectItems);
  moveToolbarNode(toolbarLocale, toolbarMoreProjectItems);

  moveToolbarNode(serverSaveButton, toolbarMoreServerItems);
  moveToolbarNode(serverManageButton, toolbarMoreServerItems);
  moveToolbarNode(serverBrowsePublishedButton, toolbarMoreServerItems);
  moveToolbarNode(publishedExitButton, toolbarMoreServerItems);

  if (layoutMode === 'tablet') {
    moveToolbarNode(serverSignInButton, toolbarServer);
  } else {
    moveToolbarNode(serverSignInButton, toolbarMoreServerItems);
  }

  if (toolbarFiles) {
    toolbarFiles.hidden = true;
  }

  if (toolbarLocale) {
    toolbarLocale.hidden = false;
  }

  const showServerGroup = hostHasVisibleItems(toolbarMoreServerItems);
  const showProjectGroup = hostHasVisibleItems(toolbarMoreProjectItems);
  if (toolbarMoreServerGroup) toolbarMoreServerGroup.hidden = !showServerGroup;
  if (toolbarMoreProjectGroup) toolbarMoreProjectGroup.hidden = !showProjectGroup;

  const hasOverflowItems = showServerGroup || showProjectGroup;
  toolbarOverflow.hidden = !hasOverflowItems;
  if (toolbarMoreButton) {
    toolbarMoreButton.hidden = !hasOverflowItems;
  }
  if (!hasOverflowItems) {
    setToolbarOverflowOpen(false);
  }

  updateToolbarWrapState();
  updateMobileServerBadgeLayout();
  syncTopbarHeightVariable();
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
    btnEdit.textContent = editorPreview && !publishedPlay.active
      ? translate('toolbar.backToEdit')
      : translate('toolbar.edit');
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
  if (serverBrowsePublishedButton) {
    serverBrowsePublishedButton.textContent = isLoadingPublishedScenes
      ? translate('published.refreshing')
      : translate('published.browse');
  }
  if (publishedExitButton) {
    publishedExitButton.textContent = translate('published.exit');
  }
  if (localeLabel) {
    localeLabel.textContent = translate('toolbar.languageLabel');
  }
  if (localeSelect) {
    localeSelect.setAttribute('aria-label', translate('toolbar.languageLabel'));
  }
  if (toolbarMoreButton) {
    const moreLabel = translate('toolbar.more');
    toolbarMoreButton.textContent = moreLabel;
    toolbarMoreButton.setAttribute('aria-label', moreLabel);
  }
  if (toolbarMoreServerTitle) {
    toolbarMoreServerTitle.textContent = translate('toolbar.moreServerGroup');
  }
  if (toolbarMoreProjectTitle) {
    toolbarMoreProjectTitle.textContent = translate('toolbar.moreProjectGroup');
  }
  if (toolbarMoreMenu) {
    toolbarMoreMenu.setAttribute('aria-label', translate('toolbar.moreMenuLabel'));
  }
  if (dismissButton) {
    dismissButton.setAttribute('aria-label', translate('toolbar.dismissMessage'));
  }
  applyImportConfirmationCopy(
    activeImportConfirmation?.kind || ImportConfirmationKind.IMPORT,
    activeImportConfirmation?.options || {}
  );
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
  if (publishedPlay.store) {
    publishedPlay.store.setLocale(nextLocale);
  }
  updateToolbarText();
  populateLocaleOptions();
  if (localeSelect) {
    localeSelect.value = nextLocale;
  }
  if (lastMessagePayload) {
    showMessage(lastMessagePayload);
  }
  syncTopbarHeightVariable();
}

function migrateLegacyLocalePreference() {
  let storage = null;
  try {
    storage = globalThis.localStorage || null;
  } catch {
    storage = null;
  }
  if (!storage) return;
  try {
    if (storage.getItem(LOCALE_STORAGE_KEY)) return;
    const legacyLocale = storage.getItem(LEGACY_LOCALE_STORAGE_KEY);
    if (!legacyLocale) return;
    store.setLocale(legacyLocale);
    storage.setItem(LOCALE_STORAGE_KEY, store.get().locale);
    storage.removeItem?.(LEGACY_LOCALE_STORAGE_KEY);
  } catch {
    // Locale migration should not block app startup.
  }
}

function getActiveStore() {
  return publishedPlay.active && publishedPlay.store ? publishedPlay.store : store;
}

function getSessionStorage() {
  try {
    const storage = globalThis.sessionStorage;
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
}

function readPlaySessionRecovery() {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(PLAY_SESSION_STORAGE_KEY) || 'null');
    if (!parsed || parsed.version !== 1 || !['edit', 'play'].includes(parsed.mode)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePlaySessionRecovery(next = {}) {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(PLAY_SESSION_STORAGE_KEY, JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      ...next,
    }));
  } catch {
    // Same-tab recovery is best effort only.
  }
}

function getProjectFingerprint(project = getActiveStore().get().project) {
  return computeDiscussionProjectFingerprint(project);
}

function getMatchingPlaybackRecovery(project, { publishedSceneId = '' } = {}) {
  const recovery = readPlaySessionRecovery();
  if (!recovery || recovery.mode !== 'play') return null;
  if (publishedSceneId && recovery.publishedSceneId !== publishedSceneId) return null;
  if (!publishedSceneId && recovery.publishedSceneId) return null;
  if (recovery.projectFingerprint !== getProjectFingerprint(project)) return null;
  return recovery.playbackState && typeof recovery.playbackState === 'object'
    ? recovery.playbackState
    : {};
}

function persistCurrentAppMode(extra = {}) {
  if (Object.prototype.hasOwnProperty.call(extra, 'playbackState')) {
    activePlaybackState = extra.playbackState ?? null;
  }
  const activeProject = getActiveStore().get().project;
  writePlaySessionRecovery({
    mode,
    projectFingerprint: getProjectFingerprint(activeProject),
    publishedSceneId: publishedPlay.active ? getRolePlayScenePublishedSceneId(publishedPlay.scene) : '',
    playbackState: mode === 'play' ? activePlaybackState : null,
  });
}

function setMode(next, options = {}) {
  if (teardown) {
    teardown();
    teardown = null;
  }
  mode = next;
  if (mode === 'edit') {
    activePlaybackState = null;
  }
  btnEdit.classList.toggle('active', mode === 'edit');
  btnPlay.classList.toggle('active', mode === 'play');
  if (appRoot) {
    appRoot.classList.toggle('layout--edit', mode === 'edit');
    appRoot.classList.toggle('layout--play', mode === 'play');
    appRoot.classList.toggle('layout--published-play', publishedPlay.active);
  }
  document.body?.classList.toggle('roleplayscene-editor-mode', mode === 'edit');
  if (mode === 'edit') {
    teardown = renderEditor(getActiveStore(), elLeft, elRight, showMessage, {
      apiClient,
      ensureServerSessionReady,
      initialSelectedSceneId: editorSession.selectedSceneId,
      initialLeftView: editorSession.leftView,
      initialSelectedSpeechBubbleAnchorId: editorSession.selectedSpeechBubbleAnchorId,
      onEditorContextChange: updateEditorSession,
      onPreviewCurrentScene: startEditorScenePreview,
    });
  } else {
    discussionSession.bindProject(getActiveStore().get().project);
    teardown = renderPlayer(getActiveStore(), elLeft, elRight, showMessage, {
      initialSceneId: options.initialSceneId ?? null,
      initialPlaybackState: options.initialPlaybackState ?? null,
      discussionSession,
      apiClient,
      onDiscussionChange: () => persistCurrentAppMode(),
      onPlaybackStateChange: (playbackState) => persistCurrentAppMode({ playbackState }),
      onPrintDiscussion: printRolePlaySceneDiscussion,
    });
  }
  persistCurrentAppMode();
  updateToolbarText();
  updatePublishedPlayUi();
}

function updateEditorSession(nextContext = {}) {
  editorSession = {
    selectedSceneId: nextContext.selectedSceneId ?? null,
    leftView: ['storyMap', 'scenePreview'].includes(nextContext.leftView)
      ? nextContext.leftView
      : 'storyMap',
    selectedSpeechBubbleAnchorId: nextContext.selectedSpeechBubbleAnchorId ?? null,
  };
}

function blurActiveElement() {
  const activeElement = document.activeElement;
  if (
    typeof HTMLElement === 'function'
    && activeElement instanceof HTMLElement
    && typeof activeElement.blur === 'function'
  ) {
    activeElement.blur();
  }
}

function startEditorScenePreview(context = {}) {
  const sceneId = context.sceneId ?? editorSession.selectedSceneId;
  const sceneExists = store.get().project.scenes.some(scene => scene.id === sceneId);
  if (!sceneExists) {
    showMessage({ textId: 'player.sceneMissing' });
    return;
  }
  blurActiveElement();
  updateEditorSession({
    selectedSceneId: sceneId,
    leftView: context.leftView ?? editorSession.leftView,
    selectedSpeechBubbleAnchorId: context.selectedSpeechBubbleAnchorId ?? editorSession.selectedSpeechBubbleAnchorId,
  });
  editorPreview = {
    initialSceneId: sceneId,
    returnSceneId: sceneId,
    returnLeftView: editorSession.leftView,
    returnSelectedSpeechBubbleAnchorId: editorSession.selectedSpeechBubbleAnchorId,
  };
  ensureAudioGate(store);
  setMode('play', { initialSceneId: sceneId });
  clearMessage();
}

function returnFromEditorScenePreview() {
  if (!editorPreview) {
    setMode('edit');
    return;
  }
  editorSession = {
    selectedSceneId: editorPreview.returnSceneId,
    leftView: editorPreview.returnLeftView,
    selectedSpeechBubbleAnchorId: editorPreview.returnSelectedSpeechBubbleAnchorId,
  };
  editorPreview = null;
  setMode('edit');
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
  lastMessagePayload = null;
  if (!messageHost || !messageText || !messageDetails) return;
  messageText.textContent = '';
  messageDetails.innerHTML = '';
  messageDetails.hidden = true;
  messageHost.hidden = true;
  messageHost.setAttribute('hidden', '');
}

function dismissMessage() {
  clearMessage();
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
  if (serverBrowsePublishedButton) {
    serverBrowsePublishedButton.disabled = isLoadingPublishedScenes;
    serverBrowsePublishedButton.textContent = isLoadingPublishedScenes ? translate('published.refreshing') : translate('published.browse');
  }
  updatePublishedPlayUi();
}

function updatePublishedPlayUi() {
  const inPublishedPlay = Boolean(publishedPlay.active);
  const inEditorPreview = Boolean(editorPreview) && !inPublishedPlay;
  [btnEdit, btnImport, btnExport, serverSaveButton, serverManageButton].forEach((control) => {
    if (control) control.hidden = inPublishedPlay;
  });
  if (btnEdit && !inPublishedPlay) {
    btnEdit.hidden = false;
  }
  if (btnPlay) {
    btnPlay.hidden = inEditorPreview ? true : false;
    btnPlay.disabled = inPublishedPlay || inEditorPreview;
  }
  if (serverBrowsePublishedButton) {
    serverBrowsePublishedButton.hidden = false;
  }
  if (publishedExitButton) {
    publishedExitButton.hidden = !inPublishedPlay;
  }
  applyToolbarOverflowLayout();
}

function getDirectPublishedSceneIdFromLocation() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    return String(params.get('publishedSceneId') || '').trim();
  } catch (err) {
    return '';
  }
}

function buildPublishedScenePlayUrl(sceneId) {
  const url = new URL(globalThis.location?.href || 'http://localhost/roleplayscene/');
  url.searchParams.set('publishedSceneId', sceneId);
  url.searchParams.delete('authReturn');
  url.hash = '';
  return url.toString();
}

function createButton(label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  return button;
}

function createActionLink(label, href, className = '') {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.className = ['server-action-link', className].filter(Boolean).join(' ');
  return link;
}

async function copyTextToClipboard(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
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
      if (pendingDirectPublishedSceneId) {
        const sceneId = pendingDirectPublishedSceneId;
        pendingDirectPublishedSceneId = '';
        openPublishedRolePlaySceneById(sceneId, { source: 'direct' }).catch((err) => {
          console.error(err);
          showMessage({ textId: 'published.openFailed' });
        });
      }
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

function getDefaultDiscussionPrintSchoolName() {
  return translate('player.discussion.defaultSchoolName');
}

function formatDiscussionPrintDate(date = new Date()) {
  try {
    return new Intl.DateTimeFormat(getActiveLocale(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

function readDiscussionPrintDetailsDraft() {
  const storedSchoolName = String(discussionPrintDetails.schoolName || '').trim();
  const useCustomSchoolName = discussionPrintDetails.schoolNameCustom && storedSchoolName;
  return {
    schoolName: useCustomSchoolName ? storedSchoolName : getDefaultDiscussionPrintSchoolName(),
    schoolNameCustom: useCustomSchoolName,
    studentName: String(discussionPrintDetails.studentName || '').trim(),
  };
}

function promptDiscussionPrintDetails() {
  if (!serverModalOverlay || !serverModalTitle || !serverModalBody || !serverModalActions) {
    return Promise.resolve(readDiscussionPrintDetailsDraft());
  }
  const draft = readDiscussionPrintDetailsDraft();
  return new Promise((resolve) => {
    let resolved = false;
    let schoolInput = null;
    let studentInput = null;
    let defaultModeButton = null;
    let customModeButton = null;
    let schoolNameCustom = draft.schoolNameCustom;
    let unsubscribeLocaleChange = null;
    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      if (unsubscribeLocaleChange) {
        unsubscribeLocaleChange();
        unsubscribeLocaleChange = null;
      }
      resolve(value);
    };
    const collectDetails = () => {
      const rawSchoolName = String(schoolInput?.value || '').trim();
      const nextSchoolName = schoolNameCustom
        ? rawSchoolName || getDefaultDiscussionPrintSchoolName()
        : getDefaultDiscussionPrintSchoolName();
      return {
        schoolName: nextSchoolName,
        schoolNameCustom: schoolNameCustom && Boolean(rawSchoolName),
        studentName: String(studentInput?.value || '').trim(),
      };
    };
    const syncSchoolNameMode = () => {
      if (schoolInput) {
        schoolInput.readOnly = !schoolNameCustom;
        schoolInput.classList.toggle('discussion-print-details-form__input--readonly', !schoolNameCustom);
        if (!schoolNameCustom) {
          schoolInput.value = getDefaultDiscussionPrintSchoolName();
        }
      }
      if (defaultModeButton) {
        defaultModeButton.setAttribute('aria-pressed', schoolNameCustom ? 'false' : 'true');
        defaultModeButton.classList.toggle('is-active', !schoolNameCustom);
      }
      if (customModeButton) {
        customModeButton.setAttribute('aria-pressed', schoolNameCustom ? 'true' : 'false');
        customModeButton.classList.toggle('is-active', schoolNameCustom);
      }
    };

    openServerModal({
      title: translate('player.discussion.printDetailsTitle'),
      bodyRenderer: (body) => {
        const form = document.createElement('form');
        form.className = 'discussion-print-details-form';

        const schoolLabel = document.createElement('label');
        schoolLabel.className = 'discussion-print-details-form__label';
        schoolLabel.textContent = translate('player.discussion.printSchoolName');
        const schoolModeRow = document.createElement('div');
        schoolModeRow.className = 'discussion-print-details-form__mode-row';
        const schoolModeLabel = document.createElement('span');
        schoolModeLabel.className = 'discussion-print-details-form__mode-label';
        schoolModeLabel.textContent = translate('player.discussion.printSchoolNameMode');
        const schoolModeGroup = document.createElement('div');
        schoolModeGroup.className = 'discussion-print-details-form__mode';
        schoolModeGroup.setAttribute('role', 'group');
        schoolModeGroup.setAttribute('aria-label', translate('player.discussion.printSchoolNameMode'));
        defaultModeButton = document.createElement('button');
        defaultModeButton.type = 'button';
        defaultModeButton.className = 'discussion-print-details-form__mode-button';
        defaultModeButton.textContent = translate('player.discussion.printSchoolNameDefault');
        defaultModeButton.addEventListener('click', () => {
          schoolNameCustom = false;
          syncSchoolNameMode();
        });
        customModeButton = document.createElement('button');
        customModeButton.type = 'button';
        customModeButton.className = 'discussion-print-details-form__mode-button';
        customModeButton.textContent = translate('player.discussion.printSchoolNameCustom');
        customModeButton.addEventListener('click', () => {
          schoolNameCustom = true;
          syncSchoolNameMode();
          schoolInput?.focus();
        });
        schoolModeGroup.append(defaultModeButton, customModeButton);
        schoolModeRow.append(schoolModeLabel, schoolModeGroup);
        schoolInput = document.createElement('input');
        schoolInput.type = 'text';
        schoolInput.maxLength = 180;
        schoolInput.value = draft.schoolName;
        schoolInput.className = 'discussion-print-details-form__input';
        schoolInput.autocomplete = 'organization';
        schoolInput.addEventListener('input', () => { schoolNameCustom = true; syncSchoolNameMode(); });
        schoolLabel.appendChild(schoolInput);

        const studentLabel = document.createElement('label');
        studentLabel.className = 'discussion-print-details-form__label';
        studentLabel.textContent = translate('player.discussion.printStudentName');
        studentInput = document.createElement('input');
        studentInput.type = 'text';
        studentInput.maxLength = 120;
        studentInput.value = draft.studentName;
        studentInput.placeholder = translate('player.discussion.printStudentNamePlaceholder');
        studentInput.className = 'discussion-print-details-form__input';
        studentInput.autocomplete = 'name';
        studentLabel.appendChild(studentInput);

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const details = collectDetails();
          discussionPrintDetails = details;
          settle(details);
          closeServerModal('print');
        });
        form.append(schoolModeRow, schoolLabel, studentLabel);
        body.appendChild(form);
        syncSchoolNameMode();
        unsubscribeLocaleChange = onLocaleChange(() => {
          if (!schoolInput || schoolNameCustom) return;
          syncSchoolNameMode();
        });
      },
      actions: [
        {
          label: translate('player.discussion.printDetailsCancel'),
          className: 'confirm-actions__secondary',
          value: null,
          onClick: () => {
            settle(null);
            closeServerModal('cancel');
          },
        },
        {
          label: translate('player.discussion.printDetailsPrint'),
          className: 'confirm-actions__primary',
          onClick: () => {
            const details = collectDetails();
            discussionPrintDetails = details;
            settle(details);
            closeServerModal('print');
          },
        },
      ],
      onClose: () => settle(null),
    });
  });
}

async function printRolePlaySceneDiscussion() {
  const activeProject = getActiveStore().get().project;
  discussionSession.bindProject(activeProject);
  if (!discussionSession.hasAnyText()) {
    showMessage({ text: translate('player.discussion.printEmpty') });
    return;
  }
  const details = await promptDiscussionPrintDetails();
  if (!details) return;
  const printWindow = globalThis.open?.('', 'roleplayscene_discussion_print', 'width=960,height=720,resizable=yes,scrollbars=yes');
  if (!printWindow || !printWindow.document) {
    showMessage({ text: translate('player.discussion.printPopupBlocked') });
    return;
  }
  const model = buildDiscussionPrintModel(activeProject, discussionSession.snapshot());
  const html = buildDiscussionPrintHtml(model, {
    reportTitle: translate('player.discussion.printReportTitle'),
    dialogue: translate('player.discussion.printDialogue'),
    choices: translate('player.discussion.printChoices'),
    discussion: translate('player.discussion.printDiscussion'),
    empty: translate('player.discussion.printEmpty'),
    student: translate('player.discussion.printStudentLabel'),
    date: translate('player.discussion.printDateLabel'),
    defaultSchoolName: getDefaultDiscussionPrintSchoolName(),
  }, {
    schoolName: details.schoolName,
    studentName: details.studentName,
    printedAt: formatDiscussionPrintDate(),
  });
  try {
    printWindow.opener = null;
  } catch {
    // Printing should still work in browsers that prevent mutating opener.
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

function getImportConfirmationCopy(kind = ImportConfirmationKind.IMPORT, options = {}) {
  const isDiscussionDiscard = kind === ImportConfirmationKind.DISCUSSION_DISCARD;
  return {
    title: options.title || translate(isDiscussionDiscard ? 'player.discussion.discardTitle' : 'messages.importConfirmTitle'),
    body: options.body || translate(isDiscussionDiscard ? 'player.discussion.discardBody' : 'messages.importConfirmBody'),
    accept: options.accept || translate(isDiscussionDiscard ? 'player.discussion.discardConfirm' : 'messages.importConfirmAccept'),
    cancel: options.cancel || translate(isDiscussionDiscard ? 'player.discussion.discardCancel' : 'messages.importConfirmCancel'),
  };
}

function applyImportConfirmationCopy(kind = ImportConfirmationKind.IMPORT, options = {}) {
  const copy = getImportConfirmationCopy(kind, options);
  if (importConfirmTitle) importConfirmTitle.textContent = copy.title;
  if (importConfirmBody) importConfirmBody.textContent = copy.body;
  if (importConfirmAccept) importConfirmAccept.textContent = copy.accept;
  if (importConfirmCancel) importConfirmCancel.textContent = copy.cancel;
  return copy;
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

function confirmProjectImport(options = {}) {
  const kind = options.kind || ImportConfirmationKind.IMPORT;
  const copy = getImportConfirmationCopy(kind, options);
  if (!importConfirmOverlay || !importConfirmAccept || !importConfirmCancel) {
    return Promise.resolve(globalThis.confirm?.(copy.body) ?? false);
  }
  if (activeImportConfirmation) {
    closeImportConfirmation(false);
  }
  applyImportConfirmationCopy(kind, options);
  importConfirmOverlay.hidden = false;
  importConfirmOverlay.removeAttribute('hidden');
  document.addEventListener('keydown', handleImportConfirmationKeydown);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  requestAnimationFrame(() => {
    importConfirmAccept.focus();
  });
  return new Promise((resolve) => {
    activeImportConfirmation = { resolve, previousFocus, kind, options };
  });
}

function confirmDiscardDiscussion() {
  return confirmProjectImport({
    kind: ImportConfirmationKind.DISCUSSION_DISCARD,
  });
}

async function ensureDiscussionCanBeDiscarded() {
  if (!discussionSession.hasAnyText()) return true;
  return await confirmDiscardDiscussion();
}

function discardDiscussion() {
  discussionSession.clear();
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

async function showDeletePublishedSceneConfirmation(scene) {
  const title = scene?.title || translate('published.values.untitledScene');
  return chooseFromServerModal({
    title: translate('published.deleteTitle'),
    message: translate('published.deleteBody', { title }),
    actions: [
      { label: translate('published.deleteConfirm'), value: 'delete', className: 'confirm-actions__primary server-danger-action' },
      { label: translate('server.cancel'), value: null, className: 'confirm-actions__secondary' },
    ],
  });
}

function showPublishDraftModal(draft, initialTitle = '') {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    openServerModal({
      title: translate('server.publishTitle'),
      bodyRenderer: (body) => {
        const description = document.createElement('p');
        description.textContent = translate('server.publishBody');
        const field = document.createElement('label');
        field.className = 'field';
        const label = document.createElement('span');
        label.textContent = translate('server.publishTitleLabel');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initialTitle || draft?.title || translate('server.values.untitledDraft');
        input.maxLength = 160;
        input.setAttribute('aria-label', translate('server.publishTitleLabel'));
        field.append(label, input);
        body.append(description, field);
      },
      actions: [
        {
          label: translate('server.cancel'),
          className: 'confirm-actions__secondary',
          onClick: () => {
            settle(null);
            closeServerModal('publish-cancel');
          },
        },
        {
          label: translate('server.publishConfirm'),
          className: 'confirm-actions__primary',
          onClick: () => {
            const input = serverModalBody?.querySelector('input[type="text"]');
            const title = String(input?.value || '').trim();
            if (!title) {
              showMessage({ textId: 'server.publishTitleRequired' });
              input?.focus();
              return;
            }
            settle({ title });
            closeServerModal('publish-confirm');
          },
        },
      ],
      onClose: () => settle(null),
    });
  });
}

async function showPublishConflictModal(result) {
  const requestedTitle = result?.error?.details?.requestedTitle || '';
  return chooseFromServerModal({
    title: translate('server.publishConflictTitle'),
    message: translate('server.publishConflictBody', { title: requestedTitle || translate('server.values.untitledDraft') }),
    actions: [
      { label: translate('server.publishEditTitle'), value: 'edit', className: 'confirm-actions__primary' },
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
  const publishState = draft?.publish_state || 'draft_only';
  const publishedSceneId = String(draft?.published_scene_id || draft?.roleplayscene_published_scene_id || '').trim();
  const showPublishedDeleted = publishState === 'current_version_published' && !publishedSceneId;
  const showPublishedLive = publishState === 'current_version_published' && Boolean(publishedSceneId);
  if (missingMediaCount <= 0 && validationWarningCount <= 0 && !showPublishedDeleted && !showPublishedLive) return;
  const badges = document.createElement('div');
  badges.className = 'server-draft-badges';
  if (showPublishedLive || showPublishedDeleted) {
    const badge = document.createElement('span');
    badge.className = showPublishedLive
      ? 'server-draft-badge server-draft-badge--ok'
      : 'server-draft-badge server-draft-badge--warn';
    badge.textContent = translate(showPublishedLive ? 'server.publishedLiveBadge' : 'server.publishedDeletedBadge');
    badges.appendChild(badge);
  }
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

function renderUploadedDraftRows(container, drafts, { onDraftDeleted = null, allowPublish = true } = {}) {
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
    actions.append(openButton, downloadButton);
    const publishState = draft?.publish_state || 'draft_only';
    if (allowPublish && publishState !== 'current_version_published') {
      const uploadedDraftId = getRolePlaySceneDraftId(draft);
      const publishButton = createButton(
        publishingDraftIds.has(uploadedDraftId)
          ? translate('server.publishing')
          : publishState === 'unpublished_changes'
            ? translate('server.publishNewVersion')
            : translate('server.publishDraft'),
        'confirm-actions__primary'
      );
      publishButton.disabled = publishingDraftIds.has(uploadedDraftId);
      publishButton.addEventListener('click', () => publishUploadedRolePlaySceneDraft(draft));
      actions.appendChild(publishButton);
    }
    const deleteButton = createButton(translate('server.deleteDraft'), 'server-danger-action');
    deleteButton.addEventListener('click', () => deleteUploadedRolePlaySceneDraft(draft, { onDraftDeleted }));
    actions.appendChild(deleteButton);
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
  recoveryMode = false,
} = {}) {
  openServerModal({
    title: recoveryMode ? translate('server.slotRecoveryTitle') : translate('server.manageTitle'),
    bodyRenderer: (body) => {
      if (recoveryMode) {
        const recoveryMessage = document.createElement('p');
        recoveryMessage.className = 'server-slot-recovery-message';
        recoveryMessage.textContent = translate('server.slotRecoveryDescription');
        body.appendChild(recoveryMessage);
      }
      const slotUsage = document.createElement('p');
      slotUsage.className = 'server-slot-usage';
      slotUsage.textContent = translate('server.slotUsage', {
        used: drafts.length,
        limit: slotLimit || 3,
      });
      body.appendChild(slotUsage);
      renderUploadedDraftRows(body, drafts, { onDraftDeleted, allowPublish: !recoveryMode });
    },
    actions: [
      {
        label: translate('server.refresh'),
        onClick: async () => {
          const result = await loadUploadedRolePlaySceneDrafts({ preflight: true, showManager: false });
          if (result?.ok) {
            renderUploadedDraftManager({ onDraftDeleted, onClose, recoveryMode });
          }
        },
      },
      {
        label: translate(recoveryMode ? 'server.cancelUpload' : 'server.close'),
        onClick: () => closeServerModal(),
        className: 'confirm-actions__secondary',
      },
    ],
    onClose,
  });
}

function getRolePlayScenePublishedSceneId(scene) {
  return String(scene?.roleplayscene_published_scene_id || scene?.publishedSceneId || '').trim();
}

function renderPublishedSceneMetadata(container, scene) {
  const metadata = document.createElement('dl');
  metadata.className = 'server-draft-meta';
  const ownerLabel = scene?.owner_email || scene?.owner_name || translate('published.values.unknownOwner');
  const rows = [
    [translate('published.meta.id'), getRolePlayScenePublishedSceneId(scene) || '-'],
    [translate('published.meta.owner'), ownerLabel],
    [translate('published.meta.size'), formatBytes(scene?.artifact_size_bytes)],
    [translate('published.meta.scenes'), String(Number(scene?.scene_count || 0))],
    [translate('published.meta.media'), String(Number(scene?.media_count || 0))],
    [translate('published.meta.validationWarnings'), String(Number(scene?.validation_warning_count || 0))],
    [translate('published.meta.published'), formatTimestamp(scene?.published_at)],
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

function renderPublishedSceneRows(container, scenes) {
  const list = document.createElement('div');
  list.className = 'server-draft-list published-scene-list';
  if (!scenes.length) {
    const empty = document.createElement('p');
    empty.className = 'server-empty';
    empty.textContent = translate('published.noScenes');
    list.appendChild(empty);
    container.appendChild(list);
    return;
  }
  scenes.forEach((scene) => {
    const sceneId = getRolePlayScenePublishedSceneId(scene);
    const row = document.createElement('article');
    row.className = 'server-draft-row published-scene-row';
    const header = document.createElement('div');
    header.className = 'server-draft-row__header';
    const title = document.createElement('h3');
    title.textContent = scene?.title || translate('published.values.untitledScene');
    header.appendChild(title);
    if (isNonEmptyString(scene?.description)) {
      const description = document.createElement('p');
      description.textContent = scene.description;
      header.appendChild(description);
    }
    row.appendChild(header);
    renderPublishedSceneMetadata(row, scene);
    const actions = document.createElement('div');
    actions.className = 'server-draft-row__actions';
    const playUrl = buildPublishedScenePlayUrl(sceneId);
    const playLink = createActionLink(translate('published.playLink'), playUrl, 'confirm-actions__primary');
    const copyLinkButton = createButton(translate('published.copyLink'));
    copyLinkButton.addEventListener('click', () => {
      copyTextToClipboard(playUrl)
        .then(() => showMessage({ textId: 'published.linkCopied' }))
        .catch((err) => {
          console.error(err);
          showMessage({ textId: 'published.linkCopyFailed' });
        });
    });
    const downloadButton = createButton(translate('published.download'));
    downloadButton.addEventListener('click', () => downloadPublishedRolePlayScene(scene));
    actions.append(playLink, copyLinkButton, downloadButton);
    const currentUserSub = serverSession.user?.sub || '';
    if (currentUserSub && scene?.owner_sub === currentUserSub) {
      const deleteButton = createButton(translate('published.delete'), 'server-danger-action');
      deleteButton.addEventListener('click', () => deletePublishedRolePlayScene(scene));
      actions.appendChild(deleteButton);
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
  container.appendChild(list);
}

function renderPublishedBrowserModal() {
  openServerModal({
    title: translate('published.browseTitle'),
    bodyRenderer: (body) => {
      const form = document.createElement('form');
      form.className = 'published-browser-filters';
      const queryInput = document.createElement('input');
      queryInput.type = 'search';
      queryInput.name = 'q';
      queryInput.value = publishedScenesFilters.q;
      queryInput.placeholder = translate('published.searchPlaceholder');
      queryInput.setAttribute('aria-label', translate('published.searchLabel'));
      const ownerInput = document.createElement('input');
      ownerInput.type = 'search';
      ownerInput.name = 'owner';
      ownerInput.value = publishedScenesFilters.owner;
      ownerInput.placeholder = translate('published.ownerPlaceholder');
      ownerInput.setAttribute('aria-label', translate('published.ownerLabel'));
      const searchButton = createButton(translate('published.search'), 'confirm-actions__primary');
      searchButton.type = 'submit';
      searchButton.disabled = isLoadingPublishedScenes;
      form.append(queryInput, ownerInput, searchButton);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        publishedScenesFilters = {
          ...publishedScenesFilters,
          q: String(queryInput.value || '').trim(),
          owner: String(ownerInput.value || '').trim(),
        };
        loadPublishedRolePlaySceneScenes({ preflight: true, showBrowser: true }).catch((err) => {
          console.error(err);
          showMessage({ textId: 'published.listFailed' });
        });
      });
      body.appendChild(form);
      renderPublishedSceneRows(body, publishedScenes);
    },
    actions: [
      {
        label: isLoadingPublishedScenes ? translate('published.refreshing') : translate('published.refresh'),
        disabled: isLoadingPublishedScenes,
        onClick: () => loadPublishedRolePlaySceneScenes({ preflight: true, showBrowser: true }),
      },
      {
        label: translate('published.loadMore'),
        disabled: isLoadingPublishedScenes || !publishedScenesHasMore,
        onClick: () => loadPublishedRolePlaySceneScenes({ preflight: true, append: true, showBrowser: true }),
      },
      {
        label: translate('server.close'),
        className: 'confirm-actions__secondary',
        onClick: () => closeServerModal(),
      },
    ],
  });
}

async function loadPublishedRolePlaySceneScenes({
  preflight = true,
  append = false,
  showBrowser = false,
} = {}) {
  if (isLoadingPublishedScenes) {
    return { ok: false, skipped: true, status: 'already_loading' };
  }
  const requestId = ++publishedScenesRequestId;
  isLoadingPublishedScenes = true;
  updateServerSessionUi();
  if (showBrowser && !serverModalOverlay?.hidden) {
    renderPublishedBrowserModal();
  }
  try {
    if (preflight) {
      const sessionReady = await ensureServerSessionReady();
      if (!sessionReady.ok) return sessionReady.result;
    }
    const offset = append ? Number(publishedScenesNextOffset || publishedScenes.length || 0) : 0;
    const result = await apiClient.listRolePlayScenePublishedScenes({
      ...publishedScenesFilters,
      limit: 20,
      offset,
    });
    if (!result.ok) {
      showMessage({ text: getServerErrorMessage(result, 'published.listFailed') });
      return result;
    }
    if (requestId !== publishedScenesRequestId) {
      return { ok: false, skipped: true, status: 'stale_response' };
    }
    const incoming = Array.isArray(result.data?.items) ? result.data.items : [];
    publishedScenes = append ? [...publishedScenes, ...incoming] : incoming;
    publishedScenesHasMore = result.data?.hasMore === true;
    publishedScenesNextOffset = Number.isFinite(Number(result.data?.nextOffset)) ? Number(result.data.nextOffset) : null;
    if (showBrowser) {
      renderPublishedBrowserModal();
    }
    return result;
  } finally {
    if (requestId === publishedScenesRequestId) {
      isLoadingPublishedScenes = false;
      updateServerSessionUi();
      if (showBrowser && !serverModalOverlay?.hidden) {
        renderPublishedBrowserModal();
      }
    }
  }
}

async function exitPublishedPlay() {
  if (!(await ensureDiscussionCanBeDiscarded())) return;
  if (publishedPlay.preparedImport?.project) {
    revokeProjectObjectUrls(publishedPlay.preparedImport.project);
  }
  editorPreview = null;
  publishedPlay = { active: false, store: null, preparedImport: null, scene: null };
  discardDiscussion();
  setMode('edit');
  showMessage({ textId: 'published.exited' });
}

async function openPublishedRolePlayScene(scene) {
  const sceneId = getRolePlayScenePublishedSceneId(scene);
  if (!sceneId) return;
  return openPublishedRolePlaySceneById(sceneId, { scene });
}

async function openPublishedRolePlaySceneById(publishedSceneId, { scene = null, source = 'browse', initialPlaybackState = null } = {}) {
  if (!(await ensureDiscussionCanBeDiscarded())) return { ok: false, canceled: true };
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) {
    if (source === 'direct') {
      pendingDirectPublishedSceneId = publishedSceneId;
    }
    return sessionReady.result;
  }
  if (openingPublishedSceneIds.has(publishedSceneId)) return;
  openingPublishedSceneIds.add(publishedSceneId);
  if (!serverModalOverlay?.hidden) renderPublishedBrowserModal();
  let preparedImport = null;
  try {
    showMessage({ textId: 'published.opening' });
    let metadata = scene;
    if (!metadata) {
      const metadataResult = await apiClient.fetchRolePlayScenePublishedScene(publishedSceneId);
      if (!metadataResult.ok) {
        showMessage({ text: getServerErrorMessage(metadataResult, 'published.openFailed') });
        return metadataResult;
      }
      metadata = metadataResult.data;
    }
    const artifact = await apiClient.fetchRolePlayScenePublishedSceneArtifact(publishedSceneId);
    if (!artifact.ok) {
      showMessage({ text: getServerErrorMessage(artifact, 'published.openFailed') });
      return artifact;
    }
    preparedImport = await prepareProjectImport(createZipFileFromBytes(
      artifact.data,
      `${sanitizeFilename(metadata?.title, 'roleplayscene-published')}.zip`,
    ));
    if (publishedPlay.preparedImport?.project) {
      revokeProjectObjectUrls(publishedPlay.preparedImport.project);
    }
    const playStore = new Store();
    playStore.setLocale(store.get().locale);
    playStore.set({ project: preparedImport.project });
    editorPreview = null;
    discardDiscussion();
    publishedPlay = { active: true, store: playStore, preparedImport, scene: metadata };
    const playbackRecovery = initialPlaybackState
      || getMatchingPlaybackRecovery(preparedImport.project, { publishedSceneId });
    closeServerModal('published-open');
    setMode('play', { initialPlaybackState: playbackRecovery });
    showMessage({ textId: 'published.opened' });
    return { ok: true };
  } catch (err) {
    if (preparedImport?.project) {
      revokeProjectObjectUrls(preparedImport.project);
    }
    console.error(err);
    showImportError(err);
    return { ok: false, error: { message: err?.message || String(err) } };
  } finally {
    openingPublishedSceneIds.delete(publishedSceneId);
    if (!serverModalOverlay?.hidden) renderPublishedBrowserModal();
  }
}

async function downloadPublishedRolePlayScene(scene) {
  const sceneId = getRolePlayScenePublishedSceneId(scene);
  if (!sceneId) return;
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) return;
  const artifact = await apiClient.fetchRolePlayScenePublishedSceneArtifact(sceneId);
  if (!artifact.ok) {
    showMessage({ text: getServerErrorMessage(artifact, 'published.downloadFailed') });
    return;
  }
  const blob = new Blob([artifact.data], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sanitizeFilename(scene?.title, 'roleplayscene-published')}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showMessage({ textId: 'published.downloaded' });
}

async function deletePublishedRolePlayScene(scene) {
  const sceneId = getRolePlayScenePublishedSceneId(scene);
  if (!sceneId) return;
  const choice = await showDeletePublishedSceneConfirmation(scene);
  if (choice !== 'delete') return;
  const sessionReady = await ensureServerSessionReady();
  if (!sessionReady.ok) return;
  const result = await apiClient.deleteRolePlayScenePublishedScene(sceneId);
  if (!result.ok) {
    showMessage({ text: getServerErrorMessage(result, 'published.deleteFailed') });
    return;
  }
  showMessage({ textId: 'published.deleted' });
  await loadPublishedRolePlaySceneScenes({ preflight: false, showBrowser: true });
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
      recoveryMode: true,
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

async function publishUploadedRolePlaySceneDraft(draft) {
  const uploadedDraftId = getRolePlaySceneDraftId(draft);
  if (!uploadedDraftId || publishingDraftIds.has(uploadedDraftId)) return;
  let attemptedTitle = draft?.title || translate('server.values.untitledDraft');
  while (true) {
    const modalResult = await showPublishDraftModal(draft, attemptedTitle);
    if (!modalResult) {
      showMessage({ textId: 'server.publishCanceled' });
      return;
    }
    attemptedTitle = modalResult.title;
    publishingDraftIds.add(uploadedDraftId);
    renderUploadedDraftManager();
    showMessage({ textId: 'server.publishingMessage' });
    let result;
    try {
      const sessionReady = await ensureServerSessionReady();
      if (!sessionReady.ok) {
        showMessage({ text: sessionReady.result?.error?.message || translate('server.signInRequired') });
        return;
      }
      result = await apiClient.publishRolePlaySceneFromUploadedDraft(uploadedDraftId, { title: attemptedTitle });
    } catch (err) {
      showMessage({ text: err?.message || translate('server.publishFailed') });
      return;
    } finally {
      publishingDraftIds.delete(uploadedDraftId);
      if (!serverModalOverlay?.hidden) renderUploadedDraftManager();
    }

    if (result?.ok) {
      showMessage({
        textId: 'server.published',
        textArgs: { id: result.data?.roleplayscene_published_scene_id || '' },
      });
      await loadUploadedRolePlaySceneDrafts({ preflight: false, showManager: true });
      return;
    }
    if (result?.error?.code === 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT') {
      showMessage({ text: getServerErrorMessage(result, 'server.publishFailed') });
      const choice = await showPublishConflictModal(result);
      if (choice === 'edit') continue;
      showMessage({ textId: 'server.publishCanceled' });
      return;
    }
    showMessage({ text: getServerErrorMessage(result, 'server.publishFailed') });
    return;
  }
}

async function openUploadedRolePlaySceneDraft(draft) {
  const uploadedDraftId = getRolePlaySceneDraftId(draft);
  if (!uploadedDraftId) return;
  if (!(await ensureDiscussionCanBeDiscarded())) return;
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
    discardDiscussion();
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
    dismissMessage();
  });
}

btnEdit.addEventListener('click', async () => {
  if (editorPreview && !publishedPlay.active) {
    if (!(await ensureDiscussionCanBeDiscarded())) return;
    discardDiscussion();
    returnFromEditorScenePreview();
    return;
  }
  if (!(await ensureDiscussionCanBeDiscarded())) return;
  discardDiscussion();
  editorPreview = null;
  setMode('edit');
});
btnPlay.addEventListener('click', () => {
  if (publishedPlay.active) {
    setMode('play');
    return;
  }
  if (editorPreview) {
    return;
  }
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
  editorPreview = null;
  store.set({ audioGate: false });
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
serverBrowsePublishedButton?.addEventListener('click', () => {
  loadPublishedRolePlaySceneScenes({ preflight: true, showBrowser: true }).catch((err) => {
    console.error(err);
    showMessage({ textId: 'published.listFailed' });
  });
});
publishedExitButton?.addEventListener('click', () => exitPublishedPlay());

toolbarMoreButton?.addEventListener('click', () => {
  const nextOpen = toolbarMoreMenu?.hidden !== false;
  setToolbarOverflowOpen(nextOpen);
});

toolbarMoreMenu?.addEventListener('click', (event) => {
  const actionElement = event.target instanceof Element
    ? event.target.closest('button, a')
    : null;
  if (!actionElement || actionElement === toolbarMoreButton) return;
  setToolbarOverflowOpen(false);
});

document.addEventListener('click', (event) => {
  if (!toolbarOverflow || toolbarOverflow.hidden || toolbarMoreMenu?.hidden !== false) return;
  if (event.target instanceof Node && toolbarOverflow.contains(event.target)) return;
  setToolbarOverflowOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  setToolbarOverflowOpen(false);
});

globalThis.addEventListener?.('resize', () => {
  applyToolbarOverflowLayout();
  syncTopbarHeightVariable();
  setToolbarOverflowOpen(false);
});

if (typeof globalThis.ResizeObserver === 'function' && topbar) {
  const topbarResizeObserver = new globalThis.ResizeObserver(() => {
    syncTopbarHeightVariable();
  });
  topbarResizeObserver.observe(topbar);
} else {
  syncTopbarHeightVariable();
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let preparedImport = null;
  try {
    if (!(await ensureDiscussionCanBeDiscarded())) {
      showMessage({ textId: 'messages.importCanceled' });
      return;
    }
    showMessage({ textId: 'messages.importingProject' });
    preparedImport = await prepareProjectImport(file);
    const shouldImport = await confirmProjectImport();
    if (!shouldImport) {
      revokeProjectObjectUrls(preparedImport.project);
      showMessage({ textId: 'messages.importCanceled' });
      return;
    }
    discardDiscussion();
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
  migrateLegacyLocalePreference();
  refreshLocaleUI(store.get().locale);
  const directPublishedSceneId = getDirectPublishedSceneIdFromLocation();
  try {
    persistenceCleanup = directPublishedSceneId
      ? () => {}
      : await setupPersistence(store, { showMessage });
  } catch (err) {
    console.error('Failed to initialise persistence', err);
    persistenceCleanup = () => {};
  }
  probeServerSessionSilently().catch((err) => {
    console.error('Failed to probe server session', err);
    serverSession = { status: 'error', user: null, error: err?.message || String(err) };
    updateServerSessionUi();
  });
  if (directPublishedSceneId) {
    openPublishedRolePlaySceneById(directPublishedSceneId, { source: 'direct' }).catch((err) => {
      console.error(err);
      showMessage({ textId: 'published.openFailed' });
    });
    updateToolbarText();
    updatePublishedPlayUi();
    return;
  }
  const recovery = readPlaySessionRecovery();
  const playbackRecovery = getMatchingPlaybackRecovery(store.get().project);
  if (recovery?.mode === 'play' && playbackRecovery) {
    setMode('play', { initialPlaybackState: playbackRecovery });
  } else {
    setMode('edit');
  }
}

bootstrap();

if (localeSelect) {
  localeSelect.addEventListener('change', (event) => {
    const selected = event.target.value;
    store.setLocale(selected);
  });
}

onLocaleChange((nextLocale) => {
  refreshLocaleUI(nextLocale);
});

window.addEventListener('beforeunload', (event) => {
  if (discussionSession.hasAnyText()) {
    event.preventDefault();
    event.returnValue = '';
    return;
  }
  if (typeof teardown === 'function') {
    teardown();
  }
  if (typeof persistenceCleanup === 'function') {
    persistenceCleanup();
  }
  if (activeAuthFlow?.cancel) {
    activeAuthFlow.cancel();
  }
  if (publishedPlay.preparedImport?.project) {
    revokeProjectObjectUrls(publishedPlay.preparedImport.project);
  }
});
