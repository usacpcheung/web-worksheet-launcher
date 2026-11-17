// Editor-only dialog views. Callers retain mutation, authentication and retry policy.
export function createEditorDialogs({ host, t, createLocalId, formatUploadedDraftTimestamp }) {
  let destroyed = false;
  let activeConfirmDialog = null;
  const pendingDialogs = new Set();
  const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

  function trackDialog(overlay, previousActive, cancelResult) {
    const events = new AbortController();
    let settled = false;
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const pending = {
      result,
      listen: (node, type, listener) => node.addEventListener(type, listener, { signal: events.signal }),
      cancel: () => pending.finish(cancelResult),
      finish: value => {
        if (settled) return;
        settled = true;
        events.abort();
        pendingDialogs.delete(pending);
        if (activeConfirmDialog === pending) activeConfirmDialog = null;
        overlay.remove();
        resolve(value);
        if (!destroyed && previousActive?.isConnected) previousActive.focus();
      },
    };
    pendingDialogs.add(pending);
    return pending;
  }

  function showConfirmDialog({
    title,
    bodyText,
    entityLabel,
    descriptionText,
    removalItems = [],
    confirmLabel = t('common.actions.delete'),
    cancelLabel = t('common.actions.cancel'),
    variant = 'danger',
    warningText = t('editor.modal.confirm.irreversibleWarning'),
    content = null,
  }) {
    if (destroyed) return Promise.resolve(false);
    activeConfirmDialog?.cancel();
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    overlay.setAttribute('role', 'presentation');
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    const titleId = `confirm-modal-title-${createLocalId('dlg')}`;
    heading.id = titleId;
    heading.textContent = title;
    dialog.setAttribute('aria-labelledby', titleId);
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    const resolvedBodyText = isNonEmptyString(bodyText) ? bodyText : descriptionText;
    const fallbackDescription = isNonEmptyString(entityLabel)
      ? t('editor.modal.confirm.deleteEntity', { entity: entityLabel })
      : t('editor.modal.confirm.defaultDescription');
    description.textContent = isNonEmptyString(resolvedBodyText)
      ? resolvedBodyText
      : fallbackDescription;
    const detailsHeading = document.createElement('p');
    detailsHeading.className = 'confirm-modal__details-heading';
    detailsHeading.textContent = t('editor.modal.confirm.thisWillRemove');
    const detailsList = document.createElement('ul');
    detailsList.className = 'confirm-modal__details-list';
    removalItems.forEach((item) => {
      const line = document.createElement('li');
      line.textContent = item;
      detailsList.appendChild(line);
    });
    const warning = document.createElement('p');
    warning.className = variant === 'warning'
      ? 'confirm-modal__warning confirm-modal__warning--caution'
      : 'confirm-modal__warning';
    warning.textContent = warningText;
    const actionRow = document.createElement('div');
    actionRow.className = 'confirm-modal__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = cancelLabel;
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = variant === 'danger'
      ? 'confirm-modal__btn confirm-modal__btn--destructive'
      : variant === 'warning'
        ? 'confirm-modal__btn confirm-modal__btn--warning'
        : 'confirm-modal__btn';
    deleteBtn.textContent = confirmLabel;
    actionRow.append(cancelBtn, deleteBtn);
    dialog.append(heading, description);
    if (content) dialog.append(content);
    if (removalItems.length > 0) {
      dialog.append(detailsHeading, detailsList);
    }
    if (isNonEmptyString(warningText)) {
      dialog.append(warning);
    }
    dialog.append(actionRow);
    overlay.appendChild(dialog);
    host.appendChild(overlay);
    const pending = trackDialog(overlay, previousActive, false);
    activeConfirmDialog = pending;

    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const getFocusable = () => Array.from(dialog.querySelectorAll(focusableSelector))
      .filter((candidate) => !candidate.hasAttribute('disabled'));
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        pending.finish(false);
        return;
      }
      if (event.key === 'Enter' && document.activeElement === cancelBtn) {
        event.preventDefault();
        pending.finish(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
        return;
      }
      if (currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    pending.listen(dialog, 'keydown', onKeyDown);
    pending.listen(cancelBtn, 'click', () => pending.finish(false));
    pending.listen(deleteBtn, 'click', () => pending.finish(true));

    cancelBtn.focus();

    return pending.result;
  }

  function showPublishModal({ uploadedDraft, initialTitle = null, initialSubject = null }) {
    if (destroyed) return Promise.resolve({ confirmed: false });
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = t('editor.modal.publish.title');
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    description.textContent = t('editor.modal.publish.description');
    const publishTitleField = document.createElement('div');
    publishTitleField.className = 'editor-field';
    const publishTitleLabel = document.createElement('label');
    publishTitleLabel.textContent = t('editor.modal.publish.publishedTitle');
    const publishTitleInput = document.createElement('input');
    publishTitleInput.className = 'control';
    publishTitleInput.value = initialTitle !== null
      ? String(initialTitle)
      : String(uploadedDraft?.title || '');
    publishTitleField.append(publishTitleLabel, publishTitleInput);
    const publishSubjectField = document.createElement('div');
    publishSubjectField.className = 'editor-field';
    const publishSubjectLabel = document.createElement('label');
    publishSubjectLabel.textContent = t('editor.modal.publish.publishedSubject');
    const publishSubjectInput = document.createElement('input');
    publishSubjectInput.className = 'control';
    publishSubjectInput.value = initialSubject !== null
      ? String(initialSubject)
      : String(uploadedDraft?.subject || '');
    publishSubjectField.append(publishSubjectLabel, publishSubjectInput);
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions confirm-modal__actions--publish';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = t('common.actions.cancel');
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'confirm-modal__btn confirm-modal__btn--primary';
    confirmBtn.textContent = t('common.actions.publish');
    actions.append(cancelBtn, confirmBtn);
    dialog.append(heading, description, publishTitleField, publishSubjectField, actions);
    overlay.appendChild(dialog);
    host.appendChild(overlay);
    const pending = trackDialog(overlay, previousActive, { confirmed: false });

    const getFocusable = () => [
      publishTitleInput,
      publishSubjectInput,
      cancelBtn,
      confirmBtn,
    ].filter((node) => !node.disabled);

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        pending.finish({ confirmed: false });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
        return;
      }
      if (currentIndex === focusable.length - 1 || currentIndex === -1) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    pending.listen(dialog, 'keydown', onKeyDown);
    pending.listen(cancelBtn, 'click', () => {
      pending.finish({ confirmed: false });
    });
    pending.listen(confirmBtn, 'click', () => {
      pending.finish({
        confirmed: true,
        title: publishTitleInput.value,
        subject: publishSubjectInput.value,
      });
    });
    publishTitleInput.focus();
    return pending.result;
  }

  function showPublishedPackageConflictModal() {
    if (destroyed) return Promise.resolve({ action: 'cancel' });
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.textContent = t('editor.modal.publishConflict.title');
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    description.textContent = t('editor.modal.publishConflict.description');
    const warning = document.createElement('p');
    warning.className = 'confirm-modal__warning';
    warning.textContent = t('editor.modal.publishConflict.warning');

    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = t('common.actions.cancel');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'confirm-modal__btn confirm-modal__btn--destructive';
    editBtn.textContent = t('editor.modal.publishConflict.editNameSubject');
    actions.append(cancelBtn, editBtn);
    dialog.append(heading, description, warning, actions);
    overlay.appendChild(dialog);
    host.appendChild(overlay);
    const pending = trackDialog(overlay, previousActive, { action: 'cancel' });

    const getFocusable = () => [cancelBtn, editBtn].filter((node) => !node.disabled);

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        pending.finish({ action: 'cancel' });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
        return;
      }
      if (currentIndex === focusable.length - 1 || currentIndex === -1) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    pending.listen(cancelBtn, 'click', () => {
      pending.finish({ action: 'cancel' });
    });
    pending.listen(editBtn, 'click', () => {
      pending.finish({ action: 'edit' });
    });
    pending.listen(dialog, 'keydown', onKeyDown);
    editBtn.focus();
    return pending.result;
  }

  function showUploadConflictModal({ existingDraft }) {
    if (destroyed) return Promise.resolve({ action: 'cancel' });
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = t('editor.modal.uploadConflict.title');
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    description.textContent = t('editor.modal.uploadConflict.description', {
      title: existingDraft?.title || t('common.values.untitled'),
    });
    const details = document.createElement('div');
    details.className = 'muted uploaded-draft-details-body';
    const subjectLine = document.createElement('div');
    subjectLine.textContent = t('common.meta.subject', { value: existingDraft?.subject || '-' });
    const uploadedLine = document.createElement('div');
    uploadedLine.textContent = t('common.meta.uploaded', { value: formatUploadedDraftTimestamp(existingDraft?.created_at) });
    const statusLine = document.createElement('div');
    statusLine.textContent = existingDraft?.published_package_id
      ? t('common.meta.status', { value: t('editor.modal.uploadConflict.statusAlreadyPublished') })
      : t('common.meta.status', { value: t('editor.modal.uploadConflict.statusDraftOnly') });
    details.append(subjectLine, uploadedLine, statusLine);
    const warning = document.createElement('p');
    warning.className = 'confirm-modal__warning';
    warning.textContent = existingDraft?.published_package_id
      ? t('editor.modal.uploadConflict.warningPublishedCopyUnaffected')
      : t('editor.modal.uploadConflict.warningReplaceArtifact');
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = t('common.actions.cancel');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'confirm-modal__btn';
    copyBtn.textContent = t('editor.modal.uploadConflict.saveAsNewCopy');
    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'confirm-modal__btn confirm-modal__btn--destructive';
    replaceBtn.textContent = t('editor.modal.uploadConflict.replaceUploadedDraft');
    actions.append(cancelBtn, copyBtn, replaceBtn);
    dialog.append(heading, description, details, warning, actions);
    overlay.appendChild(dialog);
    host.appendChild(overlay);
    const pending = trackDialog(overlay, previousActive, { action: 'cancel' });
    let resolved = false;

    const choose = (action) => {
      if (resolved) return;
      resolved = true;
      cancelBtn.disabled = true;
      copyBtn.disabled = true;
      replaceBtn.disabled = true;
      pending.finish({ action });
    };
    pending.listen(cancelBtn, 'click', () => {
      choose('cancel');
    });
    pending.listen(copyBtn, 'click', () => {
      choose('copy');
    });
    pending.listen(replaceBtn, 'click', () => {
      choose('replace');
    });
    pending.listen(dialog, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        choose('cancel');
      }
    });
    cancelBtn.focus();
    return pending.result;
  }

  return {
    showConfirmDialog, showPublishModal, showPublishedPackageConflictModal, showUploadConflictModal,
    isConfirmationOpen: () => activeConfirmDialog !== null,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const pending of [...pendingDialogs].reverse()) pending.cancel();
    },
  };
}
