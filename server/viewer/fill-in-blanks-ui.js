import { bindBlankInput } from '../app/blank-input.js';
import {
  blankDefinitions,
  blankWordPool,
  blankLength,
  renderBlankPassage,
  checkBlanks,
  blankVoiceId,
  resolveBlankVoiceTarget,
} from '../app/fill-in-blanks.js';
import { createVoiceControls } from './answer-voice-ui.js';
import {
  hasPendingRecovery,
  getVoiceRecovery,
} from './answer-voice-workflow.js';
import { requestVoiceSignIn } from './voice-sign-in.js';
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text, action) => {
  const n = el('button', '', text);
  n.type = 'button';
  n.onclick = action;
  return n;
};
const svg = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const close = svg('<path d="m6 6 12 12M18 6 6 18"/>');
let currentMenu = null;
export function createFillInBlanksControls({
  session,
  block,
  t,
  signal,
  refresh,
  view,
  sharedStatusId,
}) {
  const config = block.responseConfig,
    defs = blankDefinitions(config),
    typed = config.mode === 'typed';
  const root = el('div', 'viewer-blanks');
  const hint = el(
    'p',
    'viewer-blanks-hint',
    t(
      typed
        ? 'fillBlanks.limitHint'
        : config.reuseWords
          ? 'fillBlanks.bankReusableHint'
          : 'fillBlanks.bankHint',
    ),
  );
  const bank = el('div', 'viewer-blank-bank');
  bank.setAttribute('role', 'group');
  bank.setAttribute('aria-label', t('fillBlanks.wordBank'));
  const passage = el('div', 'viewer-blank-passage worksheet-text');
  passage.innerHTML = renderBlankPassage(
    config,
    (b) => `<span class="viewer-blank-slot" data-blank-id="${b.id}"></span>`,
  );
  const progress = el('p', 'viewer-blank-progress');
  const feedback = el('p', 'viewer-blank-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const assist = el('div', 'viewer-blank-assistance');
  root.append(hint);
  if (!typed) root.append(bank);
  root.append(passage, progress, feedback, assist);
  const records = new Map();
  let selected = null,
    chosen = null,
    menu = null,
    menuTrigger = null,
    bankSignature = null;
  const completed = () => session.state.status === 'completed';
  const answers = () => session.state.answers?.[block.blockId]?.value || {};
  const tell = (message) => (feedback.textContent = message);
  const focus = (id) => records.get(id)?.field.focus({ preventScroll: true });
  function closeMenu(restore = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    menuTrigger?.setAttribute('aria-expanded', 'false');
    if (restore) menuTrigger?.focus({ preventScroll: true });
    if (currentMenu === closeMenu) currentMenu = null;
  }
  signal.addEventListener('abort', () => closeMenu(), { once: true });
  function positionMenu() {
    if (!menu || !menuTrigger?.isConnected) {
      closeMenu();
      return;
    }
    const r = menuTrigger.getBoundingClientRect();
    menu.style.left =
      Math.max(
        8,
        Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8),
      ) + 'px';
    menu.style.top =
      Math.max(8, Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)) +
      'px';
  }
  window.addEventListener('scroll', positionMenu, { signal, capture: true });
  window.addEventListener('resize', positionMenu, { signal });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (
        menu &&
        !menu.contains(e.target) &&
        e.target !== menuTrigger &&
        !menuTrigger?.contains(e.target)
      )
        closeMenu();
    },
    { signal },
  );
  document.addEventListener(
    'focusin',
    (e) => {
      if (menu && !menu.contains(e.target) && e.target !== menuTrigger)
        closeMenu();
    },
    { signal },
  );
  function setValue(id, value) {
    const next = { ...answers(), [id]: value };
    const voiceId = blankVoiceId(block.blockId, id);
    if (Object.hasOwn(session.state.undoBuffer || {}, voiceId)) {
      const copy = { ...session.state.undoBuffer };
      delete copy[voiceId];
      session.state.undoBuffer = copy;
    }
    session.setAnswer(block.blockId, next);
    refresh();
  }
  function placeWord(word, id, source) {
    if (completed() || !records.has(id)) return;
    const pool = blankWordPool(config);
    if (!pool.has(word)) return;
    const next = { ...answers() };
    if (source) {
      if (next[source] !== word || !records.has(source)) return;
      delete next[source];
    }
    next[id] = word;
    if (session.setAnswer(block.blockId, next) === false) {
      tell(t('fillBlanks.noCopies'));
      return;
    }
    chosen = null;
    selected = id;
    refresh();
    focus(id);
    tell(t('fillBlanks.wordPlaced', { word }));
  }
  function drawBank() {
    if (typed) return;
    bank.hidden = completed();
    if (completed()) return;
    const signature = JSON.stringify([answers(), chosen, config.reuseWords]);
    if (signature === bankSignature) return;
    bankSignature = signature;
    const pool = blankWordPool(config),
      value = answers();
    const focusedWord = bank.contains(document.activeElement)
      ? document.activeElement.dataset.word
      : null;
    bank.replaceChildren();
    for (const [word, total] of pool) {
      const remaining =
        total - Object.values(value).filter((v) => v === word).length;
      if (!config.reuseWords && remaining <= 0) continue;
      const tile = button(word, () => {
        if (selected) placeWord(word, selected);
        else {
          chosen = word;
          drawBank();
          tell(t('fillBlanks.chooseBlank'));
        }
      });
      tile.className = 'viewer-blank-word';
      tile.draggable = true;
      tile.dataset.word = word;
      tile.title = word;
      tile.setAttribute('aria-pressed', String(chosen === word));
      if (!config.reuseWords && total > 1) {
        const badge = el('span', 'viewer-blank-quantity', remaining);
        badge.setAttribute(
          'aria-label',
          t('fillBlanks.remaining', { count: remaining }),
        );
        tile.append(badge);
      }
      tile.ondragstart = (e) => {
        e.dataTransfer.setData(
          'application/x-worksheet-blank',
          JSON.stringify({ blockId: block.blockId, word }),
        );
        e.dataTransfer.effectAllowed = 'move';
      };
      bank.append(tile);
    }
    if (!bank.children.length)
      bank.append(el('span', 'muted', t('fillBlanks.allPlaced')));
    if (focusedWord)
      [...bank.querySelectorAll('button')]
        .find((tile) => tile.dataset.word === focusedWord)
        ?.focus({ preventScroll: true });
  }
  for (const [i, def] of defs.entries()) {
    const wrap = passage.querySelector(`[data-blank-id="${def.id}"]`),
      field = el(typed ? 'input' : 'button', 'viewer-blank-input'),
      caption = el('span', 'viewer-blank-caption');
    field.type = typed ? 'text' : 'button';
    field.id = `viewer-blank-${crypto.randomUUID()}`;
    field.setAttribute(
      'aria-label',
      t('fillBlanks.blankNumber', { number: i + 1 }),
    );
    if (typed) field.autocomplete = 'off';
    caption.id = field.id + '-caption';
    field.setAttribute('aria-describedby', caption.id);
    const ordinal = el('span', 'viewer-blank-number', i + 1);
    ordinal.setAttribute('aria-hidden', 'true');
    wrap.append(ordinal, field, caption);
    const r = { wrap, field, caption, def };
    records.set(def.id, r);
    if (typed) {
      r.review = el('span', 'viewer-blank-input viewer-blank-submitted');
      r.review.hidden = true;
      r.review.setAttribute(
        'aria-label',
        t('fillBlanks.blankNumber', { number: i + 1 }),
      );
      wrap.insertBefore(r.review, caption);
      const id = blankVoiceId(block.blockId, def.id),
        target = resolveBlankVoiceTarget([block], id).block;
      const holder = el('section', 'viewer-blank-voice');
      holder.setAttribute(
        'aria-label',
        t('fillBlanks.blankNumber', { number: i + 1 }),
      );
      holder.append(
        el(
          'strong',
          'viewer-blank-voice-title',
          t('fillBlanks.blankNumber', { number: i + 1 }),
        ),
      );
      const voice = createVoiceControls({
        session,
        block: target,
        control: field,
        t,
        signal,
        sharedStatusId,
        navigationBlockId: block.blockId,
        view,
        keepCaretOnBlur: (node) =>
          Boolean(node?.closest?.('.viewer-blank-tools')),
        canRestoreFocus: () => {
          const rect = field.getBoundingClientRect();
          return (
            rect.bottom > 0 &&
            rect.top < innerHeight &&
            (root.contains(document.activeElement) ||
              holder.contains(document.activeElement))
          );
        },
        requestSignIn: ({ isCurrent, confirm }) =>
          requestVoiceSignIn(session, {
            blockId: id,
            signal,
            isCurrent,
            confirm,
          }),
        applied: (value) => {
          field.value = value.text;
        },
      });
      r.voice = voice;
      r.voiceId = id;
      r.holder = holder;
      holder.append(voice.root);
      assist.append(holder);
      const trigger = button('', () => {
        if (menuTrigger === trigger && menu) {
          closeMenu(true);
          return;
        }
        currentMenu?.();
        selected = def.id;
        menuTrigger = trigger;
        menu = el('div', 'viewer-blank-tools viewer-blank-menu');
        menu.setAttribute('role', 'menu');
        menu.setAttribute(
          'aria-label',
          t('fillBlanks.tools', { number: i + 1 }),
        );
        const rewrite = button(t('viewer.rewrite.action'), () => {
          closeMenu(true);
          voice.rewrite();
        });
        rewrite.disabled =
          !field.value.trim() ||
          Boolean(session.voice.active) ||
          hasPendingRecovery(getVoiceRecovery(session.state.voiceRecovery, id));
        const undo = button(t('viewer.rewrite.undo'), () => {
          closeMenu();
          const previous = session.state.undoBuffer?.[id];
          if (previous === undefined) return;
          session.setAnswer(id, previous, { restoreUndo: true });
          const next = { ...session.state.undoBuffer };
          delete next[id];
          session.state.undoBuffer = next;
          refresh();
          focus(def.id);
        });
        undo.disabled =
          Boolean(session.voice.active) ||
          !Object.hasOwn(session.state.undoBuffer || {}, id);
        voice.update();
        const add = voice.add;
        add.onclick = () => closeMenu(true);
        for (const b of [add, rewrite, undo]) {
          b.setAttribute('role', 'menuitem');
          menu.append(b);
        }
        document.body.append(menu);
        currentMenu = closeMenu;
        trigger.setAttribute('aria-expanded', 'true');
        positionMenu();
        menu.onkeydown = (e) => {
          const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(true);
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            const at = buttons.indexOf(document.activeElement),
              next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? buttons.length - 1
                    : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                      buttons.length;
            buttons[next]?.focus({ preventScroll: true });
          }
        };
        menu
          .querySelector('button:not(:disabled)')
          ?.focus({ preventScroll: true });
        update();
      });
      trigger.className = 'viewer-blank-tools viewer-blank-trigger';
      trigger.innerHTML = svg(
        '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      );
      trigger.setAttribute(
        'aria-label',
        t('fillBlanks.tools', { number: i + 1 }),
      );
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      wrap.append(trigger);
      r.trigger = trigger;
      field.addEventListener(
        'focus',
        () => {
          selected = def.id;
          update();
        },
        { signal },
      );
      field.addEventListener(
        'blur',
        () =>
          setTimeout(() => {
            if (signal.aborted) return;
            if (
              !wrap.contains(document.activeElement) &&
              !menu &&
              session.voice.active?.blockId !== id
            ) {
              if (selected === def.id) selected = null;
              update();
            }
          }, 0),
        { signal },
      );
      bindBlankInput(field, {
        signal,
        changed: (value) => {
          tell('');
          setValue(def.id, value);
        },
        shortened: () => tell(t('fillBlanks.pasteLimit')),
      });
    } else {
      wrap.classList.add('viewer-blank-slot--bank');
      field.onclick = () => {
        selected = def.id;
        if (chosen) placeWord(chosen, def.id);
        else {
          update();
          tell(t('fillBlanks.chooseWord', { number: i + 1 }));
        }
      };
      const clear = button('', () => {
        const next = { ...answers() };
        delete next[def.id];
        session.setAnswer(block.blockId, next);
        selected = def.id;
        refresh();
        focus(def.id);
      });
      clear.innerHTML = close;
      clear.className = 'viewer-blank-clear';
      clear.setAttribute(
        'aria-label',
        t('fillBlanks.clearBlank', { number: i + 1 }),
      );
      wrap.append(clear);
      r.clear = clear;
      field.ondragstart = (e) => {
        const word = answers()[def.id];
        if (!word || completed()) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(
          'application/x-worksheet-blank',
          JSON.stringify({ blockId: block.blockId, word, source: def.id }),
        );
        e.dataTransfer.effectAllowed = 'move';
      };
      wrap.ondragover = (e) => {
        if (!completed()) {
          e.preventDefault();
          wrap.classList.add('is-drop-target');
        }
      };
      wrap.ondragleave = () => wrap.classList.remove('is-drop-target');
      wrap.ondrop = (e) => {
        e.preventDefault();
        wrap.classList.remove('is-drop-target');
        let value;
        try {
          value = JSON.parse(
            e.dataTransfer.getData('application/x-worksheet-blank'),
          );
        } catch {
          return; /* External drops are not word-bank tiles. */
        }
        if (value?.blockId === block.blockId)
          placeWord(value.word, def.id, value.source);
      };
    }
  }
  function update() {
    const value = answers(),
      checked = Boolean(session.state.checkResult),
      result = checkBlanks(config, value);
    drawBank();
    for (const [id, r] of records) {
      const v = value[id] || '';
      if (typed) {
        if (r.field.value !== v && document.activeElement !== r.field)
          r.field.value = v;
        r.voice.update();
        r.field.hidden = completed();
        r.review.hidden = !completed();
        r.review.textContent = v || t('viewer.review.notAnswered');
        r.wrap.classList.toggle('is-submitted', completed());
        r.field.readOnly =
          completed() || session.voice.active?.blockId === r.voiceId;
        r.trigger.hidden = completed();
        const recovery = getVoiceRecovery(
          session.state.voiceRecovery,
          r.voiceId,
        );
        r.holder.hidden =
          completed() ||
          !(recovery || session.voice.active?.blockId === r.voiceId);
        r.wrap.classList.toggle(
          'is-active',
          selected === id || session.voice.active?.blockId === r.voiceId,
        );
      } else {
        r.field.textContent = v;
        r.field.title = v;
        r.field.setAttribute(
          'aria-label',
          `${t('fillBlanks.blankNumber', { number: defs.indexOf(r.def) + 1 })}: ${v || t('viewer.review.notAnswered')}`,
        );
        r.field.disabled = completed();
        r.field.draggable = !completed() && Boolean(v);
        r.clear.hidden = completed() || !v;
        r.wrap.classList.toggle('is-active', selected === id);
      }
      const status =
        checked || (completed() && typed && r.def.checking === 'free')
          ? result.statuses[id]
          : null;
      r.wrap.dataset.result = status || '';
      r.caption.textContent = status
        ? t('fillBlanks.' + status)
        : typed && !completed()
          ? `${blankLength(r.field.value)}/50${blankLength(r.field.value) === 50 ? ' · ' + t('fillBlanks.limitReached') : ''}`
          : '';
      r.caption.classList.toggle('is-result', Boolean(status));
      if (completed()) r.wrap.classList.remove('is-active');
    }
    progress.textContent =
      t('fillBlanks.filled', {
        count: defs.filter((d) => (value[d.id] || '').trim()).length,
        total: defs.length,
      }) +
      (checked && result.total
        ? ' · ' +
          t('fillBlanks.score', {
            correct: result.correct,
            total: result.total,
          })
        : '');
    if (completed()) closeMenu();
  }
  root.update = update;
  update();
  return root;
}
