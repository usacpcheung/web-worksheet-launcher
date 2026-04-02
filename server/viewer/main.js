import { viewerStorage } from './storage/index.js';
import { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';
import { validateViewerPayloadSchema } from '../app/contracts/validators.js';
import { normalizeNumberRules, validateNumberInputFormat } from '../app/contracts/number-input-validator.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';

const app = document.getElementById('app');
const bottomBarRoot = document.getElementById('viewer-bottom-bar-root');

const AUTOSAVE_MS = 1000;
const RESUME_FLAG_KEY = 'viewer:lastSession';
const LEGACY_STUDENT_NAME_KEY = 'viewer:studentName';
const DEFAULT_LEARNER_ID = 'local_learner';
const TEXT_WARNING_THRESHOLD_RATIO = 0.1;
let activeViewerShellAbortController = null;


const VIEWER_BOOT_ERROR_CODES = Object.freeze({
  NO_CONTENT_SOURCE: 'NO_CONTENT_SOURCE',
  LOCAL_ATTEMPT_RESUME_FAILED: 'LOCAL_ATTEMPT_RESUME_FAILED',
  VIEWER_PAYLOAD_PARSE_FAILED: 'VIEWER_PAYLOAD_PARSE_FAILED',
  SNAPSHOT_PARSE_FAILED: 'SNAPSHOT_PARSE_FAILED',
  LOCAL_DRAFT_NOT_FOUND: 'LOCAL_DRAFT_NOT_FOUND',
  IMPORTED_WORKSHEET_NOT_FOUND: 'IMPORTED_WORKSHEET_NOT_FOUND',
  INVALID_VIEWER_PAYLOAD: 'INVALID_VIEWER_PAYLOAD',
  VIEWER_BOOT_FAILED: 'VIEWER_BOOT_FAILED',
});

class ViewerBootError extends Error {
  constructor(code, options = {}) {
    super(options.technicalMessage || options.message || code);
    this.name = 'ViewerBootError';
    this.code = code;
    this.userMessage = options.userMessage || 'Viewer could not be started.';
    this.technicalMessage = options.technicalMessage || this.message;
    this.recoveryActions = Array.isArray(options.recoveryActions)
      ? options.recoveryActions
      : [
        'Reopen the viewer from a valid worksheet link.',
        'Import worksheet JSON again from the start panel.',
        'Go back and launch viewer again.',
      ];
    this.cause = options.cause;
  }
}

function asViewerBootError(error) {
  if (error instanceof ViewerBootError) {
    return error;
  }
  return new ViewerBootError(VIEWER_BOOT_ERROR_CODES.VIEWER_BOOT_FAILED, {
    userMessage: 'Viewer failed to initialize due to an unexpected error.',
    technicalMessage: error?.message || 'Unknown boot error',
    cause: error,
  });
}

function parseLaunchParamJson(params, key, parseErrorCode) {
  if (!params.has(key)) {
    return { present: false, value: null };
  }
  const rawValue = params.get(key);
  if (!rawValue) {
    throw new ViewerBootError(parseErrorCode, {
      userMessage: `The ${key} launch parameter could not be read.`,
      technicalMessage: `${key} is present but empty or malformed.`,
    });
  }

  const parsed = maybeParseEncodedJson(rawValue);
  if (!parsed) {
    throw new ViewerBootError(parseErrorCode, {
      userMessage: `The ${key} launch parameter is invalid or corrupted.`,
      technicalMessage: `${key} could not be parsed as JSON or base64url JSON.`,
    });
  }

  return { present: true, value: parsed };
}

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix = 'local') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function decodeBase64Url(input) {
  if (!input) return null;

  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function parseJsonInput(rawValue) {
  if (!rawValue) return null;

  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function maybeParseEncodedJson(rawValue) {
  if (!rawValue) return null;

  const direct = parseJsonInput(rawValue);
  if (direct) {
    return direct;
  }

  try {
    return parseJsonInput(decodeBase64Url(rawValue));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshotLikeWorksheet(value) {
  return (
    isRecord(value)
    && Array.isArray(value.blocks)
    && typeof value.worksheetId === 'string'
    && typeof value.snapshotId === 'string'
    && Number.isInteger(value.schemaVersion)
    && typeof value.publishedAt === 'string'
  );
}

function normalizeViewerBlock(block, index) {
  const safeBlock = isRecord(block) ? block : {};
  const normalizedKind = safeBlock.kind === 'question' || safeBlock.kind === 'content'
    ? safeBlock.kind
    : 'content';

  const base = {
    blockId: safeBlock.blockId || createLocalId('blk'),
    kind: normalizedKind,
    position: Number.isInteger(safeBlock.position) ? safeBlock.position : index,
  };

  if (base.kind === 'question') {
    const responseConfigSource = isRecord(safeBlock.responseConfig) ? safeBlock.responseConfig : {};
    const legacyInputType = responseConfigSource.inputType || 'text';
    const inputType = legacyInputType === 'plain_text' || legacyInputType === 'short_text'
      ? 'text'
      : legacyInputType === 'single_choice'
        ? 'multiple_choice'
        : legacyInputType;
    const normalizedResponseConfig = {
      inputType,
    };

    if (inputType === 'text') {
      normalizedResponseConfig.maxLength = Number.isFinite(responseConfigSource.maxLength)
        ? responseConfigSource.maxLength
        : 200;
      normalizedResponseConfig.displayMode = responseConfigSource.displayMode === 'single_line'
        ? 'single_line'
        : 'multi_line';
    }

    if (inputType === 'number') {
      normalizedResponseConfig.numberRules = normalizeNumberRules(responseConfigSource.numberRules);
      if (Number.isFinite(responseConfigSource.min)) {
        normalizedResponseConfig.min = Number(responseConfigSource.min);
      }
      if (Number.isFinite(responseConfigSource.max)) {
        normalizedResponseConfig.max = Number(responseConfigSource.max);
      }
    }

    if (inputType === 'multiple_choice') {
      normalizedResponseConfig.selectionMode = legacyInputType === 'single_choice'
        ? 'single'
        : responseConfigSource.selectionMode === 'multi'
          ? 'multi'
          : 'single';
      normalizedResponseConfig.shuffleOptions = Boolean(responseConfigSource.shuffleOptions);
      normalizedResponseConfig.options = Array.isArray(responseConfigSource.options)
        ? responseConfigSource.options
          .filter((option) => option !== null && option !== undefined)
          .map((option) => {
            if (isRecord(option)) {
              const value = option.value ?? option.label ?? '';
              const label = option.label ?? option.value ?? '';
              return {
                value: String(value),
                label: String(label),
              };
            }

            const normalizedOption = String(option);
            return { value: normalizedOption, label: normalizedOption };
          })
        : [];
    }

    return {
      ...base,
      prompt: {
        text: String(safeBlock?.prompt?.text || ''),
        format: safeBlock?.prompt?.format || 'plain_text',
      },
      responseConfig: normalizedResponseConfig,
    };
  }

  return {
    ...base,
    content: {
      text: String(safeBlock?.content?.text || ''),
      format: safeBlock?.content?.format || 'plain_text',
    },
  };
}

function normalizeViewerPayload(payload, fallbackLabel = 'Local worksheet') {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Viewer payload must be an object.');
  }

  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.map((block, index) => normalizeViewerBlock(block, index))
    : [];

  if (blocks.length === 0) {
    throw new Error('Viewer payload must include at least one normalized block.');
  }

  return {
    worksheetId: payload.worksheetId || createLocalId('ws'),
    snapshotId: payload.snapshotId || createLocalId('snapshot_local'),
    snapshotVersion: Number.isInteger(payload.snapshotVersion) ? payload.snapshotVersion : 1,
    title: payload.title || fallbackLabel,
    blocks,
  };
}

function coerceAnswerValueByInputType(inputType, rawValue) {
  if (inputType === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : '';
  }
  if (inputType === 'boolean') {
    if (rawValue === true || rawValue === 'true') return true;
    if (rawValue === false || rawValue === 'false') return false;
    return null;
  }
  return String(rawValue ?? '');
}

function clampTextAnswer(rawValue, maxLength) {
  const value = String(rawValue ?? '');
  const max = Number.isFinite(maxLength) && maxLength > 0 ? Math.trunc(maxLength) : 0;
  if (max <= 0) return value;
  return value.slice(0, max);
}

function computeTextLengthFeedback(rawValue, maxLength, warningThresholdRatio = TEXT_WARNING_THRESHOLD_RATIO) {
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
      statusText: `Over by ${absOver} ${absOver === 1 ? 'character' : 'characters'}. On save, text will be truncated to ${max}.`,
      counterText: `${current}/${max}`,
    };
  }
  if (remaining <= warningThreshold) {
    return {
      current,
      max,
      remaining,
      state: 'warning',
      statusText: `${remaining} ${remaining === 1 ? 'character' : 'characters'} remaining.`,
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

function updateTextCounterUI(counterNode, statusNode, feedback) {
  if (!counterNode || !feedback) return;
  counterNode.textContent = feedback.counterText;
  counterNode.className = `text-counter text-counter--${feedback.state}`;
  if (statusNode) {
    statusNode.textContent = feedback.statusText;
    statusNode.className = `text-counter-status text-counter-status--${feedback.state}`;
  }
}

function getBooleanSelectionState(rawValue) {
  const normalized = coerceAnswerValueByInputType('boolean', rawValue);
  return {
    selectedValue: normalized,
    truePressed: normalized === true,
    falsePressed: normalized === false,
  };
}

function applyBooleanGroupState(groupNode, rawValue, isDisabled = false) {
  if (!groupNode) return;
  const state = getBooleanSelectionState(rawValue);
  Array.from(groupNode.querySelectorAll('button[data-boolean-value]')).forEach((button) => {
    const buttonValue = button.dataset.booleanValue;
    const isPressed = (buttonValue === 'true' && state.truePressed) || (buttonValue === 'false' && state.falsePressed);
    button.classList.toggle('is-selected', isPressed);
    button.setAttribute('aria-pressed', String(isPressed));
    button.disabled = isDisabled;
  });
}

function getChoicePrefix(index) {
  let label = '';
  let current = Number(index) + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return `${label}.`;
}

function applyChoiceButtonGroupState(groupNode, rawValue, selectionMode = 'single', isDisabled = false) {
  if (!groupNode) return;
  const isMulti = selectionMode === 'multi';
  const selectedSet = isMulti
    ? new Set(Array.isArray(rawValue) ? rawValue.map((value) => String(value)) : [])
    : new Set(rawValue === null || rawValue === undefined || rawValue === '' ? [] : [String(rawValue)]);
  const buttons = Array.from(groupNode.querySelectorAll('button[data-choice-value]'));
  let hasSelected = false;
  buttons.forEach((button) => {
    const choiceValue = String(button.dataset.choiceValue || '');
    const isSelected = selectedSet.has(choiceValue);
    if (isSelected) hasSelected = true;
    button.classList.toggle('is-selected', isSelected);
    if (isMulti) {
      button.setAttribute('aria-pressed', String(isSelected));
    } else {
      button.setAttribute('aria-checked', String(isSelected));
    }
    button.disabled = isDisabled;
  });
  if (!isMulti) {
    buttons.forEach((button, index) => {
      const choiceValue = String(button.dataset.choiceValue || '');
      const isSelected = selectedSet.has(choiceValue);
      button.tabIndex = hasSelected ? (isSelected ? 0 : -1) : (index === 0 ? 0 : -1);
    });
  }
}

function computeNextChoiceValue({ selectionMode = 'single', currentValue, clickedValue, validValues = [] }) {
  const clicked = String(clickedValue ?? '');
  const allowedValues = new Set(validValues.map((value) => String(value)));
  if (!allowedValues.has(clicked)) {
    return selectionMode === 'multi' ? [] : '';
  }

  if (selectionMode === 'multi') {
    const normalizedCurrent = Array.isArray(currentValue)
      ? currentValue.map((value) => String(value)).filter((value, idx, allValues) => allValues.indexOf(value) === idx)
      : [];
    const nextSet = new Set(normalizedCurrent);
    if (nextSet.has(clicked)) {
      nextSet.delete(clicked);
    } else {
      nextSet.add(clicked);
    }
    // Return selected values in validValues (option) order to keep answers deterministic
    return validValues
      .map((value) => String(value))
      .filter((value) => nextSet.has(value));
  }

  const normalizedCurrent = String(currentValue ?? '');
  return normalizedCurrent === clicked ? '' : clicked;
}

function createChoiceButtonGroup({
  block,
  labelId,
  controlId,
  optionSource,
  session,
  updateSummary,
}) {
  const selectionMode = block.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single';
  const validValues = optionSource.map((option) => String(option.value ?? option.label ?? ''));
  const container = document.createElement('div');
  container.className = 'choice-button-group';
  container.setAttribute('aria-labelledby', labelId);
  if (selectionMode === 'single') {
    container.setAttribute('role', 'radiogroup');
  } else {
    container.setAttribute('role', 'group');
  }
  optionSource.forEach((opt, optionIndex) => {
    const value = String(opt.value ?? opt.label ?? '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-button-group__item';
    button.dataset.choiceValue = value;
    button.id = `${controlId}-${optionIndex}`;
    if (selectionMode === 'single') {
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.tabIndex = optionIndex === 0 ? 0 : -1;
    } else {
      button.setAttribute('aria-pressed', 'false');
    }

    const prefix = document.createElement('span');
    prefix.className = 'choice-button-group__prefix';
    prefix.textContent = getChoicePrefix(optionIndex);

    const labelText = document.createElement('span');
    labelText.className = 'choice-button-group__label';
    labelText.textContent = String(opt.label ?? opt.value ?? '');
    button.append(prefix, labelText);

    button.addEventListener('click', () => {
      const currentValue = session.state.answers?.[block.blockId]?.value;
      const nextValue = computeNextChoiceValue({
        selectionMode,
        currentValue,
        clickedValue: value,
        validValues,
      });
      session.setAnswer(block.blockId, nextValue);
      updateSummary();
    });
    container.appendChild(button);
  });

  if (selectionMode === 'single') {
    container.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
      const radioButtons = Array.from(container.querySelectorAll('button[data-choice-value]'));
      const currentIndex = radioButtons.indexOf(document.activeElement);
      if (currentIndex === -1) return;
      event.preventDefault();
      const isForward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const nextIndex = isForward
        ? (currentIndex + 1) % radioButtons.length
        : (currentIndex - 1 + radioButtons.length) % radioButtons.length;
      radioButtons.forEach((btn, idx) => {
        btn.tabIndex = idx === nextIndex ? 0 : -1;
      });
      radioButtons[nextIndex].focus();
    });
  }

  return container;
}

function coerceAnswerValueForQuestion(questionBlock, rawValue, options = {}) {
  const inputType = questionBlock?.responseConfig?.inputType || 'text';
  const responseConfig = isRecord(questionBlock?.responseConfig) ? questionBlock.responseConfig : {};
  const phase = options.phase || 'save';
  if (inputType === 'number') {
    // Already-normalized finite numbers (e.g. 1e-7) are returned directly to
    // avoid re-running string-based regex validation that rejects scientific
    // notation representations. Input validation is performed upstream by
    // getNumberInputErrorMessage before the normalized value is stored.
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return rawValue;
    }
    const validation = validateNumberInputFormat(rawValue, responseConfig.numberRules);
    if (!validation.ok) return '';
    return validation.normalizedValue;
  }
  if (inputType === 'multiple_choice') {
    const options = Array.isArray(responseConfig.options)
      ? responseConfig.options.map((opt) => String(opt?.value ?? opt?.label ?? ''))
      : [];
    if (responseConfig.selectionMode === 'multi') {
      const values = Array.isArray(rawValue) ? rawValue.map((v) => String(v)) : [];
      return values.filter((value, idx) => options.includes(value) && values.indexOf(value) === idx);
    }
    const single = String(rawValue ?? '');
    return options.includes(single) ? single : '';
  }
  if (inputType === 'text') {
    if (phase === 'edit') {
      return String(rawValue ?? '');
    }
    return clampTextAnswer(rawValue, responseConfig.maxLength);
  }
  return coerceAnswerValueByInputType(inputType, rawValue);
}

function mapDraftRecordToViewerPayload(draftRecord) {
  return normalizeViewerPayload(
    {
      worksheetId: draftRecord.localId,
      snapshotId: `${draftRecord.localId}:local-snapshot`,
      snapshotVersion: 1,
      title: draftRecord.title || 'Local draft worksheet',
      blocks: draftRecord.blocks || [],
    },
    'Local draft worksheet'
  );
}

function partitionBlocksForDisplay(blocks = []) {
  const ordered = [...blocks].sort((a, b) => a.position - b.position);
  return {
    contentBlocks: ordered.filter((block) => block.kind === 'content'),
    questionBlocks: ordered.filter((block) => block.kind === 'question'),
  };
}


function normalizeMultiSelectValues(rawValue) {
  const normalizedValues = Array.isArray(rawValue)
    ? rawValue.map((value) => String(value))
    : [];
  return Array.from(new Set(normalizedValues));
}

function areMultiSelectValuesEqual(learnerValues, correctValues) {
  const normalizedLearnerValues = normalizeMultiSelectValues(learnerValues);
  const normalizedCorrectValues = normalizeMultiSelectValues(correctValues);

  if (normalizedLearnerValues.length !== normalizedCorrectValues.length) {
    return false;
  }

  const correctSet = new Set(normalizedCorrectValues);
  return normalizedLearnerValues.every((value) => correctSet.has(value));
}

function hasValidCorrectAnswer(responseConfig) {
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
      return correctAnswer.every((value) => typeof value === 'string');
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

function hasGradeableQuestions(viewerPayload) {
  return Array.isArray(viewerPayload?.blocks) && viewerPayload.blocks.some((block) => isGradeableQuestionBlock(block));
}

function computeCheckResult(viewerPayload, answers) {
  const gradeableQuestions = Array.isArray(viewerPayload?.blocks)
    ? viewerPayload.blocks.filter((block) => isGradeableQuestionBlock(block))
    : [];

  const byBlockId = {};
  let correctCount = 0;

  gradeableQuestions.forEach((block) => {
    const inputType = block?.responseConfig?.inputType || 'text';
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
    if (isCorrect) {
      correctCount += 1;
    }
  });

  return {
    byBlockId,
    correctCount,
    totalQuestions: gradeableQuestions.length,
  };
}

function computeAnswerSummary(viewerPayload, answers) {
  const questions = (viewerPayload?.blocks || []).filter((block) => block.kind === 'question');

  function isAnsweredValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') {
      return value.trim() !== '';
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }

  const answered = questions.filter((block) => {
    const value = answers?.[block.blockId]?.value;
    return isAnsweredValue(value);
  }).length;
  return { answered, total: questions.length };
}

function pickAttemptStudentName(attemptRecord) {
  const direct = typeof attemptRecord?.studentName === 'string' ? attemptRecord.studentName.trim() : '';
  if (direct) return direct;
  const metadata = typeof attemptRecord?.metadata?.studentName === 'string'
    ? attemptRecord.metadata.studentName.trim()
    : '';
  if (metadata) return metadata;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return String(window.localStorage.getItem(LEGACY_STUDENT_NAME_KEY) || '').trim();
    }
  } catch {
    return '';
  }
  return '';
}

