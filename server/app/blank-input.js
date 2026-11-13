import { BLANK_LIMIT, blankLength, trimBlankText } from './fill-in-blanks.js';

// Keep selection replacement and native Undo when a paste only partially fits.
export function bindBlankInput(input, { signal, changed, shortened }) {
  let composing = false;
  const limit = () => {
    if (composing) return;
    const next = trimBlankText(input.value.replace(/[\r\n]+/g, ' '));
    const clipped = next !== input.value;
    if (clipped) input.value = next;
    changed(input.value);
    if (clipped) shortened();
  };
  input.addEventListener('compositionstart', () => (composing = true), {
    signal,
  });
  input.addEventListener(
    'compositionend',
    () => {
      composing = false;
      limit();
    },
    { signal },
  );
  input.addEventListener('input', limit, { signal });
  input.addEventListener(
    'paste',
    (event) => {
      const raw = event.clipboardData?.getData('text/plain');
      if (raw === undefined) return;
      const value = raw.replace(/[\r\n]+/g, ' '),
        start = input.selectionStart ?? 0,
        end = input.selectionEnd ?? start;
      const room =
          BLANK_LIMIT -
          blankLength(input.value.slice(0, start) + input.value.slice(end)),
        part = trimBlankText(value, room);
      if (part !== value || raw !== value) {
        event.preventDefault();
        if (part) document.execCommand('insertText', false, part);
        if (part !== value) shortened();
      }
    },
    { signal },
  );
  input.addEventListener(
    'beforeinput',
    (event) => {
      if (composing || event.inputType !== 'insertText' || !event.data) return;
      const start = input.selectionStart ?? 0,
        end = input.selectionEnd ?? start,
        part = trimBlankText(
          event.data,
          BLANK_LIMIT -
            blankLength(input.value.slice(0, start) + input.value.slice(end)),
        );
      if (part !== event.data) {
        event.preventDefault();
        if (part) document.execCommand('insertText', false, part);
        shortened();
      }
    },
    { signal },
  );
}
