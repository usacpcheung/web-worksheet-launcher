import { copyWorksheetText, promptTextState, PROMPT_TEXT_LIMIT } from '../app/worksheet-text.js';
import { fieldToEditorDocument, editorDocumentToField } from './rich-text-codec.js';
let engineModule;
let loadAttempt = 0;
function loadEngine() {
  if (engineModule) return engineModule;
  const url = new URL('./vendor/rich-text-engine.js', import.meta.url);
  // Browsers cache failed module fetches too; Retry must request a fresh module URL.
  if (loadAttempt++) url.searchParams.set('retry', String(loadAttempt));
  engineModule = import(url.href).catch(error => { engineModule = null; throw error; });
  return engineModule;
}
const icons = {
  bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z"/>',
  italic: '<path d="M11 4h8M5 20h8M15 4 9 20"/>',
  underline: '<path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/>',
  redText: '<path d="m6 17 6-13 6 13M8 12h8M4 21h16"/>',
  bulletList: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  orderedList: '<path d="M10 6h10M10 12h10M10 18h10M3 4h1v5M3 13c4-2 4 1 0 5h3"/>',
  blockquote: '<path d="M9 7H4v6h5v4H5M20 7h-5v6h5v4h-4"/>',
  clear: '<path d="m4 15 8-10 8 6-8 10H8zm5 6h12M8 10l8 6"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>',
};
export function createRichTextEditor(t, onChange, options = {}) {
  const copyField = options.copyField || copyWorksheetText;
  const toDocument = options.toDocument || fieldToEditorDocument;
  const fromDocument = options.fromDocument || editorDocumentToField;
  const records = new Map();
  let disposed = false;
  const update = record => {
    if (!record.editor) return;
    const editor = record.editor;
    for (const [name, button] of record.buttons) {
      if (!['clear','undo','redo'].includes(name)) button.setAttribute('aria-pressed', String(editor.isActive(name)));
      button.disabled = name === 'undo' ? !editor.can().undo() : name === 'redo' ? !editor.can().redo() : false;
    }
    record.select.value = editor.isActive('heading') ? String(editor.getAttributes('heading').level) : 'p';
    const state = record.isPrompt ? promptTextState(record.field) : null;
    record.counter.hidden = !state;
    record.counter.textContent = state ? t('formatting.promptCount', { count: state.count, max: PROMPT_TEXT_LIMIT }) : '';
    record.warning.textContent = state?.exceedsLimit ? t('formatting.promptTooLong', { max: PROMPT_TEXT_LIMIT }) : '';
    record.warning.hidden = !state?.exceedsLimit;
    editor.view.dom.setAttribute('aria-invalid', String(Boolean(state?.exceedsLimit)));
  };
  function make(key, field, identity) {
    const editorId = options.idPrefix ? `${options.idPrefix}-${identity.blockId}` : 'editor-block-editor';
    const root = document.createElement('div'); root.className = 'editor-rich-text';
    const toolbar = document.createElement('div'); toolbar.className = 'editor-rich-toolbar';
    toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', t('richEditor.toolbar'));
    const select = document.createElement('select'); select.setAttribute('aria-label', t('richEditor.style'));
    for (const value of ['p','2','3','4']) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'p' ? t('richEditor.paragraph') : t('richEditor.heading', { level: value }); select.append(option);
    }
    toolbar.append(select);
    const surface = document.createElement('div'); surface.className = 'editor-rich-surface worksheet-text';
    const counter = document.createElement('p'); counter.className = 'muted editor-prompt-counter'; counter.id = `${editorId}-count`;
    const warning = document.createElement('p'); warning.className = 'control-error'; warning.setAttribute('role', 'status'); warning.id = `${editorId}-limit`;
    const status = document.createElement('p'); status.className = 'muted'; status.setAttribute('role', 'status'); status.textContent = t('richEditor.loading');
    const record = { root, toolbar, editorId, select, surface, counter, warning, status, field: copyField(field), identity, buttons: new Map(), editor: null, isPrompt: false };
    for (const [name, paths] of Object.entries(icons)) {
      const button = document.createElement('button'); button.type = 'button';
      button.title = t(`richEditor.${name}`); button.setAttribute('aria-label', button.title);
      button.dataset.command = name;
      button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
      button.disabled = true;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        if (!record.editor || record.editor.view.composing) return;
        const chain = record.editor.chain().focus();
        if (name === 'clear') chain.unsetAllMarks().clearNodes().run();
        else if (name === 'redText') chain.toggleMark('redText').run();
        else if (['undo','redo'].includes(name)) chain[name]().run();
        else chain[`toggle${name[0].toUpperCase()}${name.slice(1)}`]().run();
      });
      toolbar.append(button); record.buttons.set(name, button);
    }
    select.disabled = true;
    select.addEventListener('change', () => {
      if (!record.editor || record.editor.view.composing) return;
      const chain = record.editor.chain().focus();
      if (select.value === 'p') chain.setParagraph().run();
      else chain.setHeading({ level: Number(select.value) }).run();
    });
    root.append(toolbar, surface, status, counter, warning);
    records.set(key, record);
    const initialize = async () => {
      status.textContent = t('richEditor.loading');
      try {
        const { createEditor } = await loadEngine();
        if (disposed || records.get(key) !== record) return;
        record.editor = createEditor({ element: surface,
          acceptDocument(doc) {
            try { fromDocument(doc, record.field); return true; }
            catch {
              status.hidden = false; status.textContent = t('richEditor.documentTooComplex');
              return false;
            }
          },
          content: toDocument(record.field), blankNode: options.blankNode === true,
          editorProps: { attributes: { id: editorId, role: 'textbox', 'aria-multiline': 'true',
            'aria-label': record.label || t('richEditor.toolbar'), 'aria-describedby': `${counter.id} ${warning.id}` } },
          onUpdate: ({ editor }) => {
            if (disposed || records.get(key) !== record) return;
            status.hidden = true;
            const next = fromDocument(editor.getJSON(), record.field);
            record.field = copyField(next);
            onChange(record.identity, next);
            update(record);
          },
          onSelectionUpdate: () => { update(record); options.selectionChanged?.(record); }, onTransaction: () => update(record),
        });
        select.disabled = false; status.hidden = true; options.ready?.(record); update(record);
      } catch (error) {
        if (disposed || records.get(key) !== record) return;
        status.replaceChildren(document.createTextNode(t('richEditor.loadFailed')));
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('richEditor.retry');
        retry.onclick = initialize; status.append(retry);
        console.error('Rich-text editor initialization failed', error);
      }
    };
    initialize(); return record;
  }
  return {
    mount(parent, label, key, field, isPrompt = false, identity) {
      const record = records.get(key) || make(key, field, identity);
      record.isPrompt = isPrompt; record.label = label.textContent;
      label.htmlFor = record.editorId;
      record.editor?.view.dom.setAttribute('aria-label', record.label);
      parent.append(label, record.root); update(record);
      this.sync(key, field);
    },
    sync(key, field) {
      const record = records.get(key);
      if (!record || !field || JSON.stringify(copyField(field)) === JSON.stringify(copyField(record.field))) return;
      record.field = copyField(field);
      // Ordinary autosave/validation updates take the equality path and retain selection/history/IME.
      record.editor?.commands.setContent(toDocument(field), { emitUpdate: false });
      update(record);
    },
    prune(keys) {
      for (const [key, record] of records) if (!keys.has(key)) {
        record.editor?.destroy(); record.root.remove(); records.delete(key);
      }
    },
    getRecord(key) { return records.get(key); },
    destroy() {
      disposed = true;
      for (const record of records.values()) record.editor?.destroy();
      records.clear();
    },
  };
}