function overlayAnswersOnViewerPayload(viewerPayload, rawAnswers = {}) {
  const normalizedAnswers = {};
  const questionBlocks = Array.isArray(viewerPayload?.blocks)
    ? viewerPayload.blocks.filter((block) => block?.kind === 'question')
    : [];
  questionBlocks.forEach((questionBlock) => {
    const saved = rawAnswers?.[questionBlock.blockId];
    if (!saved) return;
    normalizedAnswers[questionBlock.blockId] = {
      ...saved,
      value: coerceAnswerValueForQuestion(questionBlock, saved?.value, { phase: 'save' }),
    };
  });
  return normalizedAnswers;
}

function computeResumeStartBlockIndex(viewerPayload, answers = {}, attemptRecord = {}) {
  const orderedBlocks = [...(viewerPayload?.blocks || [])].sort((a, b) => a.position - b.position);
  if (orderedBlocks.length === 0) return 0;
  if (attemptRecord?.lastActiveBlockId) {
    const byId = orderedBlocks.findIndex((block) => block.blockId === attemptRecord.lastActiveBlockId);
    if (byId >= 0) return byId;
  }
  if (Number.isInteger(attemptRecord?.lastActiveIndex)) {
    const idx = Math.max(0, Math.min(orderedBlocks.length - 1, attemptRecord.lastActiveIndex));
    return idx;
  }
  const firstUnanswered = orderedBlocks.findIndex((block) => {
    if (block.kind !== 'question') return false;
    const value = answers?.[block.blockId]?.value;
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
  return firstUnanswered >= 0 ? firstUnanswered : 0;
}

function getInputHelperText(inputType, responseConfig = {}) {
  if (inputType === 'text') return 'Text response.';
  if (inputType === 'number') {
    const constraints = [];
    if (Number.isFinite(responseConfig.min)) {
      constraints.push(`minimum ${Number(responseConfig.min)}`);
    }
    if (Number.isFinite(responseConfig.max)) {
      constraints.push(`maximum ${Number(responseConfig.max)}`);
    }
    const suffix = constraints.length > 0 ? ` Range: ${constraints.join(', ')}.` : '';
    return `Enter integer/decimal only (fractions like 2/3 are not supported).${suffix}`;
  }
  if (inputType === 'boolean') return 'Choose True / False.';
  if (inputType === 'multiple_choice') return 'Choose one or more options.';
  return 'Text response.';
}

function getNumberInputErrorMessage(rawValue, responseConfig = {}) {
  const trimmed = String(rawValue ?? '').trim();
  if (trimmed === '') {
    return { message: '', normalizedValue: '' };
  }

  const normalizedRules = normalizeNumberRules(responseConfig.numberRules);
  const formatValidation = validateNumberInputFormat(trimmed, {
    allowedKinds: ['integer', 'decimal'],
    allowSigned: true,
    decimalPlacesAllowed: null,
  });
  if (!formatValidation.ok) {
    const messageByCode = {
      fraction_not_allowed: 'Fractions are not supported (for example, 2/3).',
      invalid_syntax: 'Enter a valid integer or decimal number.',
    };
    return {
      message: messageByCode[formatValidation.errorCode] || 'Enter a valid integer or decimal number.',
      normalizedValue: '',
    };
  }

  const numericValue = formatValidation.normalizedValue;
  const min = Number.isFinite(responseConfig.min) ? Number(responseConfig.min) : null;
  const max = Number.isFinite(responseConfig.max) ? Number(responseConfig.max) : null;
  if (min !== null && numericValue < min) {
    return { message: `Value is below minimum (${min}).`, normalizedValue: '' };
  }
  if (max !== null && numericValue > max) {
    return { message: `Value is above maximum (${max}).`, normalizedValue: '' };
  }

  if (!normalizedRules.allowSigned && (/^[+-]/).test(trimmed)) {
    return { message: 'Signed values are not allowed for this question.', normalizedValue: '' };
  }

  const strictValidation = validateNumberInputFormat(trimmed, normalizedRules);
  if (!strictValidation.ok) {
    const messageByCode = {
      kind_not_allowed: 'Only the configured number format is allowed.',
      decimal_places_exceeded: 'Too many decimal places for this question.',
      sign_not_allowed: 'Signed values are not allowed for this question.',
      fraction_not_allowed: 'Fractions are not supported (for example, 2/3).',
      invalid_syntax: 'Enter a valid integer or decimal number.',
    };
    return { message: messageByCode[strictValidation.errorCode] || 'Invalid number format.', normalizedValue: '' };
  }

  return { message: '', normalizedValue: strictValidation.normalizedValue };
}

function ensureControlDescribedBy(control, describedById) {
  if (!control || !describedById) return;
  const existing = String(control.getAttribute('aria-describedby') || '').trim();
  const tokens = existing ? existing.split(/\s+/).filter(Boolean) : [];
  if (!tokens.includes(describedById)) {
    tokens.push(describedById);
  }
  control.setAttribute('aria-describedby', tokens.join(' ').trim());
}

function createInputErrorNode(errorId) {
  const node = document.createElement('p');
  node.className = 'input-error';
  node.textContent = '';
  node.id = errorId;
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('role', 'status');
  return node;
}

function deterministicShuffle(items, seedText) {
  const list = [...items];
  const seedSource = String(seedText ?? '');
  let seed = 0;
  for (let i = 0; i < seedSource.length; i += 1) {
    seed = (seed * 31 + seedSource.charCodeAt(i)) >>> 0;
  }
  for (let i = list.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function resolveImportedWorksheetPayload(importedRecord) {
  const worksheet = importedRecord?.worksheet;
  if (!worksheet || typeof worksheet !== 'object') {
    throw new Error('Imported worksheet record is missing worksheet payload.');
  }

  if (worksheet.blocks && worksheet.worksheetId && worksheet.snapshotId) {
    return normalizeViewerPayload(worksheet, 'Imported worksheet');
  }

  if (isSnapshotLikeWorksheet(worksheet)) {
    try {
      return normalizeViewerPayload(mapSnapshotToViewerPayload(worksheet), 'Imported worksheet');
    } catch (error) {
      console.warn('Imported worksheet looked snapshot-like but failed snapshot validation.', error);
    }
  }

  if (worksheet.blocks) {
    return normalizeViewerPayload(
      {
        worksheetId: importedRecord.localId,
        snapshotId: `${importedRecord.localId}:imported-local`,
        snapshotVersion: 1,
        title: worksheet.title || 'Imported worksheet',
        blocks: worksheet.blocks,
      },
      'Imported worksheet'
    );
  }

  throw new Error('Imported worksheet payload format is not supported for viewer mode.');
}

class ViewerAttemptSession {
  constructor(storage) {
    this.storage = storage;
    this.state = {
      localAttemptId: null,
      viewerPayload: null,
      answers: {},
      status: 'in_progress',
      startedAt: null,
      lastSavedAt: null,
      completedAt: null,
      autosavePending: false,
      lastSaveError: null,
      payloadValidationErrors: [],
      attemptValidationErrors: [],
      lastManualSaveAt: null,
      source: 'unknown',
      sourceType: 'unknown',
      sourceLocalDraftId: null,
      sourceImportedWorksheetId: null,
      sourceDraftUpdatedAt: null,
      studentName: '',
      lastActiveBlockId: null,
      lastActiveIndex: 0,
      isFinalizing: false,
      lastFinalizeError: null,
      attemptRevision: 0,
      lastSavedRevision: 0,
      recoveryMessage: null,
      checkResult: null,
      lastProtectedAction: null,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  async validateViewerPayload(payload) {
    const validation = validateViewerPayloadSchema(payload);
    this.state.payloadValidationErrors = validation.errors;
    if (!validation.valid) {
      throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.INVALID_VIEWER_PAYLOAD, {
        userMessage: 'The worksheet content is invalid and cannot be opened in viewer.',
        technicalMessage: `Viewer payload validation failed: ${validation.errors.join('; ')}`,
      });
    }
    return validation;
  }

  async bootstrap() {
    const params = new URLSearchParams(window.location.search);
    const previewIntent = this.parsePreviewIntent(params);
    const freshnessMarker = params.get('draftUpdatedAt') || null;
    const hasExplicitContentIntent =
      params.has('localDraftId')
      || params.has('viewerPayload')
      || params.has('snapshot')
      || params.has('importedWorksheetId');

    const explicitAttemptId = params.get('localAttemptId');
    if (explicitAttemptId) {
      const resumed = await this.tryResumeAttempt(explicitAttemptId, {
        sourceDraftUpdatedAt: freshnessMarker,
        preferFreshPreview: Boolean(previewIntent?.preview && previewIntent?.localDraftId),
      });
      if (resumed) {
        this.persistResumeMetadata();
        return this.state;
      }
      throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.LOCAL_ATTEMPT_RESUME_FAILED, {
        userMessage: 'We could not restore the requested local attempt.',
        technicalMessage: `Unable to resume explicit localAttemptId=${explicitAttemptId}.`,
      });
    }

    if (!hasExplicitContentIntent) {
      const flaggedAttemptId = this.storage.resumeFlags.get(RESUME_FLAG_KEY)?.localId || null;
      if (flaggedAttemptId) {
        const resumedFromFlag = await this.tryResumeAttempt(flaggedAttemptId);
        if (resumedFromFlag) {
          this.persistResumeMetadata();
          return this.state;
        }
      }
    }

    const loadedPayload = await this.loadViewerPayloadFromSources(params, previewIntent);
    await this.validateViewerPayload(loadedPayload.payload);
    const attempt = this.createLocalAttemptState(
      loadedPayload.payload,
      loadedPayload.sourceType,
      {
        sourceDraftUpdatedAt: loadedPayload.sourceDraftUpdatedAt,
        sourceLocalDraftId: loadedPayload.sourceLocalDraftId || null,
        sourceImportedWorksheetId: loadedPayload.sourceImportedWorksheetId || null,
      }
    );
    attempt.checkResult = null;
    this.applyAttemptState(attempt, { markDirty: true });
    this.persistResumeMetadata();

    return this.state;
  }

  parsePreviewIntent(params) {
    const localDraftId = params.get('localDraftId');
    if (!localDraftId) {
      return null;
    }

    return {
      localDraftId,
      preview: params.get('preview') === '1',
      sourceDraftUpdatedAt: params.get('draftUpdatedAt') || null,
    };
  }

  async tryResumeAttempt(localAttemptId, options = {}) {
    try {
      const attemptRecord = await this.storage.attempts.get(localAttemptId);
      if (!attemptRecord) {
        return false;
      }
      const attemptSourceDraftUpdatedAt = attemptRecord.metadata?.sourceDraftUpdatedAt || null;
      const shouldBypassResumeForFreshPreview =
        options.preferFreshPreview
        && options.sourceDraftUpdatedAt
        && options.sourceDraftUpdatedAt !== attemptSourceDraftUpdatedAt;
      if (shouldBypassResumeForFreshPreview) {
        return false;
      }

      const reconstructedPayload = await this.reconstructViewerPayloadFromAttempt(attemptRecord);
      const payloadSource = reconstructedPayload || attemptRecord.viewerPayload;
      if (!payloadSource) {
        return false;
      }
      const normalizedPayload = normalizeViewerPayload(payloadSource, payloadSource?.title || 'Resumed worksheet');
      await this.validateViewerPayload(normalizedPayload);
      const mergedAnswers = overlayAnswersOnViewerPayload(normalizedPayload, attemptRecord.answers || {});
      const studentName = pickAttemptStudentName(attemptRecord);
      const resumeStartIndex = computeResumeStartBlockIndex(normalizedPayload, mergedAnswers, attemptRecord);
      const orderedBlocks = [...(normalizedPayload.blocks || [])].sort((a, b) => a.position - b.position);
      const activeBlock = orderedBlocks[resumeStartIndex] || null;

      this.applyAttemptState(
        {
          ...attemptRecord,
          answers: mergedAnswers,
          viewerPayload: normalizedPayload,
          studentName,
          checkResult: null,
          lastActiveIndex: resumeStartIndex,
          lastActiveBlockId: activeBlock?.blockId || null,
          metadata: {
            ...attemptRecord.metadata,
            localId: localAttemptId,
          },
        },
        { markDirty: false }
      );

      return true;
    } catch (error) {
      console.warn('Unable to resume local attempt from IndexedDB.', error);
      return false;
    }
  }

  async loadViewerPayloadFromSources(params, previewIntent = null) {
    if (previewIntent?.localDraftId && previewIntent?.preview) {
      const draftRecord = await this.storage.drafts.get(previewIntent.localDraftId);
      if (!draftRecord) {
        throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.LOCAL_DRAFT_NOT_FOUND, {
          userMessage: 'The requested local draft was not found.',
          technicalMessage: `Local draft not found for localId=${previewIntent.localDraftId}`,
        });
      }

      return {
        sourceType: 'local_draft_preview',
        sourceLocalDraftId: previewIntent.localDraftId,
        payload: mapDraftRecordToViewerPayload(draftRecord),
        sourceDraftUpdatedAt: draftRecord.metadata?.updatedAt || previewIntent.sourceDraftUpdatedAt || null,
      };
    }

    const viewerPayloadParam = parseLaunchParamJson(params, 'viewerPayload', VIEWER_BOOT_ERROR_CODES.VIEWER_PAYLOAD_PARSE_FAILED);
    const inlinePayload = viewerPayloadParam.present
      ? viewerPayloadParam.value
      : (typeof window !== 'undefined' ? parseJsonInput(window.__VIEWER_PAYLOAD__) : null);

    if (inlinePayload) {
      return {
        sourceType: 'inline_payload',
        payload: normalizeViewerPayload(inlinePayload, 'Local worksheet'),
      };
    }

    const snapshotParam = parseLaunchParamJson(params, 'snapshot', VIEWER_BOOT_ERROR_CODES.SNAPSHOT_PARSE_FAILED);
    if (snapshotParam.present) {
      return {
        sourceType: 'snapshot_derived',
        payload: normalizeViewerPayload(mapSnapshotToViewerPayload(snapshotParam.value), 'Snapshot worksheet'),
      };
    }

    const importedWorksheetId = params.get('importedWorksheetId');
    if (importedWorksheetId) {
      const importedRecord = await this.storage.importedWorksheets.get(importedWorksheetId);
      if (!importedRecord) {
        throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.IMPORTED_WORKSHEET_NOT_FOUND, {
          userMessage: 'The imported worksheet could not be found.',
          technicalMessage: `Imported worksheet not found for localId=${importedWorksheetId}`,
        });
      }

      return {
        sourceType: 'imported_worksheet',
        sourceImportedWorksheetId: importedWorksheetId,
        payload: resolveImportedWorksheetPayload(importedRecord),
      };
    }

    const localDraftId = params.get('localDraftId');
    if (localDraftId) {
      const draftRecord = await this.storage.drafts.get(localDraftId);
      if (!draftRecord) {
        throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.LOCAL_DRAFT_NOT_FOUND, {
          userMessage: 'The requested local draft was not found.',
          technicalMessage: `Local draft not found for localId=${localDraftId}`,
        });
      }

      return {
        sourceType: 'local_draft',
        sourceLocalDraftId: localDraftId,
        payload: mapDraftRecordToViewerPayload(draftRecord),
        sourceDraftUpdatedAt: draftRecord.metadata?.updatedAt || null,
      };
    }

    throw new ViewerBootError(VIEWER_BOOT_ERROR_CODES.NO_CONTENT_SOURCE, {
      userMessage: 'No worksheet launch content was provided.',
      technicalMessage: 'No viewer launch parameter was provided (localAttemptId/localDraftId/importedWorksheetId/viewerPayload/snapshot).',
    });
  }

  async reconstructViewerPayloadFromAttempt(attemptRecord = {}) {
    const sourceType = attemptRecord.sourceType || attemptRecord.metadata?.origin || 'inline_payload';
    const sourceLocalDraftId = attemptRecord.sourceLocalDraftId || attemptRecord.metadata?.sourceLocalDraftId || null;
    const sourceImportedWorksheetId =
      attemptRecord.sourceImportedWorksheetId || attemptRecord.metadata?.sourceImportedWorksheetId || null;
    if ((sourceType === 'local_draft' || sourceType === 'local_draft_preview') && sourceLocalDraftId) {
      const draftRecord = await this.storage.drafts?.get(sourceLocalDraftId);
      if (draftRecord) return mapDraftRecordToViewerPayload(draftRecord);
    }
    if (sourceType === 'imported_worksheet' && sourceImportedWorksheetId) {
      const importedRecord = await this.storage.importedWorksheets?.get(sourceImportedWorksheetId);
      if (importedRecord) return resolveImportedWorksheetPayload(importedRecord);
    }
    return null;
  }

  createLocalAttemptState(viewerPayload, source, options = {}) {
    const localAttemptId = createLocalId('attempt');
    const startedAt = nowIso();
    const sourceDraftUpdatedAt = options.sourceDraftUpdatedAt || null;

    return {
      localId: localAttemptId,
      localAttemptId,
      viewerPayload,
      learnerId: DEFAULT_LEARNER_ID,
      worksheetId: viewerPayload?.worksheetId || null,
      snapshotId: viewerPayload?.snapshotId || null,
      sourceType: source || 'inline_payload',
      sourceLocalDraftId: options.sourceLocalDraftId || null,
      sourceImportedWorksheetId: options.sourceImportedWorksheetId || null,
      lastActiveBlockId: viewerPayload?.blocks?.[0]?.blockId || null,
      lastActiveIndex: 0,
      studentName: options.studentName || '',
      status: 'in_progress',
      startedAt,
      lastSavedAt: startedAt,
      completedAt: null,
      answers: {},
      checkResult: null,
      metadata: {
        localId: localAttemptId,
        origin: source || 'local_source',
        sourceLocalDraftId: options.sourceLocalDraftId || null,
        sourceImportedWorksheetId: options.sourceImportedWorksheetId || null,
        studentName: options.studentName || '',
        sourceDraftUpdatedAt,
        updatedAt: startedAt,
      },
    };
  }

  applyAttemptState(attemptRecord, options = {}) {
    this.state.localAttemptId = attemptRecord.localAttemptId || attemptRecord.localId;
    this.state.viewerPayload = attemptRecord.viewerPayload;
    this.state.answers = attemptRecord.answers || {};
    this.state.status = attemptRecord.status || 'in_progress';
    this.state.startedAt = attemptRecord.startedAt || nowIso();
    this.state.lastSavedAt = attemptRecord.lastSavedAt || null;
    this.state.completedAt = attemptRecord.completedAt || attemptRecord.submittedAt || null;
    this.state.source = attemptRecord.metadata?.origin || 'local_source';
    this.state.sourceType = attemptRecord.sourceType || this.state.source;
    this.state.sourceLocalDraftId = attemptRecord.sourceLocalDraftId || attemptRecord.metadata?.sourceLocalDraftId || null;
    this.state.sourceImportedWorksheetId =
      attemptRecord.sourceImportedWorksheetId || attemptRecord.metadata?.sourceImportedWorksheetId || null;
    this.state.sourceDraftUpdatedAt = attemptRecord.metadata?.sourceDraftUpdatedAt || null;
    this.state.studentName = pickAttemptStudentName(attemptRecord);
    this.state.lastActiveBlockId = attemptRecord.lastActiveBlockId || null;
    this.state.lastActiveIndex = Number.isInteger(attemptRecord.lastActiveIndex) ? attemptRecord.lastActiveIndex : 0;
    this.state.lastSaveError = null;
    this.state.isFinalizing = false;
    this.state.lastFinalizeError = null;
    this.state.checkResult = null;

    if (options.markDirty) {
      this.state.attemptRevision += 1;
      this.scheduleAutosave();
    } else {
      this.state.attemptRevision = 1;
      this.state.lastSavedRevision = 1;
      this.state.autosavePending = false;
    }
  }

  setAnswer(blockId, value) {
    if (!blockId || this.state.status === 'completed') {
      return;
    }

    const questionBlock = this.state.viewerPayload?.blocks?.find(
      (block) => block.blockId === blockId && block.kind === 'question'
    );
    if (!questionBlock) {
      return;
    }
    const coercedValue = coerceAnswerValueForQuestion(questionBlock, value, { phase: 'edit' });

    this.state.answers = {
      ...this.state.answers,
      [blockId]: {
        value: coercedValue,
        answeredAt: nowIso(),
      },
    };
    this.state.lastActiveBlockId = blockId;

    this.state.attemptRevision += 1;
    this.scheduleAutosave();
    this.persistResumeMetadata();
  }

  async completeLocalAttempt() {
    if (!this.state.localAttemptId || this.state.isFinalizing || this.state.status === 'completed') {
      return null;
    }

    this.state.isFinalizing = true;
    this.state.lastFinalizeError = null;
    this.state.status = 'completed';
    this.state.completedAt = nowIso();
    this.state.attemptRevision += 1;
    this.persistResumeMetadata();
    this.notifyStateChange();

    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;

    try {
      const persisted = await this.autosave();
      this.state.lastFinalizeError = null;
      return persisted;
    } catch (error) {
      this.state.status = 'in_progress';
      this.state.completedAt = null;
      this.state.checkResult = null;
      this.state.lastFinalizeError = `Finalize failed. Please check your connection and try again. ${error?.message || String(error)}`;
      this.persistResumeMetadata();
      this.notifyStateChange();
      return null;
    } finally {
      this.state.isFinalizing = false;
      this.notifyStateChange();
    }
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.state.autosavePending = true;
    this.notifyStateChange();
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Viewer autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  async autosave() {
    if (!this.state.localAttemptId || !this.state.viewerPayload) {
      return null;
    }

    const revisionAtSaveStart = this.state.attemptRevision;
    const updatedAt = nowIso();

    const normalizedAnswers = {};
    Object.entries(this.state.answers || {}).forEach(([blockId, answer]) => {
      const questionBlock = this.state.viewerPayload?.blocks?.find(
        (block) => block.blockId === blockId && block.kind === 'question'
      );
      if (!questionBlock) return;
      normalizedAnswers[blockId] = {
        ...answer,
        value: coerceAnswerValueForQuestion(questionBlock, answer?.value, { phase: 'save' }),
      };
    });

    const attemptRecord = {
      localId: this.state.localAttemptId,
      localAttemptId: this.state.localAttemptId,
      viewerPayload: this.state.viewerPayload,
      learnerId: DEFAULT_LEARNER_ID,
      worksheetId: this.state.viewerPayload?.worksheetId || null,
      snapshotId: this.state.viewerPayload?.snapshotId || null,
      sourceType: this.state.sourceType || this.state.source || 'inline_payload',
      sourceLocalDraftId: this.state.sourceLocalDraftId || null,
      sourceImportedWorksheetId: this.state.sourceImportedWorksheetId || null,
      lastActiveBlockId: this.state.lastActiveBlockId || null,
      lastActiveIndex: Number.isInteger(this.state.lastActiveIndex) ? this.state.lastActiveIndex : 0,
      studentName: this.state.studentName || '',
      status: this.state.status,
      startedAt: this.state.startedAt,
      lastSavedAt: updatedAt,
      completedAt: this.state.completedAt,
      answers: normalizedAnswers,
      // checkResult is transient UI state and must not be persisted.
      metadata: {
        localId: this.state.localAttemptId,
        origin: this.state.sourceType || this.state.source || 'inline_payload',
        sourceLocalDraftId: this.state.sourceLocalDraftId || null,
        sourceImportedWorksheetId: this.state.sourceImportedWorksheetId || null,
        studentName: this.state.studentName || '',
        sourceDraftUpdatedAt: this.state.sourceDraftUpdatedAt || null,
        updatedAt,
      },
    };

    this.inFlightSaveCount += 1;
    this.state.autosavePending = true;
    this.notifyStateChange();

    try {
      const persisted = await this.storage.attempts.put(attemptRecord);
      const shouldApplySaveStatus =
        this.state.localAttemptId === attemptRecord.localId && revisionAtSaveStart >= this.state.lastSavedRevision;
      if (shouldApplySaveStatus) {
        this.state.lastSavedRevision = revisionAtSaveStart;
        this.state.lastSavedAt = persisted?.metadata?.updatedAt || updatedAt;
        this.state.lastSaveError = null;
        this.persistResumeMetadata();
        this.notifyStateChange();
      }
      return persisted;
    } catch (error) {
      const shouldApplyErrorStatus =
        this.state.localAttemptId === attemptRecord.localId && revisionAtSaveStart > this.state.lastSavedRevision;
      if (shouldApplyErrorStatus) {
        this.state.lastSaveError = error?.message || String(error);
        this.notifyStateChange();
      }
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.attemptRevision;
      this.notifyStateChange();
    }
  }

  async saveNow() {
    const persisted = await this.autosave();
    this.state.lastManualSaveAt = nowIso();
    return persisted;
  }


  async flushLocalStateForAuthRedirect() {
    if (!this.state.localAttemptId || !this.state.viewerPayload) return null;

    if (this.state.lastSavedRevision < this.state.attemptRevision) {
      return this.autosave();
    }

    return {
      localAttemptId: this.state.localAttemptId,
      viewerPayload: this.state.viewerPayload,
      answers: this.state.answers,
    };
  }

  getUiRestoreState() {
    return {
      status: this.state.status,
      worksheetId: this.state.viewerPayload?.worksheetId || null,
      snapshotId: this.state.viewerPayload?.snapshotId || null,
    };
  }

  async restoreByLocalId(localId) {
    if (!localId) return false;
    return this.tryResumeAttempt(localId);
  }

  async startImportedWorksheetFromJsonText(rawJson) {
    let worksheet;
    try {
      worksheet = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`Unable to parse worksheet JSON. ${error?.message || String(error)}`);
    }

    const importedRecord = {
      localId: createLocalId('imported'),
      worksheet,
      importedAt: nowIso(),
    };
    importedRecord.metadata = {
      localId: importedRecord.localId,
      origin: 'imported_file',
      updatedAt: importedRecord.importedAt,
    };

    try {
      await this.storage.importedWorksheets.put(importedRecord);
    } catch (error) {
      throw new Error(`Failed to save imported worksheet. ${error?.message || String(error)}`);
    }

    try {
      const payload = resolveImportedWorksheetPayload(importedRecord);
      await this.validateViewerPayload(payload);
      const attempt = this.createLocalAttemptState(payload, 'imported_worksheet');
      attempt.checkResult = null;
      this.applyAttemptState(attempt, { markDirty: true });
      this.persistResumeMetadata();
      return this.state;
    } catch (error) {
      throw new Error(`Imported worksheet is invalid. ${error?.message || String(error)}`);
    }
  }

  applyUiRestoreState(_ui = {}) {
    this.persistResumeMetadata();
  }

  setRecoveryMessage(message) {
    this.state.recoveryMessage = message || null;
  }

  async replayProtectedAction(intent) {
    this.state.lastProtectedAction = intent.actionId;
    this.setRecoveryMessage(null);
  }

  async triggerProtectedAction(actionId) {
    if (!this.authGate) {
      throw new Error('Auth gate is not configured for viewer session.');
    }

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localAttempts',
      payload: {
        localAttemptId: this.state.localAttemptId || null,
      },
    });
  }

  persistResumeMetadata() {
    if (!this.state.localAttemptId) {
      return;
    }

    this.storage.resumeFlags.set(RESUME_FLAG_KEY, {
      localId: this.state.localAttemptId,
      store: 'localAttempts',
      status: this.state.status,
      worksheetId: this.state.viewerPayload?.worksheetId || null,
      snapshotId: this.state.viewerPayload?.snapshotId || null,
      updatedAt: nowIso(),
    });
  }
}

