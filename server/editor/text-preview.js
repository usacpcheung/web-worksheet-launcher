import { setWorksheetText, promptTextState, PROMPT_TEXT_LIMIT } from '../app/worksheet-text.js';

export function createTextPreview(textarea, t, infoIcon = '') {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'editor-text-preview-toggle';
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'editor-text-edit-toggle';
  const modes = document.createElement('div'); modes.className = 'editor-text-modes'; modes.setAttribute('role', 'group');
  modes.append(edit, button);
  const help = document.createElement('details'); help.className = 'editor-text-help';
  const summary = document.createElement('summary'); summary.innerHTML = infoIcon;
  const examples = document.createElement('div'); examples.className = 'editor-text-help-popover';
  help.append(summary, examples);
  help.addEventListener('keydown', event => { if (event.key === 'Escape') { help.open = false; summary.focus(); event.stopPropagation(); } });
  const preview = document.createElement('div'); preview.className = 'control editor-text-preview worksheet-text'; preview.tabIndex = 0;
  preview.setAttribute('role', 'region'); preview.id = `${textarea.id}-preview`;
  let key = null; let showing = false; let field = null; let selection = null; let height = null;
  let isPrompt = false;
  const counter = document.createElement('p'); counter.className = 'muted editor-prompt-counter'; counter.id = `${textarea.id}-count`;
  const warning = document.createElement('p'); warning.className = 'control-error'; warning.id = `${textarea.id}-limit`; warning.setAttribute('role', 'status');
  const updateLimit = () => {
    counter.hidden = !isPrompt;
    const state = isPrompt ? promptTextState({ ...field, text: textarea.value }) : null;
    counter.textContent = state ? t('formatting.promptCount', { count: state.count, max: PROMPT_TEXT_LIMIT }) : '';
    warning.textContent = state?.exceedsLimit ? t('formatting.promptTooLong', { max: PROMPT_TEXT_LIMIT }) : '';
    warning.hidden = !state?.exceedsLimit;
    textarea.setAttribute('aria-invalid', String(Boolean(state?.exceedsLimit)));
    if (isPrompt) textarea.setAttribute('aria-describedby', `${counter.id} ${warning.id}`);
    else textarea.removeAttribute('aria-describedby');
  };
  textarea.addEventListener('input', updateLimit);
  const sync = () => {
    button.textContent = t('formatting.preview'); edit.textContent = t('formatting.edit');
    modes.setAttribute('aria-label', t('formatting.mode'));
    button.setAttribute('aria-pressed', String(showing)); edit.setAttribute('aria-pressed', String(!showing));
    button.setAttribute('aria-controls', preview.id); edit.setAttribute('aria-controls', textarea.id);
    summary.setAttribute('aria-label', t('formatting.help'));
    examples.replaceChildren();
    const title = document.createElement('strong'); title.textContent = t('formatting.help'); examples.append(title);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of [t('formatting.syntax'), t('formatting.result')]) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; head.append(cell);
    }
    const body = table.createTBody();
    const lines = t('formatting.examples').split('\n');
    for (const source of [...lines.slice(0, 6), '\\*']) {
      const row = body.insertRow(); const code = document.createElement('code'); code.textContent = source;
      row.insertCell().append(code);
      setWorksheetText(row.insertCell(), { text: source, format: 'limited-markdown-v1' });
    }
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = t('formatting.helpNote');
    examples.append(table, note);
    preview.setAttribute('aria-label', t('formatting.preview'));
    preview.classList.toggle('editor-text-preview--prompt', isPrompt);
    textarea.hidden = showing; preview.hidden = !showing;
    updateLimit();
    if (height) preview.style.height = `${height}px`;
    if (showing) {
      if (!textarea.value.trim()) { preview.textContent = t('formatting.empty'); preview.classList.add('muted'); }
      else { preview.classList.remove('muted'); setWorksheetText(preview, { ...field, text: textarea.value }); }
    }
  };
  const setMode = next => {
    if (showing === next) return;
    if (next) {
      selection = [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection, textarea.scrollTop];
      height = textarea.getBoundingClientRect().height || 180;
    }
    showing = next; sync();
    if (!showing) {
      textarea.focus();
      if (selection) { textarea.setSelectionRange(...selection.slice(0, 3)); textarea.scrollTop = selection[3]; }
    }
  };
  button.addEventListener('click', () => setMode(true));
  edit.addEventListener('click', () => setMode(false));
  return {
    mount(parent, label, nextKey, nextField, nextIsPrompt = false) {
      if (key !== nextKey) { showing = false; help.open = false; selection = null; height = null; key = nextKey; }
      field = nextField;
      isPrompt = nextIsPrompt;
      const header = document.createElement('div'); header.className = 'editor-text-field-label'; header.append(label, modes, help);
      parent.append(header, textarea, preview, counter, warning); sync();
    },
  };
}
