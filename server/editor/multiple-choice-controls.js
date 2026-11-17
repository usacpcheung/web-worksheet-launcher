// Basic multiple-choice controls. The shell owns row/media composition and mutation policy.
export function createMultipleChoiceControls({ t, createEditorIcon, setIconButtonContent, getSelectionModeLabel,
  onSelectionModeChange, onShuffleChange, onOptionsTextChange, onAddOption }) {
  let destroyed = false;
  let currentBlockId = null;
  const events = new AbortController();
  let rowEvents = new AbortController();
  const questionOptions = document.createElement('textarea');
  questionOptions.id = 'editor-question-options';
  questionOptions.style.display = 'none';
  const questionOptionsList = document.createElement('div');
  questionOptionsList.className = 'question-options-list';
  const questionOptionWarning = document.createElement('p');
  questionOptionWarning.className = 'control-error option-warning';
  questionOptionWarning.hidden = true;
  const addOptionBtn = document.createElement('button');
  addOptionBtn.type = 'button';
  addOptionBtn.className = 'option-add-btn';
  addOptionBtn.textContent = t('editor.option.add');
  const questionSelectionMode = document.createElement('select');
  questionSelectionMode.id = 'editor-question-selection-mode';
  questionSelectionMode.className = 'control';
  [
    { value: 'single', label: getSelectionModeLabel('single') },
    { value: 'multi', label: getSelectionModeLabel('multi') },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionSelectionMode.appendChild(option);
  });
  const questionShuffleOptions = document.createElement('input');
  questionShuffleOptions.id = 'editor-question-shuffle-options';
  questionShuffleOptions.type = 'checkbox';
  questionShuffleOptions.hidden = true;
  const questionShuffleToggle = document.createElement('button');
  questionShuffleToggle.type = 'button';
  questionShuffleToggle.className = 'option-correct-toggle inline-toggle__tick-btn';
  questionShuffleToggle.setAttribute('aria-label', t('editor.question.toggleShuffleAria'));
  questionShuffleToggle.setAttribute('aria-pressed', 'false');
  const questionShuffleTick = document.createElement('span');
  questionShuffleTick.className = 'option-correct-toggle__tick';
  questionShuffleTick.setAttribute('aria-hidden', 'true');
  questionShuffleTick.innerHTML = createEditorIcon('check');
  questionShuffleToggle.appendChild(questionShuffleTick);
  const selectionModeLabel = document.createElement('label');
  selectionModeLabel.textContent = t('editor.question.selectionMode');
  selectionModeLabel.htmlFor = 'editor-question-selection-mode';
  const selectionModeField = document.createElement('div');
  selectionModeField.className = 'editor-field';
  selectionModeField.append(selectionModeLabel, questionSelectionMode);
  const shuffleRow = document.createElement('div');
  shuffleRow.className = 'inline-toggle inline-toggle--custom';
  const shuffleText = document.createElement('span');
  shuffleText.textContent = t('editor.question.shuffleOptions');
  shuffleRow.append(questionShuffleToggle, questionShuffleOptions, shuffleText);

  function listen(node, type, callback) {
    node.addEventListener(type, () => {
      if (destroyed || !currentBlockId || !node.isConnected) return;
      callback(currentBlockId);
    }, { signal: events.signal });
  }
  listen(questionSelectionMode, 'change', id => onSelectionModeChange(id, questionSelectionMode.value));
  listen(questionShuffleToggle, 'click', id => onShuffleChange(id, !questionShuffleOptions.checked));
  listen(questionOptions, 'input', id => onOptionsTextChange(id, questionOptions.value));
  listen(addOptionBtn, 'click', id => onAddOption(id));

  function sync({ blockId, responseConfig } = {}) {
    currentBlockId = responseConfig?.inputType === 'multiple_choice' ? blockId : null;
    if (destroyed || !currentBlockId) return;
    const activeElement = document.activeElement;
    if (activeElement !== questionOptions) {
      questionOptions.value = (responseConfig.options || [])
        .map((option) => String(option?.value ?? option?.label ?? ''))
        .join('\n');
    }
    if (activeElement !== questionSelectionMode) {
      questionSelectionMode.value = responseConfig.selectionMode || 'single';
    }
    if (activeElement !== questionShuffleOptions) {
      questionShuffleOptions.checked = Boolean(responseConfig.shuffleOptions);
    }
    questionShuffleToggle.setAttribute('aria-pressed', questionShuffleOptions.checked ? 'true' : 'false');
  }

  function resetRows() {
    rowEvents.abort();
    rowEvents = new AbortController();
  }

  function createRow({ optionId, optionIndex, label, isPersistedOption, isSelected, isMultiSelect,
    onToggleCorrect, onTextChange, onPaste, onRemove }) {
    const row = document.createElement('div');
    row.className = 'option-row';
    row.dataset.persistedOption = isPersistedOption ? '1' : '0';
    row.dataset.optionId = optionId;

    const correctToggle = document.createElement('button');
    correctToggle.type = 'button';
    correctToggle.className = 'option-correct-toggle';
    correctToggle.title = isMultiSelect
      ? t('editor.option.includeInCorrectAnswers')
      : t('editor.option.markAsCorrectAnswer');
    correctToggle.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    correctToggle.setAttribute(
      'aria-label',
      isMultiSelect
        ? t('editor.option.toggleCorrectAnswerAriaLabelMulti', { index: optionIndex + 1 })
        : t('editor.option.toggleCorrectAnswerAriaLabelSingle', { index: optionIndex + 1 })
    );
    const tickIcon = document.createElement('span');
    tickIcon.className = 'option-correct-toggle__tick';
    tickIcon.setAttribute('aria-hidden', 'true');
    tickIcon.innerHTML = createEditorIcon('check');
    correctToggle.appendChild(tickIcon);

    const optionInput = document.createElement('input');
    optionInput.type = 'text';
    optionInput.dataset.optionInput = '1';
    optionInput.dataset.optionIndex = String(optionIndex);
    optionInput.className = 'control';
    optionInput.placeholder = t('editor.option.placeholder', { index: optionIndex + 1 });
    optionInput.value = label;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn danger';
    removeBtn.title = 'Delete this option';
    removeBtn.setAttribute('aria-label', `Delete option ${optionIndex + 1}`);
    setIconButtonContent(removeBtn, 'trash');

    const listenRow = (node, type, callback) => node.addEventListener(type, event => {
      if (destroyed || !row.isConnected) return;
      callback(event);
    }, { signal: rowEvents.signal });
    let isOptionInputComposing = false;
    listenRow(correctToggle, 'click', onToggleCorrect);
    listenRow(removeBtn, 'click', onRemove);
    listenRow(optionInput, 'compositionstart', () => { isOptionInputComposing = true; });
    listenRow(optionInput, 'compositionend', () => {
      isOptionInputComposing = false;
      onTextChange(optionInput.value);
    });
    listenRow(optionInput, 'input', event => {
      if (isOptionInputComposing || event.isComposing) return;
      onTextChange(optionInput.value);
    });
    listenRow(optionInput, 'paste', onPaste);
    return { row, optionInput, correctToggle, removeBtn };
  }

  function setWarning(text = '') {
    questionOptionWarning.hidden = !text;
    questionOptionWarning.textContent = text;
  }

  return {
    questionOptions, questionOptionsList, questionOptionWarning, addOptionBtn,
    selectionModeField, shuffleRow, sync, createRow, resetRows, setWarning,
    destroy() {
      destroyed = true;
      currentBlockId = null;
      events.abort();
      rowEvents.abort();
    },
  };
}
