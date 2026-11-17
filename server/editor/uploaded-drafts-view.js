import { t } from '../app/i18n/index.js';

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

export function formatUploadedDraftTimestamp(createdAt, locale = undefined) {
  if (!isNonEmptyString(createdAt)) return t('common.values.unknownUploadTime');
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return t('common.values.unknownUploadTime');
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

export function toUploadedDraftDisplay(item, locale = undefined) {
  const title = isNonEmptyString(item?.title) ? item.title.trim() : t('common.values.untitled');
  return {
    title,
    uploadedLabel: t('common.meta.uploaded', { value: formatUploadedDraftTimestamp(item?.created_at, locale) }),
  };
}

export function normalizeDraftPublishState(item) {
  const explicitState = isNonEmptyString(item?.publish_state) ? item.publish_state.trim() : '';
  if (explicitState === 'current_version_published' || explicitState === 'unpublished_changes' || explicitState === 'draft_only') {
    return explicitState;
  }
  const artifactSha = isNonEmptyString(item?.artifact_sha256) ? item.artifact_sha256.trim() : '';
  const lastPublishedArtifactSha = isNonEmptyString(item?.last_published_artifact_sha256)
    ? item.last_published_artifact_sha256.trim()
    : '';
  if (!lastPublishedArtifactSha) return 'draft_only';
  return artifactSha && artifactSha === lastPublishedArtifactSha ? 'current_version_published' : 'unpublished_changes';
}

export function getUploadedDraftPublishBadge(item) {
  const publishState = normalizeDraftPublishState(item);
  const hasPublishedPackage = isNonEmptyString(item?.published_package_id);
  if (publishState === 'current_version_published') {
    return {
      className: hasPublishedPackage
        ? 'editor-pill editor-pill--ok uploaded-draft-published-badge'
        : 'editor-pill editor-pill--warn uploaded-draft-published-badge',
      text: hasPublishedPackage ? t('editor.uploadedDraft.publishBadge.live') : t('editor.uploadedDraft.publishBadge.deleted'),
      helperText: hasPublishedPackage
        ? t('editor.uploadedDraft.publishBadge.liveHelp')
        : t('editor.uploadedDraft.publishBadge.deletedHelp'),
    };
  }
  if (publishState === 'unpublished_changes') {
    return {
      className: 'editor-pill editor-pill--warn uploaded-draft-published-badge',
      text: t('editor.uploadedDraft.publishBadge.updated'),
      helperText: '',
    };
  }
  return {
    className: 'editor-pill uploaded-draft-published-badge',
    text: t('editor.uploadedDraft.publishBadge.notPublished'),
    helperText: '',
  };
}

// View-only: the shell owns requests, confirmation policies and operation guards.
export function createUploadedDraftsView({ root, t, createVisualLoadStatus,
  onOpen, onCopyLink, onPublish, onDelete, onRefresh, onClose }) {
  let events = null, destroyed = false;
  function renderUploadedDraftRows(container, model, listen) {
    container.innerHTML = '';
    if (model.loading) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = t('editor.uploadedDraft.loading');
      container.appendChild(loading);
      // Existing rows remain usable during a background refresh (for example, publishing).
      if (!model.items.length) return;
    }
    if (model.error) {
      const error = document.createElement('p'); error.setAttribute('role', 'alert');
      error.textContent = model.error; container.append(error); return;
    }
    if (model.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('editor.uploadedDraft.empty');
      container.appendChild(empty);
      return;
    }
    model.items.forEach((item) => {
      const display = toUploadedDraftDisplay(item);
      const row = document.createElement('div');
      row.className = 'uploaded-draft-row';
      const meta = document.createElement('div');
      meta.className = 'uploaded-draft-meta';
      const titleLine = document.createElement('strong');
      titleLine.textContent = display.title;
      const uploadedAtLine = document.createElement('div');
      uploadedAtLine.className = 'muted uploaded-draft-uploaded-at';
      uploadedAtLine.textContent = display.uploadedLabel;
      const subjectLine = document.createElement('div');
      subjectLine.className = 'muted uploaded-draft-uploaded-at';
      subjectLine.textContent = t('common.meta.subject', { value: item.subject || '-' });
      meta.append(titleLine, subjectLine, uploadedAtLine);
      const publishedPackageId = isNonEmptyString(item.published_package_id) ? item.published_package_id : null;
      const publishState = normalizeDraftPublishState(item);
      const badgeConfig = getUploadedDraftPublishBadge(item);
      const badge = document.createElement('span');
      badge.className = badgeConfig.className;
      badge.textContent = badgeConfig.text;
      meta.appendChild(badge);
      const details = document.createElement('details');
      details.className = 'uploaded-draft-details uploaded-draft-details--draft';
      const summary = document.createElement('summary');
      summary.textContent = t('common.sections.details');
      const body = document.createElement('div');
      body.className = 'muted uploaded-draft-details-body';
      const draftIdLine = document.createElement('div');
      draftIdLine.textContent = t('editor.uploadedDraft.metaDraftId', { value: item.uploaded_draft_id || '-' });
      const publishedIdLine = document.createElement('div');
      publishedIdLine.textContent = t('editor.uploadedDraft.metaPublishedId', { value: publishedPackageId || '-' });
      const publishStateLine = document.createElement('div');
      publishStateLine.textContent = t('editor.uploadedDraft.metaPublishState', { value: publishState });
      body.append(draftIdLine, publishedIdLine, publishStateLine);
      if (badgeConfig.helperText) {
        const helperLine = document.createElement('div');
        helperLine.textContent = badgeConfig.helperText;
        body.appendChild(helperLine);
      }
      details.append(summary, body);
      meta.appendChild(details);
      const actions = document.createElement('div');
      actions.className = 'uploaded-draft-actions';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
      openBtn.dataset.editorPackageLoad = `uploaded:${item.uploaded_draft_id}`;
      openBtn.dataset.idleLabel = t('common.actions.open');
      openBtn.textContent = t('common.actions.open');
      openBtn.disabled = false;
      listen(openBtn, () => onOpen(item, display));
      actions.appendChild(openBtn);
      if (publishedPackageId) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
        copyBtn.textContent = t('editor.published.copyViewerLink');
        copyBtn.disabled = !model.serverReady;
        listen(copyBtn, () => onCopyLink(publishedPackageId));
        actions.appendChild(copyBtn);
      }

      if (publishState !== 'current_version_published') {
        const isPublishing = model.publishBusy || model.publishingIds.includes(item.uploaded_draft_id);
        const publishBtn = document.createElement('button');
        publishBtn.type = 'button';
        publishBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
        publishBtn.textContent = isPublishing
          ? t('editor.uploadedDraft.publishing')
          : publishState === 'unpublished_changes'
            ? t('editor.uploadedDraft.publishNewVersion')
            : t('common.actions.publish');
        publishBtn.disabled = isPublishing;
        listen(publishBtn, () => onPublish(item, publishBtn));
        actions.appendChild(publishBtn);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'uploaded-draft-action uploaded-draft-action--danger';
      deleteBtn.textContent = t('common.actions.delete');
      deleteBtn.disabled = false;
      listen(deleteBtn, () => onDelete(item, publishedPackageId));
      actions.appendChild(deleteBtn);
      row.append(meta, actions);
      container.appendChild(row);
    });
  }

  function render(model, isCurrent) {
    if (destroyed) return;
    events?.abort();
    events = new AbortController();
    const { signal } = events;
    const listen = (button, action) => button.addEventListener('click', () => {
      if (!signal.aborted && button.isConnected && isCurrent()) return action();
    }, { signal });
    // A list response may arrive while a publication/confirmation dialog is open.
    const hasForegroundDialog = [...document.querySelectorAll('[role="dialog"]')]
      .some(node => !root.contains(node) && node.getClientRects().length);
    root.innerHTML = '';
    if (!model.open) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal browse-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = t('editor.uploadedDraft.manage');
    const slotUsage = document.createElement('p');
    slotUsage.className = 'confirm-modal__description';
    slotUsage.hidden = Boolean(model.error) || model.loading;
    const slotLimit = Number(model.slotLimit) || 3;
    slotUsage.textContent = t('editor.uploadedDraft.slotUsage', {
      used: model.items.length,
      limit: slotLimit,
    });
    const list = document.createElement('div');
    list.className = 'browse-results';
    renderUploadedDraftRows(list, model, listen);
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'confirm-modal__btn';
    refreshBtn.textContent = model.loading ? t('common.actions.refreshing') : t('common.actions.refresh');
    refreshBtn.disabled = model.loading;
    listen(refreshBtn, () => onRefresh());
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'confirm-modal__btn';
    closeBtn.textContent = t('common.actions.close');
    listen(closeBtn, () => onClose());
    actions.append(refreshBtn, closeBtn);
    dialog.append(heading, slotUsage, list, actions);
    dialog.appendChild(createVisualLoadStatus());
    overlay.appendChild(dialog);
    root.appendChild(overlay);
    if (!hasForegroundDialog) closeBtn.focus();
  }

  return { render, destroy() { destroyed = true; events?.abort(); root.replaceChildren(); } };
}
