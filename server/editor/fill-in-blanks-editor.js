import { bindBlankInput } from '../app/blank-input.js';
import { createRichTextEditor } from './rich-text-editor.js';
import { toEngine, fromEngine } from './rich-text-codec.js';
import {
  assertBlankConfig,
  blankDefinitions,
  BLANK_LIMIT,
  MAX_BLANKS,
  blankLength,
  matchBlankText,
} from '../app/fill-in-blanks.js';
const make = (tag, className, text) => {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const button = (text, action) => {
  const b = make('button', 'editor-blank-button', text);
  b.type = 'button';
  b.onclick = action;
  return b;
};
const closeIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
export function createBlankPassageEditor(t, onChange, confirm) {
  let disposed = false;
  const instances = new Map();
  const editor = createRichTextEditor(
    t,
    (identity, config) => {
      onChange(identity, config);
      const record = instances.get(identity.blockId);
      if (record) {
        refresh(record);
        if (!record.settings?.contains(document.activeElement))
          settings(record);
      }
    },
    {
      blankNode: true,
      idPrefix: 'editor-blank-passage',
      copyField: structuredClone,
      toDocument: (config) => ({
        type: 'doc',
        content: config.passage.blocks.flatMap((n) => toEngine(n)),
      }),
      fromDocument: (doc, previous) => {
        const config = {
          ...previous,
          passage: { version: 1, blocks: doc.content.map(fromEngine) },
        };
        assertBlankConfig(config, { complete: false });
        return config;
      },
      ready(record) {
        initialize(record);
        refresh(record);
      },
      selectionChanged(record) {
        const selected = record.editor.state.selection.node;
        if (
          selected?.type.name === 'answerBlank' &&
          record.selected !== selected.attrs.data.id
        ) {
          record.selected = selected.attrs.data.id;
          settings(record);
        }
      },
    },
  );
  const found = (record) => {
    const list = [];
    record.editor?.state.doc.descendants((node, pos) => {
      if (node.type.name === 'answerBlank') list.push({ node, pos });
    });
    return list;
  };
  const message = (r, key, params) => {
    r.message.textContent = key ? t('fillBlanks.' + key, params) : '';
  };
  function publish(r, config) {
    r.field = structuredClone(config);
    onChange(r.identity, config);
    refresh(r);
  }
  function refresh(r) {
    if (!r.chips) return;
    const list = found(r);
    r.count.textContent = t('fillBlanks.blankCount', {
      count: list.length,
      max: MAX_BLANKS,
    });
    r.mode.value = r.field.mode;
    r.reuse.checked = r.field.reuseWords;
    r.bank.hidden = r.field.mode !== 'word_bank';
    r.chips.replaceChildren(
      ...list.map(({ node }, i) => {
        const b = button(
          `${i + 1}. ${node.attrs.data.text || t('fillBlanks.answerNeeded')}`,
          () => {
            r.selected = node.attrs.data.id;
            r.editor.commands.setNodeSelection(
              found(r).find((f) => f.node.attrs.data.id === r.selected).pos,
            );
            settings(r);
          },
        );
        b.setAttribute(
          'aria-pressed',
          String(r.selected === node.attrs.data.id),
        );
        b.dataset.blankId = node.attrs.data.id;
        return b;
      }),
    );
    r.distractors.replaceChildren(
      ...r.field.distractors.map((word, i) =>
        button(word + ' ×', () =>
          publish(r, {
            ...r.field,
            distractors: r.field.distractors.filter((_, j) => j !== i),
          }),
        ),
      ),
    );
    const duplicates = blankDefinitions(r.field)
      .filter((b, i, a) => a.findIndex((n) => n.text === b.text) !== i)
      .map((b) => b.text);
    r.duplicate.textContent =
      !r.field.reuseWords && duplicates.length
        ? t('fillBlanks.duplicateNotice', {
            words: [...new Set(duplicates)].join(', '),
          })
        : t('fillBlanks.bankHint');
    if (r.selected && !list.some((f) => f.node.attrs.data.id === r.selected)) {
      r.selected = null;
      r.settings.hidden = true;
    }
  }
  function initialize(r) {
    instances.set(r.identity.blockId, r);
    r.root.classList.add('editor-blank-passage');
    r.message = make('p', 'control-error');
    r.message.setAttribute('role', 'status');
    const add = button(t('fillBlanks.makeBlank'), () => makeBlank(r));
    add.id = 'editor-make-blank';
    add.onmousedown = (e) => e.preventDefault();
    r.toolbar.append(add);
    r.editor.view.dom.addEventListener('contextmenu', (event) => {
      if (r.editor.state.selection.empty) return;
      event.preventDefault();
      r.context?.remove();
      const menu = make('div', 'editor-blank-context');
      menu.setAttribute('role', 'menu');
      const item = button(t('fillBlanks.makeBlank'), () => {
        makeBlank(r);
        menu.remove();
      });
      item.setAttribute('role', 'menuitem');
      item.onmousedown = (e) => e.preventDefault();
      menu.append(item);
      r.root.append(menu);
      r.context = menu;
      const rect = r.root.getBoundingClientRect();
      menu.style.left =
        Math.max(0, Math.min(event.clientX - rect.left, rect.width - 160)) +
        'px';
      menu.style.top = event.clientY - rect.top + 'px';
    });
    r.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') r.context?.remove();
    });
    r.root.addEventListener('pointerdown', (event) => {
      if (r.context && !r.context.contains(event.target)) r.context.remove();
    });
    const hint = make('p', 'muted', t('fillBlanks.selectionHint'));
    const row = make('div', 'editor-blank-mode');
    const label = make('label', '', t('fillBlanks.answeringMode'));
    r.mode = make('select', 'control');
    r.mode.id = 'editor-blank-mode';
    label.htmlFor = r.mode.id;
    for (const value of ['typed', 'word_bank']) {
      const o = make('option', '', t('fillBlanks.' + value));
      o.value = value;
      r.mode.append(o);
    }
    r.mode.onchange = () => {
      publish(r, { ...r.field, mode: r.mode.value });
      settings(r);
    };
    r.count = make('span', 'muted');
    row.append(label, r.mode, r.count);
    r.chips = make('div', 'editor-blank-chips');
    r.settings = make('section', 'editor-blank-settings');
    r.settings.hidden = true;
    r.bank = make('section', 'editor-blank-bank');
    const reuseLabel = make('label', 'editor-blank-reuse');
    r.reuse = make('input', '');
    r.reuse.type = 'checkbox';
    r.reuse.onchange = () =>
      publish(r, { ...r.field, reuseWords: r.reuse.checked });
    reuseLabel.append(r.reuse, document.createTextNode(t('fillBlanks.reuse')));
    const distractorLabel = make('label', '', t('fillBlanks.distractors'));
    const distractor = make('input', 'control');
    distractor.id = 'editor-blank-distractor';
    distractorLabel.htmlFor = distractor.id;
    const addDistractor = button(t('fillBlanks.add'), () => {
      const value = distractor.value.trim();
      if (!value) return;
      if (blankLength(value) > BLANK_LIMIT) {
        message(r, 'answerLimit');
        return;
      }
      if (r.field.distractors.length >= 100) {
        message(r, 'tooManyDistractors');
        return;
      }
      if (!r.field.distractors.includes(value))
        publish(r, {
          ...r.field,
          distractors: [...r.field.distractors, value],
        });
      distractor.value = '';
    });
    const addRow = make('div', 'editor-blank-add');
    addRow.append(distractor, addDistractor);
    r.distractors = make('div', 'editor-blank-chips');
    r.duplicate = make('p', 'muted');
    r.bank.append(
      reuseLabel,
      distractorLabel,
      addRow,
      r.distractors,
      r.duplicate,
    );
    r.root.append(hint, row, r.chips, r.settings, r.bank, r.message);
  }
  function makeBlank(r) {
    const { from, to, $from, $to } = r.editor.state.selection;
    let invalid =
      from === to || !$from.sameParent($to) || !$from.parent.isTextblock;
    r.editor.state.doc.nodesBetween(from, to, (n) => {
      if (['answerBlank', 'hardBreak'].includes(n.type.name)) invalid = true;
    });
    if (invalid) {
      message(r, 'selectionError');
      return;
    }
    if (found(r).length >= MAX_BLANKS) {
      message(r, 'maxBlanks');
      return;
    }
    const raw = r.editor.state.doc.textBetween(from, to),
      value = raw.trim();
    if (!value || blankLength(value) > BLANK_LIMIT) {
      message(r, 'answerLimit');
      return;
    }
    const start = from + raw.length - raw.trimStart().length,
      end = to - (raw.length - raw.trimEnd().length),
      original = r.editor.state.doc
        .slice(start, end)
        .content.toJSON()
        .map(fromEngine);
    const id = 'blank_' + crypto.randomUUID().replaceAll('-', '');
    r.selected = id;
    r.editor.commands.closeBlankHistory();
    r.editor
      .chain()
      .focus()
      .insertContentAt(
        { from: start, to: end },
        {
          type: 'answerBlank',
          attrs: {
            data: {
              tag: 'blank',
              id,
              text: value,
              checking: 'auto',
              alternatives: [],
              original,
              initialText: value,
            },
          },
        },
      )
      .run();
    r.editor.commands.closeBlankHistory();
    settings(r);
    message(r, '');
  }
  function settings(r) {
    const entry = found(r).find((f) => f.node.attrs.data.id === r.selected);
    if (!entry) {
      r.settings.hidden = true;
      return;
    }
    const a = entry.node.attrs.data;
    r.settings.hidden = false;
    r.settings.replaceChildren();
    const update = (data) => {
      const current = found(r).find((f) => f.node.attrs.data.id === r.selected);
      if (current)
        r.editor.view.dispatch(
          r.editor.state.tr.setNodeMarkup(current.pos, undefined, {
            data: { ...current.node.attrs.data, ...data },
          }),
        );
    };
    const head = make('div', 'editor-blank-settings-head');
    head.append(
      make(
        'strong',
        '',
        t('fillBlanks.blankNumber', {
          number:
            found(r).findIndex((f) => f.node.attrs.data.id === r.selected) + 1,
        }),
      ),
    );
    const close = button('', () => {
      r.selected = null;
      r.settings.hidden = true;
      refresh(r);
    });
    close.classList.add('editor-blank-close');
    close.innerHTML = closeIcon;
    close.setAttribute('aria-label', t('common.actions.close'));
    head.append(close);
    r.settings.append(head);
    if (r.field.mode === 'typed') {
      const modeLabel = make('label', '', t('fillBlanks.checking'));
      const mode = make('select', 'control');
      mode.id = 'editor-blank-checking';
      modeLabel.htmlFor = mode.id;
      for (const value of ['auto', 'free']) {
        const o = make('option', '', t('fillBlanks.' + value));
        o.value = value;
        mode.append(o);
      }
      mode.value = a.checking;
      mode.onchange = () => {
        update({ checking: mode.value });
        settings(r);
      };
      r.settings.append(modeLabel, mode);
    }
    const field = (key, title, value, accept) => {
      const label = make('label', 'editor-blank-field-label', title),
        counter = make('span', 'muted', `${blankLength(value)}/50`),
        input = make('input', 'control');
      input.id = 'editor-blank-' + key;
      label.htmlFor = input.id;
      label.append(counter);
      input.value = value;
      bindBlankInput(input, {
        changed: (value) => {
          counter.textContent = `${blankLength(value)}/50`;
          accept(value);
        },
        shortened: () => message(r, 'pasteLimit'),
      });
      r.settings.append(label, input);
      return input;
    };
    field(
      'answer',
      t(
        r.field.mode === 'typed' && a.checking === 'free'
          ? 'fillBlanks.markedText'
          : 'fillBlanks.mainAnswer',
      ),
      a.text,
      (v) => update({ text: v }),
    );
    if (r.field.mode === 'typed' && a.checking === 'auto') {
      const alt = field(
        'alternative',
        t('fillBlanks.alsoAccept'),
        '',
        () => {},
      );
      const add = button(t('fillBlanks.add'), () => {
        const value = alt.value.trim(),
          fresh = found(r).find((f) => f.node.attrs.data.id === r.selected).node
            .attrs.data;
        if (!value) return;
        if (fresh.alternatives.length >= 50) {
          message(r, 'tooManyAlternatives');
          return;
        }
        if (
          [fresh.text, ...fresh.alternatives].some(
            (s) => matchBlankText(s) === matchBlankText(value),
          )
        ) {
          message(r, 'duplicateAnswer');
          return;
        }
        update({ alternatives: [...fresh.alternatives, value] });
        settings(r);
      });
      r.settings.append(add);
      const alts = make('div', 'editor-blank-chips');
      a.alternatives.forEach((v, i) =>
        alts.append(
          button(v + ' ×', () => {
            update({ alternatives: a.alternatives.filter((_, j) => i !== j) });
            settings(r);
          }),
        ),
      );
      r.settings.append(alts);
    }
    r.settings.append(
      make(
        'p',
        'muted',
        t(
          r.field.mode === 'typed' && a.checking === 'free'
            ? 'fillBlanks.freeHint'
            : 'fillBlanks.removeHint',
        ),
      ),
    );
    r.settings.append(
      button(t('fillBlanks.remove'), async () => {
        const id = r.selected;
        const current = () => found(r).find((f) => f.node.attrs.data.id === id);
        const snapshot = JSON.stringify(current()?.node.attrs.data);
        if (
          !(await confirm({
            title: t('fillBlanks.removeTitle'),
            descriptionText: t('fillBlanks.removeHint'),
            confirmLabel: t('fillBlanks.remove'),
          }))
        )
          return;
        if (
          disposed ||
          !r.root.isConnected ||
          JSON.stringify(current()?.node.attrs.data) !== snapshot
        )
          return;
        const f = current(),
          data = f.node.attrs.data;
        const nodes =
          data.text === data.initialText
            ? data.original.map((n) => toEngine(n)).flat()
            : data.text
              ? [{ type: 'text', text: data.text }]
              : [];
        r.editor.commands.closeBlankHistory();
        r.editor
          .chain()
          .focus()
          .insertContentAt({ from: f.pos, to: f.pos + f.node.nodeSize }, nodes)
          .run();
        r.editor.commands.closeBlankHistory();
        r.selected = null;
        r.settings.hidden = true;
        refresh(r);
      }),
    );
  }
  return {
    mount(parent, key, config, identity) {
      const label = make('label', '', t('fillBlanks.passage'));
      editor.mount(parent, label, key, config, false, identity);
    },
    sync(key, config) {
      editor.sync(key, config);
      const r = editor.getRecord(key);
      if (r) refresh(r);
    },
    prune(keys) {
      editor.prune(keys);
      for (const [id, r] of instances)
        if (!keys.has(`${r.identity.draftId}:${id}`)) instances.delete(id);
    },
    destroy() {
      disposed = true;
      editor.destroy();
      instances.clear();
    },
  };
}
