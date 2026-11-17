import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTextLengthFeedback, updateTextCounterUI } from './text-answer-presentation.js';

const mod = {
  computeTextLengthFeedback: (value, max, ratio) => computeTextLengthFeedback(value, max, ratio, key => key),
  updateTextCounterUI,
};

test('computeTextLengthFeedback returns normal, warning, and over-limit states', async () => {
  assert.deepEqual(mod.computeTextLengthFeedback('abcd', 50), {
    current: 4,
    max: 50,
    remaining: 46,
    state: 'normal',
    statusText: '',
    counterText: '4/50',
  });
  assert.deepEqual(mod.computeTextLengthFeedback('x'.repeat(45), 50), {
    current: 45,
    max: 50,
    remaining: 5,
    state: 'warning',
    statusText: 'textAnswer.remaining',
    counterText: '45/50',
  });
  assert.deepEqual(mod.computeTextLengthFeedback('x'.repeat(55), 50), {
    current: 55,
    max: 50,
    remaining: -5,
    state: 'over',
    statusText: 'textAnswer.over',
    counterText: '55/50',
  });
});

test('computeTextLengthFeedback handles non-integer finite maxLength via Math.trunc', async () => {
  const result = mod.computeTextLengthFeedback('abcd', 50.7);
  assert.equal(result.max, 50);
  assert.equal(result.current, 4);
  assert.equal(result.counterText, '4/50');
});

test('computeTextLengthFeedback uses singular character when count is 1', async () => {
  const warningResult = mod.computeTextLengthFeedback('x'.repeat(49), 50);
  assert.equal(warningResult.state, 'warning');
  assert.equal(warningResult.statusText, 'textAnswer.remainingOne');

  const overResult = mod.computeTextLengthFeedback('x'.repeat(51), 50);
  assert.equal(overResult.state, 'over');
  assert.equal(overResult.statusText, 'textAnswer.over');
});

test('computeTextLengthFeedback uses plural characters when count is not 1', async () => {
  const warningResult = mod.computeTextLengthFeedback('x'.repeat(45), 50);
  assert.equal(warningResult.statusText, 'textAnswer.remaining');

  const overResult = mod.computeTextLengthFeedback('x'.repeat(55), 50);
  assert.equal(overResult.statusText, 'textAnswer.over');
});

test('updateTextCounterUI sets text and semantic classes', async () => {
  const counterNode = { textContent: '', className: '' };
  const statusNode = { textContent: '', className: '' };
  mod.updateTextCounterUI(counterNode, statusNode, {
    counterText: '99/100',
    statusText: 'textAnswer.remainingOne',
    state: 'warning',
  });
  assert.equal(counterNode.textContent, '99/100');
  assert.equal(counterNode.className, 'text-counter text-counter--warning');
  assert.equal(statusNode.textContent, 'textAnswer.remainingOne');
  assert.equal(statusNode.className, 'text-counter-status text-counter-status--warning');
});

test('counter preserves UTF-16 length, zero limits and threshold rounding', () => {
  assert.equal(mod.computeTextLengthFeedback('😀', 10).current, 2);
  assert.equal(mod.computeTextLengthFeedback('abc', 0).state, 'normal');
  assert.equal(mod.computeTextLengthFeedback('x'.repeat(8), 10).state, 'normal');
  assert.equal(mod.computeTextLengthFeedback('x'.repeat(9), 10).state, 'warning');
  assert.equal(mod.computeTextLengthFeedback('x'.repeat(10), 10).state, 'warning');
  assert.equal(mod.computeTextLengthFeedback('x'.repeat(11), 10).state, 'over');
  assert.equal(mod.computeTextLengthFeedback('x'.repeat(9), 11).state, 'warning');
});
