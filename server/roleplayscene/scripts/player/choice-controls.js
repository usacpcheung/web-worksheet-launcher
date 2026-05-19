import { SceneType } from '../model.js';
import { translate } from '../i18n.js';

export function renderPlayerChoices({
  host,
  project,
  scene,
  onChoice,
  openCueCard,
  beforeChoice = null,
  cueIconText = '?',
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

    const cueIcon = document.createElement('span');
    cueIcon.className = 'player-choice-cue-icon';
    cueIcon.textContent = cueIconText;
    cueIcon.setAttribute('aria-hidden', 'true');
    cueTrigger.appendChild(cueIcon);

    cueTrigger.addEventListener('click', () => openCueCard?.(cueTrigger, cueCardText));

    row.appendChild(cueTrigger);
    row.appendChild(button);
    choiceBox.appendChild(row);
  });

  host.appendChild(choiceBox);
  return choiceBox;
}
