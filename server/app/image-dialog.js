import { t } from './i18n/index.js';
// Native modal supplies keyboard focus containment; callers own the source URL.
export function showImageDialog({ src, alt, title, signal, opener = document.activeElement }) {
  if (signal?.aborted) return;
  const dialog = document.createElement('dialog'); dialog.className = 'worksheet-image-dialog';
  dialog.setAttribute('aria-label', title);
  const header = document.createElement('header');
  const heading = document.createElement('h2'); heading.textContent = title;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'worksheet-image-close';
  close.textContent = '×'; close.setAttribute('aria-label', t('common.actions.close')); close.autofocus = true;
  header.append(heading, close);
  const image = document.createElement('img'); image.src = src; image.alt = alt;
  dialog.append(header, image); document.body.append(dialog);
  const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    signal?.removeEventListener('abort', abort);
    dialog.remove(); document.body.style.overflow = overflow;
    if (!signal?.aborted && opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const abort = () => { dialog.close(); dispose(); };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', dispose, { once: true });
  let outsideDown = false;
  const outside = e => { const r = dialog.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  dialog.addEventListener('pointerdown', e => { outsideDown = outside(e); });
  dialog.addEventListener('click', e => { if (outsideDown && outside(e)) dialog.close(); outsideDown = false; });
  signal?.addEventListener('abort', abort, { once: true });
  dialog.showModal();
}