function renderViewerShell(session) {
  if (!app || !bottomBarRoot) {
    return;
  }
  if (activeViewerShellAbortController) {
    activeViewerShellAbortController.abort();
  }
  activeViewerShellAbortController = new AbortController();
  const { signal } = activeViewerShellAbortController;

  const shell = document.createElement('div');
  shell.className = 'viewer-shell';

  const header = document.createElement('header');
  header.className = 'viewer-header';
  const headerTop = document.createElement('div');
  headerTop.className = 'viewer-header-top';
  const heading = document.createElement('h1');
  heading.textContent = session.state.viewerPayload.title;

  const answerSummary = document.createElement('p');
  answerSummary.className = 'answer-summary';
  const resumeWarning = document.createElement('p');
  resumeWarning.className = 'answer-summary';
  const status = document.createElement('p');
  let studentName = session.state.studentName || '';

  const blockSection = document.createElement('section');
  blockSection.className = 'viewer-section';
  const blockHeading = document.createElement('h2');
  const blockList = document.createElement('div');
  blockList.id = 'viewer-answer-form';
  const stepper = document.createElement('div');
  stepper.className = 'block-stepper';
  stepper.setAttribute('role', 'list');
  stepper.setAttribute('aria-label', 'Worksheet block progress');

  const navActions = document.createElement('div');
  navActions.className = 'viewer-bottom-bar__zone viewer-bottom-bar__zone--center';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'icon-nav-btn';
  prevBtn.textContent = '← Back';
  prevBtn.setAttribute('aria-label', 'Go to previous block');
  prevBtn.title = 'Previous block';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'icon-nav-btn';
  nextBtn.textContent = 'Next →';
  nextBtn.setAttribute('aria-label', 'Go to next block');
  nextBtn.title = 'Next block';
  navActions.append(prevBtn, nextBtn);
  const answerControls = new Map();
  const textControlFeedback = new Map();
  let blockSignature = null;
  let stepperOrderSignature = null;
  let lastStepperActiveIndex = -1;
  const numberInputErrors = new Map();
  const localInputCache = new Map();
  let currentBlockIndex = 0;
  currentBlockIndex = computeResumeStartBlockIndex(session.state.viewerPayload, session.state.answers, {
    lastActiveBlockId: session.state.lastActiveBlockId,
    lastActiveIndex: session.state.lastActiveIndex,
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.textContent = 'Submit';

  const utilityMenu = document.createElement('div');
  utilityMenu.className = 'viewer-utility-menu';
  const headerActions = document.createElement('div');
  headerActions.className = 'viewer-header-actions';
  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'viewer-utility-menu__trigger';
  infoBtn.setAttribute('aria-label', 'Open technical details');
  infoBtn.title = 'Technical details';
  infoBtn.textContent = 'ⓘ';
  const utilityMenuBtn = document.createElement('button');
  utilityMenuBtn.type = 'button';
  utilityMenuBtn.className = 'viewer-utility-menu__trigger';
  utilityMenuBtn.setAttribute('aria-haspopup', 'menu');
  utilityMenuBtn.setAttribute('aria-expanded', 'false');
  utilityMenuBtn.setAttribute('aria-controls', 'viewer-utility-menu-list');
  utilityMenuBtn.setAttribute('aria-label', 'Open more actions');
  utilityMenuBtn.title = 'More actions';
  utilityMenuBtn.textContent = '≡';
  const utilityMenuList = document.createElement('div');
  utilityMenuList.className = 'viewer-utility-menu__list';
  utilityMenuList.id = 'viewer-utility-menu-list';
  utilityMenuList.setAttribute('role', 'menu');
  utilityMenuList.hidden = true;

  const syncResumeBtn = document.createElement('button');
  syncResumeBtn.type = 'button';
  syncResumeBtn.className = 'viewer-utility-menu__item';
  syncResumeBtn.setAttribute('role', 'menuitem');
  syncResumeBtn.textContent = 'Sync/Resume (Sign-in required)';

  const rewriteAssistBtn = document.createElement('button');
  rewriteAssistBtn.type = 'button';
  rewriteAssistBtn.className = 'viewer-utility-menu__item';
  rewriteAssistBtn.setAttribute('role', 'menuitem');
  rewriteAssistBtn.textContent = 'Rewrite Assist (Sign-in required)';
  utilityMenuList.append(syncResumeBtn, rewriteAssistBtn);
  utilityMenu.append(utilityMenuBtn, utilityMenuList);
  headerActions.append(infoBtn, utilityMenu);

  const detailsModal = document.createElement('div');
  detailsModal.className = 'viewer-details-modal';
  detailsModal.hidden = true;
  detailsModal.setAttribute('role', 'dialog');
  detailsModal.setAttribute('aria-modal', 'true');
  detailsModal.setAttribute('aria-labelledby', 'viewer-details-modal-title');
  const detailsContent = document.createElement('div');
  detailsContent.className = 'viewer-details-modal__content';
  const detailsTitle = document.createElement('h2');
  detailsTitle.id = 'viewer-details-modal-title';
  detailsTitle.textContent = 'Technical details';
  const learnerNameForm = document.createElement('form');
  learnerNameForm.className = 'viewer-details-form';
  const learnerNameLabel = document.createElement('label');
  learnerNameLabel.className = 'viewer-details-form__label';
  learnerNameLabel.setAttribute('for', 'viewer-student-name-input');
  learnerNameLabel.textContent = 'Student name';
  const learnerNameInput = document.createElement('input');
  learnerNameInput.id = 'viewer-student-name-input';
  learnerNameInput.className = 'viewer-details-form__input';
  learnerNameInput.type = 'text';
  learnerNameInput.maxLength = 120;
  learnerNameInput.placeholder = 'Enter student name';
  learnerNameInput.autocomplete = 'name';
  const learnerNameSaveBtn = document.createElement('button');
  learnerNameSaveBtn.type = 'submit';
  learnerNameSaveBtn.className = 'viewer-details-form__save';
  learnerNameSaveBtn.textContent = 'Apply';
  learnerNameForm.append(learnerNameLabel, learnerNameInput, learnerNameSaveBtn);
  const detailsList = document.createElement('dl');
  detailsList.className = 'viewer-details-list';
  const detailsCloseBtn = document.createElement('button');
  detailsCloseBtn.type = 'button';
  detailsCloseBtn.textContent = 'Close';
  detailsCloseBtn.className = 'viewer-details-modal__close';
  detailsContent.append(detailsTitle, learnerNameForm, detailsList, detailsCloseBtn);
  detailsModal.append(detailsContent);

  const bottomBar = document.createElement('div');
  bottomBar.className = 'viewer-bottom-bar';
  const bottomBarInner = document.createElement('div');
  bottomBarInner.className = 'viewer-bottom-bar__inner';
  const leftZone = document.createElement('div');
  leftZone.className = 'viewer-bottom-bar__zone viewer-bottom-bar__zone--left';
  const rightZone = document.createElement('div');
  rightZone.className = 'viewer-bottom-bar__zone viewer-bottom-bar__zone--right';

  completeBtn.addEventListener('click', async () => {
    await session.completeLocalAttempt();
    renderUI();
  });
  leftZone.append(saveBtn);
  rightZone.append(completeBtn);
  bottomBarInner.append(leftZone, navActions, rightZone);
  bottomBar.append(bottomBarInner);

  const getOrderedBlocks = () => (
    [...(session.state.viewerPayload?.blocks || [])].sort((a, b) => a.position - b.position)
  );

  const getMenuItems = () => Array.from(utilityMenuList.querySelectorAll('.viewer-utility-menu__item'));
  let lastFocusedElement = null;

  const copyTextValue = async (rawValue) => {
    const value = String(rawValue ?? '');
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const fallback = document.createElement('textarea');
    fallback.value = value;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'absolute';
    fallback.style.left = '-9999px';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  };

  const renderTechnicalDetails = () => {
    const technicalRows = [
      ['Worksheet ID', session.state.viewerPayload?.worksheetId || 'n/a'],
      ['Snapshot ID', session.state.viewerPayload?.snapshotId || 'n/a'],
      ['Local attempt ID', session.state.localAttemptId || 'n/a'],
      ['Source', session.state.source || 'n/a'],
    ];
    learnerNameInput.value = studentName;
    detailsList.innerHTML = '';
    technicalRows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'viewer-details-list__row';
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      const valueText = document.createElement('code');
      valueText.textContent = String(value);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'viewer-details-list__copy';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', `Copy ${label}`);
      copyBtn.addEventListener('click', async () => {
        await copyTextValue(value);
      });
      description.append(valueText, copyBtn);
      row.append(term, description);
      detailsList.appendChild(row);
    });
  };

  const trapModalFocus = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTechnicalDetails();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = detailsModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function closeTechnicalDetails() {
    detailsModal.hidden = true;
    detailsModal.removeEventListener('keydown', trapModalFocus);
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
  }

  const openTechnicalDetails = () => {
    lastFocusedElement = document.activeElement;
    renderTechnicalDetails();
    detailsModal.hidden = false;
    detailsModal.addEventListener('keydown', trapModalFocus);
    detailsCloseBtn.focus();
  };

  learnerNameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    studentName = learnerNameInput.value.trim();
    session.state.studentName = studentName;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(LEGACY_STUDENT_NAME_KEY, studentName);
      }
    } catch {
      // Ignore localStorage failures in restricted contexts.
    }
    renderUI();
    learnerNameInput.focus();
  });

  infoBtn.addEventListener('click', () => {
    openTechnicalDetails();
  });
  detailsCloseBtn.addEventListener('click', () => {
    closeTechnicalDetails();
  });
  detailsModal.addEventListener('click', (event) => {
    if (event.target === detailsModal) {
      closeTechnicalDetails();
    }
  });

  const closeUtilityMenu = ({ returnFocus = false } = {}) => {
    utilityMenuList.hidden = true;
    utilityMenuBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) {
      utilityMenuBtn.focus();
    }
  };

  const openUtilityMenu = () => {
    utilityMenuList.hidden = false;
    utilityMenuBtn.setAttribute('aria-expanded', 'true');
  };

  const isUtilityMenuOpen = () => (
    !utilityMenuList.hidden
    && utilityMenuBtn.getAttribute('aria-expanded') === 'true'
  );

  const focusMenuItemByDelta = (delta) => {
    const items = getMenuItems();
    if (items.length === 0) return;
    const activeIndex = items.indexOf(document.activeElement);
    const nextIndex = activeIndex === -1
      ? 0
      : (activeIndex + delta + items.length) % items.length;
    items[nextIndex].focus();
  };

  utilityMenuBtn.addEventListener('click', () => {
    const isOpen = utilityMenuBtn.getAttribute('aria-expanded') === 'true';
    if (isOpen) {
      closeUtilityMenu();
      return;
    }
    openUtilityMenu();
    getMenuItems()[0]?.focus();
  });

  utilityMenuBtn.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    openUtilityMenu();
    getMenuItems()[0]?.focus();
  });

  utilityMenuList.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeUtilityMenu({ returnFocus: true });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusMenuItemByDelta(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItemByDelta(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      getMenuItems()[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const items = getMenuItems();
      items[items.length - 1]?.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (!utilityMenu.contains(event.target)) {
      closeUtilityMenu();
    }
  }, { signal });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && detailsModal.hidden && isUtilityMenuOpen()) {
      closeUtilityMenu({ returnFocus: true });
    }
  }, { signal });

  const getStepperLabel = (block, counters) => {
    if (block.kind === 'content') {
      counters.content += 1;
      return counters.content === 1 ? 'Instruction' : `Instruction ${counters.content}`;
    }
    counters.question += 1;
    return `Question ${counters.question}`;
  };

  const getStepperOrderSignature = (orderedBlocks) => (
    orderedBlocks.map((block) => `${block.blockId}:${block.position}:${block.kind}`).join('|')
  );

  const scrollStepperToActive = (activeNode, activeIndex, totalItems) => {
    if (!activeNode || !stepper) return;

    const ensureActiveNodeVisible = () => {
      const containerRect = stepper.getBoundingClientRect();
      const nodeRect = activeNode.getBoundingClientRect();
      const leftInset = 6;
      const rightInset = 6;

      if (nodeRect.left < containerRect.left + leftInset) {
        const delta = (containerRect.left + leftInset) - nodeRect.left;
        const nextLeft = Math.max(0, stepper.scrollLeft - delta);
        stepper.scrollLeft = nextLeft;
        return;
      }

      if (nodeRect.right > containerRect.right - rightInset) {
        const delta = nodeRect.right - (containerRect.right - rightInset);
        const maxScrollLeft = Math.max(0, stepper.scrollWidth - stepper.clientWidth);
        const nextLeft = Math.min(maxScrollLeft, stepper.scrollLeft + delta);
        stepper.scrollLeft = nextLeft;
      }
    };

    const shouldReduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scheduleEnsureActiveNodeVisible = () => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          ensureActiveNodeVisible();
        });
        return;
      }
      ensureActiveNodeVisible();
    };

    const maxScrollLeft = Math.max(0, stepper.scrollWidth - stepper.clientWidth);
    if (maxScrollLeft === 0) {
      stepper.scrollLeft = 0;
      scheduleEnsureActiveNodeVisible();
      return;
    }

    if (activeIndex <= 0) {
      stepper.scrollLeft = 0;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          stepper.scrollLeft = 0;
          ensureActiveNodeVisible();
        });
      }
      return;
    }

    if (activeIndex >= totalItems - 1) {
      stepper.scrollLeft = maxScrollLeft;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          stepper.scrollLeft = maxScrollLeft;
          ensureActiveNodeVisible();
        });
      }
      return;
    }

    const nodeLeft = activeNode.offsetLeft;
    const targetLeft = nodeLeft - ((stepper.clientWidth - activeNode.offsetWidth) / 2);
    const clampedLeft = Math.min(Math.max(targetLeft, 0), maxScrollLeft);
    const behavior = shouldReduceMotion ? 'auto' : 'smooth';
    stepper.scrollTo({ left: clampedLeft, behavior });
    scheduleEnsureActiveNodeVisible();
  };

  const updateStepperFitState = () => {
    const fitsContainer = stepper.scrollWidth <= stepper.clientWidth;
    stepper.dataset.fit = fitsContainer ? 'true' : 'false';
  };

  const renderStepper = (orderedBlocks, activeIndex, { shouldScrollToActive = false } = {}) => {
    stepper.innerHTML = '';
    const counters = { content: 0, question: 0 };

    orderedBlocks.forEach((block, index) => {
      const item = document.createElement('div');
      item.className = 'block-stepper__item';
      item.setAttribute('role', 'listitem');

      const isCompleted = index < activeIndex;
      const isCurrent = index === activeIndex;
      const stateClass = isCompleted ? 'is-completed' : isCurrent ? 'is-current' : 'is-upcoming';
      item.classList.add(stateClass);

      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'block-stepper__node';
      node.textContent = `${index + 1}`;
      node.title = `Go to block ${index + 1}`;
      if (isCurrent) {
        node.setAttribute('aria-label', `Block ${index + 1} of ${orderedBlocks.length}`);
        node.setAttribute('aria-current', 'step');
      } else {
        node.setAttribute('aria-label', `Block ${index + 1} of ${orderedBlocks.length}`);
      }
      node.addEventListener('click', () => {
        if (currentBlockIndex === index) return;
        currentBlockIndex = index;
        persistNavigationState(orderedBlocks);
        renderUI();
      });

      const label = document.createElement('p');
      label.className = 'block-stepper__label';
      label.textContent = getStepperLabel(block, counters);

      item.append(node, label);
      if (index < orderedBlocks.length - 1) {
        const connector = document.createElement('span');
        connector.className = `block-stepper__connector ${isCompleted ? 'is-completed' : 'is-upcoming'}`;
        item.append(connector);
      }
      stepper.appendChild(item);
    });

    updateStepperFitState();

    const activeNode = stepper.querySelector('.block-stepper__item.is-current');
    if (shouldScrollToActive && activeNode) {
      scrollStepperToActive(activeNode, activeIndex, orderedBlocks.length);
    }
  };

  const updateStepperActiveState = (orderedBlocks, activeIndex, { shouldScrollToActive = false } = {}) => {
    const stepperItems = stepper.querySelectorAll('.block-stepper__item');
    stepperItems.forEach((item, index) => {
      const node = item.querySelector('.block-stepper__node');
      const connector = item.querySelector('.block-stepper__connector');
      const isCompleted = index < activeIndex;
      const isCurrent = index === activeIndex;

      item.classList.remove('is-completed', 'is-current', 'is-upcoming');
      item.classList.add(isCompleted ? 'is-completed' : isCurrent ? 'is-current' : 'is-upcoming');

      if (node) {
        node.setAttribute('aria-label', `Block ${index + 1} of ${orderedBlocks.length}`);
        if (isCurrent) {
          node.setAttribute('aria-current', 'step');
        } else {
          node.removeAttribute('aria-current');
        }
      }

      if (connector) {
        connector.classList.remove('is-completed', 'is-upcoming');
        connector.classList.add(isCompleted ? 'is-completed' : 'is-upcoming');
      }
    });

    if (shouldScrollToActive) {
      const activeNode = stepper.querySelector('.block-stepper__item.is-current');
      if (activeNode) {
        scrollStepperToActive(activeNode, activeIndex, orderedBlocks.length);
      }
    }
  };

  const cacheRawControlValue = (blockId, value) => {
    localInputCache.set(blockId, value);
  };

  const renderCurrentBlockCard = (currentBlock) => {
    const currentBlockCheckResult = currentBlock?.blockId
      ? session.state.checkResult?.byBlockId?.[currentBlock.blockId]
      : undefined;
    const hasGlobalCheckResult = session.state.checkResult !== null;
    const currentBlockIsGradeable = isGradeableQuestionBlock(currentBlock);
    const hasCurrentBlockCheckResult = typeof currentBlockCheckResult === 'boolean';
    const shouldShowCheckFeedback = hasGlobalCheckResult && currentBlockIsGradeable && hasCurrentBlockCheckResult;

    const nextSignature = JSON.stringify({
      blockId: currentBlock?.blockId || null,
      prompt: currentBlock?.prompt?.text || '',
      content: currentBlock?.content?.text || '',
      inputType: currentBlock?.responseConfig?.inputType || null,
      maxLength: currentBlock?.responseConfig?.maxLength || null,
      options: Array.isArray(currentBlock?.responseConfig?.options)
        ? currentBlock.responseConfig.options.map((opt) => [opt?.value ?? '', opt?.label ?? ''])
        : [],
      hasGlobalCheckResult,
      currentBlockIsGradeable,
      currentBlockCheckResult: hasCurrentBlockCheckResult ? currentBlockCheckResult : null,
    });
    if (nextSignature === blockSignature) return;

    blockSignature = nextSignature;
    answerControls.clear();
    textControlFeedback.clear();
    blockList.innerHTML = '';
    if (!currentBlock) return;

    if (currentBlock.kind === 'content') {
      const card = document.createElement('article');
      card.className = 'content-card viewer-card-transition';
      card.textContent = currentBlock.content?.text || '';
      blockList.appendChild(card);
      return;
    }

    const block = currentBlock;
    const card = document.createElement('article');
    card.className = 'question-card viewer-card-transition';
      const label = document.createElement('label');
      const inputType = block.responseConfig?.inputType || 'text';
      const controlId = `answer-${block.blockId}`;
      label.id = `${controlId}-label`;
      label.textContent = block.prompt?.text || 'Question';

      let checkBadge = null;
      let checkReveal = null;
      if (shouldShowCheckFeedback) {
        const isCorrect = currentBlockCheckResult === true;
        const correctAnswer = block.responseConfig?.correctAnswer;
        const formatCorrectAnswer = () => {
          if (inputType === 'multiple_choice') {
            if (block.responseConfig?.selectionMode === 'multi') {
              return Array.isArray(correctAnswer) ? correctAnswer.map((value) => String(value)).join(', ') : '';
            }
            return String(correctAnswer ?? '');
          }
          if (inputType === 'boolean') {
            return coerceAnswerValueByInputType('boolean', correctAnswer) === true ? 'True' : 'False';
          }
          if (inputType === 'number') {
            return String(correctAnswer ?? '');
          }
          return '';
        };

        checkBadge = document.createElement('p');
        checkBadge.className = `viewer-check-badge ${isCorrect ? 'is-correct' : 'is-incorrect'}`;
        checkBadge.textContent = isCorrect ? '✅ Correct' : '❌ Incorrect';

        checkReveal = document.createElement('p');
        checkReveal.className = 'viewer-check-reveal muted';
        checkReveal.textContent = `Correct answer: ${formatCorrectAnswer()}`;
      }

      const helper = document.createElement('p');
      helper.className = 'muted';
      helper.textContent = getInputHelperText(inputType, block.responseConfig || {});
      helper.id = `${controlId}-helper`;
      const inputError = createInputErrorNode(`${controlId}-error`);
      let textCounter = null;
      let textStatus = null;
      if (inputType === 'text') {
        textCounter = document.createElement('p');
        textCounter.className = 'text-counter';
        textCounter.id = `${controlId}-counter`;
        textStatus = document.createElement('p');
        textStatus.className = 'text-counter-status';
        textStatus.id = `${controlId}-status`;
        textStatus.setAttribute('aria-live', 'polite');
        textStatus.setAttribute('role', 'status');
      }

      let control;
      if (inputType === 'text' && block.responseConfig?.displayMode === 'single_line') {
        control = document.createElement('input');
        control.type = 'text';
        control.addEventListener('input', () => {
          cacheRawControlValue(block.blockId, control.value);
          session.setAnswer(block.blockId, control.value);
          const feedback = computeTextLengthFeedback(control.value, block.responseConfig?.maxLength || 200);
          updateTextCounterUI(textCounter, textStatus, feedback);
          renderUI();
        });
      } else if (inputType === 'number') {
        control = document.createElement('input');
        control.type = 'text';
        control.inputMode = 'decimal';
        const numberRules = normalizeNumberRules(block.responseConfig?.numberRules);
        const allowSignedPrefix = numberRules.allowSigned ? '[+-]?' : '';
        let decimalPattern;
        if (numberRules.allowedKinds.includes('decimal') && typeof numberRules.decimalPlacesAllowed === 'number') {
          decimalPattern = numberRules.decimalPlacesAllowed > 0
            ? `\\d+\\.\\d{1,${numberRules.decimalPlacesAllowed}}`
            : '\\d+';
        } else {
          decimalPattern = '\\d+\\.\\d+';
        }
        const kindPattern = numberRules.allowedKinds.includes('integer') && numberRules.allowedKinds.includes('decimal')
          ? '\\d+(\\.\\d+)?'
          : numberRules.allowedKinds.includes('decimal')
            ? decimalPattern
            : '\\d+';
        control.pattern = `${allowSignedPrefix}${kindPattern}`;
        const kinds = numberRules.allowedKinds;
        let kindDescription;
        if (kinds.includes('integer') && kinds.includes('decimal')) {
          kindDescription = 'integer or decimal number';
        } else if (kinds.includes('integer')) {
          kindDescription = 'integer';
        } else if (kinds.includes('decimal')) {
          kindDescription = 'decimal number';
        } else {
          kindDescription = 'number';
        }
        const constraints = [];
        if (!numberRules.allowSigned) {
          constraints.push('without a leading + or - sign');
        }
        if (kinds.includes('decimal') && typeof numberRules.decimalPlacesAllowed === 'number') {
          if (numberRules.decimalPlacesAllowed === 1) {
            constraints.push('with at most 1 digit after the decimal point');
          } else if (numberRules.decimalPlacesAllowed > 1) {
            constraints.push(`with at most ${numberRules.decimalPlacesAllowed} digits after the decimal point`);
          }
        }
        let title = `Enter a valid ${kindDescription}`;
        if (constraints.length > 0) {
          title += ` (${constraints.join(', ')}).`;
        } else {
          title += '.';
        }
        control.title = title;
        control.addEventListener('input', () => {
          cacheRawControlValue(block.blockId, control.value);
          const { message, normalizedValue } = getNumberInputErrorMessage(control.value, block.responseConfig || {});
          if (message) {
            numberInputErrors.set(block.blockId, message);
            session.setAnswer(block.blockId, '');
            renderUI();
            return;
          }
          numberInputErrors.set(block.blockId, '');
          session.setAnswer(block.blockId, normalizedValue);
          renderUI();
        });
      } else if (inputType === 'boolean') {
        control = document.createElement('div');
        control.className = 'boolean-segmented-control';
        control.setAttribute('role', 'group');
        control.setAttribute('aria-labelledby', label.id);
        [
          { value: true, datasetValue: 'true', label: 'True' },
          { value: false, datasetValue: 'false', label: 'False' },
        ].forEach((optionConfig) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'boolean-segmented-control__button';
          button.dataset.booleanValue = optionConfig.datasetValue;
          button.textContent = optionConfig.label;
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            const currentValue = session.state.answers?.[block.blockId]?.value;
            const normalizedCurrentValue = coerceAnswerValueByInputType('boolean', currentValue);
            const nextValue = normalizedCurrentValue === optionConfig.value ? null : optionConfig.value;
            session.setAnswer(block.blockId, nextValue);
            renderUI();
          });
          control.appendChild(button);
        });
      } else if (inputType === 'multiple_choice' && Array.isArray(block.responseConfig?.options)) {
        const optionSource = block.responseConfig.shuffleOptions
          ? deterministicShuffle(
            block.responseConfig.options,
            `${session.state.localAttemptId || 'attempt'}:${block.blockId}`
          )
          : block.responseConfig.options;
        control = createChoiceButtonGroup({
          block,
          labelId: label.id,
          controlId,
          optionSource,
          session,
          updateSummary: () => renderUI(),
        });
      } else {
        control = document.createElement('textarea');
        control.rows = 5;
        control.addEventListener('input', () => {
          cacheRawControlValue(block.blockId, control.value);
          session.setAnswer(block.blockId, control.value);
          const feedback = computeTextLengthFeedback(control.value, block.responseConfig?.maxLength || 200);
          updateTextCounterUI(textCounter, textStatus, feedback);
          renderUI();
        });
      }

      if (typeof HTMLElement !== 'undefined' && control instanceof HTMLElement) {
        control.id = controlId;
        if (control.matches('input, select, textarea')) {
          label.htmlFor = controlId;
        } else {
          label.removeAttribute('for');
        }
        ensureControlDescribedBy(control, helper.id);
        if (inputType === 'text') {
          ensureControlDescribedBy(control, textCounter.id);
          ensureControlDescribedBy(control, textStatus.id);
        }
        ensureControlDescribedBy(control, inputError.id);
      }
      answerControls.set(block.blockId, control);
      if (inputType === 'text') {
        textControlFeedback.set(block.blockId, {
          counter: textCounter,
          status: textStatus,
        });
        card.append(label);
        if (checkBadge && checkReveal) {
          card.append(checkBadge, checkReveal);
        }
        card.append(helper, control, textCounter, textStatus, inputError);
      } else {
        card.append(label);
        if (checkBadge && checkReveal) {
          card.append(checkBadge, checkReveal);
        }
        card.append(helper, control, inputError);
      }
      blockList.appendChild(card);
  };

  const syncAnswerControlValues = (currentBlock) => {
    if (!currentBlock || currentBlock.kind !== 'question') return;
    const activeElement = document.activeElement;
    const block = currentBlock;
    const control = answerControls.get(block.blockId);
    if (!control) return;
      const inputType = block.responseConfig?.inputType || 'text';
      const storedValue = session.state.answers?.[block.blockId]?.value;
      const cachedRawValue = localInputCache.get(block.blockId);
      const nextValue = cachedRawValue !== undefined
        ? String(cachedRawValue)
        : inputType === 'number'
        ? (storedValue === '' || storedValue === null || storedValue === undefined ? '' : String(storedValue))
        : inputType === 'boolean'
          ? (storedValue === true ? 'true' : storedValue === false ? 'false' : '')
          : String(storedValue || '');
      if (inputType === 'multiple_choice') {
        applyChoiceButtonGroupState(
          control,
          storedValue,
          block.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single',
          session.state.status === 'completed'
        );
      } else if (inputType === 'boolean') {
        applyBooleanGroupState(control, storedValue, session.state.status === 'completed');
      } else if (control !== activeElement && control.value !== nextValue) {
        control.value = nextValue;
      }
      if (inputType === 'text') {
        const feedbackNodes = textControlFeedback.get(block.blockId);
        const feedback = computeTextLengthFeedback(control.value, block.responseConfig?.maxLength || 200);
        updateTextCounterUI(feedbackNodes?.counter, feedbackNodes?.status, feedback);
      }
      if (inputType !== 'multiple_choice' && inputType !== 'boolean') {
        control.disabled = session.state.status === 'completed';
      }
      const card = control.closest('.question-card');
      const errorNode = card?.querySelector('.input-error');
      if (errorNode) {
        errorNode.textContent = inputType === 'number' ? (numberInputErrors.get(block.blockId) || '') : '';
      }
  };

  const persistNavigationState = (orderedBlocks) => {
    session.state.lastActiveIndex = currentBlockIndex;
    session.state.lastActiveBlockId = orderedBlocks[currentBlockIndex]?.blockId || null;
    session.state.attemptRevision += 1;
    session.scheduleAutosave();
  };

  const goPrev = () => {
    currentBlockIndex = Math.max(0, currentBlockIndex - 1);
    const orderedBlocks = getOrderedBlocks();
    persistNavigationState(orderedBlocks);
    renderUI();
  };

  const goNext = () => {
    const orderedBlocks = getOrderedBlocks();
    currentBlockIndex = Math.min(Math.max(orderedBlocks.length - 1, 0), currentBlockIndex + 1);
    persistNavigationState(orderedBlocks);
    renderUI();
  };

  const renderUI = () => {
    const orderedBlocks = getOrderedBlocks();
    if (orderedBlocks.length === 0) return;
    currentBlockIndex = Math.min(Math.max(currentBlockIndex, 0), orderedBlocks.length - 1);
    const currentBlock = orderedBlocks[currentBlockIndex];
    const stepperSignature = getStepperOrderSignature(orderedBlocks);
    const activeIndexChanged = currentBlockIndex !== lastStepperActiveIndex;
    const orderChanged = stepperSignature !== stepperOrderSignature;

    blockHeading.textContent = currentBlock.kind === 'content' ? 'Content' : 'Question';
    if (orderChanged) {
      renderStepper(orderedBlocks, currentBlockIndex, { shouldScrollToActive: activeIndexChanged || orderChanged });
    } else if (activeIndexChanged) {
      updateStepperActiveState(orderedBlocks, currentBlockIndex, { shouldScrollToActive: true });
    }
    stepperOrderSignature = stepperSignature;
    lastStepperActiveIndex = currentBlockIndex;
    renderCurrentBlockCard(currentBlock);
    syncAnswerControlValues(currentBlock);

    const summary = computeAnswerSummary(session.state.viewerPayload, session.state.answers);
    status.textContent = session.state.isFinalizing
      ? 'Finalizing submission…'
      : session.state.lastFinalizeError
        ? `⚠️ ${session.state.lastFinalizeError}`
        : session.state.status === 'completed'
          ? `Finalized${session.state.completedAt ? ` at ${session.state.completedAt}` : ''}`
          : session.state.lastSaveError
            ? `⚠️ ${session.state.lastSaveError}`
            : session.state.autosavePending
              ? 'Saving…'
              : `Saved${session.state.lastSavedAt ? ` at ${session.state.lastSavedAt}` : ''}`;
    resumeWarning.textContent = session.state.recoveryMessage ? `⚠️ ${session.state.recoveryMessage}` : '';
    resumeWarning.hidden = !session.state.recoveryMessage;
    saveBtn.disabled = session.state.isFinalizing;
    completeBtn.disabled = session.state.status === 'completed' || session.state.isFinalizing;
    prevBtn.disabled = currentBlockIndex === 0;
    nextBtn.disabled = currentBlockIndex >= orderedBlocks.length - 1;
    const normalizedAttemptStatus = session.state.status
      ? String(session.state.status).replace(/_/g, '-')
      : 'n/a';
    const summaryParts = [];
    if (studentName) {
      summaryParts.push(`Student ${studentName}`);
    }
    summaryParts.push(`Answered ${summary.answered}/${summary.total}`);
    summaryParts.push(status.textContent);
    summaryParts.push(`Status ${normalizedAttemptStatus}`);
    answerSummary.textContent = summaryParts.join(' · ');
  };

  session.setOnStateChange(() => {
    renderUI();
  });

  saveBtn.addEventListener('click', async () => {
    await session.saveNow();
    renderUI();
  });
  syncResumeBtn.addEventListener('click', async () => {
    closeUtilityMenu({ returnFocus: true });
    await session.triggerProtectedAction('resumeAttemptSyncAfterLogin');
    renderUI();
  });

  rewriteAssistBtn.addEventListener('click', async () => {
    closeUtilityMenu({ returnFocus: true });
    await session.triggerProtectedAction('resumeViewerRewriteAfterLogin');
    renderUI();
  });
  window.addEventListener('resize', () => {
    updateStepperFitState();
    if (currentBlockIndex === 0) {
      stepper.scrollLeft = 0;
    }
  }, { signal });
  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);

  headerTop.append(heading, headerActions);
  header.append(headerTop, answerSummary, resumeWarning);
  blockSection.append(blockHeading, stepper, blockList);
  shell.append(header, blockSection);
  app.innerHTML = '';
  bottomBarRoot.innerHTML = '';
  app.append(shell, detailsModal);
  bottomBarRoot.append(bottomBar);
  renderUI();
}


