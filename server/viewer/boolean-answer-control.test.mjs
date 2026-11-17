import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './boolean-answer-control.js';

test('getBooleanSelectionState maps stored values to selected button state', () => {
  assert.deepEqual(mod.getBooleanSelectionState(true), {
    selectedValue: true,
    truePressed: true,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState(false), {
    selectedValue: false,
    truePressed: false,
    falsePressed: true,
  });
  assert.deepEqual(mod.getBooleanSelectionState(null), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState('true'), {
    selectedValue: true,
    truePressed: true,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState('false'), {
    selectedValue: false,
    truePressed: false,
    falsePressed: true,
  });
  assert.deepEqual(mod.getBooleanSelectionState(''), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
  assert.deepEqual(mod.getBooleanSelectionState(undefined), {
    selectedValue: null,
    truePressed: false,
    falsePressed: false,
  });
});

test('applyBooleanGroupState hydrates selected and disabled button state', () => {
  function createButton(booleanValue) {
    const button = {
      dataset: { booleanValue },
      disabled: false,
      attributes: {},
      selectedClass: false,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
    };
    button.classList = {
      toggle: (_className, flag) => {
        button.selectedClass = Boolean(flag);
      },
    };
    return button;
  }
  const trueButton = createButton('true');
  const falseButton = createButton('false');
  const group = {
    querySelectorAll: () => [trueButton, falseButton],
  };

  mod.applyBooleanGroupState(group, true, true);
  assert.equal(trueButton.selectedClass, true);
  assert.equal(falseButton.selectedClass, false);
  assert.equal(trueButton.attributes['aria-pressed'], 'true');
  assert.equal(falseButton.attributes['aria-pressed'], 'false');
  assert.equal(trueButton.disabled, true);
  assert.equal(falseButton.disabled, true);

  mod.applyBooleanGroupState(group, null, false);
  assert.equal(trueButton.selectedClass, false);
  assert.equal(falseButton.selectedClass, false);
  assert.equal(trueButton.attributes['aria-pressed'], 'false');
  assert.equal(falseButton.attributes['aria-pressed'], 'false');
  assert.equal(trueButton.disabled, false);
  assert.equal(falseButton.disabled, false);
});

