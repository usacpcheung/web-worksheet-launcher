import { viewerStorage } from './storage/index.js';
import { mapSnapshotToViewerPayload } from '../app/contracts/mappers.js';
import { validateViewerPayloadSchema } from '../app/contracts/validators.js';
import { normalizeNumberRules, validateNumberInputFormat } from '../app/contracts/number-input-validator.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';
import { probeSession } from '../app/auth/session-readiness.js';
import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from '../app/auth/auth-popup-flow.js';
import { mapLegacyJsonToPackageModel, parseWorksheetPackage } from '../editor/worksheet-package.js';
import { createServerApiClient } from '../app/api/server-api-client.js';
import {
  DEFAULT_PUBLISHED_PACKAGE_LIMIT,
  fetchPublishedPackagesPage,
  mergePublishedPackageRows,
  normalizePaginationState,
  normalizePublishedPackageFilters,
} from '../app/api/published-packages-service.js';

const app = document.getElementById('app');
const bottomBarRoot = document.getElementById('viewer-bottom-bar-root');

const AUTOSAVE_MS = 1000;
const RESUME_FLAG_KEY = 'viewer:lastSession';
const DEFAULT_LEARNER_ID = 'local_learner';
const TEXT_WARNING_THRESHOLD_RATIO = 0.1;
const VIEWER_SERVER_SESSION_STATES = Object.freeze({
  LOGGED_OUT: 'logged_out',
  CHECKING: 'checking',
  LOGGED_IN: 'logged_in',
});
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please log in again.';
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
        'Import a worksheet package again from the start panel.',
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

function isAuthSessionError(error) {
  const status = Number(error?.status);
  const code = String(error?.code || '').toUpperCase();
  return Boolean(
    error?.requiresSignIn
    || status === 401
    || status === 403
    || code === 'AUTH_REQUIRED'
  );
}

function nowIso() {
  return new Date().toISOString();
}

