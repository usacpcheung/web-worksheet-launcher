import { BubbleMode, MAX_DIALOGUE_LINES, MAX_SPEECH_BUBBLE_ANCHORS, SceneType, createChoice } from '../model.js';
import { translate } from '../i18n.js';
import {
  ROLEPLAYSCENE_T2A_PRESETS,
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  getRolePlaySceneT2APresetFromAudioName,
  getRolePlaySceneT2ATextState,
} from '../t2a-presets.js';

function attachComposedValueListener(field, callback) {
  let composing = false;
  let lastValue = field.value;
  const emit = () => {
    const nextValue = field.value;
    if (nextValue === lastValue) return;
    lastValue = nextValue;
    callback(nextValue);
  };
  field.addEventListener('compositionstart', () => {
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
    emit();
  });
  field.addEventListener('input', (event) => {
    if (event.isComposing || composing) {
      return;
    }
    emit();
  });
}

function getClampedPercent(value) {
  return Math.max(0, Math.min(1, Number(value))) * 100;
}

export function renderInspector(hostEl, project, scene, actions) {
  hostEl.innerHTML = '';
  hostEl.classList.add('inspector');

  const projectTitleField = document.createElement('label');
  projectTitleField.className = 'field';
  const projectTitleLabel = document.createElement('span');
  projectTitleLabel.textContent = translate('inspector.projectTitleLabel');
  projectTitleField.appendChild(projectTitleLabel);
  const projectTitleInput = document.createElement('input');
  projectTitleInput.type = 'text';
  projectTitleInput.value = project.meta?.title ?? '';
  projectTitleInput.placeholder = translate('inspector.projectTitlePlaceholder');
  projectTitleInput.maxLength = 120;
  projectTitleInput.dataset.focusKey = 'project-title';
  attachComposedValueListener(projectTitleInput, (value) => {
    actions.onUpdateProjectTitle?.(value);
  });
  projectTitleField.appendChild(projectTitleInput);
  hostEl.appendChild(projectTitleField);

  if (!scene) {
    const empty = document.createElement('p');
    empty.textContent = translate('inspector.emptyState');
    hostEl.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'inspector-header';
  const sceneHeading = document.createElement('h3');
  sceneHeading.textContent = scene.id;
  header.appendChild(sceneHeading);

  const controls = document.createElement('div');
  controls.className = 'inspector-actions';

  const addBtn = document.createElement('button');
  addBtn.textContent = translate('inspector.header.addScene');
  addBtn.addEventListener('click', () => actions.onAddScene?.());
  addBtn.disabled = project.scenes.length >= 20;

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = translate('inspector.header.deleteScene');
  deleteBtn.addEventListener('click', () => actions.onDeleteScene?.(scene.id));
  deleteBtn.disabled = !actions.canDeleteScene;

  controls.append(addBtn, deleteBtn);
  header.appendChild(controls);
  hostEl.appendChild(header);

  // Scene type selector
  const typeField = document.createElement('label');
  typeField.className = 'field';
  const typeLabel = document.createElement('span');
  typeLabel.textContent = translate('inspector.sceneTypeLabel');
  typeField.appendChild(typeLabel);
  const typeSelect = document.createElement('select');
  typeSelect.dataset.focusKey = `scene-type-${scene.id}`;
  const sceneTypeOptions = [
    { value: SceneType.START, label: translate('inspector.sceneTypes.start') },
    { value: SceneType.INTERMEDIATE, label: translate('inspector.sceneTypes.intermediate') },
    { value: SceneType.END, label: translate('inspector.sceneTypes.end') },
  ];
  sceneTypeOptions.forEach(optionDef => {
    const option = document.createElement('option');
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    typeSelect.appendChild(option);
  });
  typeSelect.value = scene.type;
  typeSelect.addEventListener('change', () => {
    actions.onSetSceneType?.(scene.id, typeSelect.value);
  });
  typeField.appendChild(typeSelect);
  hostEl.appendChild(typeField);

  // Image upload
  const imageField = document.createElement('div');
  imageField.className = 'field';
  const imageLabel = document.createElement('span');
  imageLabel.textContent = translate('inspector.image.label');
  imageField.appendChild(imageLabel);

  const imagePreview = document.createElement('div');
  imagePreview.className = 'image-preview';
  if (scene.image?.objectUrl) {
    const img = document.createElement('img');
    img.src = scene.image.objectUrl;
    img.alt = translate('inspector.image.previewAlt', { sceneId: scene.id });
    imagePreview.appendChild(img);
  } else {
    imagePreview.textContent = translate('inspector.image.empty');
  }
  imageField.appendChild(imagePreview);

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    actions.onSetSceneImage?.(scene.id, file || null);
  });
  imageField.appendChild(imageInput);

  if (scene.image) {
    const removeImageBtn = document.createElement('button');
    removeImageBtn.type = 'button';
    removeImageBtn.textContent = translate('inspector.image.remove');
    removeImageBtn.addEventListener('click', () => actions.onSetSceneImage?.(scene.id, null));
    imageField.appendChild(removeImageBtn);
  }

  hostEl.appendChild(imageField);

  const speechBubble = scene.speechBubble || { enabled: false, anchors: [] };
  const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];
  const speechSection = document.createElement('section');
  speechSection.className = 'speech-bubble-editor';

  const speechToggle = document.createElement('label');
  speechToggle.className = 'field speech-bubble-editor__toggle';
  const speechToggleText = document.createElement('span');
  speechToggleText.textContent = translate('inspector.speechBubble.title');
  speechToggle.appendChild(speechToggleText);
  const speechCheckbox = document.createElement('input');
  speechCheckbox.type = 'checkbox';
  speechCheckbox.checked = speechBubble.enabled === true;
  speechCheckbox.addEventListener('change', () => {
    actions.onToggleSpeechBubble?.(scene.id, speechCheckbox.checked);
  });
  speechToggle.appendChild(speechCheckbox);
  speechSection.appendChild(speechToggle);

  if (speechBubble.enabled) {
    const helper = document.createElement('p');
    helper.className = 'hint';
    helper.textContent = translate('inspector.speechBubble.previewHint');
    speechSection.appendChild(helper);

    const anchorStage = document.createElement('div');
    anchorStage.className = 'speech-bubble-stage';
    anchorStage.setAttribute('role', 'group');
    anchorStage.setAttribute('aria-label', translate('inspector.speechBubble.stageLabel'));
    const anchorFrame = document.createElement('div');
    anchorFrame.className = scene.image?.objectUrl
      ? 'speech-bubble-stage__frame'
      : 'speech-bubble-stage__frame speech-bubble-stage__frame--empty';
    if (scene.image?.objectUrl) {
      const anchorImage = document.createElement('img');
      anchorImage.src = scene.image.objectUrl;
      anchorImage.alt = translate('inspector.image.previewAlt', { sceneId: scene.id });
      anchorFrame.appendChild(anchorImage);
    } else {
      const emptyStage = document.createElement('span');
      emptyStage.textContent = translate('inspector.image.empty');
      anchorFrame.appendChild(emptyStage);
    }
    anchorFrame.addEventListener('click', (event) => {
      const rect = anchorFrame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      actions.onAddOrMoveSpeechBubbleAnchor?.(scene.id, {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      });
    });

    anchors.forEach((anchor) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'speech-bubble-anchor-marker';
      if (actions.isSpeechBubbleAnchorSelected?.(anchor.id)) {
        marker.classList.add('is-selected');
      }
      marker.textContent = anchor.label || '';
      marker.style.left = `${getClampedPercent(anchor.x)}%`;
      marker.style.top = `${getClampedPercent(anchor.y)}%`;
      marker.setAttribute('aria-label', translate('inspector.speechBubble.selectAnchor', { label: anchor.label || anchor.id }));
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        actions.onSelectSpeechBubbleAnchor?.(scene.id, anchor.id);
      });
      anchorFrame.appendChild(marker);
    });

    anchorStage.appendChild(anchorFrame);
    speechSection.appendChild(anchorStage);

    const count = document.createElement('p');
    count.className = 'hint';
    count.textContent = translate('inspector.speechBubble.anchorCount', {
      count: anchors.length,
      max: MAX_SPEECH_BUBBLE_ANCHORS,
    });
    speechSection.appendChild(count);

    if (anchors.length) {
      const anchorList = document.createElement('ul');
      anchorList.className = 'speech-bubble-anchor-list';
      anchors.forEach((anchor) => {
        const usage = scene.dialogue.filter(line => (
          line.bubble?.mode === BubbleMode.ANCHOR && line.bubble.anchorId === anchor.id
        )).length;
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = translate('inspector.speechBubble.anchorUsage', {
          label: anchor.label || anchor.id,
          count: usage,
        });
        item.appendChild(label);
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.textContent = actions.isSpeechBubbleAnchorSelected?.(anchor.id)
          ? translate('inspector.speechBubble.selectedAnchor')
          : translate('inspector.speechBubble.moveAnchor');
        selectButton.addEventListener('click', () => actions.onSelectSpeechBubbleAnchor?.(scene.id, anchor.id));
        item.appendChild(selectButton);
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.textContent = translate('inspector.speechBubble.deleteAnchor');
        deleteButton.addEventListener('click', () => actions.onDeleteSpeechBubbleAnchor?.(scene.id, anchor.id));
        item.appendChild(deleteButton);
        anchorList.appendChild(item);
      });
      speechSection.appendChild(anchorList);
    }
  }
  hostEl.appendChild(speechSection);

  const backgroundField = document.createElement('div');
  backgroundField.className = 'field';
  const backgroundLabel = document.createElement('span');
  backgroundLabel.textContent = translate('inspector.background.label');
  backgroundField.appendChild(backgroundLabel);

  if (scene.backgroundAudio) {
    const info = document.createElement('div');
    info.className = 'audio-info';
    const trackName = scene.backgroundAudio.name || translate('inspector.background.fallbackName');
    info.textContent = translate('inspector.background.attached', { name: trackName });
    backgroundField.appendChild(info);
  } else {
    const emptyInfo = document.createElement('p');
    emptyInfo.className = 'hint';
    emptyInfo.textContent = translate('inspector.background.empty');
    backgroundField.appendChild(emptyInfo);
  }

  const backgroundInput = document.createElement('input');
  backgroundInput.type = 'file';
  backgroundInput.accept = 'audio/*';
  backgroundInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    actions.onSetSceneBackgroundAudio?.(scene.id, file || null);
  });
  backgroundField.appendChild(backgroundInput);

  if (scene.backgroundAudio) {
    const removeBgButton = document.createElement('button');
    removeBgButton.type = 'button';
    removeBgButton.textContent = translate('inspector.background.remove');
    removeBgButton.addEventListener('click', () => actions.onSetSceneBackgroundAudio?.(scene.id, null));
    backgroundField.appendChild(removeBgButton);
  }

  hostEl.appendChild(backgroundField);

  // Dialogue
  const dialogueSection = document.createElement('section');
  dialogueSection.className = 'dialogue-editor';
  const dialogueHeader = document.createElement('h4');
  dialogueHeader.textContent = translate('inspector.dialogue.title');
  dialogueSection.appendChild(dialogueHeader);

  scene.dialogue.forEach((line, index) => {
    const lineField = document.createElement('div');
    lineField.className = 'dialogue-line';

    const textLabel = document.createElement('label');
    const textSpan = document.createElement('span');
    textSpan.textContent = translate('inspector.dialogue.lineLabel', { index: index + 1 });
    textLabel.appendChild(textSpan);
    const textarea = document.createElement('textarea');
    textarea.value = line.text || '';
    textarea.rows = 2;
    textarea.dataset.focusKey = `dialogue-${scene.id}-${index}`;
    attachComposedValueListener(textarea, (value) => {
      actions.onUpdateDialogueText?.(scene.id, index, value);
    });
    textLabel.appendChild(textarea);
    lineField.appendChild(textLabel);

    const audioLabel = document.createElement('label');
    const audioSpan = document.createElement('span');
    audioSpan.textContent = translate('inspector.dialogue.audioLabel');
    audioLabel.appendChild(audioSpan);
    const audioInput = document.createElement('input');
    audioInput.type = 'file';
    audioInput.accept = 'audio/mpeg,audio/mp3';
    audioInput.dataset.focusKey = `dialogue-audio-${scene.id}-${index}`;
    audioInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      actions.onSetDialogueAudio?.(scene.id, index, file || null);
    });
    audioLabel.appendChild(audioInput);
    lineField.appendChild(audioLabel);

    if (line.audio) {
      const audioInfo = document.createElement('div');
      audioInfo.className = 'audio-info';
      const audioName = line.audio.name || '';
      audioInfo.textContent = translate('inspector.dialogue.audioAttached', { name: audioName });
      const t2aPreset = getRolePlaySceneT2APresetFromAudioName(audioName);
      if (t2aPreset) {
        const presetBadge = document.createElement('span');
        presetBadge.className = 'audio-info__badge';
        presetBadge.textContent = translate('inspector.dialogue.t2aPresetBadge', {
          preset: translate(t2aPreset.labelKey),
        });
        audioInfo.appendChild(presetBadge);
      }
      if (line.audio.objectUrl) {
        const isPreviewingAudio = actions.isDialogueAudioPreviewing?.(scene.id, index) === true;
        const previewAudio = document.createElement('button');
        previewAudio.type = 'button';
        previewAudio.textContent = isPreviewingAudio
          ? translate('inspector.dialogue.stopAudioPreview')
          : translate('inspector.dialogue.playAudioPreview');
        previewAudio.addEventListener('click', () => actions.onPreviewDialogueAudio?.(scene.id, index));
        audioInfo.appendChild(previewAudio);
      }
      const removeAudio = document.createElement('button');
      removeAudio.type = 'button';
      removeAudio.textContent = translate('inspector.dialogue.removeAudio');
      removeAudio.addEventListener('click', () => actions.onSetDialogueAudio?.(scene.id, index, null));
      audioInfo.appendChild(removeAudio);
      lineField.appendChild(audioInfo);
    }

    const t2aState = getRolePlaySceneT2ATextState(line.text || '');
    const isGeneratingAudio = actions.isDialogueAudioGenerating?.(scene.id, index) === true;
    const t2aControls = document.createElement('div');
    t2aControls.className = 'dialogue-t2a-controls';

    const presetLabel = document.createElement('label');
    presetLabel.className = 'dialogue-t2a-controls__preset';
    const presetText = document.createElement('span');
    presetText.textContent = translate('inspector.dialogue.t2aPresetLabel');
    presetLabel.appendChild(presetText);
    const presetSelect = document.createElement('select');
    presetSelect.dataset.focusKey = `dialogue-t2a-preset-${scene.id}-${index}`;
    ROLEPLAYSCENE_T2A_PRESETS.forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = translate(preset.labelKey);
      presetSelect.appendChild(option);
    });
    presetLabel.appendChild(presetSelect);

    const generateAudio = document.createElement('button');
    generateAudio.type = 'button';
    generateAudio.textContent = isGeneratingAudio
      ? translate('inspector.dialogue.generatingAudio')
      : line.audio
        ? translate('inspector.dialogue.regenerateAudio')
        : translate('inspector.dialogue.generateAudio');
    generateAudio.disabled = !t2aState.eligible || isGeneratingAudio;
    generateAudio.addEventListener('click', () => {
      actions.onGenerateDialogueAudio?.(scene.id, index, presetSelect.value);
    });

    const t2aHint = document.createElement('p');
    t2aHint.className = 'hint dialogue-t2a-controls__hint';
    if (!t2aState.hasText) {
      t2aHint.textContent = translate('inspector.dialogue.t2aTextRequired');
    } else if (t2aState.exceedsLimit) {
      t2aHint.textContent = translate('inspector.dialogue.t2aTextTooLong', { max: ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH });
    } else {
      t2aHint.hidden = true;
    }

    t2aControls.append(presetLabel, generateAudio);
    lineField.append(t2aControls, t2aHint);

    if (speechBubble.enabled) {
      const bubbleControls = document.createElement('div');
      bubbleControls.className = 'dialogue-bubble-controls';
      const bubbleModeLabel = document.createElement('label');
      bubbleModeLabel.className = 'field';
      const bubbleModeText = document.createElement('span');
      bubbleModeText.textContent = translate('inspector.speechBubble.lineModeLabel');
      bubbleModeLabel.appendChild(bubbleModeText);
      const bubbleModeSelect = document.createElement('select');
      bubbleModeSelect.dataset.focusKey = `dialogue-bubble-mode-${scene.id}-${index}`;
      [
        { value: BubbleMode.ANCHOR, label: translate('inspector.speechBubble.lineModes.anchor') },
        { value: BubbleMode.CENTER, label: translate('inspector.speechBubble.lineModes.center') },
        { value: BubbleMode.HIDDEN, label: translate('inspector.speechBubble.lineModes.hidden') },
      ].forEach(optionDef => {
        const option = document.createElement('option');
        option.value = optionDef.value;
        option.textContent = optionDef.label;
        bubbleModeSelect.appendChild(option);
      });
      bubbleModeSelect.value = line.bubble?.mode || BubbleMode.CENTER;
      bubbleModeSelect.addEventListener('change', () => {
        const firstAnchorId = anchors[0]?.id ?? null;
        actions.onUpdateDialogueBubble?.(scene.id, index, {
          mode: bubbleModeSelect.value,
          anchorId: bubbleModeSelect.value === BubbleMode.ANCHOR
            ? (line.bubble?.anchorId || firstAnchorId)
            : null,
        });
      });
      bubbleModeLabel.appendChild(bubbleModeSelect);
      bubbleControls.appendChild(bubbleModeLabel);

      if ((line.bubble?.mode || BubbleMode.CENTER) === BubbleMode.ANCHOR) {
        const anchorLabel = document.createElement('label');
        anchorLabel.className = 'field';
        const anchorText = document.createElement('span');
        anchorText.textContent = translate('inspector.speechBubble.lineAnchorLabel');
        anchorLabel.appendChild(anchorText);
        const anchorSelect = document.createElement('select');
        anchorSelect.dataset.focusKey = `dialogue-bubble-anchor-${scene.id}-${index}`;
        const noneOption = document.createElement('option');
        noneOption.value = '';
        noneOption.textContent = translate('inspector.speechBubble.lineAnchorMissing');
        anchorSelect.appendChild(noneOption);
        anchors.forEach((anchor) => {
          const option = document.createElement('option');
          option.value = anchor.id;
          option.textContent = anchor.label || anchor.id;
          anchorSelect.appendChild(option);
        });
        anchorSelect.value = line.bubble?.anchorId || '';
        anchorSelect.addEventListener('change', () => {
          actions.onUpdateDialogueBubble?.(scene.id, index, {
            mode: BubbleMode.ANCHOR,
            anchorId: anchorSelect.value || null,
          });
        });
        anchorLabel.appendChild(anchorSelect);
        bubbleControls.appendChild(anchorLabel);
      }
      lineField.appendChild(bubbleControls);
    }

    const removeLineBtn = document.createElement('button');
    removeLineBtn.type = 'button';
    removeLineBtn.textContent = translate('inspector.dialogue.deleteLine');
    removeLineBtn.addEventListener('click', () => actions.onRemoveDialogue?.(scene.id, index));
    removeLineBtn.disabled = scene.dialogue.length <= 1;
    lineField.appendChild(removeLineBtn);

    dialogueSection.appendChild(lineField);
  });

  const addLineBtn = document.createElement('button');
  addLineBtn.type = 'button';
  addLineBtn.textContent = translate('inspector.dialogue.addLine');
  addLineBtn.addEventListener('click', () => actions.onAddDialogue?.(scene.id));
  addLineBtn.disabled = scene.dialogue.length >= MAX_DIALOGUE_LINES;
  dialogueSection.appendChild(addLineBtn);
  hostEl.appendChild(dialogueSection);

  // Choices
  const choiceSection = document.createElement('section');
  choiceSection.className = 'choice-editor';
  const choiceHeader = document.createElement('h4');
  choiceHeader.textContent = translate('inspector.choices.title');
  choiceSection.appendChild(choiceHeader);

  if (!scene.choices.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'empty';
    emptyMessage.textContent = translate('inspector.choices.empty');
    choiceSection.appendChild(emptyMessage);
  }

  scene.choices.forEach((choice, index) => {
    const choiceRow = document.createElement('div');
    choiceRow.className = 'choice-row';

    const labelInput = document.createElement('textarea');
    labelInput.placeholder = translate('inspector.choices.labelPlaceholder');
    labelInput.value = choice.label || '';
    labelInput.rows = 2;
    labelInput.dataset.focusKey = `choice-label-${scene.id}-${index}`;
    attachComposedValueListener(labelInput, (value) => {
      actions.onUpdateChoice?.(scene.id, index, { label: value });
    });
    choiceRow.appendChild(labelInput);

    const cueCardField = document.createElement('label');
    cueCardField.className = 'field';
    const cueCardLabel = document.createElement('span');
    cueCardLabel.textContent = translate('inspector.choices.cueCardLabel');
    cueCardField.appendChild(cueCardLabel);

    const cueCardInput = document.createElement('textarea');
    cueCardInput.placeholder = translate('inspector.choices.cueCardPlaceholder');
    cueCardInput.value = choice.cueCardText || '';
    cueCardInput.rows = 3;
    cueCardInput.dataset.focusKey = `choice-cue-card-${scene.id}-${index}`;
    attachComposedValueListener(cueCardInput, (value) => {
      actions.onUpdateChoice?.(scene.id, index, { cueCardText: value });
    });
    cueCardField.appendChild(cueCardInput);
    choiceRow.appendChild(cueCardField);

    const select = document.createElement('select');
    select.dataset.focusKey = `choice-target-${scene.id}-${index}`;
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = translate('inspector.choices.destinationPlaceholder');
    select.appendChild(noneOption);
    project.scenes.forEach((target) => {
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.id;
      select.appendChild(option);
    });
    select.value = choice.nextSceneId || '';
    select.addEventListener('change', () => {
      const value = select.value || null;
      actions.onUpdateChoice?.(scene.id, index, { nextSceneId: value });
    });
    choiceRow.appendChild(select);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = translate('inspector.choices.remove');
    removeBtn.addEventListener('click', () => actions.onRemoveChoice?.(scene.id, index));
    choiceRow.appendChild(removeBtn);

    choiceSection.appendChild(choiceRow);
  });

  const addChoiceBtn = document.createElement('button');
  addChoiceBtn.type = 'button';
  addChoiceBtn.textContent = translate('inspector.choices.add');
  addChoiceBtn.addEventListener('click', () => actions.onAddChoice?.(scene.id, createChoice()));
  addChoiceBtn.disabled = scene.choices.length >= 3 || scene.type === SceneType.END;
  choiceSection.appendChild(addChoiceBtn);

  if (scene.type !== SceneType.END) {
    const autoNextField = document.createElement('label');
    autoNextField.className = 'field';
    const autoNextLabel = document.createElement('span');
    autoNextLabel.textContent = translate('inspector.choices.autoAdvanceLabel');
    autoNextField.appendChild(autoNextLabel);

    const autoNextSelect = document.createElement('select');
    autoNextSelect.dataset.focusKey = `auto-next-${scene.id}`;

    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = translate('inspector.choices.autoAdvanceNone');
    autoNextSelect.appendChild(noneOption);

    project.scenes.forEach(target => {
      if (target.id === scene.id) return;
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.id;
      autoNextSelect.appendChild(option);
    });

    const hasChoices = scene.choices.length > 0;
    const validSelection = scene.autoNextSceneId && project.scenes.some(target => target.id === scene.autoNextSceneId)
      ? scene.autoNextSceneId
      : '';
    autoNextSelect.value = validSelection || '';
    if (hasChoices) {
      autoNextSelect.value = '';
      autoNextSelect.disabled = true;
    }

    autoNextSelect.addEventListener('change', () => {
      const value = autoNextSelect.value || null;
      actions.onSetAutoNext?.(scene.id, value);
    });

    autoNextField.appendChild(autoNextSelect);

    if (hasChoices) {
      const helper = document.createElement('p');
      helper.className = 'hint';
      helper.textContent = translate('inspector.choices.autoAdvanceHelper');
      autoNextField.appendChild(helper);
    }

    choiceSection.appendChild(autoNextField);
  }
  hostEl.appendChild(choiceSection);

}

export function renderValidation(result, host, options = {}) {
  const { showEmptyState = true } = options;
  host.innerHTML = '';
  if (!result) return;
  const { errors = [], warnings = [] } = result;
  if (!errors.length && !warnings.length) {
    if (showEmptyState) {
      const ok = document.createElement('p');
      ok.className = 'validation-ok';
      ok.textContent = translate('inspector.validationOk');
      host.appendChild(ok);
    }
    return;
  }

  if (errors.length) {
    const list = document.createElement('ul');
    list.className = 'validation-errors';
    errors.forEach(err => {
      const li = document.createElement('li');
      li.textContent = err;
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  if (warnings.length) {
    const list = document.createElement('ul');
    list.className = 'validation-warnings';
    warnings.forEach(msg => {
      const li = document.createElement('li');
      li.textContent = msg;
      list.appendChild(li);
    });
    host.appendChild(list);
  }
}
