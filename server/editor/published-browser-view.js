// View-only: the shell owns search state, requests, auth and worksheet replacement.
export function createPublishedBrowserView({ root, t, formatTimestamp, createVisualLoadStatus,
  onSearch, onRefresh, onLoadMore, onCopyLink, onOpen, onDelete, onClose }) {
  let events = null, destroyed = false;
  function render(model, isCurrent) {
    if (destroyed) return;
    events?.abort();
    events = new AbortController();
    const { signal } = events;
    const listen = (button, action) => button.addEventListener('click', () => {
      if (!signal.aborted && button.isConnected && isCurrent()) return action();
    }, { signal });
    root.innerHTML = '';
    if (!model.open) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal browse-modal';
    const heading = document.createElement('h3');
    heading.textContent = t('editor.published.browse');
    const filterRow = document.createElement('div');
    filterRow.className = 'browse-modal__filters';
    const titleFilter = document.createElement('input');
    titleFilter.className = 'control';
    titleFilter.placeholder = t('common.publishedBrowser.filterByTitle');
    titleFilter.value = model.title;
    const subjectFilter = document.createElement('input');
    subjectFilter.className = 'control';
    subjectFilter.placeholder = t('common.publishedBrowser.filterBySubject');
    subjectFilter.value = model.subject;
    const ownerFilter = document.createElement('input');
    ownerFilter.className = 'control';
    ownerFilter.placeholder = t('common.publishedBrowser.filterByOwnerEmail');
    ownerFilter.value = model.owner;
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'browse-modal__search-btn';
    searchBtn.innerHTML = '<svg class="browse-modal__search-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.25" stroke="currentColor" stroke-width="1.6"></circle><path d="M12.5 12.5L16.25 16.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';
    searchBtn.setAttribute('aria-label', t('common.publishedBrowser.searchAriaLabel'));
    searchBtn.disabled = model.loading;
    filterRow.append(titleFilter, subjectFilter, ownerFilter, searchBtn);
    const results = document.createElement('div');
    results.className = 'browse-results';
    if (model.error) {
      const error = document.createElement('p');
      error.className = 'control-error';
      error.textContent = model.error;
      results.appendChild(error);
    } else if (model.loading) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = t('common.publishedBrowser.loading');
      results.appendChild(loading);
    } else if (model.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('common.publishedBrowser.empty');
      results.appendChild(empty);
    } else {
      model.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'published-result-row';
        const titleLine = document.createElement('div');
        titleLine.className = 'published-result-title-line';
        const title = document.createElement('strong');
        title.className = 'published-result-title';
        title.textContent = item.title || t('common.values.untitled');
        const publishedDate = document.createElement('span');
        publishedDate.className = 'published-result-date muted';
        publishedDate.textContent = formatTimestamp(item.published_at);
        titleLine.append(title, publishedDate);
        const subjectOwner = document.createElement('div');
        subjectOwner.className = 'muted published-result-subject-owner';
        subjectOwner.textContent = t('editor.published.metaSubjectOwner', {
          subject: item.subject || '—',
          owner: item.owner_email || item.owner_name || item.owner_sub || '—',
        });
        const publishedMeta = document.createElement('div');
        publishedMeta.className = 'muted published-result-id';
        publishedMeta.textContent = t('common.meta.packageId', { value: item.published_package_id });
        row.append(titleLine, subjectOwner, publishedMeta);
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'uploaded-draft-action published-result-action';
        copyBtn.textContent = t('editor.published.copyViewerLink');
        listen(copyBtn, () => onCopyLink(item));
        const openInEditorBtn = document.createElement('button');
        openInEditorBtn.type = 'button';
        openInEditorBtn.className = 'uploaded-draft-action published-result-action';
        openInEditorBtn.dataset.editorPackageLoad = `published:${item.published_package_id}`;
        openInEditorBtn.dataset.idleLabel = t('editor.published.openInEditor');
        const isOpening = model.openingIds.includes(item.published_package_id);
        openInEditorBtn.textContent = isOpening ? t('editor.published.openingInEditor') : t('editor.published.openInEditor');
        openInEditorBtn.disabled = model.loading || isOpening;
        listen(openInEditorBtn, () => onOpen(item));
        const actionRow = document.createElement('div');
        actionRow.className = 'published-result-actions';
        actionRow.append(copyBtn, openInEditorBtn);
        const currentUserSub = model.currentUserSub;
        if (currentUserSub && item.owner_sub === currentUserSub) {
          const deletePublishedBtn = document.createElement('button');
          deletePublishedBtn.type = 'button';
          deletePublishedBtn.className = 'uploaded-draft-action uploaded-draft-action--danger published-result-action';
          deletePublishedBtn.textContent = t('common.actions.delete');
          listen(deletePublishedBtn, () => onDelete(item));
          actionRow.appendChild(deletePublishedBtn);
        }
        row.appendChild(actionRow);
        results.appendChild(row);
      });
    }
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'confirm-modal__btn';
    loadMoreBtn.textContent = model.loading ? t('common.actions.loading') : t('common.actions.loadMore');
    loadMoreBtn.hidden = !model.hasMore;
    loadMoreBtn.disabled = model.loading;
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'confirm-modal__btn';
    refreshBtn.textContent = t('common.actions.refresh');
    refreshBtn.disabled = model.loading;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'confirm-modal__btn';
    closeBtn.textContent = t('common.actions.close');
    actions.append(loadMoreBtn, refreshBtn, closeBtn);
    dialog.append(heading, filterRow, results, actions);
    dialog.appendChild(createVisualLoadStatus());
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    const readFilters = () => ({ title: titleFilter.value, subject: subjectFilter.value, owner: ownerFilter.value });
    listen(searchBtn, () => onSearch(readFilters()));
    listen(loadMoreBtn, () => onLoadMore());
    listen(refreshBtn, () => onRefresh(readFilters()));
    listen(closeBtn, () => onClose());
  }

  return { render, destroy() { destroyed = true; events?.abort(); root.replaceChildren(); } };
}