function formatTimestampForDisplay(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    return 'unknown time';
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatTimestampForReportHeader(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    return '';
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

function maybeParseEncodedJson(rawValue) {
  if (!rawValue) return null;

  try {
    return JSON.parse(rawValue);
  } catch {
    // Continue to base64url decode path.
  }

  try {
    const decoded = decodeBase64Url(rawValue);
    if (!decoded) return null;
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionMediaRefs(mediaRefs) {
  if (!Array.isArray(mediaRefs)) return [];
  return mediaRefs
    .map((ref) => {
      if (!isRecord(ref)) return null;
      if (ref.usage !== 'option_audio') return null;
      if (typeof ref.assetId !== 'string' || !ref.assetId.trim()) return null;
      return { usage: 'option_audio', assetId: String(ref.assetId) };
    })
    .filter(Boolean);
}

function normalizePromptMediaRefs(mediaRefs) {
  if (!Array.isArray(mediaRefs)) return [];
  return mediaRefs
    .map((ref) => {
      if (!isRecord(ref)) return null;
      if (ref.usage !== 'question_image' && ref.usage !== 'question_audio') return null;
      if (typeof ref.assetId !== 'string' || !ref.assetId.trim()) return null;
      return { usage: ref.usage, assetId: String(ref.assetId) };
    })
    .filter(Boolean);
}

function computeStableHash(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `h_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function getSourceIdentity(sourceType, options = {}) {
  if (sourceType === 'local_draft' || sourceType === 'local_draft_preview') {
    return options.sourceLocalDraftId ? `draft:${options.sourceLocalDraftId}` : 'draft:unknown';
  }
  if (sourceType === 'imported_worksheet') {
    return options.sourceImportedWorksheetId ? `imported:${options.sourceImportedWorksheetId}` : 'imported:unknown';
  }
  if (sourceType === 'snapshot_derived') {
    return options.snapshotId ? `snapshot:${options.snapshotId}` : 'snapshot:unknown';
  }
  if (sourceType === 'inline_payload') {
    return options.snapshotId ? `inline:${options.snapshotId}` : 'inline:unknown';
  }
  return `${sourceType || 'unknown'}:${options.worksheetId || 'unknown'}`;
}

function computeViewerPayloadFingerprint(payload) {
  const normalized = normalizeViewerPayload(payload, payload?.title || 'Local worksheet');
  const projection = {
    worksheetId: normalized.worksheetId || null,
    snapshotId: normalized.snapshotId || null,
    title: normalized.title || '',
    blocks: (normalized.blocks || []).map((block) => ({
      blockId: block.blockId,
      kind: block.kind,
      position: block.position,
      prompt: block.prompt
        ? {
          text: block.prompt.text || '',
          format: block.prompt.format || 'plain_text',
          mediaRefs: normalizePromptMediaRefs(block.prompt.mediaRefs),
        }
        : null,
      content: block.content
        ? {
          text: block.content.text || '',
          format: block.content.format || 'plain_text',
        }
        : null,
      responseConfig: isRecord(block.responseConfig)
        ? {
          inputType: block.responseConfig.inputType || 'text',
          selectionMode: block.responseConfig.selectionMode || null,
          options: Array.isArray(block.responseConfig.options)
            ? block.responseConfig.options.map((option, index) => ({
              id: option?.id || `opt_${index}`,
              value: String(option?.value ?? option?.label ?? ''),
              label: String(option?.label ?? option?.value ?? ''),
              mediaRefs: normalizeOptionMediaRefs(option?.mediaRefs),
            }))
            : [],
        }
        : null,
    })),
  };
  return computeStableHash(projection);
}

function buildTechnicalDetailsRows(state = {}) {
  const rows = [
    ['Local attempt ID', state.localAttemptId || 'n/a'],
  ];

  if (state.sourceLocalDraftId) {
    rows.push(['Local draft ID', state.sourceLocalDraftId]);
  }
  if (state.sourceImportedWorksheetId) {
    rows.push(['Imported worksheet ID', state.sourceImportedWorksheetId]);
  }

  return rows;
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
    const inputType = responseConfigSource.inputType == null
      ? 'text'
      : responseConfigSource.inputType;
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
      normalizedResponseConfig.selectionMode = responseConfigSource.selectionMode === 'multi'
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
                id: typeof option.id === 'string' && option.id.trim()
                  ? String(option.id)
                  : `opt_${index}_${computeStableHash(`${value}:${label}`)}`,
                value: String(value),
                label: String(label),
                mediaRefs: normalizeOptionMediaRefs(option.mediaRefs),
              };
            }

            const normalizedOption = String(option);
            return {
              id: `opt_${index}_${computeStableHash(normalizedOption)}`,
              value: normalizedOption,
              label: normalizedOption,
              mediaRefs: [],
            };
          })
        : [];
    }

    if (Object.hasOwn(responseConfigSource, 'correctAnswer')) {
      if (inputType === 'number') {
        const normalizedCorrectAnswer = coerceAnswerValueByInputType('number', responseConfigSource.correctAnswer);
        if (normalizedCorrectAnswer !== '') {
          normalizedResponseConfig.correctAnswer = normalizedCorrectAnswer;
        }
      } else if (inputType === 'boolean') {
        const normalizedCorrectAnswer = coerceAnswerValueByInputType('boolean', responseConfigSource.correctAnswer);
        if (normalizedCorrectAnswer === true || normalizedCorrectAnswer === false) {
          normalizedResponseConfig.correctAnswer = normalizedCorrectAnswer;
        }
      } else if (inputType === 'multiple_choice') {
        if (normalizedResponseConfig.selectionMode === 'multi') {
          const normalizedCorrectAnswer = normalizeMultiSelectValues(responseConfigSource.correctAnswer);
          if (Array.isArray(responseConfigSource.correctAnswer) && normalizedCorrectAnswer.length > 0) {
            normalizedResponseConfig.correctAnswer = normalizedCorrectAnswer;
          }
        } else if (typeof responseConfigSource.correctAnswer === 'string') {
          normalizedResponseConfig.correctAnswer = String(responseConfigSource.correctAnswer);
        }
      }
    }

    return {
      ...base,
      prompt: {
        text: String(safeBlock?.prompt?.text || ''),
        format: safeBlock?.prompt?.format || 'plain_text',
        mediaRefs: normalizePromptMediaRefs(safeBlock?.prompt?.mediaRefs),
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
  reportMediaFeedback,
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
    const row = document.createElement('div');
    row.className = 'choice-button-group__row';
    const value = String(opt.value ?? opt.label ?? '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-button-group__item';
    button.dataset.choiceValue = value;
    button.id = `${controlId}-${String(opt?.id || optionIndex).replace(/[^A-Za-z0-9_-]/g, '_')}`;
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

    const labelWrap = document.createElement('span');
    labelWrap.className = 'choice-button-group__label-wrap';

    const labelText = document.createElement('span');
    labelText.className = 'choice-button-group__label';
    labelText.textContent = String(opt.label ?? opt.value ?? '');
    labelWrap.appendChild(labelText);

    const optionAudioRef = normalizeOptionMediaRefs(opt?.mediaRefs)[0] || null;
    button.append(prefix, labelWrap);

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
    row.appendChild(button);

    if (optionAudioRef) {
      const optionAudioBtn = document.createElement('button');
      optionAudioBtn.type = 'button';
      optionAudioBtn.className = 'choice-audio-btn question-card__prompt-audio-btn';
      optionAudioBtn.textContent = '🔊';
      optionAudioBtn.setAttribute('aria-label', 'Play option audio');
      optionAudioBtn.title = 'Play option audio';
      optionAudioBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (optionAudioBtn.disabled) return;
        optionAudioBtn.disabled = true;

        const result = await session.playAssetAudio(optionAudioRef.assetId, {
          onStart: () => {
            if (typeof reportMediaFeedback === 'function') {
              reportMediaFeedback('');
            }
          },
          onEnded: () => {
            optionAudioBtn.disabled = false;
            if (typeof reportMediaFeedback === 'function') {
              reportMediaFeedback('');
            }
          },
          onError: () => {
            optionAudioBtn.disabled = false;
          },
          onInterrupted: () => {
            optionAudioBtn.disabled = false;
          },
        });
        if (typeof reportMediaFeedback === 'function') {
          if (!result.ok) {
            optionAudioBtn.disabled = false;
            reportMediaFeedback(result.message || 'Unable to play option audio.');
          }
        }
      });
      row.appendChild(optionAudioBtn);
    }

    container.appendChild(row);
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
  return inputType === 'multiple_choice' || inputType === 'boolean' || inputType === 'number';
}

function isSupportedCheckQuestionBlock(block) {
  if (block?.kind !== 'question') {
    return false;
  }

  return isSupportedCheckInputType(block?.responseConfig?.inputType);
}

function hasGradeableQuestions(viewerPayload) {
  return Array.isArray(viewerPayload?.blocks) && viewerPayload.blocks.some((block) => isGradeableQuestionBlock(block));
}

function computeCheckResult(viewerPayload, answers) {
  const checkableQuestions = Array.isArray(viewerPayload?.blocks)
    ? viewerPayload.blocks.filter((block) => isSupportedCheckQuestionBlock(block))
    : [];

  const byBlockId = {};
  const statusByBlockId = {};
  let correctCount = 0;
  let totalQuestions = 0;

  checkableQuestions.forEach((block) => {
    const inputType = block?.responseConfig?.inputType || 'text';
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
    correctCount,
    totalQuestions,
  };
}

function getCheckRevealMessage({ status, learnerAnswerText, correctAnswerText }) {
  const normalizedLearnerAnswer = typeof learnerAnswerText === 'string'
    ? learnerAnswerText.trim()
    : '';
  const learnerClause = normalizedLearnerAnswer.length > 0
    ? `Your answer was: ${normalizedLearnerAnswer}`
    : 'Your answer was: No answer submitted';

  if (status === 'correct') {
    return `Correct answer: ${correctAnswerText}`;
  }

  if (status === 'ungraded_missing_or_invalid_key' || status === 'ungraded_missing_key') {
    return learnerClause;
  }

  return `${learnerClause} · Correct answer: ${correctAnswerText}`;
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

function getOptionLabelByValue(block, rawValue) {
  const options = Array.isArray(block?.responseConfig?.options)
    ? block.responseConfig.options
    : [];
  const normalizedValue = String(rawValue ?? '');
  const matched = options.find((option) => String(option?.value ?? option?.label ?? '') === normalizedValue);
  return matched ? String(matched.label ?? matched.value ?? normalizedValue) : normalizedValue;
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
        return 'No answer submitted';
      }
      const options = Array.isArray(block?.responseConfig?.options)
        ? block.responseConfig.options
        : [];
      const optionOrder = options.map((option) => String(option?.value ?? option?.label ?? ''));
      const orderedValues = optionOrder.filter((value) => normalizedValues.includes(value));
      const remainingValues = normalizedValues.filter((value) => !orderedValues.includes(value));
      return [...orderedValues, ...remainingValues]
        .map((value) => getOptionLabelByValue(block, value))
        .join('\n');
    }

    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
      return 'No answer submitted';
    }
    return getOptionLabelByValue(block, rawValue);
  }

  if (inputType === 'boolean') {
    const normalized = coerceAnswerValueByInputType('boolean', rawValue);
    if (normalized === true) return 'True';
    if (normalized === false) return 'False';
    return 'No answer submitted';
  }

  if (inputType === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      return 'No answer submitted';
    }
    return String(rawValue);
  }

  const textValue = String(rawValue ?? '');
  return textValue.trim() ? textValue : 'No answer submitted';
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
        ? normalizedValues.map((value) => getOptionLabelByValue(block, value)).join('\n')
        : '';
    }
    return typeof correctAnswer === 'string' && correctAnswer.trim()
      ? getOptionLabelByValue(block, correctAnswer)
      : '';
  }

  if (inputType === 'boolean') {
    const normalized = coerceAnswerValueByInputType('boolean', correctAnswer);
    if (normalized === true) return 'True';
    if (normalized === false) return 'False';
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
      label: 'Correct',
      detail: '',
    };
  }

  if (status === 'incorrect') {
    const correctAnswerText = formatCorrectAnswerForPrint(block);
    return {
      status,
      label: 'Incorrect',
      detail: correctAnswerText ? `Correct answer: ${correctAnswerText}` : '',
    };
  }

  return {
    status,
    label: 'Not graded',
    detail: '',
  };
}

function classifyPrintQuestionLayout(question) {
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMultilineTextForHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
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
        message: 'Question image unavailable.',
      };
    }
    const mimeType = normalizePrintImageMimeType(asset?.metadata?.mimeType, 'image/png');
    const src = binaryToDataUrl(asset.binary, mimeType);
    if (!src) {
      return {
        status: 'missing',
        message: 'Question image unavailable.',
      };
    }
    return {
      status: 'ready',
      src,
      alt: 'Question image',
    };
  } catch {
    return {
      status: 'missing',
      message: 'Question image unavailable.',
    };
  }
}

async function buildWorksheetPrintReportModel({
  viewerPayload,
  answers = {},
  studentName = '',
  completedAt = '',
  checkResult = null,
  storage = null,
} = {}) {
  const orderedQuestions = getQuestionBlocksInOrder(viewerPayload);
  const checkedSummary = checkResult
    ? `Checked ${checkResult.correctCount}/${checkResult.totalQuestions} correct`
    : '';

  const questions = await Promise.all(orderedQuestions.map(async (block, index) => {
    const learnerValue = answers?.[block.blockId]?.value;
    const questionImage = await resolvePrintQuestionImage(getQuestionImageRefForPrint(block), storage);
    const question = {
      blockId: block.blockId,
      questionNumber: index + 1,
      promptText: String(block?.prompt?.text || '').trim(),
      answerText: formatAnswerValueForPrint(block, learnerValue),
      result: buildPrintQuestionResult(block, checkResult),
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
      layoutMode: classifyPrintQuestionLayout(question),
      sectionBreakModes: {
        prompt: promptSectionMode,
        answer: answerSectionMode,
        checkedAnswer: checkedAnswerSectionMode,
      },
    };
  }));

  return {
    title: String(viewerPayload?.title || 'Worksheet'),
    studentName: String(studentName || '').trim(),
    completedAtLabel: formatTimestampForReportHeader(completedAt),
    checkedSummary,
    questions,
  };
}

function buildWorksheetPrintReportHtml(reportModel) {
  const studentRow = reportModel.studentName
    ? `
      <div class="print-meta-row">
        <dt>Student</dt>
        <dd>${escapeHtml(reportModel.studentName)}</dd>
      </div>
    `
    : '';
  const completedRow = reportModel.completedAtLabel
    ? `
      <div class="print-meta-row">
        <dt>Completed</dt>
        <dd>${escapeHtml(reportModel.completedAtLabel)}</dd>
      </div>
    `
    : '';
  const checkedRow = reportModel.checkedSummary
    ? `
      <div class="print-meta-row">
        <dt>Check result</dt>
        <dd>${escapeHtml(reportModel.checkedSummary)}</dd>
      </div>
    `
    : '';

  const questionsHtml = reportModel.questions.map((question) => {
    const imageHtml = question.image?.status === 'ready' && question.image?.src
      ? `
        <div class="print-question-image-wrap">
          <img class="print-question-image" src="${escapeHtml(question.image.src)}" alt="${escapeHtml(question.image.alt || 'Question image')}">
        </div>
      `
      : question.image?.status === 'missing'
        ? `<p class="print-question-media-note">${escapeHtml(question.image.message || 'Question image unavailable.')}</p>`
        : '';

    const checkedAnswerSectionClass = `print-question-section--${escapeHtml(question.sectionBreakModes?.checkedAnswer || 'keep')}`;
    const resultHtml = question.result
      ? `
        <section class="print-question-section print-question-section--result ${checkedAnswerSectionClass} print-result-${escapeHtml(question.result.status || 'neutral')}">
          <h3>Checked answer</h3>
          <p class="print-result-label">${escapeHtml(question.result.label)}</p>
          ${question.result.detail ? `<p class="print-result-detail">${formatMultilineTextForHtml(question.result.detail)}</p>` : ''}
        </section>
      `
      : '';

    return `
      <article class="print-question print-question--${escapeHtml(question.layoutMode || 'keep-all')}">
        <header class="print-question-header">
          <div class="print-question-number">Question ${question.questionNumber}</div>
        </header>
        <section class="print-question-section print-question-section--prompt print-question-section--${escapeHtml(question.sectionBreakModes?.prompt || 'keep')}">
          <h3>Question</h3>
          <p class="print-question-text">${formatMultilineTextForHtml(question.promptText || 'No prompt text provided.')}</p>
          ${imageHtml}
        </section>
        <section class="print-question-section print-question-section--answer print-question-section--${escapeHtml(question.sectionBreakModes?.answer || 'keep')}">
          <h3>Answer</h3>
          <p class="print-answer-text">${formatMultilineTextForHtml(question.answerText)}</p>
        </section>
        ${resultHtml}
      </article>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(reportModel.title)} - Print Report</title>
  <style>
    @page {
      size: A4;
      margin: 16mm 14mm 18mm 14mm;
    }

    :root {
      color-scheme: light;
      font-family: "Georgia", "Times New Roman", serif;
      color: #111;
      background: #fff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: #111;
      background: #fff;
      font-size: 11.5pt;
      line-height: 1.45;
    }

    .print-report {
      width: 100%;
    }

    .print-header {
      border-bottom: 1px solid #b8bcc4;
      padding-bottom: 10mm;
      margin-bottom: 9mm;
      break-after: avoid;
    }

    .print-title {
      margin: 0 0 5mm;
      font-size: 20pt;
      line-height: 1.15;
      font-weight: 700;
    }

    .print-meta {
      display: grid;
      gap: 2.5mm;
      margin: 0;
    }

    .print-meta-row {
      display: grid;
      grid-template-columns: 32mm 1fr;
      gap: 4mm;
    }

    .print-meta-row dt {
      font-weight: 700;
    }

    .print-meta-row dd {
      margin: 0;
    }

    .print-question {
      margin: 0 0 9mm;
      padding: 0 0 4mm;
      background: transparent;
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question--keep-all,
    .print-question--keep-head,
    .print-question--flow {
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question-header {
      break-after: avoid;
      page-break-after: avoid;
      margin-bottom: 3mm;
    }

    .print-question-number {
      font-size: 13pt;
      font-weight: 700;
    }

    .print-question-section {
      margin-top: 0;
      padding-top: 0;
    }

    .print-question-section + .print-question-section {
      margin-top: 4.5mm;
      padding-top: 0;
    }

    .print-question-section--keep {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .print-question-section--flow {
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question-section h3 {
      margin: 0 0 2mm;
      font-size: 10pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #444;
      break-after: avoid;
      page-break-after: avoid;
    }

    .print-question-text,
    .print-answer-text,
    .print-result-detail,
    .print-question-media-note,
    .print-result-label {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .print-question-image-wrap {
      margin-top: 4mm;
    }

    .print-question-image {
      display: block;
      max-width: 100%;
      max-height: 60mm;
      border: 1px solid #d7dbe2;
      border-radius: 2mm;
    }

    .print-question-media-note {
      color: #666;
      font-style: italic;
    }

    .print-question-section--result .print-result-label {
      margin-bottom: 1.5mm;
    }

    .print-result-correct .print-result-label {
      font-weight: 700;
    }

    .print-result-incorrect .print-result-label,
    .print-result-ungraded_missing_or_invalid_key .print-result-label {
      font-weight: 700;
    }

    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <main class="print-report">
    <header class="print-header">
      <h1 class="print-title">${escapeHtml(reportModel.title)}</h1>
      <dl class="print-meta">
        ${studentRow}
        ${completedRow}
        ${checkedRow}
      </dl>
    </header>
    ${questionsHtml}
  </main>
  <script>
    (function () {
      const images = Array.from(document.images || []);
      const waitForImages = images.length === 0
        ? Promise.resolve()
        : Promise.all(images.map((img) => (
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
        )));

      waitForImages.then(() => {
        if (typeof window.focus === 'function') {
          window.focus();
        }
        if (typeof window.print === 'function') {
          window.print();
        }
      });

      window.addEventListener('afterprint', () => {
        if (typeof window.close === 'function') {
          window.close();
        }
      });
    }());
  </script>
</body>
</html>`;
}

async function startWorksheetPrintFlow({
  session,
  openWindow = (...args) => window.open(...args),
} = {}) {
  if (!session?.state?.viewerPayload || session.state.status !== 'completed') {
    return {
      ok: false,
      message: 'Submit the worksheet before printing the report.',
    };
  }

  const printWindow = openWindow('', 'worksheet_print_report', 'width=960,height=720,resizable=yes,scrollbars=yes');
  if (!printWindow || !printWindow.document || typeof printWindow.document.open !== 'function') {
    return {
      ok: false,
      message: 'Print window was blocked. Allow popups for this site, then try again.',
    };
  }
  try {
    printWindow.opener = null;
  } catch {
    // Ignore environments that prevent mutating opener.
  }

  const reportModel = await buildWorksheetPrintReportModel({
    viewerPayload: session.state.viewerPayload,
    answers: session.state.answers,
    studentName: session.state.studentName,
    completedAt: session.state.completedAt,
    checkResult: session.state.checkResult,
    storage: session.storage,
  });

  if (
    printWindow.closed
    || !printWindow.document
    || typeof printWindow.document.open !== 'function'
    || typeof printWindow.document.write !== 'function'
    || typeof printWindow.document.close !== 'function'
  ) {
    return {
      ok: false,
      message: 'Print window was closed before the report finished loading. Try printing again.',
    };
  }

  const html = buildWorksheetPrintReportHtml(reportModel);
  try {
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  } catch {
    return {
      ok: false,
      message: 'Unable to load the print report window. Try printing again.',
    };
  }
  return {
    ok: true,
    reportModel,
  };
}

function pickAttemptStudentName(attemptRecord) {
  const direct = typeof attemptRecord?.studentName === 'string' ? attemptRecord.studentName.trim() : '';
  if (direct) return direct;
  const metadata = typeof attemptRecord?.metadata?.studentName === 'string'
    ? attemptRecord.metadata.studentName.trim()
    : '';
  if (metadata) return metadata;
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
  if (inputType === 'multiple_choice') {
    return responseConfig?.selectionMode === 'multi'
      ? 'Choose one or more options.'
      : 'Choose one option only.';
  }
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
  constructor(storage, options = {}) {
    this.storage = storage;
    this.apiClient = options.apiClient || createServerApiClient();
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
      sourceId: null,
      sourceFingerprint: null,
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
      utilityMessage: null,
      undoBuffer: {},
      isRewriting: false,
      rewritingBlockId: null,
      rewriteMessageByBlock: {},
      lastProtectedAction: null,
      serverSession: {
        status: VIEWER_SERVER_SESSION_STATES.CHECKING,
        user: null,
        error: null,
      },
      serverActionMessage: null,
      publishedPackages: [],
      publishedHasMore: false,
      publishedNextOffset: null,
      publishedQuery: '',
      publishedFilters: {
        title: '',
        subject: '',
        owner: '',
      },
      publishedListError: null,
      isLoadingPublishedPackages: false,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
    this.activeAudio = null;
    this.activeAudioObjectUrl = null;
    this.activeAudioPlayback = null;
    this._playRequestId = 0;
    this._authPopupWindow = null;
    this._authPopupFlow = null;
    this._activeAuthFlowId = null;
    this._authAutoLoadInFlightByFlowId = new Set();
    this._openingPublishedPackageIds = new Set();
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  finalizeActiveAudio(reason = 'interrupted') {
    const playback = this.activeAudioPlayback;
    if (!playback || playback.finalized) return;
    playback.finalized = true;
    this.activeAudioPlayback = null;

    const { audio, objectUrl, hooks } = playback;
    if (audio) {
      if (reason === 'interrupted') {
        try {
          audio.pause();
        } catch {
          // no-op
        }
      }
      audio.src = '';
    }

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    this.activeAudio = null;
    this.activeAudioObjectUrl = null;

    if (reason === 'ended') {
      hooks?.onEnded?.();
    } else if (reason === 'error') {
      hooks?.onError?.();
    } else if (reason === 'interrupted') {
      hooks?.onInterrupted?.();
    }
  }

  stopActiveAudio(reason = 'interrupted') {
    this.finalizeActiveAudio(reason);
  }

  async playAssetAudio(assetId, hooks = {}) {
    if (!assetId) {
      return { ok: false, message: 'Audio is not attached to this item.' };
    }
    const requestId = ++this._playRequestId;
    const asset = await this.storage.localAssets?.get?.(assetId);
    if (requestId !== this._playRequestId) {
      return { ok: false, message: 'Audio request superseded.' };
    }
    if (!asset?.binary) {
      return { ok: false, message: `Audio asset is missing (${assetId}).` };
    }

    this.stopActiveAudio();
    const mimeType = asset?.metadata?.mimeType || 'audio/mpeg';
    const objectUrl = URL.createObjectURL(new Blob([asset.binary], { type: mimeType }));
    const audio = new Audio(objectUrl);
    this.activeAudioPlayback = { audio, objectUrl, hooks, finalized: false };
    this.activeAudio = audio;
    this.activeAudioObjectUrl = objectUrl;
    audio.addEventListener('ended', () => {
      if (this.activeAudio === audio) {
        this.stopActiveAudio('ended');
      }
    });
    audio.addEventListener('error', () => {
      if (this.activeAudio === audio) {
        this.stopActiveAudio('error');
      }
    });
    try {
      await audio.play();
      hooks?.onStart?.();
      return { ok: true };
    } catch {
      this.stopActiveAudio('error');
      return { ok: false, message: 'Audio playback failed. File may be blocked or corrupt.' };
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
      const expectedSourceId = attemptRecord.sourceId || attemptRecord.metadata?.sourceId || null;
      const expectedFingerprint = attemptRecord.sourceFingerprint || attemptRecord.metadata?.sourceFingerprint || null;
      const actualSourceId = getSourceIdentity(attemptRecord.sourceType || attemptRecord.metadata?.origin || 'unknown', {
        sourceLocalDraftId: attemptRecord.sourceLocalDraftId || attemptRecord.metadata?.sourceLocalDraftId || null,
        sourceImportedWorksheetId:
          attemptRecord.sourceImportedWorksheetId || attemptRecord.metadata?.sourceImportedWorksheetId || null,
        worksheetId: normalizedPayload?.worksheetId || null,
        snapshotId: normalizedPayload?.snapshotId || null,
      });
      const actualFingerprint = computeViewerPayloadFingerprint(normalizedPayload);
      if ((expectedSourceId && expectedSourceId !== actualSourceId) || (expectedFingerprint && expectedFingerprint !== actualFingerprint)) {
        this.setRecoveryMessage('Saved attempt no longer matches this worksheet source. Start a new attempt.');
        return false;
      }
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
      : null;

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

    const sourceId = getSourceIdentity(source || 'inline_payload', {
      sourceLocalDraftId: options.sourceLocalDraftId || null,
      sourceImportedWorksheetId: options.sourceImportedWorksheetId || null,
      worksheetId: viewerPayload?.worksheetId || null,
      snapshotId: viewerPayload?.snapshotId || null,
    });
    const sourceFingerprint = computeViewerPayloadFingerprint(viewerPayload);

    return {
      localId: localAttemptId,
      localAttemptId,
      viewerPayload,
      learnerId: DEFAULT_LEARNER_ID,
      worksheetId: viewerPayload?.worksheetId || null,
      snapshotId: viewerPayload?.snapshotId || null,
      sourceType: source || 'inline_payload',
      sourceId,
      sourceFingerprint,
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
        sourceId,
        sourceFingerprint,
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
    this.state.sourceId = attemptRecord.sourceId || null;
    this.state.sourceFingerprint = attemptRecord.sourceFingerprint || null;
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
    this.state.undoBuffer = {};
    this.state.isRewriting = false;
    this.state.rewritingBlockId = null;
    this.state.rewriteMessageByBlock = {};

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
    this.state.checkResult = null;
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

  checkAnswers() {
    if (this.state.isFinalizing || this.state.status !== 'completed' || !this.state.viewerPayload) {
      return null;
    }

    this.state.checkResult = computeCheckResult(this.state.viewerPayload, this.state.answers || {});
    this.notifyStateChange();
    return this.state.checkResult;
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
      sourceId: this.state.sourceId || null,
      sourceFingerprint: this.state.sourceFingerprint || null,
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
        sourceId: this.state.sourceId || null,
        sourceFingerprint: this.state.sourceFingerprint || null,
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
    let parsedWorksheet;
    try {
      parsedWorksheet = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`Unable to parse worksheet JSON. ${error?.message || String(error)}`);
    }

    let mappedPackage;
    try {
      mappedPackage = mapLegacyJsonToPackageModel(parsedWorksheet);
    } catch (error) {
      throw new Error(`Imported worksheet is invalid. ${error?.message || String(error)}`);
    }

    return this.startImportedWorksheetFromPackageModel(mappedPackage);
  }

  async startImportedWorksheetFromPackageFile(fileOrBytes) {
    let packageModel;
    try {
      packageModel = parseWorksheetPackage(fileOrBytes);
    } catch (error) {
      throw new Error(`Unable to import worksheet package. ${error?.message || String(error)}`);
    }
    return this.startImportedWorksheetFromPackageModel(packageModel);
  }

  async startImportedWorksheetFromPackageModel(packageModel) {
    const worksheet = packageModel?.worksheet;
    if (!worksheet || typeof worksheet !== 'object') {
      throw new Error('Imported worksheet package is missing worksheet content.');
    }
    const importedAt = nowIso();
    const packageAssets = Array.isArray(packageModel?.assets) ? packageModel.assets : [];

    const importedRecord = {
      localId: createLocalId('imported'),
      worksheet,
      importedAt,
    };
    importedRecord.metadata = {
      localId: importedRecord.localId,
      origin: 'imported_file',
      updatedAt: importedRecord.importedAt,
    };

    const payload = resolveImportedWorksheetPayload(importedRecord);
    await this.validateViewerPayload(payload);

    const persistedAssetIds = [];
    try {
      await this.storage.importedWorksheets.put(importedRecord);

      if (packageAssets.length > 0 && this.storage.localAssets?.put) {
        try {
          for (const asset of packageAssets) {
            if (!asset || typeof asset !== 'object' || typeof asset.assetId !== 'string' || !asset.assetId.trim()) {
              continue;
            }
            if (!(asset.binary instanceof Uint8Array) || asset.binary.byteLength === 0) {
              continue;
            }
            await this.storage.localAssets.put({
              localId: asset.assetId,
              binary: asset.binary,
              metadata: {
                localId: asset.assetId,
                origin: 'imported_package_asset',
                updatedAt: importedAt,
                kind: asset.kind || null,
                usage: asset.usage || null,
                mimeType: asset.mimeType || null,
                path: asset.path || null,
              },
            });
            persistedAssetIds.push(asset.assetId);
          }
        } catch (error) {
          throw new Error(`Failed to save imported package assets. ${error?.message || String(error)}`);
        }
      }
    } catch (error) {
      await Promise.all(
        persistedAssetIds.map((assetId) => this.storage.localAssets?.remove?.(assetId).catch(() => {}))
      );
      await this.storage.importedWorksheets?.remove?.(importedRecord.localId).catch(() => {});
      if (String(error?.message || '').startsWith('Failed to save imported package assets.')) {
        throw error;
      }
      throw new Error(`Failed to save imported worksheet. ${error?.message || String(error)}`);
    }

    try {
      const attempt = this.createLocalAttemptState(payload, 'imported_worksheet', {
        sourceImportedWorksheetId: importedRecord.localId,
      });
      attempt.checkResult = null;
      this.applyAttemptState(attempt, { markDirty: true });
      this.persistResumeMetadata();
      return this.state;
    } catch (error) {
      await Promise.all(
        persistedAssetIds.map((assetId) => this.storage.localAssets?.remove?.(assetId).catch(() => {}))
      );
      await this.storage.importedWorksheets?.remove?.(importedRecord.localId).catch(() => {});
      throw new Error(`Imported worksheet is invalid. ${error?.message || String(error)}`);
    }
  }

  applyUiRestoreState(_ui = {}) {
    this.persistResumeMetadata();
  }

  setRecoveryMessage(message) {
    this.state.recoveryMessage = message || null;
  }

  setRewriteMessage(blockId, message) {
    if (typeof blockId !== 'string' || !blockId) {
      return;
    }
    const nextMessages = { ...(this.state.rewriteMessageByBlock || {}) };
    if (message) {
      nextMessages[blockId] = String(message);
    } else {
      delete nextMessages[blockId];
    }
    this.state.rewriteMessageByBlock = nextMessages;
  }

  async replayProtectedAction(intent) {
    const actionId = typeof intent?.actionId === 'string' ? intent.actionId : '';
    const payload = intent?.payload && typeof intent.payload === 'object' ? intent.payload : {};
    this.state.lastProtectedAction = actionId || null;

    switch (actionId) {
      case 'viewerRewrite':
      case 'resumeViewerRewriteAfterLogin':
        return this.replayViewerRewriteIntent(payload);
      case 'resumeAttemptServerResumeAfterLogin':
        this.setRecoveryMessage(null);
        return { ok: true, status: 'noop_resume_attempt' };
      default:
        this.setRecoveryMessage(null);
        return { ok: true, status: 'noop_unsupported_action' };
    }
  }

  validateViewerRewriteIntentPayload(payload = {}) {
    const currentAttemptId = this.state.localAttemptId || null;
    const intentAttemptId = typeof payload.localAttemptId === 'string' ? payload.localAttemptId : null;
    if (!currentAttemptId || !intentAttemptId || intentAttemptId !== currentAttemptId) {
      return {
        ok: false,
        message: 'Rewrite recovery context is stale. Please retry from the current attempt.',
      };
    }

    const intentBlockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const blocks = Array.isArray(this.state.viewerPayload?.blocks) ? this.state.viewerPayload.blocks : [];
    const matchingBlock = intentBlockId
      ? blocks.find((block) => block?.blockId === intentBlockId)
      : null;
    if (!intentBlockId || !matchingBlock) {
      return {
        ok: false,
        message: 'Rewrite recovery target is no longer available for this worksheet.',
      };
    }

    if (this.state.lastActiveBlockId && this.state.lastActiveBlockId !== intentBlockId) {
      return {
        ok: false,
        message: 'Rewrite recovery target is stale. Navigate to the target question and retry.',
      };
    }

    return { ok: true };
  }

  async replayViewerRewriteIntent(payload = {}) {
    const blockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const validation = this.validateViewerRewriteIntentPayload(payload);
    if (!validation.ok) {
      if (blockId) {
        this.setRewriteMessage(blockId, validation.message);
      } else {
        this.setRecoveryMessage(validation.message);
      }
      console.warn('[viewer] Ignoring stale/invalid rewrite recovery intent.', {
        action: 'viewerRewrite',
        payload,
      });
      return { ok: false, status: 'invalid_context' };
    }

    const blocks = Array.isArray(this.state.viewerPayload?.blocks) ? this.state.viewerPayload.blocks : [];
    const targetBlock = blockId ? blocks.find((block) => block?.blockId === blockId) : null;
    const isRewriteTargetSupported = Boolean(
      targetBlock
      && targetBlock.kind === 'question'
      && targetBlock.responseConfig?.inputType === 'text'
    );
    if (!isRewriteTargetSupported) {
      this.setRewriteMessage(blockId, 'Rewrite is only available for text-response questions.');
      return { ok: false, status: 'unsupported_target' };
    }

    const answerTextAtClickTime = typeof payload.answerTextAtClickTime === 'string'
      ? payload.answerTextAtClickTime
      : String(payload.answerTextAtClickTime ?? '');
    const trimmedClickText = answerTextAtClickTime.trim();
    if (!trimmedClickText) {
      this.setRewriteMessage(blockId, 'Nothing to rewrite yet. Enter a response first, then try Rewrite again.');
      return { ok: false, status: 'empty_source_text' };
    }

    this.state.isRewriting = true;
    this.state.rewritingBlockId = blockId;
    this.setRewriteMessage(blockId, null);
    this.setRecoveryMessage(null);
    this.notifyStateChange();

    const clearRewriteFlags = () => {
      this.state.isRewriting = false;
      this.state.rewritingBlockId = null;
    };

    const currentAnswerValue = (attemptBlockId) => {
      const answerRecord = attemptBlockId ? this.state.answers?.[attemptBlockId] : null;
      const rawValue = answerRecord && typeof answerRecord === 'object'
        ? answerRecord.value
        : answerRecord;
      return typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
    };

    const rewriteResult = await this.apiClient.rewriteText(trimmedClickText);
    if (!rewriteResult?.ok) {
      const rewriteError = rewriteResult?.error || rewriteResult || null;
      const errorCode = typeof rewriteError?.code === 'string' && rewriteError.code.trim()
        ? rewriteError.code.trim()
        : 'UNKNOWN_ERROR';
      const errorStatus = Number.isFinite(Number(rewriteError?.status))
        ? Number(rewriteError.status)
        : null;
      const errorMessage = typeof rewriteError?.message === 'string' && rewriteError.message.trim()
        ? rewriteError.message.trim()
        : 'No additional error message provided.';
      const errorDetails = rewriteError?.details;
      const detailsPreviewLimit = 1200;
      const rawDetailsText = errorDetails == null
        ? ''
        : String(typeof errorDetails === 'object' ? JSON.stringify(errorDetails) : errorDetails);
      const detailsText = rawDetailsText.length > detailsPreviewLimit
        ? `${rawDetailsText.slice(0, detailsPreviewLimit)}...`
        : rawDetailsText;

      clearRewriteFlags();
      this.setRewriteMessage(
        blockId,
        `Rewrite could not be completed. code=${errorCode}${errorStatus !== null ? ` | status=${errorStatus}` : ''} | message=${errorMessage}${detailsText ? ` | details=${detailsText}` : ''}`
      );
      console.error('[viewer] Rewrite request failed.', {
        blockId,
        sourceLength: trimmedClickText.length,
        error: rewriteError,
      });
      this.notifyStateChange();
      return {
        ok: false,
        status: 'rewrite_failed',
        error: rewriteError,
      };
    }

    const currentAttemptId = this.state.localAttemptId || null;
    const intentAttemptId = typeof payload.localAttemptId === 'string' ? payload.localAttemptId : null;
    const refreshedBlocks = Array.isArray(this.state.viewerPayload?.blocks) ? this.state.viewerPayload.blocks : [];
    const refreshedBlock = blockId ? refreshedBlocks.find((block) => block?.blockId === blockId) : null;
    const isFreshContext = Boolean(
      currentAttemptId
      && intentAttemptId
      && currentAttemptId === intentAttemptId
      && refreshedBlock
      && refreshedBlock.kind === 'question'
      && refreshedBlock.responseConfig?.inputType === 'text'
      && this.state.status !== 'completed'
      && (!this.state.lastActiveBlockId || this.state.lastActiveBlockId === blockId)
    );
    const answerMatchesSnapshot = currentAnswerValue(blockId).trim() === trimmedClickText;

    if (!isFreshContext || !answerMatchesSnapshot) {
      clearRewriteFlags();
      this.setRewriteMessage(
        blockId,
        'Your answer changed before rewrite finished, so we did not apply the rewrite. Please review and try again.'
      );
      this.notifyStateChange();
      return { ok: false, status: 'rewrite_stale_context' };
    }

    const preRewriteAnswer = currentAnswerValue(blockId);
    const rewrittenText = String(rewriteResult.data?.text ?? '').trim();
    this.state.undoBuffer = {
      ...this.state.undoBuffer,
      [blockId]: preRewriteAnswer,
    };
    const beforeApplyAnswer = currentAnswerValue(blockId);
    this.setAnswer(blockId, rewrittenText);
    const afterApplyAnswer = currentAnswerValue(blockId);
    if (this.state.status === 'completed' || afterApplyAnswer === beforeApplyAnswer) {
      const nextUndoBuffer = { ...(this.state.undoBuffer || {}) };
      delete nextUndoBuffer[blockId];
      this.state.undoBuffer = nextUndoBuffer;
      clearRewriteFlags();
      this.setRewriteMessage(
        blockId,
        'Rewrite finished, but your answer could not be updated because this attempt is no longer editable.'
      );
      this.notifyStateChange();
      return { ok: false, status: 'rewrite_not_applied' };
    }
    clearRewriteFlags();
    this.setRewriteMessage(blockId, null);
    this.setRecoveryMessage(null);
    this.notifyStateChange();
    return { ok: true, status: 'rewrite_applied' };
  }

  async triggerProtectedAction(actionId, intentPayload = {}) {
    if (!this.authGate) {
      throw new Error('Auth gate is not configured for viewer session.');
    }

    const payload = {
      ...(intentPayload && typeof intentPayload === 'object' ? intentPayload : {}),
      localAttemptId: this.state.localAttemptId || null,
    };

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localAttempts',
      payload,
    });
  }

  beginServerSignIn() {
    if (this._authPopupFlow?.cancel) {
      this._authPopupFlow.cancel();
    }
    const authFlowId = createLocalId('auth_flow');
    this._activeAuthFlowId = authFlowId;

    const finalizeFlow = () => {
      if (this._activeAuthFlowId === authFlowId) {
        this._activeAuthFlowId = null;
      }
      this._authPopupWindow = null;
      this._authPopupFlow = null;
    };

    this._authPopupFlow = startAuthPopupFlow({
      apiClient: this.apiClient,
      source: 'viewer',
      authFlowId,
      pollIntervalMs: AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs,
      pollTimeoutMs: AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs,
      shouldContinue: () => this._activeAuthFlowId === authFlowId,
      onPopupBlocked: () => {
        this.state.serverActionMessage = 'Sign-in popup was blocked. Allow popups for this site, then try again.';
        this.notifyStateChange();
      },
      onStatusMessage: (message) => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (message === 'Complete sign-in in the popup. Session will refresh automatically.') {
          this.state.serverActionMessage = message;
          this.notifyStateChange();
        }
      },
      onSessionReady: async () => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (this._authAutoLoadInFlightByFlowId.has(authFlowId)) return;
        this._authAutoLoadInFlightByFlowId.add(authFlowId);
        try {
          this.state.serverActionMessage = 'Sign-in completed. Refreshing server session…';
          this.notifyStateChange();
          const result = await this.preflightPublishedSession();
          if (result.ok && this.state.serverSession.status === VIEWER_SERVER_SESSION_STATES.LOGGED_IN) {
            await this.browsePublishedPackages(this.state.publishedFilters || {}, { preflight: false, reset: true });
            this.state.serverActionMessage = null;
            this.notifyStateChange();
            finalizeFlow();
            return;
          }
          const fallbackMessage = result?.result?.error?.message || this.state.serverSession?.error || 'Sign-in completed, but session is still not ready.';
          this.state.serverActionMessage = fallbackMessage;
          this.notifyStateChange();
          finalizeFlow();
        } finally {
          this._authAutoLoadInFlightByFlowId.delete(authFlowId);
        }
      },
      onSessionNotReady: (result) => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (result?.final === false && result?.waitingForCallback === true) {
          this.state.serverActionMessage = 'Still waiting for sign-in confirmation from the popup…';
          this.notifyStateChange();
          return;
        }
        if (result?.error?.code === 'SESSION_WAIT_CANCELLED') {
          finalizeFlow();
          return;
        }
        if (this.state.serverActionMessage === 'Sign-in popup was blocked. Allow popups for this site, then try again.') {
          finalizeFlow();
          return;
        }
        this.state.serverActionMessage = result?.error?.message || this.state.serverActionMessage;
        this.notifyStateChange();
        finalizeFlow();
        this._authAutoLoadInFlightByFlowId.delete(authFlowId);
      },
    });
    this._authPopupWindow = this._authPopupFlow?.popupWindow || null;
  }

  async refreshServerSession() {
    this.state.serverSession = {
      status: VIEWER_SERVER_SESSION_STATES.CHECKING,
      user: null,
      error: null,
    };
    this.notifyStateChange();
    return this.probeServerSessionSilently({ force: true });
  }

  transitionServerSessionToLoggedOut(message = SESSION_EXPIRED_MESSAGE) {
    const resolvedMessage = String(message || '').trim() || SESSION_EXPIRED_MESSAGE;
    this.state.serverSession = {
      status: VIEWER_SERVER_SESSION_STATES.LOGGED_OUT,
      user: null,
      error: resolvedMessage,
    };
    this.state.serverActionMessage = resolvedMessage;
    this.notifyStateChange();
  }

  async probeServerSessionSilently({ force = false } = {}) {
    const result = await probeSession({ apiClient: this.apiClient, force });
    if (result.status !== 'ready') {
      const message = result.error?.message || 'Sign-in is required before using server features.';
      if (isAuthSessionError(result.error)) {
        this.transitionServerSessionToLoggedOut(SESSION_EXPIRED_MESSAGE);
      } else {
        this.state.serverSession = {
          status: VIEWER_SERVER_SESSION_STATES.CHECKING,
          user: null,
          error: message,
        };
        this.state.serverActionMessage = message;
        this.notifyStateChange();
      }
      return result;
    }
    this.state.serverSession = {
      status: VIEWER_SERVER_SESSION_STATES.LOGGED_IN,
      user: result.user || null,
      error: null,
    };
    this.notifyStateChange();
    return result;
  }

  async ensureServerSessionReady(notReadyMessage = 'Sign-in is required before using server features.') {
    const result = await this.probeServerSessionSilently({ force: true });
    if (result.ok && this.state.serverSession.status === VIEWER_SERVER_SESSION_STATES.LOGGED_IN) {
      return { ok: true, result };
    }
    const message = result.error?.message || notReadyMessage;
    if (result.status === 'not_ready' && isAuthSessionError(result.error)) {
      this.transitionServerSessionToLoggedOut(SESSION_EXPIRED_MESSAGE);
    } else {
      this.state.serverSession = {
        status: VIEWER_SERVER_SESSION_STATES.CHECKING,
        user: null,
        error: message,
      };
      this.state.serverActionMessage = message;
      this.notifyStateChange();
    }
    return { ok: false, result };
  }

  async preflightPublishedSession() {
    return this.ensureServerSessionReady();
  }

  async browsePublishedPackages(query = '', options = {}) {
    const requestedFilters = typeof query === 'object' && query !== null
      ? query
      : { title: query, subject: '', owner: '' };
    const normalizedFilters = normalizePublishedPackageFilters(requestedFilters);
    const previousFilters = normalizePublishedPackageFilters(this.state.publishedFilters || {});
    const filtersChanged = (
      previousFilters.title !== normalizedFilters.title
      || previousFilters.subject !== normalizedFilters.subject
      || previousFilters.owner !== normalizedFilters.owner
    );
    const isAppend = options.append === true && !filtersChanged && options.reset !== true;

    this.state.publishedFilters = normalizedFilters;
    this.state.publishedQuery = normalizedFilters.title;
    if (filtersChanged || options.reset === true) {
      this.state.publishedPackages = [];
      this.state.publishedHasMore = false;
      this.state.publishedNextOffset = null;
      this.state.publishedListError = null;
    }
    this.notifyStateChange();

    if (options.preflight !== false) {
      const sessionReady = await this.preflightPublishedSession();
      if (!sessionReady.ok) return sessionReady.result;
    }
    this.state.isLoadingPublishedPackages = true;
    this.notifyStateChange();
    const requestOffset = isAppend && Number.isFinite(Number(this.state.publishedNextOffset))
      ? Number(this.state.publishedNextOffset)
      : 0;
    const filters = normalizePublishedPackageFilters(normalizedFilters);
    const pagination = normalizePaginationState({
      limit: DEFAULT_PUBLISHED_PACKAGE_LIMIT,
      offset: requestOffset,
    });
    const result = await fetchPublishedPackagesPage({
      apiClient: this.apiClient,
      filters,
      pagination,
    });
    this.state.isLoadingPublishedPackages = false;
    if (!result.ok) {
      this.state.serverActionMessage = result.error.message;
      this.state.publishedListError = result.error.message;
      this.notifyStateChange();
      return result;
    }
    const nextItems = Array.isArray(result.data?.items) ? result.data.items : [];
    this.state.publishedPackages = mergePublishedPackageRows({
      existingRows: this.state.publishedPackages,
      incomingRows: nextItems,
      append: isAppend,
    });
    this.state.publishedHasMore = result.data?.hasMore === true;
    this.state.publishedNextOffset = Number.isFinite(Number(result.data?.nextOffset))
      ? Number(result.data.nextOffset)
      : null;
    this.state.publishedListError = null;
    this.state.serverActionMessage = null;
    this.notifyStateChange();
    return result;
  }

  async startFromPublishedPackage(publishedPackageId) {
    const normalizedPublishedPackageId = String(publishedPackageId || '').trim();
    if (!normalizedPublishedPackageId) {
      const message = 'Published package ID is required.';
      this.state.serverActionMessage = message;
      this.notifyStateChange();
      return { ok: false, error: { message } };
    }
    if (this._openingPublishedPackageIds.has(normalizedPublishedPackageId)) {
      return { ok: false, skipped: true, error: { message: `Open already in progress for ${normalizedPublishedPackageId}.` } };
    }
    this._openingPublishedPackageIds.add(normalizedPublishedPackageId);
    try {
      const sessionReady = await this.preflightPublishedSession();
      if (!sessionReady.ok) return sessionReady.result;
      const artifact = await this.apiClient.fetchPublishedPackageArtifact(normalizedPublishedPackageId);
      if (!artifact.ok) {
        this.state.serverActionMessage = artifact.error.message;
        this.notifyStateChange();
        return artifact;
      }
      const started = await this.startImportedWorksheetFromPackageFile(artifact.data);
      this.state.serverActionMessage = `Imported published package ${normalizedPublishedPackageId} into local viewer runtime.`;
      this.notifyStateChange();
      return { ok: true, data: started };
    } finally {
      this._openingPublishedPackageIds.delete(normalizedPublishedPackageId);
    }
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

  async discardAttempt(localAttemptId) {
    if (!localAttemptId) return;
    await this.storage.attempts.remove(localAttemptId);
    const flagged = this.storage.resumeFlags.get(RESUME_FLAG_KEY);
    if (flagged?.localId === localAttemptId) {
      this.storage.resumeFlags.clear(RESUME_FLAG_KEY);
    }
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
  const utilityFeedback = document.createElement('p');
  utilityFeedback.className = 'viewer-utility-feedback';
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
  saveBtn.className = 'viewer-bottom-action-btn';
  saveBtn.textContent = 'Save';
  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.className = 'viewer-bottom-action-btn';
  completeBtn.textContent = 'Submit';
  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'viewer-bottom-action-btn';
  checkBtn.textContent = 'Check Answer';

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
  syncResumeBtn.textContent = 'Server Resume (Sign-in required)';

  const printReportBtn = document.createElement('button');
  printReportBtn.type = 'button';
  printReportBtn.className = 'viewer-utility-menu__item';
  printReportBtn.setAttribute('role', 'menuitem');
  printReportBtn.textContent = 'Print worksheet report';
  utilityMenuList.append(syncResumeBtn, printReportBtn);
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

  const showBottomButtonClickFeedback = (button) => {
    if (!button) return;
    button.classList.remove('is-click-feedback');
    // Force restart of animation for repeated clicks.
    void button.offsetWidth;
    button.classList.add('is-click-feedback');
  };

  completeBtn.addEventListener('click', async () => {
    showBottomButtonClickFeedback(completeBtn);
    await session.completeLocalAttempt();
    renderUI();
  });
  checkBtn.addEventListener('click', () => {
    showBottomButtonClickFeedback(checkBtn);
    session.checkAnswers();
    renderUI();
  });
  leftZone.append(saveBtn);
  rightZone.append(completeBtn, checkBtn);
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
    const technicalRows = buildTechnicalDetailsRows(session.state);
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

  const getTrimmedAnswerTextForBlock = (blockId) => {
    if (!blockId) return '';
    const answerRecord = session.state.answers?.[blockId];
    const rawAnswer = answerRecord && typeof answerRecord === 'object'
      ? answerRecord.value
      : answerRecord;
    return typeof rawAnswer === 'string'
      ? rawAnswer.trim()
      : String(rawAnswer ?? '').trim();
  };

  const buildViewerRewriteIntentPayloadForBlock = (questionBlock) => {
    const localAttemptId = typeof session.state.localAttemptId === 'string'
      ? session.state.localAttemptId
      : null;
    const blockId = typeof questionBlock?.blockId === 'string' ? questionBlock.blockId : null;
    const isTextQuestion = Boolean(
      questionBlock
      && questionBlock.kind === 'question'
      && questionBlock.responseConfig?.inputType === 'text'
      && blockId
    );
    if (!localAttemptId || !isTextQuestion) {
      return null;
    }
    return {
      localAttemptId,
      blockId,
      answerTextAtClickTime: getTrimmedAnswerTextForBlock(blockId),
    };
  };

  const renderCurrentBlockCard = (currentBlock) => {
    const currentBlockCheckStatus = currentBlock?.blockId
      ? session.state.checkResult?.statusByBlockId?.[currentBlock.blockId]
      : undefined;
    const hasGlobalCheckResult = session.state.checkResult !== null;
    const currentBlockIsCheckable = isSupportedCheckQuestionBlock(currentBlock);
    const hasCurrentBlockCheckStatus = typeof currentBlockCheckStatus === 'string';
    const shouldShowCheckFeedback = hasGlobalCheckResult && currentBlockIsCheckable && hasCurrentBlockCheckStatus;
    const currentBlockId = currentBlock?.blockId || null;
    const currentBlockInputType = currentBlock?.responseConfig?.inputType || null;

    const nextSignature = JSON.stringify({
      blockId: currentBlockId,
      prompt: currentBlock?.prompt?.text || '',
      content: currentBlock?.content?.text || '',
      inputType: currentBlockInputType,
      maxLength: currentBlock?.responseConfig?.maxLength || null,
      options: Array.isArray(currentBlock?.responseConfig?.options)
        ? currentBlock.responseConfig.options.map((opt) => [
          opt?.id ?? '',
          opt?.value ?? '',
          opt?.label ?? '',
          JSON.stringify(normalizeOptionMediaRefs(opt?.mediaRefs)),
        ])
        : [],
      hasGlobalCheckResult,
      currentBlockIsCheckable,
      currentBlockCheckStatus: hasCurrentBlockCheckStatus ? currentBlockCheckStatus : null,
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
    const mediaFeedback = document.createElement('p');
    mediaFeedback.className = 'viewer-media-feedback';
    mediaFeedback.setAttribute('role', 'status');
    mediaFeedback.setAttribute('aria-live', 'polite');
    const setMediaFeedback = (message) => {
      mediaFeedback.textContent = message || '';
    };

    const promptMediaRefs = normalizePromptMediaRefs(block.prompt?.mediaRefs);
    const questionImageRef = promptMediaRefs.find((ref) => ref.usage === 'question_image') || null;
    const questionAudioRef = promptMediaRefs.find((ref) => ref.usage === 'question_audio') || null;

    const promptRow = document.createElement('div');
    promptRow.className = 'question-card__prompt-row';
    const promptTextWrap = document.createElement('div');
    promptTextWrap.className = 'question-card__prompt-text';
    promptTextWrap.append(label);
    promptRow.append(promptTextWrap);
    card.append(promptRow);

    if (questionAudioRef?.assetId) {
      const questionAudioBtn = document.createElement('button');
      questionAudioBtn.type = 'button';
      questionAudioBtn.className = 'question-card__prompt-audio-btn';
      questionAudioBtn.setAttribute('aria-label', 'Play question audio');
      questionAudioBtn.title = 'Play question audio';
      questionAudioBtn.textContent = '🔊';
      questionAudioBtn.addEventListener('click', async () => {
        if (questionAudioBtn.disabled) return;
        questionAudioBtn.disabled = true;

        const result = await session.playAssetAudio(questionAudioRef.assetId, {
          onStart: () => {
            setMediaFeedback('');
          },
          onEnded: () => {
            questionAudioBtn.disabled = false;
            setMediaFeedback('');
          },
          onError: () => {
            questionAudioBtn.disabled = false;
          },
          onInterrupted: () => {
            questionAudioBtn.disabled = false;
          },
        });
        if (!result.ok) {
          questionAudioBtn.disabled = false;
          setMediaFeedback(result.message || 'Unable to play question audio.');
        }
      });
      promptRow.append(questionAudioBtn);
    }

    if (questionImageRef?.assetId) {
      const imageWrap = document.createElement('div');
      imageWrap.className = 'viewer-question-image-wrap';
      const imageEl = document.createElement('img');
      imageEl.className = 'viewer-question-image';
      imageEl.alt = 'Question image';
      imageWrap.appendChild(imageEl);
      card.append(imageWrap);
      session.storage.localAssets?.get?.(questionImageRef.assetId).then((asset) => {
        if (!asset?.binary) {
          setMediaFeedback(`Question image is missing (${questionImageRef.assetId}).`);
          return;
        }
        const mimeType = asset?.metadata?.mimeType || 'image/png';
        const objectUrl = URL.createObjectURL(new Blob([asset.binary], { type: mimeType }));
        imageEl.onload = () => URL.revokeObjectURL(objectUrl);
        imageEl.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          setMediaFeedback('Question image could not be rendered (file may be corrupt).');
          imageWrap.remove();
        };
        imageEl.src = objectUrl;
      }).catch(() => {
        setMediaFeedback('Question image could not be loaded.');
      });
    }

      let checkBanner = null;
      let checkReveal = null;
      if (shouldShowCheckFeedback) {
        const checkStatus = currentBlockCheckStatus;
        const isCorrect = checkStatus === 'correct';
        const isIncorrect = checkStatus === 'incorrect';
        const isUngradedMissingOrInvalidKey = checkStatus === 'ungraded_missing_or_invalid_key'
          || checkStatus === 'ungraded_missing_key';
        const correctAnswer = block.responseConfig?.correctAnswer;
        const learnerAnswer = session.state.answers?.[block.blockId]?.value;
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

        const formatLearnerAnswer = () => {
          if (inputType === 'multiple_choice') {
            if (block.responseConfig?.selectionMode === 'multi') {
              return Array.isArray(learnerAnswer) ? learnerAnswer.map((value) => String(value)).join(', ') : '';
            }
            return String(learnerAnswer ?? '');
          }
          if (inputType === 'boolean') {
            const normalized = coerceAnswerValueByInputType('boolean', learnerAnswer);
            if (normalized === true) return 'True';
            if (normalized === false) return 'False';
            return '';
          }
          if (inputType === 'number') {
            return learnerAnswer === '' || learnerAnswer === null || learnerAnswer === undefined
              ? ''
              : String(learnerAnswer);
          }
          return '';
        };

        checkBanner = document.createElement('div');
        checkBanner.className = `viewer-check-banner ${isCorrect ? 'is-correct' : isIncorrect ? 'is-incorrect' : 'is-ungraded'}`;
        const checkIcon = document.createElement('span');
        checkIcon.className = 'viewer-check-banner__icon';
        checkIcon.textContent = isCorrect ? '✓' : isIncorrect ? '✕' : '•';
        const checkBody = document.createElement('div');
        checkBody.className = 'viewer-check-banner__body';
        const checkTitle = document.createElement('p');
        checkTitle.className = 'viewer-check-banner__title';
        checkTitle.textContent = isCorrect ? 'Correct' : isIncorrect ? 'Incorrect' : 'Not graded';
        const checkDetail = document.createElement('p');
        checkDetail.className = 'viewer-check-banner__detail';
        checkDetail.textContent = isCorrect
          ? 'Great Work!'
          : isIncorrect
            ? 'Not quite.'
            : 'Answer key missing or invalid for this question.';
        checkBody.append(checkTitle, checkDetail);
        checkBanner.append(checkIcon, checkBody);

        checkReveal = document.createElement('p');
        checkReveal.className = 'viewer-check-reveal muted';
        checkReveal.textContent = getCheckRevealMessage({
          status: checkStatus,
          learnerAnswerText: formatLearnerAnswer(),
          correctAnswerText: isUngradedMissingOrInvalidKey ? '' : formatCorrectAnswer(),
        });

        if (isCorrect) {
          card.classList.add('question-card--checked-correct');
        } else if (isIncorrect) {
          card.classList.add('question-card--checked-incorrect');
        }
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
          if (Object.prototype.hasOwnProperty.call(session.state.undoBuffer || {}, block.blockId)) {
            const nextUndoBuffer = { ...(session.state.undoBuffer || {}) };
            delete nextUndoBuffer[block.blockId];
            session.state.undoBuffer = nextUndoBuffer;
          }
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
          reportMediaFeedback: setMediaFeedback,
        });
      } else {
        control = document.createElement('textarea');
        control.rows = 5;
        control.addEventListener('input', () => {
          cacheRawControlValue(block.blockId, control.value);
          if (Object.prototype.hasOwnProperty.call(session.state.undoBuffer || {}, block.blockId)) {
            const nextUndoBuffer = { ...(session.state.undoBuffer || {}) };
            delete nextUndoBuffer[block.blockId];
            session.state.undoBuffer = nextUndoBuffer;
          }
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
        const rewriteRow = document.createElement('div');
        rewriteRow.className = 'question-card__rewrite-row';

        const rewriteButton = document.createElement('button');
        rewriteButton.type = 'button';
        rewriteButton.className = 'question-card__rewrite-btn';
        rewriteButton.textContent = 'Rewrite';
        rewriteButton.addEventListener('click', async () => {
          if (rewriteButton.disabled) {
            return;
          }
          const rewriteIntentPayload = buildViewerRewriteIntentPayloadForBlock(block);
          if (!rewriteIntentPayload) {
            session.state.utilityMessage = 'Rewrite is available only for text-response questions.';
            renderUI();
            return;
          }
          session.state.utilityMessage = null;
          await session.triggerProtectedAction('viewerRewrite', rewriteIntentPayload);
          renderUI();
        });

        const undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.className = 'question-card__undo-btn';
        undoButton.textContent = 'Undo';
        undoButton.addEventListener('click', () => {
          if (undoButton.disabled) {
            return;
          }
          const savedUndoAnswer = session.state.undoBuffer?.[block.blockId];
          if (savedUndoAnswer === undefined) {
            return;
          }
          session.setAnswer(block.blockId, savedUndoAnswer);
          const nextUndoBuffer = { ...(session.state.undoBuffer || {}) };
          delete nextUndoBuffer[block.blockId];
          session.state.undoBuffer = nextUndoBuffer;
          renderUI();
        });

        const rewriteHint = document.createElement('p');
        rewriteHint.className = 'question-card__rewrite-hint';
        const rewriteError = document.createElement('p');
        rewriteError.className = 'question-card__rewrite-error';
        rewriteRow.append(rewriteButton, undoButton, rewriteHint, rewriteError);

        if (!card.contains(label)) card.append(label);
        if (checkBanner && checkReveal) {
          card.append(checkBanner, checkReveal);
        }
        card.append(helper, control, mediaFeedback, textCounter, textStatus, rewriteRow, inputError);
      } else {
        if (!card.contains(label)) card.append(label);
        if (checkBanner && checkReveal) {
          card.append(checkBanner, checkReveal);
        }
        card.append(helper, control, mediaFeedback, inputError);
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
        const card = control.closest('.question-card');
        const rewriteButton = card?.querySelector('.question-card__rewrite-btn');
        const undoButton = card?.querySelector('.question-card__undo-btn');
        const rewriteHint = card?.querySelector('.question-card__rewrite-hint');
        const rewriteError = card?.querySelector('.question-card__rewrite-error');
        const trimmedAnswerLength = getTrimmedAnswerTextForBlock(block.blockId).length;
        const isAttemptCompleted = session.state.status === 'completed';
        const hasUndoEntry = Object.prototype.hasOwnProperty.call(session.state.undoBuffer || {}, block.blockId);
        const isRewriteInFlight = session.state.isRewriting && session.state.rewritingBlockId === block.blockId;
        const canRewriteByLength = trimmedAnswerLength > 0 && trimmedAnswerLength <= 300;
        const canRewrite = !isAttemptCompleted && !isRewriteInFlight && canRewriteByLength;

        if (rewriteButton) {
          rewriteButton.textContent = isRewriteInFlight ? 'Rewriting…' : 'Rewrite';
          rewriteButton.disabled = !canRewrite;
        }
        if (undoButton) {
          undoButton.disabled = isAttemptCompleted || !hasUndoEntry;
        }
        if (rewriteHint) {
          if (trimmedAnswerLength === 0) {
            rewriteHint.textContent = 'Enter text to rewrite.';
          } else if (trimmedAnswerLength > 300) {
            rewriteHint.textContent = 'Answer is too long to rewrite (max 300 characters).';
          } else {
            rewriteHint.textContent = '';
          }
        }
        if (rewriteError) {
          const rewriteInlineMessage = String(session.state.rewriteMessageByBlock?.[block.blockId] || '');
          rewriteError.textContent = rewriteInlineMessage ? `⚠️ ${rewriteInlineMessage}` : '';
        }
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
    utilityFeedback.textContent = session.state.utilityMessage ? `⚠️ ${session.state.utilityMessage}` : '';
    utilityFeedback.hidden = !session.state.utilityMessage;
    saveBtn.disabled = session.state.isFinalizing;
    completeBtn.disabled = session.state.status === 'completed' || session.state.isFinalizing;
    const checkAvailable = session.state.status === 'completed';
    checkBtn.hidden = !checkAvailable;
    checkBtn.disabled = session.state.isFinalizing || !checkAvailable;
    printReportBtn.hidden = !checkAvailable;
    printReportBtn.disabled = session.state.isFinalizing || !checkAvailable;
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
    if (session.state.checkResult) {
      summaryParts.push(`Checked ${session.state.checkResult.correctCount}/${session.state.checkResult.totalQuestions} correct`);
    }
    summaryParts.push(status.textContent);
    summaryParts.push(`Status ${normalizedAttemptStatus}`);
    answerSummary.textContent = summaryParts.join(' · ');
  };

  session.setOnStateChange(() => {
    renderUI();
  });

  saveBtn.addEventListener('click', async () => {
    showBottomButtonClickFeedback(saveBtn);
    await session.saveNow();
    renderUI();
  });
  syncResumeBtn.addEventListener('click', async () => {
    closeUtilityMenu({ returnFocus: true });
    await session.triggerProtectedAction('resumeAttemptServerResumeAfterLogin');
    renderUI();
  });

  printReportBtn.addEventListener('click', async () => {
    closeUtilityMenu({ returnFocus: true });
    session.state.utilityMessage = null;
    const result = await startWorksheetPrintFlow({ session });
    if (!result.ok) {
      session.state.utilityMessage = result.message;
    }
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
  header.append(headerTop, answerSummary, resumeWarning, utilityFeedback);
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
  description.textContent = 'Resume local attempts, import a worksheet, or load a published online version.';
  const resumeAttempt = options.resumeAttempt || null;
  const onResumeAttempt = typeof options.onResumeAttempt === 'function' ? options.onResumeAttempt : null;
  const onDiscardResume = typeof options.onDiscardResume === 'function' ? options.onDiscardResume : null;
  const importPackageBtn = document.createElement('button');
  importPackageBtn.type = 'button';
  importPackageBtn.className = 'viewer-start-btn viewer-start-btn--primary';
  importPackageBtn.textContent = 'Import worksheet package (.zip)';

  const importActions = document.createElement('div');
  importActions.className = 'viewer-start-actions';
  importActions.append(importPackageBtn);
  const serverActions = document.createElement('div');
  serverActions.className = 'viewer-start-actions';
  const signInBtn = document.createElement('button');
  signInBtn.type = 'button';
  signInBtn.className = 'viewer-start-btn';
  signInBtn.textContent = 'Log in to view published online worksheet';
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.type = 'button';
  loadMoreBtn.className = 'viewer-start-btn viewer-load-more-btn';
  loadMoreBtn.textContent = 'Load more';
  loadMoreBtn.hidden = true;
  const loadMoreRow = document.createElement('div');
  loadMoreRow.className = 'viewer-load-more-row';
  loadMoreRow.append(loadMoreBtn);
  const filterRow = document.createElement('div');
  filterRow.className = 'viewer-start-actions viewer-published-filters';
  const publishedHeading = document.createElement('h2');
  publishedHeading.className = 'viewer-published-heading';
  publishedHeading.textContent = 'Published Packages';
  const titleFilterInput = document.createElement('input');
  titleFilterInput.type = 'search';
  titleFilterInput.placeholder = 'Filter by title';
  titleFilterInput.className = 'viewer-details-form__input';
  titleFilterInput.setAttribute('aria-label', 'Filter published packages by title');
  const subjectFilterInput = document.createElement('input');
  subjectFilterInput.type = 'search';
  subjectFilterInput.placeholder = 'Filter by subject';
  subjectFilterInput.className = 'viewer-details-form__input';
  subjectFilterInput.setAttribute('aria-label', 'Filter published packages by subject');
  const ownerFilterInput = document.createElement('input');
  ownerFilterInput.type = 'search';
  ownerFilterInput.placeholder = 'Filter by owner';
  ownerFilterInput.className = 'viewer-details-form__input';
  ownerFilterInput.setAttribute('aria-label', 'Filter published packages by owner');
  filterRow.append(titleFilterInput, subjectFilterInput, ownerFilterInput);
  const sessionStatus = document.createElement('p');
  sessionStatus.className = 'muted viewer-session-status';
  const publishedList = document.createElement('div');
  publishedList.className = 'muted viewer-published-list';

  const packageFileInput = document.createElement('input');
  packageFileInput.type = 'file';
  packageFileInput.accept = 'application/zip,.zip';
  packageFileInput.hidden = true;

  const errorMessage = document.createElement('p');
  errorMessage.className = 'viewer-start-error';
  errorMessage.textContent = startWarningMessage || '';
  errorMessage.setAttribute('role', 'status');
  errorMessage.setAttribute('aria-live', 'polite');

  let resumeCard = null;
  if (resumeAttempt) {
    resumeCard = document.createElement('div');
    resumeCard.className = 'viewer-resume-card';
    const resumeTitle = document.createElement('h2');
    resumeTitle.textContent = 'Resume previous attempt';
    const resumeMeta = document.createElement('p');
    resumeMeta.className = 'muted';
    const resumeUpdatedAt =
      resumeAttempt.metadata?.updatedAt
      || resumeAttempt.lastSavedAt
      || resumeAttempt.startedAt
      || null;
    resumeMeta.textContent = `Attempt ${resumeAttempt.localId || 'unknown'} · ${formatTimestampForDisplay(resumeUpdatedAt)}`;
    const resumeActions = document.createElement('div');
    resumeActions.className = 'viewer-start-actions';
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'viewer-start-btn viewer-start-btn--primary';
    resumeBtn.textContent = 'Resume attempt';
    resumeBtn.addEventListener('click', async () => {
      errorMessage.textContent = '';
      if (onResumeAttempt) await onResumeAttempt();
    });
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'viewer-start-btn viewer-start-btn--quiet';
    discardBtn.textContent = 'Discard attempt';
    discardBtn.addEventListener('click', async () => {
      errorMessage.textContent = '';
      if (onDiscardResume) await onDiscardResume();
    });
    resumeActions.append(resumeBtn, discardBtn);
    resumeCard.append(resumeTitle, resumeMeta, resumeActions);
  }

  importPackageBtn.addEventListener('click', () => {
    errorMessage.textContent = '';
    packageFileInput.click();
  });

  packageFileInput.addEventListener('change', async () => {
    const selected = packageFileInput.files?.[0];
    if (!selected) return;

    try {
      const bytes = await selected.arrayBuffer();
      await session.startImportedWorksheetFromPackageFile(bytes);
      if (session.state.localAttemptId) {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('localAttemptId', session.state.localAttemptId);
        window.history.replaceState({}, '', nextUrl);
      }
      renderViewerShell(session);
      window.viewerSession = session;
    } catch (error) {
      errorMessage.textContent = error?.message || 'Unable to import worksheet package.';
    } finally {
      packageFileInput.value = '';
    }
  });

  signInBtn.addEventListener('click', () => {
    session.beginServerSignIn();
    renderServerControls();
  });
  const scheduleDebouncedBrowse = (() => {
    let debounceTimer = null;
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await session.browsePublishedPackages({
          title: titleFilterInput.value,
          subject: subjectFilterInput.value,
          owner: ownerFilterInput.value,
        });
        renderServerControls();
      }, 300);
    };
  })();
  [titleFilterInput, subjectFilterInput, ownerFilterInput].forEach((input) => {
    input.addEventListener('input', () => {
      scheduleDebouncedBrowse();
    });
  });
  loadMoreBtn.addEventListener('click', async () => {
    await session.browsePublishedPackages(session.state.publishedFilters || {}, { append: true });
    renderServerControls();
  });

  async function openPublishedPackage(publishedPackageId) {
    const result = await session.startFromPublishedPackage(publishedPackageId);
    if (!result.ok) {
      renderServerControls();
      return;
    }
    if (session.state.localAttemptId) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('localAttemptId', session.state.localAttemptId);
      window.history.replaceState({}, '', nextUrl);
    }
    renderViewerShell(session);
    window.viewerSession = session;
  }

  function renderServerControls() {
    const sessionState = session.state.serverSession?.status || VIEWER_SERVER_SESSION_STATES.CHECKING;
    const isLoggedIn = sessionState === VIEWER_SERVER_SESSION_STATES.LOGGED_IN;
    const isChecking = sessionState === VIEWER_SERVER_SESSION_STATES.CHECKING;
    const canAccessPublished = isLoggedIn;
    const userLabel = session.state.serverSession?.user?.email || session.state.serverSession?.user?.sub || 'unknown';
    let defaultSessionMessage = '';
    if (isLoggedIn) {
      defaultSessionMessage = `Server session: ready (${userLabel})`;
    } else if (isChecking) {
      defaultSessionMessage = 'Server session: checking…';
    } else {
      defaultSessionMessage = `Server session: logged out. ${session.state.serverSession?.error || 'Log in to view published online worksheet.'}`;
    }
    const actionMessage = typeof session.state.serverActionMessage === 'string'
      ? session.state.serverActionMessage.trim()
      : '';
    sessionStatus.textContent = actionMessage || defaultSessionMessage;
    signInBtn.hidden = isLoggedIn;
    signInBtn.disabled = isChecking;
    publishedHeading.hidden = !canAccessPublished;
    filterRow.hidden = !canAccessPublished;
    titleFilterInput.hidden = !canAccessPublished;
    subjectFilterInput.hidden = !canAccessPublished;
    ownerFilterInput.hidden = !canAccessPublished;
    titleFilterInput.disabled = !canAccessPublished || session.state.isLoadingPublishedPackages;
    subjectFilterInput.disabled = !canAccessPublished || session.state.isLoadingPublishedPackages;
    ownerFilterInput.disabled = !canAccessPublished || session.state.isLoadingPublishedPackages;
    const activeFilters = session.state.publishedFilters || {};
    if (document.activeElement !== titleFilterInput) titleFilterInput.value = String(activeFilters.title || '');
    if (document.activeElement !== subjectFilterInput) subjectFilterInput.value = String(activeFilters.subject || '');
    if (document.activeElement !== ownerFilterInput) ownerFilterInput.value = String(activeFilters.owner || '');
    loadMoreBtn.hidden = !canAccessPublished || !session.state.publishedHasMore;
    loadMoreBtn.disabled = !canAccessPublished || session.state.isLoadingPublishedPackages || !session.state.publishedHasMore;
    loadMoreRow.hidden = loadMoreBtn.hidden;
    publishedList.innerHTML = '';
    publishedList.hidden = !canAccessPublished;
    if (!canAccessPublished) {
      return;
    }
    const publishedItems = Array.isArray(session.state.publishedPackages) ? session.state.publishedPackages : [];
    if (session.state.publishedListError) {
      const errorRow = document.createElement('p');
      errorRow.className = 'viewer-list-error';
      errorRow.appendChild(document.createTextNode('Could not load packages. '));
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'viewer-list-retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', async () => {
        await session.browsePublishedPackages(session.state.publishedFilters || {}, { reset: true });
        renderServerControls();
      });
      errorRow.appendChild(retryBtn);
      publishedList.appendChild(errorRow);
      return;
    }
    if (publishedItems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = session.state.isLoadingPublishedPackages ? 'Loading published packages…' : 'No published packages loaded.';
      publishedList.appendChild(empty);
      return;
    }
    publishedItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'viewer-published-row';
      const meta = document.createElement('div');
      meta.className = 'muted viewer-published-meta';
      const publishedAtLabel = item.published_at ? formatTimestampForDisplay(item.published_at) : 'unknown time';
      const ownerLabel = item.owner_email || item.owner_name || item.owner_sub || '—';
      meta.textContent = `Title: ${item.title || 'Untitled'} · Subject: ${item.subject || '—'} · Owner: ${ownerLabel} · Published: ${publishedAtLabel}`;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'viewer-start-btn viewer-published-open-btn';
      openBtn.textContent = 'Open package';
      openBtn.disabled = !isLoggedIn || session.state.isLoadingPublishedPackages || !item.published_package_id;
      openBtn.addEventListener('click', async () => {
        await openPublishedPackage(item.published_package_id);
      });
      if (item.published_package_id) {
        const idLine = document.createElement('div');
        idLine.className = 'muted viewer-published-id';
        idLine.textContent = `Publish ID: ${item.published_package_id}`;
        row.append(meta, openBtn, idLine);
      } else {
        row.append(meta, openBtn);
      }
      publishedList.appendChild(row);
    });
  }

  panel.append(heading, description);
  if (resumeAttempt) {
    panel.append(resumeCard);
  }
  serverActions.append(signInBtn);
  panel.append(importActions, serverActions, sessionStatus, publishedHeading, filterRow, publishedList, loadMoreRow, packageFileInput, errorMessage);
  app.innerHTML = '';
  bottomBarRoot.innerHTML = '';
  app.append(panel);
  renderServerControls();
  if (typeof session.setOnStateChange === 'function') {
    session.setOnStateChange(() => renderServerControls());
  }
}

async function bootstrapViewer() {
  const session = new ViewerAttemptSession(viewerStorage);
  const hasOnlyAllowedKeys = (payload, allowedKeys) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    return Object.keys(payload).every((key) => allowedKeys.has(key));
  };
  const validateViewerIntent = (intent) => {
    const actionId = typeof intent?.actionId === 'string' ? intent.actionId : '';
    if (!actionId || !session.state.localAttemptId) return false;
    const payload = intent?.payload;

    if (actionId === 'viewerRewrite' || actionId === 'resumeViewerRewriteAfterLogin') {
      const allowed = new Set(['localAttemptId', 'blockId', 'answerTextAtClickTime']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      if (typeof payload.localAttemptId !== 'string' || typeof payload.blockId !== 'string') return false;
      if (payload.answerTextAtClickTime !== undefined && typeof payload.answerTextAtClickTime !== 'string') return false;
      return session.validateViewerRewriteIntentPayload(payload).ok;
    }

    if (actionId === 'resumeAttemptServerResumeAfterLogin') {
      const allowed = new Set(['localAttemptId']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      return typeof payload.localAttemptId === 'string' && payload.localAttemptId === session.state.localAttemptId;
    }

    return false;
  };

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
    validateIntent: (intent) => validateViewerIntent(intent),
    replayIntent: (intent) => session.replayProtectedAction(intent),
    onRecoveryMessage: (message) => session.setRecoveryMessage(message),
    redirectToAuth: ({ redirectTo }) => {
      const url = new URL(redirectTo);
      url.searchParams.set('auth', '1');
      window.location.assign(url.toString());
    },
  });

  session.authGate = authGate;
  await session.refreshServerSession();
  if (session.state.serverSession.status === VIEWER_SERVER_SESSION_STATES.LOGGED_IN) {
    await session.browsePublishedPackages('');
  }

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
    const resumeAttempt = flaggedAttempt?.localId
      ? await session.storage.attempts.get(flaggedAttempt.localId)
      : null;
    const startPanelHandlers = {
      onResumeAttempt: async () => {
        if (!resumeAttempt?.localId) return;
        const resumed = await session.tryResumeAttempt(resumeAttempt.localId);
        if (!resumed) {
          renderViewerStartPanel(session, {
            warningMessage: session.state.recoveryMessage || `We couldn't restore your previous session.`,
            resumeAttempt: resumeAttempt || null,
            ...startPanelHandlers,
          });
          return;
        }
        renderViewerShell(session);
        window.viewerSession = session;
      },
      onStartFresh: async () => {
        renderViewerStartPanel(session, { warningMessage: null });
      },
      onDiscardResume: async () => {
        if (!resumeAttempt?.localId) return;
        await session.discardAttempt(resumeAttempt.localId);
        renderViewerStartPanel(session, { warningMessage: 'Saved local attempt discarded.' });
      },
    };
    renderViewerStartPanel(session, {
      warningMessage: session.state.recoveryMessage,
      resumeAttempt: resumeAttempt || null,
      ...startPanelHandlers,
    });
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
  getCheckRevealMessage,
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
  createChoiceButtonGroup,
  applyChoiceButtonGroupState,
  computeNextChoiceValue,
  deterministicShuffle,
  ensureControlDescribedBy,
  createInputErrorNode,
  classifyPrintQuestionLayout,
  buildWorksheetPrintReportModel,
  buildWorksheetPrintReportHtml,
  startWorksheetPrintFlow,
  renderViewerFatalError,
  ViewerBootError,
  VIEWER_BOOT_ERROR_CODES,
};
