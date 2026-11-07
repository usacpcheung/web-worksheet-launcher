import { acceptsTextEdit } from '../app/text-answer.js';

// Reject whole oversize edits instead of native maxlength's silent paste truncation.
// Delay validation until IME composition ends; preserve text and selection on rejection.
export function bindTextAnswerInput(control, { config, getValue, accepted, rejected, signal }) {
  let composing = false;
  let before = null;
  const capture = () => {
    before = { value: control.value, start: control.selectionStart, end: control.selectionEnd };
  };
  const commit = () => {
    const previous = String(getValue() ?? '');
    if (!acceptsTextEdit(previous, control.value, config)) {
      control.value = previous;
      if (before?.value === previous) control.setSelectionRange(before.start, before.end);
      rejected();
      return;
    }
    accepted(control.value);
    before = null;
  };
  control.addEventListener(
    'beforeinput',
    () => {
      if (!composing) capture();
    },
    { signal }
  );
  control.addEventListener(
    'paste',
    (event) => {
      if (!event.clipboardData) return;
      const clipboardText = event.clipboardData.getData('text/plain');
      // Native single-line inputs strip line breaks; textareas normalize CRLF.
      const text =
        control.tagName === 'INPUT'
          ? clipboardText.replace(/[\r\n]/g, '')
          : clipboardText.replace(/\r\n?/g, '\n');
      const next =
        control.value.slice(0, control.selectionStart) + text + control.value.slice(control.selectionEnd);
      if (!acceptsTextEdit(control.value, next, config)) {
        event.preventDefault();
        rejected();
      }
    },
    { signal }
  );
  control.addEventListener(
    'compositionstart',
    () => {
      capture();
      composing = true;
    },
    { signal }
  );
  control.addEventListener(
    'compositionend',
    () => {
      composing = false;
      commit();
    },
    { signal }
  );
  control.addEventListener(
    'input',
    (event) => {
      if (!composing && !event.isComposing) commit();
    },
    { signal }
  );
}
