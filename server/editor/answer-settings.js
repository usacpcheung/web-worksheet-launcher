import { isLongText, textLimitCeiling, textConfigError } from '../app/text-answer.js';

// Presentation only: the shell owns mutations, validation rules and confirmation flows.
export function createAnswerSettings({
  t, createEditorIcon, getTextDisplayModeLabel, getBooleanAnswerLabel,
  getNumberQuestionValidationErrors, onTextModeChange, onMaxLengthChange,
  onDisplayModeChange, onNumberRangeChange, onBooleanAnswerChange,
  onNumberAnswerChange, onAllowSignedChange, onDecimalPlacesChange,
}) {
  let destroyed = false;
  let currentBlockId = null;
  let textLimitError = null;
  const events = new AbortController();
  let mountEvents = new AbortController();
  const listen = (element, event, action) => element.addEventListener(event, () => {
    if (!destroyed && currentBlockId && element.isConnected) action();
  }, { signal: events.signal });
  const questionTextDisplayMode = document.createElement('div');
  questionTextDisplayMode.id = 'editor-question-text-display-mode';
  questionTextDisplayMode.className = 'answer-toggle';
  questionTextDisplayMode.setAttribute('role', 'group');
  questionTextDisplayMode.setAttribute('aria-labelledby', 'editor-question-text-display-mode-label');
  const questionTextDisplayModeButtons = [
    { value: 'single_line', label: getTextDisplayModeLabel('single_line') },
    { value: 'multi_line', label: getTextDisplayModeLabel('multi_line') },
  ].map(({ value, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-toggle__btn';
    button.dataset.textDisplayMode = value;
    button.setAttribute('aria-pressed', 'false');
    const tick = document.createElement('span');
    tick.className = 'answer-toggle__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.innerHTML = createEditorIcon('check');
    const text = document.createElement('span');
    text.textContent = label;
    button.append(tick, text);
    questionTextDisplayMode.appendChild(button);
    return button;
  });
  const questionMaxLength = document.createElement('input');
  questionMaxLength.id = 'editor-question-max-length';
  questionMaxLength.type = 'number';
  questionMaxLength.min = '1';
  questionMaxLength.className = 'control';
  const questionMin = document.createElement('input');
  questionMin.id = 'editor-question-min';
  questionMin.type = 'number';
  questionMin.className = 'control';
  const questionMax = document.createElement('input');
  questionMax.id = 'editor-question-max';
  questionMax.type = 'number';
  questionMax.className = 'control';
  const questionNumberAllowSigned = document.createElement('input');
  questionNumberAllowSigned.id = 'editor-question-number-allow-signed';
  questionNumberAllowSigned.type = 'checkbox';
  questionNumberAllowSigned.hidden = true;
  const questionNumberAllowSignedToggle = document.createElement('button');
  questionNumberAllowSignedToggle.type = 'button';
  questionNumberAllowSignedToggle.className = 'option-correct-toggle inline-toggle__tick-btn';
  questionNumberAllowSignedToggle.setAttribute('aria-label', t('editor.question.toggleSignedValuesAria'));
  questionNumberAllowSignedToggle.setAttribute('aria-pressed', 'false');
  const questionNumberAllowSignedTick = document.createElement('span');
  questionNumberAllowSignedTick.className = 'option-correct-toggle__tick';
  questionNumberAllowSignedTick.setAttribute('aria-hidden', 'true');
  questionNumberAllowSignedTick.innerHTML = createEditorIcon('check');
  questionNumberAllowSignedToggle.appendChild(questionNumberAllowSignedTick);
  const questionNumberDecimalPlacesAllowed = document.createElement('input');
  questionNumberDecimalPlacesAllowed.id = 'editor-question-number-decimal-places-allowed';
  questionNumberDecimalPlacesAllowed.type = 'number';
  questionNumberDecimalPlacesAllowed.min = '0';
  questionNumberDecimalPlacesAllowed.step = '1';
  questionNumberDecimalPlacesAllowed.className = 'control';
  const questionCorrectAnswerBoolean = document.createElement('div');
  questionCorrectAnswerBoolean.id = 'editor-question-correct-answer-boolean';
  questionCorrectAnswerBoolean.className = 'boolean-answer-toggle';
  questionCorrectAnswerBoolean.setAttribute('role', 'group');
  questionCorrectAnswerBoolean.setAttribute('aria-labelledby', 'editor-question-correct-answer-boolean-label');
  const questionCorrectAnswerBooleanButtons = ['true', 'false'].map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'boolean-answer-toggle__btn';
    button.dataset.booleanAnswerValue = value;
    button.setAttribute('aria-pressed', 'false');
    const tick = document.createElement('span');
    tick.className = 'boolean-answer-toggle__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.innerHTML = createEditorIcon('check');
    const text = document.createElement('span');
    text.textContent = getBooleanAnswerLabel(value);
    button.append(tick, text);
    questionCorrectAnswerBoolean.appendChild(button);
    return button;
  });
  const questionCorrectAnswerNumber = document.createElement('input');
  questionCorrectAnswerNumber.id = 'editor-question-correct-answer-number';
  questionCorrectAnswerNumber.type = 'number';
  questionCorrectAnswerNumber.step = 'any';
  questionCorrectAnswerNumber.className = 'control';
  const questionMinError = document.createElement('p');
  questionMinError.className = 'control-error';
  const questionMaxError = document.createElement('p');
  questionMaxError.className = 'control-error';
  const questionNumberDecimalPlacesAllowedError = document.createElement('p');
  questionNumberDecimalPlacesAllowedError.className = 'control-error';
  const questionCorrectAnswerNumberError = document.createElement('p');
  questionCorrectAnswerNumberError.className = 'control-error';

  const updateNumberValidationFeedback = (responseConfig) => {
    const clearFieldError = (input, errorNode) => {
      input.classList.remove('control-invalid');
      errorNode.textContent = '';
    };
    clearFieldError(questionMin, questionMinError);
    clearFieldError(questionMax, questionMaxError);
    clearFieldError(questionNumberDecimalPlacesAllowed, questionNumberDecimalPlacesAllowedError);
    clearFieldError(questionCorrectAnswerNumber, questionCorrectAnswerNumberError);

    if (responseConfig?.inputType !== 'number') return;

    const errors = getNumberQuestionValidationErrors(responseConfig, {
      decimalPlacesAllowed: questionNumberDecimalPlacesAllowed.value,
      correctAnswer: questionCorrectAnswerNumber.value,
    });
    const setFieldError = (input, errorNode, message) => {
      if (!message) return;
      input.classList.add('control-invalid');
      errorNode.textContent = message;
    };
    setFieldError(questionMin, questionMinError, errors.min);
    setFieldError(questionMax, questionMaxError, errors.max);
    setFieldError(
      questionNumberDecimalPlacesAllowed,
      questionNumberDecimalPlacesAllowedError,
      errors.decimalPlacesAllowed
    );
    setFieldError(questionCorrectAnswerNumber, questionCorrectAnswerNumberError, errors.correctAnswer);
  };

  function sync({ blockId = null, responseConfig = null } = {}) {
    if (destroyed) return;
    currentBlockId = blockId;
    const activeElement = document.activeElement;
    if (responseConfig) {
      questionMaxLength.max = String(textLimitCeiling(responseConfig));
      questionMaxLength.setAttribute('aria-invalid', String(Boolean(textConfigError(responseConfig, { authoring: true }))));
      if (textLimitError) textLimitError.textContent = textConfigError(responseConfig, { authoring: true }) ? t(isLongText(responseConfig) ? 'textAnswer.invalidLong' : 'textAnswer.invalid', { max: textLimitCeiling(responseConfig) }) : '';
      if (activeElement !== questionMaxLength) {
        questionMaxLength.value = responseConfig.maxLength || 200;
      }
      const activeDisplayMode = responseConfig.displayMode === 'single_line' ? 'single_line' : 'multi_line';
      questionTextDisplayModeButtons.forEach((button) => {
        button.setAttribute(
          'aria-pressed',
          button.dataset.textDisplayMode === activeDisplayMode ? 'true' : 'false'
        );
      });
      if (activeElement !== questionMin) questionMin.value = responseConfig.min ?? '';
      if (activeElement !== questionMax) questionMax.value = responseConfig.max ?? '';
      if (activeElement !== questionNumberAllowSigned) {
        questionNumberAllowSigned.checked = responseConfig.numberRules?.allowSigned !== false;
      }
      questionNumberAllowSignedToggle.setAttribute(
        'aria-pressed',
        questionNumberAllowSigned.checked ? 'true' : 'false'
      );
      if (activeElement !== questionNumberDecimalPlacesAllowed) {
        questionNumberDecimalPlacesAllowed.value = Number.isInteger(responseConfig.numberRules?.decimalPlacesAllowed)
          ? String(responseConfig.numberRules.decimalPlacesAllowed)
          : '';
      }
      questionCorrectAnswerBooleanButtons.forEach((button) => {
        const isSelected = typeof responseConfig.correctAnswer === 'boolean'
          && button.dataset.booleanAnswerValue === String(responseConfig.correctAnswer);
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
      if (activeElement !== questionCorrectAnswerNumber) {
        questionCorrectAnswerNumber.value = typeof responseConfig.correctAnswer === 'number'
          ? String(responseConfig.correctAnswer)
          : '';
      }
    }
    updateNumberValidationFeedback(responseConfig);
  }

  function mount(answerSection, { blockId, responseConfig }, activeInputType) {
    if (destroyed) return;
    mountEvents.abort();
    mountEvents = new AbortController();
    textLimitError = null;
    if (activeInputType === 'text') {
      const longLabel = document.createElement('label');
      longLabel.className = 'editor-long-text-toggle';
      const longToggle = document.createElement('input');
      longToggle.type = 'checkbox';
      longToggle.id = 'editor-question-long-text';
      longToggle.checked = isLongText(responseConfig);
      longLabel.append(longToggle, document.createTextNode(t('textAnswer.toggle')));
      const modeHint = document.createElement('p');
      modeHint.className = 'muted';
      modeHint.textContent = t(isLongText(responseConfig) ? 'textAnswer.longHint' : 'textAnswer.standardHint');
      longToggle.addEventListener('change', () => {
        if (destroyed || !longToggle.isConnected) return;
        onTextModeChange(blockId, longToggle.checked, () => { longToggle.checked = true; });
      }, { signal: mountEvents.signal });
      answerSection.append(longLabel, modeHint);
      const textSettingsRow = document.createElement('div');
      textSettingsRow.className = 'text-answer-settings';
      const maxLengthField = document.createElement('div');
      maxLengthField.className = 'editor-field';
      const maxLengthLabel = document.createElement('label');
      maxLengthLabel.textContent = t('editor.question.maxLength');
      maxLengthLabel.htmlFor = 'editor-question-max-length';
      const limitError = document.createElement('p');
      textLimitError = limitError;
      limitError.className = 'input-error';
      limitError.dataset.textLimitError = '';
      limitError.setAttribute('role', 'status');
      limitError.textContent = textConfigError(responseConfig, { authoring: true }) ? t(isLongText(responseConfig) ? 'textAnswer.invalidLong' : 'textAnswer.invalid', { max: textLimitCeiling(responseConfig) }) : '';
      maxLengthField.append(maxLengthLabel, questionMaxLength, limitError);

      const displayModeField = document.createElement('div');
      displayModeField.className = 'editor-field';
      const displayModeLabel = document.createElement('label');
      displayModeLabel.id = 'editor-question-text-display-mode-label';
      displayModeLabel.textContent = t('editor.question.responseFormat');
      displayModeField.append(displayModeLabel, questionTextDisplayMode);
      textSettingsRow.append(maxLengthField);
      if (!isLongText(responseConfig)) textSettingsRow.append(displayModeField);
      answerSection.appendChild(textSettingsRow);
    }

    if (activeInputType === 'number') {
      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.textContent = t('editor.question.correctAnswer');
      correctAnswerLabel.htmlFor = 'editor-question-correct-answer-number';
      const correctAnswerField = document.createElement('div');
      correctAnswerField.className = 'editor-field number-answer-field';
      correctAnswerField.append(correctAnswerLabel, questionCorrectAnswerNumber, questionCorrectAnswerNumberError);
      const minLabel = document.createElement('label');
      minLabel.textContent = t('editor.question.min');
      minLabel.htmlFor = 'editor-question-min';
      const minField = document.createElement('div');
      minField.className = 'editor-field number-answer-field';
      minField.append(minLabel, questionMin, questionMinError);
      const maxLabel = document.createElement('label');
      maxLabel.textContent = t('editor.question.max');
      maxLabel.htmlFor = 'editor-question-max';
      const maxField = document.createElement('div');
      maxField.className = 'editor-field number-answer-field';
      maxField.append(maxLabel, questionMax, questionMaxError);
      const rangeRow = document.createElement('div');
      rangeRow.className = 'number-answer-range';
      rangeRow.append(correctAnswerField, minField, maxField);
      answerSection.append(rangeRow);

      const rulesRow = document.createElement('div');
      rulesRow.className = 'number-answer-rules';
      const signedField = document.createElement('div');
      signedField.className = 'editor-field number-answer-signed-field';
      const signedRow = document.createElement('div');
      signedRow.className = 'inline-toggle inline-toggle--custom';
      const signedText = document.createElement('span');
      signedText.textContent = t('editor.question.allowSignedValues');
      signedRow.append(questionNumberAllowSignedToggle, questionNumberAllowSigned, signedText);
      signedField.append(signedRow);

      const decimalPlacesField = document.createElement('div');
      decimalPlacesField.className = 'editor-field number-answer-field';
      const decimalPlacesLabel = document.createElement('label');
      decimalPlacesLabel.textContent = t('editor.question.decimalPlaces');
      decimalPlacesLabel.htmlFor = 'editor-question-number-decimal-places-allowed';
      const decimalPlacesHint = document.createElement('p');
      decimalPlacesHint.className = 'muted number-answer-hint';
      decimalPlacesHint.textContent = t('editor.question.decimalPlacesHint');
      decimalPlacesField.append(
        decimalPlacesLabel,
        questionNumberDecimalPlacesAllowed,
        questionNumberDecimalPlacesAllowedError
      );
      rulesRow.append(decimalPlacesField, signedField, decimalPlacesHint);
      answerSection.append(rulesRow);
    }

    if (activeInputType === 'boolean') {
      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.id = 'editor-question-correct-answer-boolean-label';
      correctAnswerLabel.textContent = t('editor.question.correctAnswer');
      answerSection.append(correctAnswerLabel, questionCorrectAnswerBoolean);
    }
  }

  listen(questionMaxLength, 'input', () => {
    onMaxLengthChange(currentBlockId, questionMaxLength.value);
  });
  questionTextDisplayModeButtons.forEach((button) => {
    listen(button, 'click', () => {
      onDisplayModeChange(
        currentBlockId,
        button.dataset.textDisplayMode || 'multi_line'
      );
    });
  });
  listen(questionMin, 'input', () => {
    onNumberRangeChange(currentBlockId, 'min', questionMin.value);
  });
  listen(questionMax, 'input', () => {
    onNumberRangeChange(currentBlockId, 'max', questionMax.value);
  });
  questionCorrectAnswerBooleanButtons.forEach((button) => {
    listen(button, 'click', () => {
      const selectedValue = button.dataset.booleanAnswerValue || '';
      const nextValue = button.getAttribute('aria-pressed') === 'true' ? '' : selectedValue;
      onBooleanAnswerChange(currentBlockId, nextValue);
    });
  });
  listen(questionCorrectAnswerNumber, 'input', () => {
    onNumberAnswerChange(currentBlockId, questionCorrectAnswerNumber.value);
  });
  listen(questionNumberAllowSignedToggle, 'click', () => {
    onAllowSignedChange(currentBlockId, !questionNumberAllowSigned.checked);
  });
  listen(questionNumberDecimalPlacesAllowed, 'input', () => {
    onDecimalPlacesChange(
      currentBlockId,
      questionNumberDecimalPlacesAllowed.value
    );
  });
  function destroy() {
    destroyed = true;
    currentBlockId = null;
    textLimitError = null;
    events.abort();
    mountEvents.abort();
  }

  return { mount, sync, destroy };
}
