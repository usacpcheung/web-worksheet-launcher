import { optionImageRef } from '../app/option-images.js';
import { mountOptionImage } from './option-image-ui.js';
export function getChoicePrefix(index) {
  let label = '';
  let current = Number(index) + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return `${label}.`;
}

export function applyChoiceButtonGroupState(groupNode, rawValue, selectionMode = 'single', isDisabled = false) {
  if (!groupNode) return;
  const isMulti = selectionMode === 'multi';
  const selectedSet = isMulti
    ? new Set(Array.isArray(rawValue) ? rawValue.map((value) => String(value)) : [])
    : new Set(rawValue === null || rawValue === undefined || rawValue === '' ? [] : [String(rawValue)]);
  const buttons = Array.from(groupNode.querySelectorAll('button[data-choice-value]'));
  let hasSelected = false;
  buttons.forEach((button) => {
    const choiceValue = String(button.dataset.choiceValue || '');
    const isSelected = selectedSet.has(choiceValue);
    if (isSelected) hasSelected = true;
    button.classList.toggle('is-selected', isSelected);
    if (isMulti) {
      button.setAttribute('aria-pressed', String(isSelected));
    } else {
      button.setAttribute('aria-checked', String(isSelected));
    }
    button.disabled = isDisabled;
  });
  if (!isMulti) {
    buttons.forEach((button, index) => {
      const choiceValue = String(button.dataset.choiceValue || '');
      const isSelected = selectedSet.has(choiceValue);
      button.tabIndex = hasSelected ? (isSelected ? 0 : -1) : (index === 0 ? 0 : -1);
    });
  }
}

export function computeNextChoiceValue({ selectionMode = 'single', currentValue, clickedValue, validValues = [] }) {
  const clicked = String(clickedValue ?? '');
  const allowedValues = new Set(validValues.map((value) => String(value)));
  if (!allowedValues.has(clicked)) {
    return selectionMode === 'multi' ? [] : '';
  }

  if (selectionMode === 'multi') {
    const normalizedCurrent = Array.isArray(currentValue)
      ? currentValue.map((value) => String(value)).filter((value, idx, allValues) => allValues.indexOf(value) === idx)
      : [];
    const nextSet = new Set(normalizedCurrent);
    if (nextSet.has(clicked)) {
      nextSet.delete(clicked);
    } else {
      nextSet.add(clicked);
    }
    // Return selected values in validValues (option) order to keep answers deterministic
    return validValues
      .map((value) => String(value))
      .filter((value) => nextSet.has(value));
  }

  const normalizedCurrent = String(currentValue ?? '');
  return normalizedCurrent === clicked ? '' : clicked;
}

export function createChoiceButtonGroup({
  block,
  labelId,
  controlId,
  optionSource,
  session,
  updateSummary,
  reportMediaFeedback,
  signal,
  createViewerAudioControl,
}) {
  const selectionMode = block.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single';
  const validValues = optionSource.map((option) => String(option.value ?? option.label ?? ''));
  const container = document.createElement('div');
  container.className = 'choice-button-group';
  const imageLayout = optionSource.some(optionImageRef);
  container.classList.toggle('choice-button-group--images', imageLayout);
  container.setAttribute('aria-labelledby', labelId);
  if (selectionMode === 'single') {
    container.setAttribute('role', 'radiogroup');
  } else {
    container.setAttribute('role', 'group');
  }
  optionSource.forEach((opt, optionIndex) => {
    const row = document.createElement('div');
    row.className = 'choice-button-group__row';
    const value = String(opt.value ?? opt.label ?? '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-button-group__item';
    button.dataset.choiceValue = value;
    button.id = `${controlId}-${String(opt?.id || optionIndex).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (selectionMode === 'single') {
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.tabIndex = optionIndex === 0 ? 0 : -1;
    } else {
      button.setAttribute('aria-pressed', 'false');
    }

    const prefix = document.createElement('span');
    prefix.className = 'choice-button-group__prefix';
    prefix.textContent = getChoicePrefix(optionIndex);

    const labelWrap = document.createElement('span');
    labelWrap.className = 'choice-button-group__label-wrap';

    const labelText = document.createElement('span');
    labelText.className = 'choice-button-group__label';
    labelText.textContent = String(opt.label ?? opt.value ?? '');
    labelWrap.appendChild(labelText);

    button.append(prefix, labelWrap);

    button.addEventListener('click', () => {
      const currentValue = session.state.answers?.[block.blockId]?.value;
      const nextValue = computeNextChoiceValue({
        selectionMode,
        currentValue,
        clickedValue: value,
        validValues,
      });
      session.setAnswer(block.blockId, nextValue);
      updateSummary();
    }, { signal });
    row.appendChild(button);

    const optionAudioControl = createViewerAudioControl({
      audioTracks: opt?.audioTracks,
      legacyAudioRef: (opt?.mediaRefs || []).find(ref => ref.usage === 'option_audio') || null,
      kind: 'option',
      session,
      reportMediaFeedback,
      signal,
    });
    if (imageLayout) {
      const tools = document.createElement('div'); tools.className = 'viewer-option-tools';
      const audioSlot = document.createElement('div'); audioSlot.className = 'viewer-option-audio-slot';
      if (optionAudioControl) audioSlot.append(optionAudioControl);
      tools.append(audioSlot); row.append(tools);
      mountOptionImage({ option: opt, button, tools, storage: session.storage, prefix: getChoicePrefix(optionIndex), signal });
    } else if (optionAudioControl) row.appendChild(optionAudioControl);

    container.appendChild(row);
  });

  if (selectionMode === 'single') {
    container.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
      const radioButtons = Array.from(container.querySelectorAll('button[data-choice-value]'));
      const currentIndex = radioButtons.indexOf(container.getRootNode().activeElement);
      if (currentIndex === -1) return;
      event.preventDefault();
      const isForward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const nextIndex = isForward
        ? (currentIndex + 1) % radioButtons.length
        : (currentIndex - 1 + radioButtons.length) % radioButtons.length;
      radioButtons.forEach((btn, idx) => {
        btn.tabIndex = idx === nextIndex ? 0 : -1;
      });
      radioButtons[nextIndex].focus();
    }, { signal });
  }

  return container;
}

