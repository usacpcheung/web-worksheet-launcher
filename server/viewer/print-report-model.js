import { t, getLocale } from '../app/i18n/index.js';
import { feedbackPrintHtml } from './feedback-ui.js';
import { cloneFeedback } from '../app/worksheet-feedback.js';
import { isFillInBlanks } from '../app/fill-in-blanks.js';
import { imageAnswerRefs } from '../app/image-response.js';
import { optionImageRef, imageDescription } from '../app/option-images.js';
import { copyWorksheetText } from '../app/worksheet-text.js';
import { getChoicePrefix } from './choice-button-group.js';
import { firstNonBlankString, normalizePromptMediaRefs, coerceAnswerValueByInputType, getBooleanAnswerLabel, deterministicShuffle } from './worksheet-values.js';

// Report preparation reads local assets but never saves or changes the attempt.
// Locale is resolved at call time, just as it is for the live viewer.
export const VIEWER_PRINT_DEFAULT_SCHOOL_NAMES = Object.freeze({
  en: 'Hong Kong Red Cross Hospital Schools',
  'zh-Hant': '香港紅十字會醫院學校',
});
function formatTimestampForReportHeader(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    return t('common.values.notRecorded');
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function getDefaultViewerPrintSchoolName(locale = getLocale()) {
  const fallback = VIEWER_PRINT_DEFAULT_SCHOOL_NAMES[locale] || VIEWER_PRINT_DEFAULT_SCHOOL_NAMES.en;
  const translated = t('viewer.print.defaultSchoolName');
  return translated === 'viewer.print.defaultSchoolName' ? fallback : translated;
}

export function normalizeViewerPrintSchoolName(value) {
  return firstNonBlankString(value, getDefaultViewerPrintSchoolName());
}

function getQuestionBlocksInOrder(viewerPayload) {
  return Array.isArray(viewerPayload?.blocks)
    ? viewerPayload.blocks
      .filter((block) => block?.kind === 'question')
      .sort((a, b) => a.position - b.position)
    : [];
}

function getQuestionImageRefForPrint(block) {
  const promptMediaRefs = normalizePromptMediaRefs(block?.prompt?.mediaRefs);
  return promptMediaRefs.find((ref) => ref.usage === 'question_image') || null;
}

function getOptionDisplayTextByValue(block, rawValue) {
  const options = Array.isArray(block?.responseConfig?.options)
    ? block.responseConfig.options
    : [];
  const normalizedValue = String(rawValue ?? '');
  const matchedIndex = options.findIndex((option) => String(option?.value ?? option?.label ?? '') === normalizedValue);
  if (matchedIndex < 0) {
    return normalizedValue;
  }
  const label = String(options[matchedIndex]?.label ?? options[matchedIndex]?.value ?? normalizedValue) || t('optionImages.imageAlt', { option: getChoicePrefix(matchedIndex) });
  return `${getChoicePrefix(matchedIndex)} ${label}`;
}

function formatAnswerValueForPrint(block, rawValue) {
  const inputType = block?.responseConfig?.inputType || 'text';
  if (inputType === 'multiple_choice') {
    const selectionMode = block?.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single';
    if (selectionMode === 'multi') {
      const normalizedValues = Array.isArray(rawValue)
        ? rawValue.map((value) => String(value))
        : [];
      if (normalizedValues.length === 0) {
        return t('viewer.print.notAnswered');
      }
      const options = Array.isArray(block?.responseConfig?.options)
        ? block.responseConfig.options
        : [];
      const optionOrder = options.map((option) => String(option?.value ?? option?.label ?? ''));
      const orderedValues = optionOrder.filter((value) => normalizedValues.includes(value));
      const remainingValues = normalizedValues.filter((value) => !orderedValues.includes(value));
      return [...orderedValues, ...remainingValues]
        .map((value) => getOptionDisplayTextByValue(block, value))
        .join('\n');
    }

    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
      return t('viewer.print.notAnswered');
    }
    return getOptionDisplayTextByValue(block, rawValue);
  }

  if (inputType === 'boolean') {
    const normalized = coerceAnswerValueByInputType('boolean', rawValue);
    if (normalized === true) return getBooleanAnswerLabel(true, t);
    if (normalized === false) return getBooleanAnswerLabel(false, t);
    return t('viewer.print.notAnswered');
  }

  if (inputType === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      return t('viewer.print.notAnswered');
    }
    return String(rawValue);
  }

  const textValue = String(rawValue ?? '');
  return textValue.trim() ? textValue : t('viewer.print.notAnswered');
}

