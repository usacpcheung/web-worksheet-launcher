import { isFillInBlanks, blankAnswered, checkBlanks } from '../app/fill-in-blanks.js';
import { coerceAnswerValueByInputType, isAnsweredValue } from './worksheet-values.js';

// Calculate results only. The session owns when checking is permitted, result
// storage and notifications; presentation owns how those results are displayed.
export function normalizeMultiSelectValues(rawValue) {
  const normalizedValues = Array.isArray(rawValue)
    ? rawValue.map((value) => String(value))
    : [];
  return Array.from(new Set(normalizedValues));
}

export function areMultiSelectValuesEqual(learnerValues, correctValues) {
  const normalizedLearnerValues = normalizeMultiSelectValues(learnerValues);
  const normalizedCorrectValues = normalizeMultiSelectValues(correctValues);

  if (normalizedLearnerValues.length !== normalizedCorrectValues.length) {
    return false;
  }

  const correctSet = new Set(normalizedCorrectValues);
  return normalizedLearnerValues.every((value) => correctSet.has(value));
}

function hasValidCorrectAnswer(responseConfig) {
  if (isFillInBlanks(responseConfig)) return checkBlanks(responseConfig, {}).total > 0;
  if (!responseConfig || !Object.hasOwn(responseConfig, 'correctAnswer')) {
    return false;
  }

  const { inputType, selectionMode, correctAnswer } = responseConfig;

  if (inputType === 'boolean') {
    return typeof correctAnswer === 'boolean';
  }

  if (inputType === 'number') {
    const numericValue = Number(correctAnswer);
    return Number.isFinite(numericValue);
  }

  if (inputType === 'multiple_choice') {
    if (selectionMode === 'multi') {
      if (!Array.isArray(correctAnswer)) {
        return false;
      }
      return correctAnswer.length > 0 && correctAnswer.every((value) => typeof value === 'string');
    }

    return typeof correctAnswer === 'string';
  }

  // Other input types are not gradeable here.
  return false;
}

function isGradeableQuestionBlock(block) {
  if (block?.kind !== 'question') {
    return false;
  }

  const responseConfig = block?.responseConfig;
  return hasValidCorrectAnswer(responseConfig);
}

function isSupportedCheckInputType(inputType) {
  return inputType === 'multiple_choice' || inputType === 'boolean' || inputType === 'number' || inputType === 'fill_in_blanks';
}

export function isSupportedCheckQuestionBlock(block) {
  if (block?.kind !== 'question') {
    return false;
  }

  return isSupportedCheckInputType(block?.responseConfig?.inputType);
}

export function hasGradeableQuestions(viewerPayload) {
  return Array.isArray(viewerPayload?.blocks) && viewerPayload.blocks.some((block) => isGradeableQuestionBlock(block));
}

export function computeCheckResult(viewerPayload, answers) {
  const checkableQuestions = Array.isArray(viewerPayload?.blocks)
    ? viewerPayload.blocks.filter((block) => isSupportedCheckQuestionBlock(block))
    : [];

  const byBlockId = {};
  const statusByBlockId = {};
  const blanksByBlockId = {};
  let correctCount = 0;
  let totalQuestions = 0;

  checkableQuestions.forEach((block) => {
    const inputType = block?.responseConfig?.inputType || 'text';
    if (inputType === 'fill_in_blanks') {
      const result = checkBlanks(block.responseConfig, answers?.[block.blockId]?.value);
      blanksByBlockId[block.blockId] = result;
      if (result.total) { byBlockId[block.blockId] = result.correct === result.total; statusByBlockId[block.blockId] = result.correct === result.total ? 'correct' : 'incorrect'; totalQuestions += result.total; correctCount += result.correct; }
      else statusByBlockId[block.blockId] = 'teacher_review';
      return;
    }
    const hasValidAnswerKey = hasValidCorrectAnswer(block?.responseConfig);
    if (!hasValidAnswerKey) {
      statusByBlockId[block.blockId] = 'ungraded_missing_or_invalid_key';
      return;
    }

    const selectionMode = block?.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single';
    const learnerValue = answers?.[block.blockId]?.value;
    const correctAnswer = block?.responseConfig?.correctAnswer;

    let isCorrect = false;

    if (inputType === 'multiple_choice') {
      if (selectionMode === 'multi') {
        isCorrect = areMultiSelectValuesEqual(learnerValue, correctAnswer);
      } else {
        isCorrect = String(learnerValue ?? '') === String(correctAnswer ?? '');
      }
    } else if (inputType === 'boolean') {
      isCorrect = coerceAnswerValueByInputType('boolean', learnerValue) === coerceAnswerValueByInputType('boolean', correctAnswer);
    } else if (inputType === 'number') {
      // Treat empty/absent learner values as unanswered rather than as 0.
      if (learnerValue !== '' && learnerValue !== null && learnerValue !== undefined) {
        const learnerNumber = Number(learnerValue);
        const correctNumber = Number(correctAnswer);
        isCorrect =
          Number.isFinite(learnerNumber) &&
          Number.isFinite(correctNumber) &&
          learnerNumber === correctNumber;
      }
    }

    byBlockId[block.blockId] = isCorrect;
    statusByBlockId[block.blockId] = isCorrect ? 'correct' : 'incorrect';
    totalQuestions += 1;
    if (isCorrect) {
      correctCount += 1;
    }
  });

  return {
    byBlockId,
    statusByBlockId,
    ...(Object.keys(blanksByBlockId).length ? { blanksByBlockId } : {}),
    correctCount,
    totalQuestions,
  };
}

export function computeAnswerSummary(viewerPayload, answers) {
  const questions = (viewerPayload?.blocks || []).filter((block) => block.kind === 'question');

  const answered = questions.filter((block) => {
    const value = answers?.[block.blockId]?.value;
    return isFillInBlanks(block.responseConfig) ? blankAnswered(block.responseConfig, value) : isAnsweredValue(value);
  }).length;
  return { answered, total: questions.length };
}

