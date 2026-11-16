import { translate, getAvailableLocales } from '../i18n.js';

const HEADER_TABLET_MIN_WIDTH = 768;
const HEADER_COMPACT_MAX_WIDTH = 1023;
const DEFAULT_TOPBAR_HEIGHT_PX = 64;

// Owns toolbar presentation and listeners, not application actions or state.
// Existing controls are moved between hosts so their identity/handlers survive resize.
export function createToolbarController({ onLocaleChange }) {
  const btnEdit = document.getElementById('mode-edit');
  const btnPlay = document.getElementById('mode-play');
  const btnNewStory = document.getElementById('new-story-btn');
  const btnImport = document.getElementById('import-btn');
  const btnExport = document.getElementById('export-btn');
  const serverStatus = document.getElementById('server-status');
  const serverSignInButton = document.getElementById('server-signin-btn');
  const serverSaveButton = document.getElementById('server-save-btn');
  const serverManageButton = document.getElementById('server-manage-btn');
  const serverBrowsePublishedButton = document.getElementById('server-browse-published-btn');
  const publishedExitButton = document.getElementById('published-exit-btn');
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
    moveToolbarNode(btnNewStory, toolbarFiles);
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

    moveToolbarNode(btnNewStory, toolbarMoreProjectItems);
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

  function updateToolbarText({ inEditorPreview, isUploadingDraft, isLoadingUploadedDrafts, isLoadingPublishedScenes }) {
    if (topbarTitle) {
      topbarTitle.textContent = translate('toolbar.appName');
    }
    if (btnEdit) {
      btnEdit.textContent = inEditorPreview
        ? translate('toolbar.backToEdit')
        : translate('toolbar.edit');
    }
    if (btnPlay) {
      btnPlay.textContent = translate('toolbar.play');
    }
    if (btnNewStory) {
      btnNewStory.textContent = translate('toolbar.newStory');
      btnNewStory.title = translate('toolbar.newStoryTitle');
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
        ? translate('server.cancelUpload')
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
  }

  function populateLocaleOptions(currentValue) {
    if (!localeSelect) return;
    const locales = getAvailableLocales();
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
    localeSelect.value = currentValue;
  }

  function updateServerSessionUi({ serverSession, isOpeningDraft, isUploadingDraft, isLoadingUploadedDrafts, isLoadingPublishedScenes }) {
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
      serverSaveButton.disabled = isOpeningDraft;
      serverSaveButton.setAttribute('aria-busy', String(isUploadingDraft));
      serverSaveButton.textContent = isUploadingDraft ? translate('server.cancelUpload') : translate('server.save');
    }
    if (serverManageButton) {
      serverManageButton.disabled = isLoadingUploadedDrafts || isOpeningDraft;
      serverManageButton.textContent = isLoadingUploadedDrafts ? translate('server.refreshing') : translate('server.manage');
    }
    if (serverBrowsePublishedButton) {
      serverBrowsePublishedButton.disabled = isLoadingPublishedScenes || isOpeningDraft;
      serverBrowsePublishedButton.textContent = isLoadingPublishedScenes ? translate('published.refreshing') : translate('published.browse');
    }
  }

  function updatePublishedPlayUi({ inPublishedPlay, inEditorPreview }) {
    [btnEdit, btnNewStory, btnImport, btnExport, serverSaveButton, serverManageButton].forEach((control) => {
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

  // Draft progress updates must not rebuild/rearrange the menu or move focus.
  function updateDraftAvailability({ isOpeningDraft, isLoadingPublishedScenes, isLoadingUploadedDrafts }) {
    if (btnImport) btnImport.disabled = isOpeningDraft;
    if (btnNewStory) btnNewStory.disabled = isOpeningDraft;
    if (serverBrowsePublishedButton) {
      serverBrowsePublishedButton.disabled = isOpeningDraft || isLoadingPublishedScenes;
      serverBrowsePublishedButton.textContent = translate(isLoadingPublishedScenes ? 'published.refreshing' : 'published.browse');
    }
    if (serverSaveButton) serverSaveButton.disabled = isOpeningDraft;
    if (serverManageButton) serverManageButton.disabled = isLoadingUploadedDrafts || isOpeningDraft;
  }

  const cleanups = [];
  function listen(target, type, handler) {
    target?.addEventListener?.(type, handler);
    cleanups.push(() => target?.removeEventListener?.(type, handler));
  }

  listen(toolbarMoreButton, 'click', () => {
    const nextOpen = toolbarMoreMenu?.hidden !== false;
    setToolbarOverflowOpen(nextOpen);
  });

  listen(toolbarMoreMenu, 'click', (event) => {
    const actionElement = event.target instanceof Element
      ? event.target.closest('button, a')
      : null;
    if (!actionElement || actionElement === toolbarMoreButton) return;
    setToolbarOverflowOpen(false);
  });

  listen(document, 'click', (event) => {
    if (!toolbarOverflow || toolbarOverflow.hidden || toolbarMoreMenu?.hidden !== false) return;
    if (event.target instanceof Node && toolbarOverflow.contains(event.target)) return;
    setToolbarOverflowOpen(false);
  });

  listen(document, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    setToolbarOverflowOpen(false);
  });

  listen(globalThis, 'resize', () => {
    applyToolbarOverflowLayout();
    syncTopbarHeightVariable();
    setToolbarOverflowOpen(false);
  });

  if (typeof globalThis.ResizeObserver === 'function' && topbar) {
    const topbarResizeObserver = new globalThis.ResizeObserver(() => {
      syncTopbarHeightVariable();
    });
    topbarResizeObserver.observe(topbar);
    cleanups.push(() => topbarResizeObserver.disconnect());
  } else {
    syncTopbarHeightVariable();
  }

  listen(localeSelect, 'change', event => onLocaleChange(event.target.value));

  return {
    render(state) {
      updateToolbarText(state);
      updateServerSessionUi(state);
      updatePublishedPlayUi(state);
    },
    setMode(mode) {
      btnEdit?.classList.toggle('active', mode === 'edit');
      btnPlay?.classList.toggle('active', mode === 'play');
    },
    populateLocaleOptions,
    updateDraftAvailability,
    syncHeight: syncTopbarHeightVariable,
    destroy() {
      cleanups.splice(0).forEach(cleanup => cleanup());
    },
  };
}