function formatCorrectAnswerForPrint(block) {
  const inputType = block?.responseConfig?.inputType || 'text';
  const correctAnswer = block?.responseConfig?.correctAnswer;

  if (inputType === 'multiple_choice') {
    const selectionMode = block?.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single';
    if (selectionMode === 'multi') {
      const normalizedValues = Array.isArray(correctAnswer)
        ? correctAnswer.map((value) => String(value))
        : [];
      return normalizedValues.length > 0
        ? normalizedValues.map((value) => getOptionDisplayTextByValue(block, value)).join('\n')
        : '';
    }
    return typeof correctAnswer === 'string' && correctAnswer.trim()
      ? getOptionDisplayTextByValue(block, correctAnswer)
      : '';
  }

  if (inputType === 'boolean') {
    const normalized = coerceAnswerValueByInputType('boolean', correctAnswer);
    if (normalized === true) return getBooleanAnswerLabel(true, t);
    if (normalized === false) return getBooleanAnswerLabel(false, t);
    return '';
  }

  if (inputType === 'number') {
    return correctAnswer === '' || correctAnswer === null || correctAnswer === undefined
      ? ''
      : String(correctAnswer);
  }

  return '';
}

function buildPrintQuestionResult(block, checkResult) {
  if (!checkResult) {
    return null;
  }

  const status = checkResult?.statusByBlockId?.[block?.blockId] || null;
  if (!status) {
    return null;
  }

  if (status === 'correct') {
    return {
      status,
      label: t('viewer.check.correct'),
      detail: '',
    };
  }

  if (status === 'incorrect') {
    const correctAnswerText = formatCorrectAnswerForPrint(block);
    return {
      status,
      label: t('viewer.check.incorrect'),
      detail: correctAnswerText ? t('viewer.check.reveal.correctAnswer', { answer: correctAnswerText }) : '',
    };
  }

  return {
    status,
    label: t('viewer.check.notGraded'),
    detail: '',
  };
}

export function classifyPrintQuestionLayout(question) {
  const promptText = String(question?.promptText || '');
  const answerText = String(question?.answerText || '');
  const resultDetail = String(question?.result?.detail || '');
  const hasImage = question?.image?.status === 'ready';
  const combinedText = [promptText, answerText, resultDetail].join('\n');
  const lineCount = combinedText.split(/\r?\n/).length;
  const answerLineBreaks = (answerText.match(/\n/g) || []).length;
  const estimatedBlockChars = promptText.length + answerText.length + resultDetail.length;
  const hasVisibleResultDetail = resultDetail.trim().length > 0;

  if (
    estimatedBlockChars > 900
    || lineCount > 18
    || answerText.length > 450
    || answerLineBreaks >= 3
  ) {
    return 'flow';
  }

  if (
    promptText.length > 240
    || answerText.length > 260
    || lineCount > 10
    || (hasImage && estimatedBlockChars > 260)
    || (hasVisibleResultDetail && estimatedBlockChars > 320)
  ) {
    return 'keep-head';
  }

  return 'keep-all';
}

