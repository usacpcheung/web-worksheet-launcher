import { prepareAnswerImage } from '../app/prepare-answer-image.js';
import { showImageDialog } from '../app/image-dialog.js';
import { t } from '../app/i18n/index.js';
const svg = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">${path}</svg>`;
const zoomIcon = svg('<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6m-3-3v6"/>');
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  n.className = cls;
  if (tag === 'button') n.type = 'button';
  if (text !== undefined) n.textContent = text;
  return n;
};
function confirmRemove(opener, signal) {
  return new Promise((resolve) => {
    const dialog = make('dialog', 'confirm-modal image-response-confirm');
    dialog.setAttribute('aria-label', t('imageResponse.removeTitle'));
    dialog.append(
      make('h3', '', t('imageResponse.removeTitle')),
      make('p', 'confirm-modal__description', t('imageResponse.removeHint'))
    );
    const actions = make('div', 'confirm-modal__actions'),
      cancel = make('button', 'confirm-modal__btn', t('common.actions.cancel')),
      remove = make(
        'button',
        'confirm-modal__btn confirm-modal__btn--destructive',
        t('imageResponse.remove')
      );
    let accepted = false;
    cancel.onclick = () => dialog.close();
    remove.onclick = () => {
      accepted = true;
      dialog.close();
    };
    actions.append(cancel, remove);
    dialog.append(actions);
    document.body.append(dialog);
    const abort = () => dialog.close();
    signal.addEventListener('abort', abort, { once: true });
    dialog.onclose = () => {
      signal.removeEventListener('abort', abort);
      dialog.remove();
      opener?.focus({ preventScroll: true });
      resolve(accepted);
    };
    dialog.showModal();
    cancel.focus();
  });
}
export function createImageResponseControls({ session, block, signal }) {
  const root = make('div', 'image-response'),
    grid = make('div', 'image-response-grid'),
    tools = make('div', 'image-response-tools'),
    add = make('button', 'image-response-add', t('imageResponse.add')),
    count = make('span', 'muted'),
    hint = make('p', 'muted', t('imageResponse.rules')),
    feedback = make('div', 'image-response-feedback');
  feedback.setAttribute('role', 'status');
  root.append(grid, tools, hint, feedback);
  tools.append(add, count);
  let disposed = false,
    urls = [],
    renderKey,
    renderGeneration = 0,
    controller,
    activeDialog,
    refreshDialog;
  const attemptId = session.state.localAttemptId;
  const refs = () => session.state.answers?.[block.blockId]?.value || [];
  const current = () =>
    !disposed && session.state.localAttemptId === attemptId && session.state.status !== 'completed';
  const clearUrls = () => {
    activeDialog?.close();
    activeDialog = refreshDialog = null;
    urls.forEach(URL.revokeObjectURL);
    urls = [];
  };
  signal.addEventListener(
    'abort',
    () => {
      disposed = true;
      controller?.abort();
      clearUrls();
    },
    { once: true }
  );
  function enlarged(index, opener) {
    if (!urls[index]) return;
    showImageDialog({
      src: urls[index],
      alt: t('imageResponse.image', { number: index + 1 }),
      title: t('imageResponse.image', { number: index + 1 }),
      signal,
      opener,
    });
    const dialog = document.querySelector('.worksheet-image-dialog');
    if (!dialog) return;
    activeDialog = dialog;
    dialog.addEventListener(
      'close',
      () => {
        if (activeDialog === dialog) activeDialog = refreshDialog = null;
      },
      { once: true }
    );
    if (refs().length < 2) return;
    const nav = make('div', 'image-response-tools'),
      prev = make('button', '', t('imageResponse.previous')),
      pos = make('span', ''),
      next = make('button', '', t('imageResponse.next'));
    const update = () => {
      dialog.querySelector('img').src = urls[index];
      dialog.querySelector('img').alt = t('imageResponse.image', {
        number: index + 1,
      });
      dialog.querySelector('h2').textContent = t('imageResponse.image', {
        number: index + 1,
      });
      dialog.setAttribute('aria-label', t('imageResponse.image', { number: index + 1 }));
      pos.textContent = `${index + 1} / ${refs().length}`;
      prev.disabled = index === 0 || !urls[index - 1];
      next.disabled = index === refs().length - 1 || !urls[index + 1];
    };
    prev.onclick = () => {
      index--;
      update();
    };
    next.onclick = () => {
      index++;
      update();
    };
    refreshDialog = update;
    nav.append(prev, pos, next);
    dialog.append(nav);
    update();
  }
  async function commit(next, expected, blob) {
    if (!current()) return;
    const assetId = blob ? crypto.randomUUID() : null;
    const asset = blob
      ? {
          localId: assetId,
          binary: new Uint8Array(await blob.arrayBuffer()),
          metadata: {
            localId: assetId,
            ownerAttemptId: attemptId,
            mimeType: blob.type,
            origin: 'image_answer',
            updatedAt: new Date().toISOString(),
          },
        }
      : null;
    const values = next.map((r) => (r.assetId === null ? { assetId } : r));
    const isCurrent = () =>
      current() && !controller?.signal.aborted && JSON.stringify(refs()) === JSON.stringify(expected);
    if (!isCurrent()) return;
    await session.storage.commitAnswerImages({
      attemptId,
      blockId: block.blockId,
      expected,
      next: values,
      asset,
      isCurrent,
    });
    if (!isCurrent()) return;
    session.state.answers = {
      ...session.state.answers,
      [block.blockId]: { value: values, answeredAt: new Date().toISOString() },
    };
    session.state.attemptRevision++;
    // Persist any text/metadata edits made while the image transaction was pending.
    session.scheduleAutosave();
    session.state.lastSavedAt = new Date().toISOString();
    session.notifyStateChange();
  }
  async function run(file, index) {
    if (!current() || session.imagePending || session.imageExportPending) return;
    const token = {};
    session.imagePending = token;
    controller = new AbortController();
    const expected = structuredClone(refs());
    const status = make('p', '', t('imageResponse.preparing')),
      cancel = make('button', '', t('common.actions.cancel'));
    feedback.replaceChildren(status, cancel);
    cancel.onclick = () => controller.abort();
    session.notifyStateChange();
    update();
    try {
      const prepared = await prepareAnswerImage(file, {
        signal: controller.signal,
      });
      if (!current() || controller.signal.aborted) return;
      if (prepared.changed) {
        const url = URL.createObjectURL(prepared.blob),
          img = make('img', 'image-response-candidate');
        img.src = url;
        img.alt = t('imageResponse.review');
        const use = make('button', 'image-response-add', t('imageResponse.use'));
        status.textContent = t('imageResponse.review');
        feedback.append(img, use);
        const accept = await new Promise((resolve) => {
          use.onclick = () => resolve(true);
          controller.signal.addEventListener('abort', () => resolve(false), {
            once: true,
          });
          cancel.onclick = () => controller.abort();
        });
        URL.revokeObjectURL(url);
        if (!accept || !current()) return;
      }
      if (controller.signal.aborted) return;
      const next = [...expected];
      if (index == null) next.push({ assetId: null });
      else next[index] = { assetId: null };
      cancel.disabled = true;
      await session.flushLocalStateForAuthRedirect();
      await commit(next, expected, prepared.blob);
      feedback.replaceChildren();
    } catch (error) {
      if (error.name !== 'AbortError')
        feedback.replaceChildren(
          make(
            'p',
            'input-error',
            t(
              error.code === 'IMAGE_SIZE'
                ? 'imageResponse.tooLarge'
                : error.code === 'IMAGE_DIMENSIONS'
                  ? 'imageResponse.dimensions'
                  : error.code === 'IMAGE_FORMAT'
                    ? 'imageResponse.format'
                    : error.code === 'IMAGE_PREPARATION'
                      ? 'imageResponse.prepareFailed'
                      : error.name === 'QuotaExceededError'
                        ? 'imageResponse.storageFull'
                        : 'imageResponse.failed'
            )
          )
        );
    } finally {
      if (controller.signal.aborted) feedback.replaceChildren();
      if (session.imagePending === token) session.imagePending = null;
      session.notifyStateChange();
      update();
    }
  }
  function choose(index) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png';
    input.onchange = () => {
      if (input.files[0]) run(input.files[0], index);
    };
    input.click();
  }
  add.onclick = () => choose(null);
  async function update() {
    if (disposed) return;
    const value = refs(),
      completed = session.state.status === 'completed';
    add.hidden = completed;
    add.disabled =
      !!(session.imagePending || session.imageExportPending) ||
      value.length >= block.responseConfig.maxImages;
    count.textContent = t('imageResponse.count', {
      count: value.length,
      max: block.responseConfig.maxImages,
    });
    root.querySelectorAll('[data-edit-image]').forEach((b) => {
      b.hidden = completed;
      b.disabled = !!(session.imagePending || session.imageExportPending);
    });
    const key = JSON.stringify([value, completed]);
    if (key === renderKey) return;
    renderKey = key;
    const generation = ++renderGeneration;
    clearUrls();
    grid.replaceChildren();
    if (!value.length) {
      grid.append(make('p', 'image-response-empty', t('imageResponse.empty')));
      return;
    }
    for (let i = 0; i < value.length; i++) {
      const card = make('article', 'image-response-card'),
        picture = make('div', 'image-response-picture'),
        open = make('button', 'image-response-open'),
        zoom = make('button', 'viewer-option-enlarge'),
        meta = make('div', 'image-response-meta'),
        actions = make('div', 'image-response-tools');
      open.setAttribute('aria-label', t('imageResponse.enlarge', { number: i + 1 }));
      zoom.setAttribute('aria-label', open.getAttribute('aria-label'));
      zoom.innerHTML = zoomIcon;
      open.disabled = zoom.disabled = true;
      const replace = make('button', '', t('imageResponse.replace')),
        remove = make('button', '', t('imageResponse.remove'));
      replace.dataset.editImage = remove.dataset.editImage = '';
      replace.hidden = remove.hidden = completed;
      replace.disabled = remove.disabled = !!(session.imagePending || session.imageExportPending);
      replace.onclick = () => choose(i);
      remove.onclick = async () => {
        if (!current() || session.imagePending || session.imageExportPending) return;
        const expected = structuredClone(refs());
        if (!(await confirmRemove(remove, signal)) || !current()) return;
        const token = {};
        if (session.imagePending || session.imageExportPending) return;
        session.imagePending = token;
        controller = new AbortController();
        try {
          await session.flushLocalStateForAuthRedirect();
          await commit(
            expected.filter((_, j) => i !== j),
            expected
          );
        } catch {
          feedback.replaceChildren(make('p', 'input-error', t('imageResponse.failed')));
        } finally {
          if (session.imagePending === token) session.imagePending = null;
          session.notifyStateChange();
          update();
        }
      };
      actions.append(replace, remove);
      meta.append(make('h4', '', t('imageResponse.image', { number: i + 1 })), actions);
      picture.append(open, zoom);
      card.append(picture, meta);
      grid.append(card);
      try {
        const asset = await session.storage.localAssets.get(value[i].assetId);
        if (disposed || generation !== renderGeneration) return;
        if (!asset?.binary) throw new Error('missing');
        const url = URL.createObjectURL(new Blob([asset.binary], { type: asset.metadata.mimeType }));
        urls[i] = url;
        refreshDialog?.();
        const img = make('img', '');
        img.src = url;
        img.alt = t('imageResponse.image', { number: i + 1 });
        open.append(img);
        img.onload = () => {
          open.disabled = zoom.disabled = false;
        };
        img.onerror = () => {
          open.textContent = t('imageResponse.unavailable');
          open.disabled = zoom.disabled = true;
        };
        open.onclick = zoom.onclick = () => enlarged(i, document.activeElement);
      } catch {
        open.textContent = t('imageResponse.unavailable');
      }
    }
  }
  root.update = update;
  update();
  return root;
}