function renderViewerFatalError(error) {
  if (!app || !bottomBarRoot) {
    return;
  }
  const bootError = asViewerBootError(error);
  const panel = document.createElement('section');
  panel.className = 'viewer-fatal-panel';

  const heading = document.createElement('h1');
  heading.textContent = 'Unable to open worksheet viewer';

  const message = document.createElement('p');
  message.className = 'viewer-fatal-panel__message';
  message.textContent = bootError.userMessage;

  const actionsHeading = document.createElement('h2');
  actionsHeading.className = 'viewer-fatal-panel__subheading';
  actionsHeading.textContent = 'What you can do';

  const actions = document.createElement('ul');
  actions.className = 'viewer-fatal-panel__actions';
  bootError.recoveryActions.forEach((actionText) => {
    const item = document.createElement('li');
    item.textContent = actionText;
    actions.appendChild(item);
  });

  const details = document.createElement('details');
  details.className = 'viewer-fatal-panel__details';
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  const detailBody = document.createElement('pre');
  detailBody.textContent = `${bootError.code}: ${bootError.technicalMessage}`;
  details.append(summary, detailBody);

  panel.append(heading, message, actionsHeading, actions, details);
  app.innerHTML = '';
  bottomBarRoot.innerHTML = '';
  app.append(panel);
}

