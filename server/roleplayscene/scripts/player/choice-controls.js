import { SceneType } from '../model.js';
import { translate } from '../i18n.js';

function createCueCardIcon() {
  const svg = document.createElementNS
    ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    : document.createElement('svg');
  if (svg.classList?.add) {
    svg.classList.add('player-choice-cue-icon', 'theater-icon');
  } else if (typeof svg.className === 'string') {
    svg.className = 'player-choice-cue-icon theater-icon';
  } else {
    svg.setAttribute('class', 'player-choice-cue-icon theater-icon');
  }
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS
    ? document.createElementNS('http://www.w3.org/2000/svg', 'path')
    : document.createElement('path');
  path.setAttribute('d', 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.8c.8.6 1.3 1.4 1.5 2.2h5c.2-.8.7-1.6 1.5-2.2A7 7 0 0 0 12 2Z');
  svg.appendChild(path);

  return svg;
}

export function renderPlayerChoices({
  host,
  project,
  scene,
  onChoice,
  openCueCard,
  beforeChoice = null,
}) {
  const choiceBox = document.createElement('div');
  choiceBox.className = 'player-choices';

  if (scene.type === SceneType.END) {
    const endMessage = document.createElement('p');
    endMessage.className = 'the-end';
    endMessage.textContent = translate('player.choices.endMessage');
    choiceBox.appendChild(endMessage);
    host.appendChild(choiceBox);
    return choiceBox;
  }

  const sceneChoices = scene.choices || [];
  const autoNextId = scene.autoNextSceneId ?? null;
  const autoNextValid = Boolean(autoNextId)
    && project.scenes.some(s => s.id === autoNextId);

  if (!sceneChoices.length) {
    if (autoNextId) {
      const continueButton = document.createElement('button');
      continueButton.type = 'button';
      continueButton.textContent = translate('player.choices.continue');
      continueButton.disabled = !autoNextValid;
      if (!autoNextValid) {
        continueButton.title = translate('player.choices.autoNextMissing');
      }
      continueButton.addEventListener('click', () => {
        beforeChoice?.();
        if (autoNextValid && autoNextId) {
          onChoice?.(autoNextId);
        }
      });
      choiceBox.appendChild(continueButton);
    } else {
      const noChoices = document.createElement('p');
      noChoices.className = 'empty';
      noChoices.textContent = translate('player.choices.noneAvailable');
      choiceBox.appendChild(noChoices);
    }
  }

  sceneChoices.forEach(choice => {
    const cueCardText = typeof choice.cueCardText === 'string'
      ? choice.cueCardText.trim()
      : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'player-choice-button';

    const choiceLabel = choice.label || translate('player.choices.continue');
    const labelText = document.createElement('span');
    labelText.className = 'player-choice-label';
    labelText.textContent = choiceLabel;

    button.appendChild(labelText);

    button.disabled = !choice.nextSceneId || !project.scenes.some(s => s.id === choice.nextSceneId);
    button.addEventListener('click', () => {
      beforeChoice?.();
      if (choice.nextSceneId) {
        onChoice?.(choice.nextSceneId);
      }
    });

    if (!cueCardText) {
      choiceBox.appendChild(button);
      return;
    }

    const row = document.createElement('div');
    row.className = 'player-choice-row';

    const cueTrigger = document.createElement('button');
    cueTrigger.type = 'button';
    cueTrigger.className = 'player-choice-cue-trigger';
    cueTrigger.setAttribute('aria-expanded', 'false');
    cueTrigger.setAttribute('aria-label', translate('player.choices.cueCardTriggerLabel', { label: choiceLabel }));
    cueTrigger.appendChild(createCueCardIcon());

    cueTrigger.addEventListener('click', () => openCueCard?.(cueTrigger, cueCardText, { choiceLabel }));

    row.appendChild(cueTrigger);
    row.appendChild(button);
    choiceBox.appendChild(row);
  });

  host.appendChild(choiceBox);
  return choiceBox;
}
