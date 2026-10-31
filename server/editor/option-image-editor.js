import { optionImageRef, imageDescription } from '../app/option-images.js';
import { t } from '../app/i18n/index.js';
import { showImageDialog } from '../app/image-dialog.js';

let descriptionSequence = 0;
export function mountOptionImageEditor({ row, option, blockId, session, icon, confirm, refresh, run }) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-btn editor-option-image-button';
  button.innerHTML = icon('image'); button.title = t('optionImages.manage'); button.setAttribute('aria-label', button.title);
  row.querySelector('[data-option-input]').after(button);
  row.querySelector('[data-option-input]').placeholder = t('optionImages.placeholder');
  const ref = optionImageRef(option);
  button.classList.toggle('is-attached', Boolean(ref));
  const choose = () => {
    const draftId = session.state.draft?.localId, generation = session._audioDraftGeneration;
    const existed = session.findBlock(blockId)?.responseConfig?.options?.some(item => item.id === option.id);
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => run(async () => {
      const file = input.files?.[0]; if (!file) return;
      const current = () => session.state.draft?.localId === draftId && session._audioDraftGeneration === generation && row.isConnected && (!existed || session.findBlock(blockId)?.responseConfig?.options?.some(item => item.id === option.id && optionImageRef(item)?.assetId === ref?.assetId));
      if (!current()) return;
      if (ref && !await confirm(t('optionImages.replace'))) return;
      if (!current()) return;
      // The initially displayed empty row may not yet have a persisted option.
      if (!session.findBlock(blockId)?.responseConfig?.options?.some(item => item.id === option.id)) {
        session.updateQuestionOptionAtIndex(blockId, Number(row.querySelector('input').dataset.optionIndex), '', { optionId: option.id });
      }
      await session.attachOptionImage(blockId, option.id, file, { confirmReplace: true, isCurrent: current }); refresh();
    })); input.click();
  };
  button.addEventListener('click', choose);
  if (!ref) return;
  const strip = document.createElement('div'); strip.className = 'editor-option-image-attachment';
  const thumb = document.createElement('img'); thumb.alt = option.imageDescription || t('optionImages.imageAlt', { option: '' });
  const actions = document.createElement('div'); actions.className = 'media-row__actions';
  const action = (text, callback) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'media-action-btn'; b.textContent = text; b.onclick = callback; actions.append(b); return b; };
  const view = action(t('editor.media.actions.view'), () => showImageDialog({ src: thumb.src, alt: thumb.alt, title: t('optionImages.imageAlt', { option: '' }), opener: view })); view.disabled = true;
  action(t('editor.media.actions.replace'), choose);
  action(t('editor.media.actions.remove'), () => run(async () => {
    const draft = session.state.draft;
    if (!await confirm(t('optionImages.remove')) || draft !== session.state.draft) return;
    await session.removeOptionImage(blockId, option.id, { confirmRemove: true }); refresh();
  }));
  const field = document.createElement('div'); field.className = 'editor-option-image-description';
  const label = document.createElement('label'); label.textContent = t('optionImages.description');
  const input = document.createElement('textarea'); input.className = 'control'; input.rows = 2; input.value = option.imageDescription || '';
  input.id = `option-image-description-${++descriptionSequence}`; label.htmlFor = input.id;
  const count = document.createElement('span'); count.className = 'muted'; count.id = input.id + '-count';
  const help = document.createElement('p'); help.className = 'muted'; help.id = input.id + '-help'; help.textContent = t('optionImages.descriptionHelp');
  input.setAttribute('aria-describedby', `${count.id} ${help.id}`);
  const update = (save = true) => {
    input.value = imageDescription(input.value); count.textContent = t('optionImages.count', { count: Array.from(input.value).length });
    thumb.alt = input.value.trim() || t('optionImages.imageAlt', { option: '' });
    if (save) session.updateOptionImageDescription(blockId, option.id, input.value);
  };
  input.addEventListener('input', e => { if (!e.isComposing) update(); }); input.addEventListener('compositionend', () => update()); update(false);
  field.append(label, input, count, help); strip.append(thumb, actions, field); row.append(strip);
  session.getLocalAssetRecord(ref.assetId).then(asset => {
    if (!strip.isConnected || !asset?.binary) return;
    const reader = new FileReader();
    reader.onload = () => { if (strip.isConnected) { thumb.src = reader.result; view.disabled = false; } };
    reader.readAsDataURL(new Blob([asset.binary], { type: asset.metadata?.mimeType || 'image/png' }));
  });
}
