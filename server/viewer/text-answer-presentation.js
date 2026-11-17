import { isLongText } from '../app/text-answer.js';
import { t as translate } from '../app/i18n/index.js';

export function computeTextLengthFeedback(rawValue, maxLength, warningThresholdRatio = 0.1, t = translate) {
  const current = String(rawValue ?? '').length;
  const max = Number.isFinite(maxLength) && maxLength > 0 ? Math.trunc(maxLength) : 0;
  const remaining = max - current;
  const warningThreshold = Math.ceil(max * warningThresholdRatio);
  if (max === 0) {
    return {
      current,
      max,
      remaining,
      state: 'normal',
      statusText: '',
      counterText: `${current}/${max}`,
    };
  }
  if (remaining < 0) {
    const absOver = Math.abs(remaining);
    return {
      current,
      max,
      remaining,
      state: 'over',
      statusText: t('textAnswer.over', { count: absOver, max }),
      counterText: `${current}/${max}`,
    };
  }
  if (remaining <= warningThreshold) {
    return {
      current,
      max,
      remaining,
      state: 'warning',
      statusText: t(remaining === 1 ? 'textAnswer.remainingOne' : 'textAnswer.remaining', { count: remaining }),
      counterText: `${current}/${max}`,
    };
  }
  return {
    current,
    max,
    remaining,
    state: 'normal',
    statusText: '',
    counterText: `${current}/${max}`,
  };
}

export function updateTextCounterUI(counterNode, statusNode, feedback) {
  if (!counterNode || !feedback) return;
  counterNode.textContent = feedback.counterText;
  counterNode.className = `text-counter text-counter--${feedback.state}`;
  if (statusNode) {
    statusNode.textContent = feedback.statusText;
    statusNode.className = `text-counter-status text-counter-status--${feedback.state}`;
  }
}

// Presentation only: the shell binds input, owns answer/cache/Undo mutations,
// creates voice controls and computes action eligibility.
export function createTextAnswerControl(config) {
  const singleLine = !isLongText(config) && config?.displayMode === 'single_line';
  const control = document.createElement(singleLine ? 'input' : 'textarea');
  if (singleLine) control.type = 'text';
  else control.rows = isLongText(config) ? 12 : 5;
  return control;
}

export function createTextFeedbackNodes(controlId) {
  const counter = document.createElement('p');
  counter.className = 'text-counter';
  counter.id = `${controlId}-counter`;
  const status = document.createElement('p');
  status.className = 'text-counter-status';
  status.id = `${controlId}-status`;
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('role', 'status');
  return { counter, status };
}

export function createTextAnswerPresentation({
  control, counter, status, helper, label, voiceElements, t, createIcon,
  sharedStatusId, signal, onRewrite, onUndo,
}) {
  const footer = document.createElement('div');
  footer.className = 'question-card__text-footer';
  const actionsRow = document.createElement('div');
  actionsRow.className = 'question-card__text-actions-row';
  let rewriteButton = null;
  let undoButton = null;
  let rewriteHint = null;
  if (voiceElements) {
    const rewriteRow = document.createElement('div');
    rewriteRow.className = 'question-card__rewrite-row';
    const rewriteMessages = document.createElement('div');
    rewriteMessages.className = 'question-card__rewrite-messages';
    rewriteButton = document.createElement('button');
    rewriteButton.type = 'button';
    rewriteButton.className = 'question-card__rewrite-btn icon-nav-btn';
    rewriteButton.textContent = t('viewer.rewrite.action');
    rewriteButton.setAttribute('aria-describedby', sharedStatusId);
    rewriteButton.addEventListener('click', () => {
      if (!rewriteButton.disabled) onRewrite();
    }, { signal });
    undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'question-card__undo-btn icon-nav-btn';
    undoButton.textContent = t('viewer.rewrite.undo');
    undoButton.addEventListener('click', () => {
      if (!undoButton.disabled) onUndo();
    }, { signal });
    rewriteHint = document.createElement('p');
    rewriteHint.className = 'question-card__rewrite-hint';
    for (const [button, icon] of [[voiceElements.add, 'voice'], [rewriteButton, 'rewrite'], [undoButton, 'undo']]) {
      const caption = document.createElement('span');
      caption.className = 'viewer-action-label';
      caption.textContent = button.textContent;
      button.replaceChildren(caption);
      button.insertAdjacentHTML('afterbegin', createIcon(icon));
    }
    // Use the existing voice nodes, keeping their listeners and recovery state.
    rewriteRow.append(voiceElements.add, rewriteButton, undoButton);
    rewriteMessages.append(status, rewriteHint);
    actionsRow.append(counter, rewriteRow);
    footer.append(actionsRow, rewriteMessages, voiceElements.root);
  } else {
    actionsRow.append(counter);
    footer.append(actionsRow, status);
  }
  // Presentation-only clone: never bind answer handlers or persist its value.
  const reviewStatus = control.cloneNode(false);
  reviewStatus.id = `${control.id}-review`;
  reviewStatus.className = 'question-card__review-status question-card__submitted-text';
  reviewStatus.value = t('viewer.review.notAnswered');
  reviewStatus.readOnly = true;
  reviewStatus.disabled = false;
  reviewStatus.removeAttribute('aria-describedby');
  reviewStatus.hidden = true;
  return {
    control, counter, status, footer, helper, reviewStatus, label,
    rewriteButton, undoButton, rewriteHint,
    editingDescription: control.getAttribute('aria-describedby'),
  };
}

export function updateTextAnswerActions(presentation, {
  counterFeedback, rewriteLabel, canRewrite, undoDisabled, hintText, hintWarning,
}) {
  const { counter, status, rewriteButton, undoButton, rewriteHint } = presentation;
  updateTextCounterUI(counter, status, counterFeedback);
  if (rewriteButton) {
    rewriteButton.querySelector('.viewer-action-label').textContent = rewriteLabel;
    rewriteButton.disabled = !canRewrite;
  }
  if (undoButton) undoButton.disabled = undoDisabled;
  if (rewriteHint) {
    rewriteHint.classList.toggle('is-warning', hintWarning);
    rewriteHint.textContent = hintText;
  }
}

// Call AFTER the voice UI update, which also sets control.readOnly.
// Otherwise it could overwrite the submitted-answer lock.
export function updateTextAnswerReview(presentation, { card, completed, hasAnswer }) {
  const { control, footer, helper, reviewStatus, label, editingDescription } = presentation;
  card.classList.toggle('question-card--text-review', completed);
  footer.hidden = completed;
  helper.hidden = completed;
  reviewStatus.hidden = !completed || hasAnswer;
  control.hidden = completed && !hasAnswer;
  label.htmlFor = control.hidden ? reviewStatus.id : control.id;
  control.classList.toggle('question-card__submitted-text', completed);
  control.disabled = false;
  if (completed) {
    control.readOnly = true;
    control.removeAttribute('aria-describedby');
  } else if (editingDescription) {
    control.setAttribute('aria-describedby', editingDescription);
  }
}
