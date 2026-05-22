import { BubbleMode, MAX_SPEECH_BUBBLE_ANCHORS } from '../model.js';
import { translate } from '../i18n.js';

export function renderSpeechBubbleEditorSection(scene, actions) {
  const speechBubble = scene.speechBubble || { enabled: false, anchors: [] };
  const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];
  const speechSection = document.createElement('section');
  speechSection.className = 'rps-inspector-section speech-bubble-editor';

  const header = document.createElement('div');
  header.className = 'rps-inspector-section__header';
  const icon = document.createElement('span');
  icon.className = 'rps-editor-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8 8 0 0 1-8 8H7l-4 3v-6.2A8 8 0 1 1 21 11.5Z"></path></svg>';
  const heading = document.createElement('h4');
  heading.textContent = translate('inspector.speechBubble.title');
  header.append(icon, heading);
  speechSection.appendChild(header);

  const body = document.createElement('div');
  body.className = 'rps-inspector-section__body speech-bubble-editor__body';

  const speechToggle = document.createElement('label');
  speechToggle.className = 'field speech-bubble-editor__toggle';
  const speechToggleText = document.createElement('span');
  speechToggleText.textContent = translate('inspector.speechBubble.enableLabel');
  speechToggle.appendChild(speechToggleText);
  const speechCheckbox = document.createElement('input');
  speechCheckbox.type = 'checkbox';
  speechCheckbox.checked = speechBubble.enabled === true;
  speechCheckbox.addEventListener('change', () => {
    actions.onToggleSpeechBubble?.(scene.id, speechCheckbox.checked);
  });
  speechToggle.appendChild(speechCheckbox);
  body.appendChild(speechToggle);

  if (speechBubble.enabled) {
    const helper = document.createElement('p');
    helper.className = 'hint';
    helper.textContent = translate('inspector.speechBubble.scenePreviewHint');
    body.appendChild(helper);

    const count = document.createElement('p');
    count.className = 'hint';
    count.textContent = translate('inspector.speechBubble.anchorCount', {
      count: anchors.length,
      max: MAX_SPEECH_BUBBLE_ANCHORS,
    });
    body.appendChild(count);

    if (anchors.length) {
      const anchorList = document.createElement('ul');
      anchorList.className = 'speech-bubble-anchor-list';
      anchors.forEach((anchor) => {
        const usage = scene.dialogue.filter(line => (
          line.bubble?.mode === BubbleMode.ANCHOR && line.bubble.anchorId === anchor.id
        )).length;
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'speech-bubble-anchor-list__label';
        label.textContent = translate('inspector.speechBubble.anchorUsage', {
          label: anchor.label || anchor.id,
          count: usage,
        });
        item.appendChild(label);
        const itemActions = document.createElement('div');
        itemActions.className = 'speech-bubble-anchor-list__actions';
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'rps-editor-action rps-editor-action--neutral';
        selectButton.textContent = actions.isSpeechBubbleAnchorSelected?.(anchor.id)
          ? translate('inspector.speechBubble.selectedAnchor')
          : translate('inspector.speechBubble.moveAnchor');
        selectButton.addEventListener('click', () => actions.onSelectSpeechBubbleAnchor?.(scene.id, anchor.id));
        itemActions.appendChild(selectButton);
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'rps-editor-action rps-editor-action--danger';
        deleteButton.textContent = translate('inspector.speechBubble.deleteAnchor');
        deleteButton.addEventListener('click', () => actions.onDeleteSpeechBubbleAnchor?.(scene.id, anchor.id));
        itemActions.appendChild(deleteButton);
        item.appendChild(itemActions);
        anchorList.appendChild(item);
      });
      body.appendChild(anchorList);
    }
  }

  speechSection.appendChild(body);
  return speechSection;
}

export function renderDialogueBubbleControls({ scene, line, index, anchors, actions }) {
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

  return bubbleControls;
}
