import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTextAnswerInput } from './text-answer-input.js';

function pasteFixture(tagName, value, maxLength) {
  const control = new EventTarget();
  Object.assign(control, { tagName, value, selectionStart: value.length, selectionEnd: value.length });
  let rejected = 0;
  bindTextAnswerInput(control, {
    config: { inputType: 'text', maxLength },
    getValue: () => value,
    accepted() {},
    rejected: () => rejected++,
  });
  return {
    control,
    paste(text) {
      const event = new Event('paste', { cancelable: true });
      event.clipboardData = { getData: () => text };
      return control.dispatchEvent(event);
    },
    get rejected() {
      return rejected;
    },
  };
}

test('paste limits follow native single-line removal and textarea normalization of line breaks', () => {
  const single = pasteFixture('INPUT', '', 2);
  assert.equal(single.paste('a\r\nb'), true, 'Native single-line input would contain ab');
  assert.equal(single.paste('a\r\nbc'), false);
  assert.equal(single.rejected, 1);
  const multi = pasteFixture('TEXTAREA', '', 3);
  assert.equal(multi.paste('a\r\nb'), true, 'CRLF is one newline in a textarea');
  assert.equal(multi.paste('a\r\nbc'), false);
});

test('paste counts selection replacement and rejects whole additions without changing the prior answer', () => {
  const fixture = pasteFixture('TEXTAREA', 'keep', 4);
  assert.equal(fixture.paste('new'), false);
  assert.equal(fixture.control.value, 'keep');
  fixture.control.selectionStart = 0;
  assert.equal(fixture.paste('新的答案'), true);
  assert.equal(fixture.paste('這是新的答案'), false);
  assert.equal(fixture.control.value, 'keep');
});
