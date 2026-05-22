import { MAX_DIALOGUE_LINES, SceneType, createChoice } from '../model.js';
import { translate } from '../i18n.js';
import { renderDialogueBubbleControls, renderSpeechBubbleEditorSection } from './speech-bubble-inspector.js';
import {
  ROLEPLAYSCENE_T2A_PRESETS,
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  getRolePlaySceneT2APresetFromAudioName,
  getRolePlaySceneT2ATextState,
} from '../t2a-presets.js';

const ADD_SPEAKER_VALUE = '__add-speaker__';

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

const ICONS = {
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="8.5" cy="10.5" r="1.5"></circle><path d="M21 15l-4.5-4.5L7 20"></path>',
  audio: '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
  dialogue: '<path d="M21 11.5a8 8 0 0 1-8 8H7l-4 3v-6.2A8 8 0 1 1 21 11.5Z"></path>',
  list: '<path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>',
};

function createEditorIcon(name) {
  const icon = document.createElement('span');
  icon.className = 'rps-editor-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.info}</svg>`;
  return icon;
}

function createInspectorSection(title, iconName, className = '') {
  const section = document.createElement('section');
  section.className = `rps-inspector-section ${className}`.trim();

  const header = document.createElement('div');
  header.className = 'rps-inspector-section__header';
  header.appendChild(createEditorIcon(iconName));

  const heading = document.createElement('h4');
  heading.textContent = title;
  header.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'rps-inspector-section__body';

  section.append(header, body);
  return { section, body };
}

function createField(labelText, control, className = '') {
  const field = document.createElement('label');
  field.className = `field ${className}`.trim();
  const label = document.createElement('span');
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function applyButtonClass(button, variant = 'neutral') {
  button.classList.add('rps-editor-action', `rps-editor-action--${variant}`);
  return button;
}

function createActionButton(label, variant = 'neutral') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return applyButtonClass(button, variant);
}

function createMediaRow({ label, status, input, inputLabel, actions = [] }) {
  const row = document.createElement('div');
  row.className = 'rps-media-row';

  const meta = document.createElement('div');
  meta.className = 'rps-media-row__meta';
  const title = document.createElement('span');
  title.className = 'rps-media-row__title';
  title.textContent = label;
  const statusText = document.createElement('span');
  statusText.className = 'rps-media-row__status';
  statusText.textContent = status;
  meta.append(title, statusText);

  const actionGroup = document.createElement('div');
  actionGroup.className = 'rps-media-row__actions';
  if (input) {
    input.classList.add('rps-media-row__file');
    const trigger = createActionButton(inputLabel || label);
    trigger.addEventListener('click', () => input.click());
    actionGroup.append(trigger, input);
  }
  actions.forEach(action => actionGroup.appendChild(action));

  row.append(meta, actionGroup);
  return row;
}

function createLightRow(titleText, className = '') {
  const row = document.createElement('div');
  row.className = `rps-light-row ${className}`.trim();

  const header = document.createElement('div');
  header.className = 'rps-light-row__header';
  const title = document.createElement('h5');
  title.textContent = titleText;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'rps-light-row__actions';

  const body = document.createElement('div');
  body.className = 'rps-light-row__body';

  row.append(header, body);
  return { row, header, body, actions };
}