function classifyPrintSectionBreakMode({
  text = '',
  hasImage = false,
  lineThreshold = 28,
  charThreshold = 1200,
} = {}) {
  const normalizedText = String(text || '');
  const lineCount = normalizedText.split(/\r?\n/).length;
  const effectiveCharThreshold = hasImage ? Math.max(700, charThreshold - 220) : charThreshold;
  if (normalizedText.length > effectiveCharThreshold || lineCount > lineThreshold) {
    return 'flow';
  }
  return 'keep';
}


function encodeBytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const PRINT_IMAGE_MIME_TYPE_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

function normalizePrintImageMimeType(mimeType, fallback = 'image/png') {
  if (typeof mimeType !== 'string') {
    return fallback;
  }
  const normalized = mimeType.trim().toLowerCase().split(';')[0];
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (!PRINT_IMAGE_MIME_TYPE_ALLOWLIST.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function binaryToDataUrl(binary, mimeType = 'image/png') {
  if (!(binary instanceof Uint8Array) || binary.byteLength === 0) {
    return null;
  }
  const safeMimeType = normalizePrintImageMimeType(mimeType, 'image/png');
  const encoded = encodeBytesToBase64(binary);
  return `data:${safeMimeType};base64,${encoded}`;
}

async function resolvePrintQuestionImage(questionImageRef, storage) {
  if (!questionImageRef?.assetId || !storage?.localAssets?.get) {
    return null;
  }

  try {
    const asset = await storage.localAssets.get(questionImageRef.assetId);
    if (!(asset?.binary instanceof Uint8Array) || asset.binary.byteLength === 0) {
      return {
        status: 'missing',
        message: t('viewer.print.questionImageUnavailable'),
      };
    }
    const mimeType = normalizePrintImageMimeType(asset?.metadata?.mimeType, 'image/png');
    const src = binaryToDataUrl(asset.binary, mimeType);
    if (!src) {
      return {
        status: 'missing',
        message: t('viewer.print.questionImageUnavailable'),
      };
    }
    return {
      status: 'ready',
      src,
      alt: t('viewer.print.questionImageAlt'),
    };
  } catch {
    return {
      status: 'missing',
      message: t('viewer.print.questionImageUnavailable'),
    };
  }
}

export async function buildWorksheetPrintReportModel({
  viewerPayload,
  answers = {},
  feedback = {},
  studentName = '',
  submittedAt = '',
  schoolName = getDefaultViewerPrintSchoolName(),
  subject = '',
  checkResult = null,
  storage = null,
  localAttemptId = 'attempt',
} = {}) {
  const feedbackHtml = feedbackPrintHtml(cloneFeedback(viewerPayload?.feedback), structuredClone(feedback), t);
  const orderedQuestions = getQuestionBlocksInOrder(viewerPayload);
  const checkedSummary = checkResult
    ? t('viewer.print.checkedSummary', {
      correct: checkResult.correctCount,
      total: checkResult.totalQuestions,
    })
    : '';

  const questions = await Promise.all(orderedQuestions.map(async (block, index) => {
    const learnerValue = answers?.[block.blockId]?.value;
    const config = block.responseConfig || {};
    const options = Array.isArray(config.options) ? config.options : [];
    const displayedOptions = config.shuffleOptions
      ? deterministicShuffle(options, `${localAttemptId || 'attempt'}:${block.blockId}`)
      : options;
    // Resolve printed letters, selected choices and marking details in the same
    // order the learner saw, without changing the stored payload or answers.
    const displayBlock = { ...block, responseConfig: { ...config, options: displayedOptions } };
    const selectedValues = config.selectionMode === 'multi'
      ? (Array.isArray(learnerValue) ? learnerValue.map(String) : [])
      : learnerValue == null ? [] : [String(learnerValue)];
    const choices = config.inputType === 'multiple_choice'
      ? await Promise.all(displayedOptions.map(async (option, optionIndex) => ({
        label: String(option.label ?? option.value ?? ''),
        prefix: getChoicePrefix(optionIndex),
        image: optionImageRef(option) ? await resolvePrintQuestionImage(optionImageRef(option), storage) : null,
        imageAlt: imageDescription(option.imageDescription) || t('optionImages.imageAlt', { option: getChoicePrefix(optionIndex) }),
        selected: selectedValues.includes(String(option.value ?? option.label ?? '')),
      })))
      : config.inputType === 'boolean'
        ? [true, false].map(value => ({ label: getBooleanAnswerLabel(value, t), booleanValue: String(value),
          selected: coerceAnswerValueByInputType('boolean', learnerValue) === value }))
        : [];
    const questionImage = await resolvePrintQuestionImage(getQuestionImageRefForPrint(block), storage);
    const flowChoices = choices.some(choice => choice.image) || choices.length > 8 || choices.some(choice => choice.label.length > 500)
      || choices.reduce((length, choice) => length + choice.label.length, 0) > 850;
    const answerImages = config.inputType === 'image_response' ? await Promise.all(imageAnswerRefs(learnerValue || [], config.maxImages).map(ref=>resolvePrintQuestionImage(ref,storage))) : [];
    const question = {
      answerImages,
      kind: 'question',
      blockId: block.blockId,
      questionNumber: index + 1,
      inputType: config.inputType || 'text',
      choices,
      blankConfig: isFillInBlanks(config) ? config : null,
      blankAnswers: isFillInBlanks(config) ? learnerValue : null,
      blanksChecked: Boolean(checkResult),
      promptText: String(block?.prompt?.text || ''),
      promptFormat: block?.prompt?.format || 'plain_text',
      promptField: copyWorksheetText(block.prompt),
      answerText: config.inputType === 'image_response' ? (answerImages.length ? '' : t('viewer.print.notAnswered')) : formatAnswerValueForPrint(displayBlock, learnerValue),
      result: buildPrintQuestionResult(displayBlock, checkResult),
      image: questionImage,
    };
    const promptSectionMode = classifyPrintSectionBreakMode({
      text: question.promptText,
      hasImage: question.image?.status === 'ready',
      lineThreshold: 20,
      charThreshold: 850,
    });
    const answerSectionMode = classifyPrintSectionBreakMode({
      text: question.answerText,
      lineThreshold: 30,
      charThreshold: 1400,
    });
    const checkedAnswerSectionMode = question.result
      ? classifyPrintSectionBreakMode({
        text: [question.result.label, question.result.detail || ''].join('\n'),
        lineThreshold: 22,
        charThreshold: 1000,
      })
      : null;
    return {
      ...question,
      layoutMode: (isFillInBlanks(config) || flowChoices || answerImages.length) ? 'flow' : classifyPrintQuestionLayout(question),
      sectionBreakModes: {
        prompt: promptSectionMode,
        answer: (isFillInBlanks(config) || flowChoices || answerImages.length) ? 'flow' : answerSectionMode,
        checkedAnswer: checkedAnswerSectionMode,
      },
    };
  }));

  const questionById = new Map(questions.map(question => [question.blockId, question]));
  let readingNumber = 0;
  const sections = [...(viewerPayload?.blocks || [])]
    .sort((a, b) => a.position - b.position)
    .flatMap(block => block.kind === 'content' ? [{
      kind: 'content', blockId: block.blockId,
      label: t('viewer.navigation.reading', { number: ++readingNumber }),
      content: block.content || { text: '' },
    }] : questionById.has(block.blockId) ? [questionById.get(block.blockId)] : []);

  return {
    schoolName: normalizeViewerPrintSchoolName(schoolName),
    title: String(viewerPayload?.title || t('viewer.print.worksheetFallbackTitle')),
    subject: firstNonBlankString(subject, viewerPayload?.subject, viewerPayload?.metadata?.subject),
    studentName: String(studentName || '').trim(),
    submittedAtLabel: formatTimestampForReportHeader(submittedAt),
    checkedSummary,
    feedbackHtml,
    questions,
    sections,
    locale: getLocale(),
  };
}

