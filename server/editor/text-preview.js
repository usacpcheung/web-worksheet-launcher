import { setWorksheetText } from '../app/worksheet-text.js';

export function createTextPreview(textarea, t) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'editor-text-preview-toggle';
  const help = document.createElement('details'); help.className = 'editor-text-help';
  const summary = document.createElement('summary'); summary.textContent = '?';
  const examples = document.createElement('div'); examples.className = 'editor-text-help-popover';
  help.append(summary, examples);
  help.addEventListener('keydown', event => { if (event.key === 'Escape') { help.open = false; summary.focus(); event.stopPropagation(); } });
  const preview = document.createElement('div'); preview.className = 'control editor-text-preview worksheet-text'; preview.tabIndex = 0;
  preview.setAttribute('role', 'region'); preview.id = `${textarea.id}-preview`;
  let key = null; let showing = false; let field = null; let selection = null; let height = null;
  const sync = () => {
    button.textContent = t(showing ? 'formatting.edit' : 'formatting.preview');
    button.setAttribute('aria-expanded', String(showing)); button.setAttribute('aria-controls', preview.id);
    summary.setAttribute('aria-label', t('formatting.help'));
    examples.textContent = t('formatting.examples');
    preview.setAttribute('aria-label', t('formatting.preview'));
    textarea.hidden = showing; preview.hidden = !showing;
    if (height) preview.style.height = `${height}px`;
    if (showing) {
      if (!textarea.value.trim()) { preview.textContent = t('formatting.empty'); preview.classList.add('muted'); }
      else { preview.classList.remove('muted'); setWorksheetText(preview, { ...field, text: textarea.value }); }
    }
  };
  button.addEventListener('click', () => {
    if (!showing) {
      selection = [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection, textarea.scrollTop];
      height = textarea.getBoundingClientRect().height || 180;
    }
    showing = !showing; sync();
    if (!showing) {
      textarea.focus();
      if (selection) { textarea.setSelectionRange(...selection.slice(0, 3)); textarea.scrollTop = selection[3]; }
    }
  });
  return {
    mount(parent, label, nextKey, nextField) {
      if (key !== nextKey) { showing = false; help.open = false; selection = null; height = null; key = nextKey; }
      field = nextField;
      const header = document.createElement('div'); header.className = 'editor-text-field-label'; header.append(label, button, help);
      parent.append(header, textarea, preview); sync();
    },
  };
}
