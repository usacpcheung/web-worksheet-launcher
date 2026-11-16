import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './number-answer-control.js';

test('getNumberInputErrorMessage reports range and rule errors without coercion', () => {
  const responseConfig = {
    min: 1,
    max: 5,
    numberRules: {
      allowedKinds: ['integer', 'decimal'],
      allowSigned: false,
      decimalPlacesAllowed: 1,
    },
  };

  assert.deepEqual(mod.getNumberInputErrorMessage('0', responseConfig), {
    message: 'Value is below minimum (1).',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('6', responseConfig), {
    message: 'Value is above maximum (5).',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('+2', responseConfig), {
    message: 'Signed values are not allowed for this question.',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('1.23', responseConfig), {
    message: 'Too many decimal places for this question.',
    normalizedValue: '',
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('4.5', responseConfig), {
    message: '',
    normalizedValue: 4.5,
  });
});

test('getNumberInputErrorMessage ignores legacy step config', () => {
  const responseConfig = { min: 0, max: 10, step: 0.5 };

  assert.deepEqual(mod.getNumberInputErrorMessage('1.3', responseConfig), {
    message: '',
    normalizedValue: 1.3,
  });
  assert.deepEqual(mod.getNumberInputErrorMessage('2.5', responseConfig), {
    message: '',
    normalizedValue: 2.5,
  });
});



test('number validation retains empty, partial, fraction and strict-format behaviour', () => {
  assert.deepEqual(mod.getNumberInputErrorMessage('  '), { message: '', normalizedValue: '' });
  for (const value of ['-', '+', '1.', '1e3']) {
    assert.deepEqual(mod.getNumberInputErrorMessage(value), {
      message: 'Enter a valid integer or decimal number.', normalizedValue: '',
    });
  }
  assert.match(mod.getNumberInputErrorMessage('2/3').message, /Fractions are not supported/);
  assert.deepEqual(mod.getNumberInputErrorMessage('0'), { message: '', normalizedValue: 0 });
  assert.deepEqual(mod.getNumberInputErrorMessage('-1.20'), { message: '', normalizedValue: -1.2 });
  assert.match(mod.getNumberInputErrorMessage('2.5', { numberRules: { allowedKinds: ['integer'] } }).message, /configured number format/);
  assert.match(mod.getNumberInputErrorMessage('2', { numberRules: { allowedKinds: ['decimal'] } }).message, /configured number format/);
});