export function renderInspector(hostEl, project, scene, actions) {
  hostEl.innerHTML = '';
  hostEl.classList.add('inspector');

  const projectTitleInput = document.createElement('input');
  projectTitleInput.type = 'text';
  projectTitleInput.value = project.meta?.title ?? '';
  projectTitleInput.placeholder = translate('inspector.projectTitlePlaceholder');
  projectTitleInput.maxLength = 120;
  projectTitleInput.dataset.focusKey = 'project-title';
  attachComposedValueListener(projectTitleInput, (value) => {
    actions.onUpdateProjectTitle?.(value);
  });
  const projectTitleField = createField(translate('inspector.projectTitleLabel'), projectTitleInput);
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

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'inspector-actions__preview';
  applyButtonClass(previewBtn, 'preview');
  previewBtn.textContent = translate('inspector.header.previewCurrentScene');
  previewBtn.addEventListener('click', () => actions.onPreviewCurrentScene?.(scene.id));

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  applyButtonClass(addBtn);
  addBtn.textContent = translate('inspector.header.addScene');
  addBtn.addEventListener('click', () => actions.onAddScene?.());
  addBtn.disabled = project.scenes.length >= 20;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  applyButtonClass(deleteBtn, 'danger');
  deleteBtn.textContent = translate('inspector.header.deleteScene');
  deleteBtn.addEventListener('click', () => actions.onDeleteScene?.(scene.id));
  deleteBtn.disabled = !actions.canDeleteScene;

  controls.append(previewBtn, addBtn, deleteBtn);
  header.appendChild(controls);
  hostEl.appendChild(header);

  const basics = createInspectorSection(translate('inspector.sections.sceneBasics'), 'info', 'rps-inspector-section--basics');
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
  basics.body.appendChild(createField(translate('inspector.sceneTypeLabel'), typeSelect));
  hostEl.appendChild(basics.section);

  const mediaSection = createInspectorSection(translate('inspector.sections.sceneMedia'), 'image', 'rps-inspector-section--media');
  const imageStatus = scene.image
    ? translate('inspector.image.attached', { name: scene.image.name || translate('inspector.image.fallbackName') })
    : translate('inspector.image.empty');
  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    actions.onSetSceneImage?.(scene.id, file || null);
  });
  const imageActions = [];
  if (scene.image) {
    const removeImageBtn = createActionButton(translate('inspector.image.remove'), 'danger');
    removeImageBtn.textContent = translate('inspector.image.remove');
    removeImageBtn.addEventListener('click', () => actions.onSetSceneImage?.(scene.id, null));
    imageActions.push(removeImageBtn);
  }
  mediaSection.body.appendChild(createMediaRow({
    label: translate('inspector.image.label'),
    status: imageStatus,
    input: imageInput,
    inputLabel: scene.image ? translate('inspector.mediaActions.replace') : translate('inspector.mediaActions.choose'),
    actions: imageActions,
  }));

  const speechBubble = scene.speechBubble || { enabled: false, anchors: [] };
  const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];

  const backgroundStatus = scene.backgroundAudio
    ? translate('inspector.background.attached', {
        name: scene.backgroundAudio.name || translate('inspector.background.fallbackName'),
      })
    : translate('inspector.background.empty');
  const backgroundInput = document.createElement('input');
  backgroundInput.type = 'file';
  backgroundInput.accept = 'audio/*';
  backgroundInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    actions.onSetSceneBackgroundAudio?.(scene.id, file || null);
  });
  const backgroundActions = [];
  if (scene.backgroundAudio) {
    const removeBgButton = createActionButton(translate('inspector.background.remove'), 'danger');
    removeBgButton.textContent = translate('inspector.background.remove');
    removeBgButton.addEventListener('click', () => actions.onSetSceneBackgroundAudio?.(scene.id, null));
    backgroundActions.push(removeBgButton);
  }
  mediaSection.body.appendChild(createMediaRow({
    label: translate('inspector.background.label'),
    status: backgroundStatus,
    input: backgroundInput,
    inputLabel: scene.backgroundAudio ? translate('inspector.mediaActions.replace') : translate('inspector.mediaActions.choose'),
    actions: backgroundActions,
  }));
  hostEl.appendChild(mediaSection.section);
  hostEl.appendChild(renderSpeechBubbleEditorSection(scene, actions));

  const dialogue = createInspectorSection(translate('inspector.dialogue.title'), 'dialogue', 'dialogue-editor');
  const speakers = Array.isArray(project.speakers) ? project.speakers : [];

  scene.dialogue.forEach((line, index) => {
    const lineParts = createLightRow(translate('inspector.dialogue.lineLabel', { index: index + 1 }), 'dialogue-line');
    const lineField = lineParts.row;

    const speakerSelect = document.createElement('select');
    speakerSelect.dataset.focusKey = `dialogue-speaker-${scene.id}-${index}`;
    const noSpeakerOption = document.createElement('option');
    noSpeakerOption.value = '';
    noSpeakerOption.textContent = translate('inspector.dialogue.speakerNone');
    speakerSelect.appendChild(noSpeakerOption);
    speakers.forEach((speaker) => {
      const option = document.createElement('option');
      option.value = speaker.id;
      option.textContent = speaker.name;
      speakerSelect.appendChild(option);
    });
    if (line.speakerId && !speakers.some(speaker => speaker.id === line.speakerId)) {
      const missingOption = document.createElement('option');
      missingOption.value = line.speakerId;
      missingOption.textContent = translate('inspector.dialogue.speakerMissing');
      speakerSelect.appendChild(missingOption);
    }
    const addSpeakerOption = document.createElement('option');
    addSpeakerOption.value = ADD_SPEAKER_VALUE;
    addSpeakerOption.textContent = translate('inspector.dialogue.speakerAdd');
    speakerSelect.appendChild(addSpeakerOption);
    speakerSelect.value = line.speakerId || '';
    speakerSelect.addEventListener('change', () => {
      if (speakerSelect.value === ADD_SPEAKER_VALUE) {
        actions.onStartCreateSpeakerForDialogue?.(scene.id, index);
        return;
      }
      actions.onUpdateDialogueSpeaker?.(scene.id, index, speakerSelect.value || null);
    });
    lineParts.body.appendChild(createField(translate('inspector.dialogue.speakerLabel'), speakerSelect, 'dialogue-speaker-field'));

    const speakerDraft = actions.getSpeakerDraftForDialogue?.(scene.id, index);
    if (speakerDraft != null) {
      const speakerAddRow = document.createElement('div');
      speakerAddRow.className = 'dialogue-speaker-add';
      const speakerNameInput = document.createElement('input');
      speakerNameInput.type = 'text';
      speakerNameInput.value = speakerDraft;
      speakerNameInput.maxLength = 60;
      speakerNameInput.placeholder = translate('inspector.dialogue.speakerNamePlaceholder');
      speakerNameInput.dataset.focusKey = `dialogue-speaker-new-${scene.id}-${index}`;
      attachComposedValueListener(speakerNameInput, (value) => {
        actions.onUpdateSpeakerDraftForDialogue?.(scene.id, index, value);
      });
      speakerAddRow.appendChild(createField(translate('inspector.dialogue.speakerNameLabel'), speakerNameInput));

      const speakerAddActions = document.createElement('div');
      speakerAddActions.className = 'dialogue-speaker-add__actions';
      const addSpeakerBtn = createActionButton(translate('inspector.dialogue.speakerAddConfirm'), 'neutral');
      addSpeakerBtn.disabled = !String(speakerDraft || '').trim();
      addSpeakerBtn.addEventListener('click', () => actions.onCommitSpeakerForDialogue?.(scene.id, index));
      const cancelSpeakerBtn = createActionButton(translate('inspector.dialogue.speakerAddCancel'), 'neutral');
      cancelSpeakerBtn.addEventListener('click', () => actions.onCancelCreateSpeakerForDialogue?.(scene.id, index));
      speakerAddActions.append(addSpeakerBtn, cancelSpeakerBtn);
      speakerAddRow.appendChild(speakerAddActions);
      lineParts.body.appendChild(speakerAddRow);
    }

    const textarea = document.createElement('textarea');
    textarea.value = line.text || '';
    textarea.rows = 2;
    textarea.dataset.focusKey = `dialogue-${scene.id}-${index}`;
    attachComposedValueListener(textarea, (value) => {
      actions.onUpdateDialogueText?.(scene.id, index, value);
    });
    lineParts.body.appendChild(createField(translate('inspector.dialogue.textLabel'), textarea));

    const audioInput = document.createElement('input');
    audioInput.type = 'file';
    audioInput.accept = 'audio/mpeg,audio/mp3';
    audioInput.dataset.focusKey = `dialogue-audio-${scene.id}-${index}`;
    audioInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      actions.onSetDialogueAudio?.(scene.id, index, file || null);
    });
    const audioActions = [];
    let audioStatus = translate('inspector.dialogue.audioLabel');
    if (line.audio) {
      const audioName = line.audio.name || '';
      audioStatus = translate('inspector.dialogue.audioAttached', { name: audioName });
      const t2aPreset = getRolePlaySceneT2APresetFromAudioName(audioName);
      if (t2aPreset) {
        const presetBadge = document.createElement('span');
        presetBadge.className = 'audio-info__badge';
        presetBadge.textContent = translate('inspector.dialogue.t2aPresetBadge', {
          preset: translate(t2aPreset.labelKey),
        });
        audioActions.push(presetBadge);
      }
      if (line.audio.objectUrl) {
        const isPreviewingAudio = actions.isDialogueAudioPreviewing?.(scene.id, index) === true;
        const previewAudio = createActionButton(
          isPreviewingAudio
            ? translate('inspector.dialogue.stopAudioPreview')
            : translate('inspector.dialogue.playAudioPreview'),
          'neutral',
        );
        previewAudio.textContent = isPreviewingAudio
          ? translate('inspector.dialogue.stopAudioPreview')
          : translate('inspector.dialogue.playAudioPreview');
        previewAudio.addEventListener('click', () => actions.onPreviewDialogueAudio?.(scene.id, index));
        audioActions.push(previewAudio);
      }
      const removeAudio = createActionButton(translate('inspector.dialogue.removeAudio'), 'danger');
      removeAudio.textContent = translate('inspector.dialogue.removeAudio');
      removeAudio.addEventListener('click', () => actions.onSetDialogueAudio?.(scene.id, index, null));
      audioActions.push(removeAudio);
    }
    lineParts.body.appendChild(createMediaRow({
      label: translate('inspector.dialogue.audioLabel'),
      status: audioStatus,
      input: audioInput,
      inputLabel: line.audio ? translate('inspector.mediaActions.replace') : translate('inspector.mediaActions.choose'),
      actions: audioActions,
    }));

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
    applyButtonClass(generateAudio);
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
    lineParts.body.append(t2aControls, t2aHint);

    if (speechBubble.enabled) {
      lineParts.body.appendChild(renderDialogueBubbleControls({ scene, line, index, anchors, actions }));
    }

    const removeLineBtn = createActionButton(translate('inspector.dialogue.deleteLine'), 'danger');
    removeLineBtn.textContent = translate('inspector.dialogue.deleteLine');
    removeLineBtn.addEventListener('click', () => actions.onRemoveDialogue?.(scene.id, index));
    removeLineBtn.disabled = scene.dialogue.length <= 1;
    lineParts.actions.appendChild(removeLineBtn);
    lineParts.header.appendChild(lineParts.actions);

    dialogue.body.appendChild(lineField);
  });

  const addLineBtn = createActionButton(translate('inspector.dialogue.addLine'));
  addLineBtn.textContent = translate('inspector.dialogue.addLine');
  addLineBtn.addEventListener('click', () => actions.onAddDialogue?.(scene.id));
  addLineBtn.disabled = scene.dialogue.length >= MAX_DIALOGUE_LINES;
  dialogue.body.appendChild(addLineBtn);
  hostEl.appendChild(dialogue.section);

  const choices = createInspectorSection(translate('inspector.choices.title'), 'list', 'choice-editor');

  if (!scene.choices.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'empty';
    emptyMessage.textContent = translate('inspector.choices.empty');
    choices.body.appendChild(emptyMessage);
  }

  scene.choices.forEach((choice, index) => {
    const choiceParts = createLightRow(translate('inspector.choices.rowLabel', { index: index + 1 }), 'choice-row');
    const choiceRow = choiceParts.row;

    const labelInput = document.createElement('textarea');
    labelInput.placeholder = translate('inspector.choices.labelPlaceholder');
    labelInput.value = choice.label || '';
    labelInput.rows = 2;
    labelInput.dataset.focusKey = `choice-label-${scene.id}-${index}`;
    attachComposedValueListener(labelInput, (value) => {
      actions.onUpdateChoice?.(scene.id, index, { label: value });
    });
    choiceParts.body.appendChild(createField(translate('inspector.choices.textLabel'), labelInput));

    const cueCardInput = document.createElement('textarea');
    cueCardInput.placeholder = translate('inspector.choices.cueCardPlaceholder');
    cueCardInput.value = choice.cueCardText || '';
    cueCardInput.rows = 3;
    cueCardInput.dataset.focusKey = `choice-cue-card-${scene.id}-${index}`;
    attachComposedValueListener(cueCardInput, (value) => {
      actions.onUpdateChoice?.(scene.id, index, { cueCardText: value });
    });
    choiceParts.body.appendChild(createField(translate('inspector.choices.cueCardLabel'), cueCardInput));

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
    choiceParts.body.appendChild(createField(translate('inspector.choices.destinationPlaceholder'), select));

    const removeBtn = createActionButton(translate('inspector.choices.remove'), 'danger');
    removeBtn.textContent = translate('inspector.choices.remove');
    removeBtn.addEventListener('click', () => actions.onRemoveChoice?.(scene.id, index));
    choiceParts.actions.appendChild(removeBtn);
    choiceParts.header.appendChild(choiceParts.actions);

    choices.body.appendChild(choiceRow);
  });

  const addChoiceBtn = createActionButton(translate('inspector.choices.add'));
  addChoiceBtn.classList.add('choice-add-action');
  addChoiceBtn.textContent = translate('inspector.choices.add');
  addChoiceBtn.addEventListener('click', () => actions.onAddChoice?.(scene.id, createChoice()));
  addChoiceBtn.disabled = scene.choices.length >= 3 || scene.type === SceneType.END;
  choices.body.appendChild(addChoiceBtn);

  if (scene.type !== SceneType.END) {
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

    const autoNextField = createField(translate('inspector.choices.autoAdvanceLabel'), autoNextSelect);
    autoNextField.classList.add('choice-auto-next');

    if (hasChoices) {
      const helper = document.createElement('p');
      helper.className = 'hint';
      helper.textContent = translate('inspector.choices.autoAdvanceHelper');
      autoNextField.appendChild(helper);
    }

    choices.body.appendChild(autoNextField);
  }
  hostEl.appendChild(choices.section);

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
