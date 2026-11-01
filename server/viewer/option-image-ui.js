import { optionImageRef, imageDescription } from '../app/option-images.js';
import { showImageDialog } from '../app/image-dialog.js';
import { t } from '../app/i18n/index.js';
export function mountOptionImage({ option, button, tools, storage, prefix, signal }) {
  const frame = document.createElement('span'); frame.className = 'viewer-option-image'; button.append(frame);
  const ref = optionImageRef(option);
  if (!ref) return;
  const alt = imageDescription(option.imageDescription).trim() || t('optionImages.imageAlt', { option: prefix });
  const image = document.createElement('img'); image.alt = alt; frame.append(image);
  const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'viewer-option-enlarge';
  zoom.setAttribute('aria-label', t('optionImages.enlarge', { option: prefix })); zoom.title = zoom.getAttribute('aria-label');
  zoom.setAttribute('aria-haspopup', 'dialog'); zoom.disabled = true;
  zoom.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6m-3-3v6"/></svg>';
  tools.append(zoom);
  let url;
  const cleanup = () => { if (url) URL.revokeObjectURL(url); url = null; };
  signal.addEventListener('abort', cleanup, { once: true });
  const missing = () => { if (signal.aborted) return; cleanup(); frame.textContent = t('optionImages.unavailable'); zoom.disabled = true; };
  zoom.addEventListener('click', () => showImageDialog({ src: url, alt, title: t('optionImages.imageAlt', { option: prefix }), signal, opener: zoom }), { signal });
  image.addEventListener('error', missing, { signal });
  image.addEventListener('load', () => { zoom.disabled = false; }, { signal });
  Promise.resolve().then(() => storage.localAssets.get(ref.assetId)).then(asset => {
    if (signal.aborted) return;
    if (!(asset?.binary instanceof Uint8Array) || !asset.binary.length) { missing(); return; }
    const mime = asset.metadata?.mimeType || 'image/png';
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mime)) { missing(); return; }
    url = URL.createObjectURL(new Blob([asset.binary], { type: mime })); image.src = url;
  }).catch(missing);
}