function renderViewerStartPanel(session, options = {}) {
  if (!app || !bottomBarRoot) {
    return;
  }
  const startWarningMessage = typeof options.warningMessage === 'string' && options.warningMessage.trim()
    ? options.warningMessage.trim()
    : null;

  const panel = document.createElement('section');
  panel.className = 'viewer-start-panel';
  const heading = document.createElement('h1');
  heading.textContent = 'Start Viewer';
  const description = document.createElement('p');
  description.className = 'muted';
  description.textContent = 'Import worksheet JSON to launch a local attempt preview.';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = 'Import worksheet JSON';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.hidden = true;

  const errorMessage = document.createElement('p');
  errorMessage.className = 'viewer-start-error';
  errorMessage.textContent = startWarningMessage || '';
  errorMessage.setAttribute('role', 'status');
  errorMessage.setAttribute('aria-live', 'polite');

  importBtn.addEventListener('click', () => {
    errorMessage.textContent = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const selected = fileInput.files?.[0];
    if (!selected) return;

    try {
      const rawJson = await selected.text();
      await session.startImportedWorksheetFromJsonText(rawJson);
      if (session.state.localAttemptId) {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('localAttemptId', session.state.localAttemptId);
        window.history.replaceState({}, '', nextUrl);
      }
      renderViewerShell(session);
      window.viewerSession = session;
    } catch (error) {
      errorMessage.textContent = error?.message || 'Unable to import worksheet JSON.';
    } finally {
      fileInput.value = '';
    }
  });

  panel.append(heading, description, importBtn, fileInput, errorMessage);
  app.innerHTML = '';
  bottomBarRoot.innerHTML = '';
  app.append(panel);
}

