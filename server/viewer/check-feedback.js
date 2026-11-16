import { t as translate } from '../app/i18n/index.js';
import { coerceAnswerValueByInputType, getBooleanAnswerLabel } from './worksheet-values.js';

export function getCheckRevealMessage({ status, learnerAnswerText, correctAnswerText }, t = translate) {
  const normalizedLearnerAnswer = typeof learnerAnswerText === 'string'
    ? learnerAnswerText.trim()
    : '';
  const learnerClause = normalizedLearnerAnswer.length > 0
    ? t('viewer.check.reveal.yourAnswer', { answer: normalizedLearnerAnswer })
    : t('viewer.check.reveal.noAnswer');

  if (status === 'correct') {
    return t('viewer.check.reveal.correctAnswer', { answer: correctAnswerText });
  }

  if (status === 'ungraded_missing_or_invalid_key' || status === 'ungraded_missing_key') {
    return learnerClause;
  }

  return t('viewer.check.reveal.incorrectWithCorrectAnswer', {
    learnerClause,
    answer: correctAnswerText,
  });
}

// Render an already computed result. The caller decides whether feedback is
// available and owns checking, answer state, card placement and lifecycle.
export function createCheckFeedback({ responseConfig, learnerAnswer, checkStatus, t = translate }) {
  const inputType = responseConfig?.inputType || 'text';
  const isCorrect = checkStatus === 'correct';
  const isIncorrect = checkStatus === 'incorrect';
  const isUngradedMissingOrInvalidKey = checkStatus === 'ungraded_missing_or_invalid_key'
    || checkStatus === 'ungraded_missing_key';
  const correctAnswer = responseConfig?.correctAnswer;
  const formatCorrectAnswer = () => {
    if (inputType === 'multiple_choice') {
      if (responseConfig?.selectionMode === 'multi') {
        return Array.isArray(correctAnswer) ? correctAnswer.map((value) => String(value)).join(', ') : '';
      }
      return String(correctAnswer ?? '');
    }
    if (inputType === 'boolean') {
      return getBooleanAnswerLabel(coerceAnswerValueByInputType('boolean', correctAnswer) === true, t);
    }
    if (inputType === 'number') {
      return String(correctAnswer ?? '');
    }
    return '';
  };

  const formatLearnerAnswer = () => {
    if (inputType === 'multiple_choice') {
      if (responseConfig?.selectionMode === 'multi') {
        return Array.isArray(learnerAnswer) ? learnerAnswer.map((value) => String(value)).join(', ') : '';
      }
      return String(learnerAnswer ?? '');
    }
    if (inputType === 'boolean') {
      const normalized = coerceAnswerValueByInputType('boolean', learnerAnswer);
      if (normalized === true) return getBooleanAnswerLabel(true, t);
      if (normalized === false) return getBooleanAnswerLabel(false, t);
      return '';
    }
    if (inputType === 'number') {
      return learnerAnswer === '' || learnerAnswer === null || learnerAnswer === undefined
        ? ''
        : String(learnerAnswer);
    }
    return '';
  };

  const checkBanner = document.createElement('div');
  checkBanner.className = `viewer-check-banner ${isCorrect ? 'is-correct' : isIncorrect ? 'is-incorrect' : 'is-ungraded'}`;
  const checkIcon = document.createElement('span');
  checkIcon.className = 'viewer-check-banner__icon';
  checkIcon.textContent = isCorrect ? '✓' : isIncorrect ? '✕' : '•';
  const checkBody = document.createElement('div');
  checkBody.className = 'viewer-check-banner__body';
  const checkTitle = document.createElement('p');
  checkTitle.className = 'viewer-check-banner__title';
  checkTitle.textContent = isCorrect
    ? t('viewer.check.correct')
    : isIncorrect
      ? t('viewer.check.incorrect')
      : t('viewer.check.notGraded');
  const checkDetail = document.createElement('p');
  checkDetail.className = 'viewer-check-banner__detail';
  checkDetail.textContent = isCorrect
    ? t('viewer.check.greatWork')
    : isIncorrect
      ? t('viewer.check.notQuite')
      : t('viewer.check.missingAnswerKey');
  checkBody.append(checkTitle, checkDetail);
  checkBanner.append(checkIcon, checkBody);

  const checkReveal = document.createElement('p');
  checkReveal.className = 'viewer-check-reveal muted';
  checkReveal.textContent = getCheckRevealMessage({
    status: checkStatus,
    learnerAnswerText: formatLearnerAnswer(),
    correctAnswerText: isUngradedMissingOrInvalidKey ? '' : formatCorrectAnswer(),
  }, t);
  const cardClassName = isCorrect ? 'question-card--checked-correct'
    : isIncorrect ? 'question-card--checked-incorrect' : null;
  return { checkBanner, checkReveal, cardClassName };
}
