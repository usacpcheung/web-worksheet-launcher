import { coerceAnswerValueByInputType, getBooleanAnswerLabel } from './worksheet-values.js';

export function getBooleanSelectionState(rawValue) {
  const normalized = coerceAnswerValueByInputType('boolean', rawValue);
  return {
    selectedValue: normalized,
    truePressed: normalized === true,
    falsePressed: normalized === false,
  };
}

export function applyBooleanGroupState(groupNode, rawValue, isDisabled = false) {
  if (!groupNode) return;
  const state = getBooleanSelectionState(rawValue);
  Array.from(groupNode.querySelectorAll('button[data-boolean-value]')).forEach((button) => {
    const buttonValue = button.dataset.booleanValue;
    const isPressed = (buttonValue === 'true' && state.truePressed) || (buttonValue === 'false' && state.falsePressed);
    button.classList.toggle('is-selected', isPressed);
    button.setAttribute('aria-pressed', String(isPressed));
    button.disabled = isDisabled;
  });
}

// Read the latest stored value on every click, including repeated toggles.
export function createBooleanAnswerControl({ labelId, t, signal, getValue, onChange }) {
  const control = document.createElement('div');
  control.className = 'boolean-segmented-control';
  control.setAttribute('role', 'group');
  control.setAttribute('aria-labelledby', labelId);
  [
    { value: true, datasetValue: 'true', label: getBooleanAnswerLabel(true, t) },
    { value: false, datasetValue: 'false', label: getBooleanAnswerLabel(false, t) },
  ].forEach((optionConfig) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'boolean-segmented-control__button';
    button.dataset.booleanValue = optionConfig.datasetValue;
    button.textContent = optionConfig.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      const currentValue = getValue();
      const normalizedCurrentValue = coerceAnswerValueByInputType('boolean', currentValue);
      const nextValue = normalizedCurrentValue === optionConfig.value ? null : optionConfig.value;
      onChange(nextValue);
    }, { signal });
    control.appendChild(button);
  });
  return control;
}