async function bootstrapViewer() {
  const session = new ViewerAttemptSession(viewerStorage);

  const authGate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: RESUME_FLAG_KEY,
    storage: session.storage,
    isAuthenticated: () => new URL(window.location.href).searchParams.get('auth') === '1',
    getCurrentLocalId: () => session.state.localAttemptId || null,
    getCurrentUiState: () => session.getUiRestoreState(),
    persistLocalRecord: () => session.flushLocalStateForAuthRedirect(),
    restoreByLocalId: (localIdToRestore) => session.restoreByLocalId(localIdToRestore),
    restoreUiState: (uiState) => session.applyUiRestoreState(uiState),
    validateIntent: (intent) => Boolean(intent?.actionId && session.state.localAttemptId),
    replayIntent: (intent) => session.replayProtectedAction(intent),
    onRecoveryMessage: (message) => session.setRecoveryMessage(message),
    redirectToAuth: ({ redirectTo }) => {
      const url = new URL(redirectTo);
      url.searchParams.set('auth', '1');
      window.location.assign(url.toString());
    },
  });

  session.authGate = authGate;

  const params = new URLSearchParams(window.location.search);
  const hasAuthReturn = params.get('authReturn') === '1';
  const hasLaunchIntent =
    params.has('localAttemptId')
    || params.has('localDraftId')
    || params.has('viewerPayload')
    || params.has('snapshot')
    || params.has('importedWorksheetId')
    || hasAuthReturn;

  if (!hasLaunchIntent) {
    const flaggedAttempt = session.storage.resumeFlags.get(RESUME_FLAG_KEY);
    if (flaggedAttempt?.localId) {
      const resumed = await session.tryResumeAttempt(flaggedAttempt.localId);
      if (resumed) {
        renderViewerShell(session);
        window.viewerSession = session;
        return;
      }
      session.setRecoveryMessage(
        `We couldn't restore your previous session. Please import the worksheet JSON to continue.`
      );
    }
    renderViewerStartPanel(session, { warningMessage: session.state.recoveryMessage });
    return;
  }

  const hasRealContentIntent =
    params.has('localAttemptId')
    || params.has('localDraftId')
    || params.has('viewerPayload')
    || params.has('snapshot')
    || params.has('importedWorksheetId');

  if (hasAuthReturn) {
    const restoreResult = await authGate.restoreAfterAuthReturn();
    if (session.state.viewerPayload) {
      renderViewerShell(session);
      window.viewerSession = session;
      return;
    }

    if (!hasRealContentIntent) {
      session.setRecoveryMessage(
        session.state.recoveryMessage
        || 'We could not restore your previous auth-return session. Reopen a valid worksheet link or import worksheet JSON again.'
      );
      renderViewerStartPanel(session, { warningMessage: session.state.recoveryMessage });
      return;
    }

    if (restoreResult.status === 'no_pending_intent' || !session.state.viewerPayload) {
      await session.bootstrap();
    }
  } else {
    await session.bootstrap();
  }

  renderViewerShell(session);
  window.viewerSession = session;
}

bootstrapViewer().catch((error) => {
  console.error('Failed to bootstrap viewer', error);
  renderViewerFatalError(error);
});

export {
  ViewerAttemptSession,
  normalizeViewerPayload,
  resolveImportedWorksheetPayload,
  normalizeViewerBlock,
  computeAnswerSummary,
  computeCheckResult,
  hasGradeableQuestions,
  normalizeMultiSelectValues,
  areMultiSelectValuesEqual,
  partitionBlocksForDisplay,
  getInputHelperText,
  getNumberInputErrorMessage,
  coerceAnswerValueForQuestion,
  clampTextAnswer,
  computeTextLengthFeedback,
  updateTextCounterUI,
  getBooleanSelectionState,
  applyBooleanGroupState,
  getChoicePrefix,
  applyChoiceButtonGroupState,
  computeNextChoiceValue,
  deterministicShuffle,
  ensureControlDescribedBy,
  createInputErrorNode,
  renderViewerFatalError,
  ViewerBootError,
  VIEWER_BOOT_ERROR_CODES,
};
