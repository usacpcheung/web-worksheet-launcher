import { BubbleMode, MAX_SPEECH_BUBBLE_ANCHORS } from '../model.js';
import { translate } from '../i18n.js';

function getClampedPercent(value) {
  return Math.max(0, Math.min(1, Number(value))) * 100;
}

export function renderSpeechBubbleEditorSection(scene, actions) {
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
