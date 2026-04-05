import { editorStorage } from './storage/index.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';
import {
  createWorksheetPackageFromDraft,
  mapLegacyJsonToPackageModel,
  parseWorksheetPackage,
} from './worksheet-package.js';
import { MEDIA_LIMITS, IMAGE_MIME_TYPES, IMAGE_EXTENSIONS, AUDIO_MIME_TYPES, AUDIO_EXTENSIONS } from './media-config.js';

const app = document.getElementById('app');

const AUTOSAVE_MS = 1000;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';
const DEFAULT_PUBLISHER_ID = 'local_editor';
let contractsPromise;

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix = 'local') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeMediaUsage(usage) {
  if (usage === 'option_audio') return 'option_audio';
  if (usage === 'question_audio') return 'question_audio';
  if (usage === 'question_image') return 'question_image';
  return null;
}

function normalizeMediaRefs(mediaRefs, allowedUsage = null) {
  const refs = Array.isArray(mediaRefs) ? mediaRefs : [];
  return refs
    .map((ref) => {
      if (!isRecord(ref) || !isNonEmptyString(ref.assetId)) return null;
      const usage = normalizeMediaUsage(ref.usage);
      if (!usage) return null;
      if (allowedUsage && usage !== allowedUsage) return null;
      return { assetId: String(ref.assetId), usage };
    })
    .filter(Boolean);
}

function getSingleMediaRef(mediaRefs, usage) {
  const refs = normalizeMediaRefs(mediaRefs, usage);
  return refs[0] || null;
}

function setSingleMediaRef(mediaRefs, usage, assetId) {
  const existing = normalizeMediaRefs(mediaRefs).filter((ref) => ref.usage !== usage);
  if (!assetId) return existing;
  return [...existing, { assetId, usage }];
}

function removeSingleMediaRef(mediaRefs, usage) {
  return normalizeMediaRefs(mediaRefs).filter((ref) => ref.usage !== usage);
}

function collectQuestionAssetIds(block) {
  if (!isRecord(block) || block.kind !== 'question') return [];
  const ids = new Set();
  normalizeMediaRefs(block?.prompt?.mediaRefs).forEach((ref) => ids.add(ref.assetId));
  const options = Array.isArray(block?.responseConfig?.options) ? block.responseConfig.options : [];
  options.forEach((option) => {
    normalizeMediaRefs(option?.mediaRefs, 'option_audio').forEach((ref) => ids.add(ref.assetId));
  });
  return Array.from(ids);
}

function collectDraftQuestionAssetIds(draft) {
  if (!isRecord(draft) || !Array.isArray(draft.blocks)) return new Set();
  const ids = new Set();
  draft.blocks.forEach((block) => {
    collectQuestionAssetIds(block).forEach((assetId) => ids.add(assetId));
  });
  return ids;
}

function hasTypedText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getBlockDeletePolicy(block) {
  if (!isRecord(block)) {
    return { mode: 'safe_direct_delete', hasTypedContent: false, hasAssets: false };
  }
  const promptText = String(block?.prompt?.text || '');
  const contentText = String(block?.content?.text || '');
  const options = Array.isArray(block?.responseConfig?.options) ? block.responseConfig.options : [];
  const hasOptionText = options.some((option) => {
    const normalized = normalizeResponseOption(option);
    return hasTypedText(normalized.label) || hasTypedText(normalized.value);
  });
  const hasTypedContent = hasTypedText(promptText) || hasTypedText(contentText) || hasOptionText;
  const hasAssets = collectQuestionAssetIds(block).length > 0;
  return {
    mode: hasTypedContent || hasAssets ? 'confirm_delete' : 'safe_direct_delete',
    hasTypedContent,
    hasAssets,
  };
}

function getOptionDeletePolicy(option) {
  const normalized = normalizeResponseOption(option);
  const hasTypedContent = hasTypedText(normalized.label) || hasTypedText(normalized.value);
  const hasAssets = normalizeMediaRefs(normalized.mediaRefs, 'option_audio').length > 0;
  return {
    mode: hasTypedContent || hasAssets ? 'confirm_delete' : 'safe_direct_delete',
    hasTypedContent,
    hasAssets,
  };
}

function getSwitchImpact(fromType, toType, questionState) {
  const normalizedFromType = CANONICAL_RESPONSE_INPUT_TYPES.has(fromType) ? fromType : 'text';
  const normalizedToType = CANONICAL_RESPONSE_INPUT_TYPES.has(toType) ? toType : 'text';
  const responseConfig = normalizeQuestionResponseConfig(questionState?.responseConfig);
  const normalizedOptions = Array.isArray(responseConfig.options)
    ? responseConfig.options.map((option) => normalizeResponseOption(option))
    : [];
  const shouldRemoveOptions = normalizedFromType === 'multiple_choice' && normalizedToType !== 'multiple_choice';
  const optionCountToRemove = shouldRemoveOptions ? normalizedOptions.length : 0;
  const optionAttachmentCountToRemove = shouldRemoveOptions
    ? normalizedOptions.reduce((count, option) => count + normalizeMediaRefs(option.mediaRefs, 'option_audio').length, 0)
    : 0;
  const hasOptionTextLoss = shouldRemoveOptions
    ? normalizedOptions.some((option) => hasTypedText(option.label) || hasTypedText(option.value))
    : false;
  const hasMeaningfulDataLoss = hasOptionTextLoss || optionAttachmentCountToRemove > 0;
  return {
    fromType: normalizedFromType,
    toType: normalizedToType,
    optionCountToRemove,
    optionAttachmentCountToRemove,
    hasOptionTextLoss,
    hasMeaningfulDataLoss,
  };
}

function extFromName(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function fileLooksLikeType(file, mimeTypes, extensions) {
  const type = String(file?.type || '').toLowerCase();
  if (type) {
    return mimeTypes.includes(type);
  }
  const ext = extFromName(file?.name || '');
  return extensions.includes(ext);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAssetExtensionFallback(kind, mimeType) {
  const normalizedMime = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  if (kind === 'image') {
    if (normalizedMime === 'image/png') return 'png';
    if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') return 'jpg';
    if (normalizedMime === 'image/webp') return 'webp';
    return 'png';
  }
  if (kind === 'audio') {
    if (normalizedMime === 'audio/mpeg' || normalizedMime === 'audio/mp3') return 'mp3';
    return 'mp3';
  }
  return 'bin';
}

function normalizeAssetPath(assetId, fileName = '', fallbackExt = '') {
  const base = String(assetId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = extFromName(fileName) || fallbackExt;
  return `media/${base}${ext ? `.${ext}` : ''}`;
}

function validateMediaFile(file, kind) {
  if (!file) return { ok: false, message: 'Please choose a file first.' };
  const isImage = kind === 'image';
  const mimeTypes = isImage ? IMAGE_MIME_TYPES : AUDIO_MIME_TYPES;
  const extensions = isImage ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
  const maxBytes = isImage ? MEDIA_LIMITS.imageMaxBytes : MEDIA_LIMITS.audioMaxBytes;
  if (!fileLooksLikeType(file, mimeTypes, extensions)) {
    return {
      ok: false,
      message: isImage
        ? 'Unsupported image type. Allowed: .png, .jpg, .jpeg, .webp.'
        : 'Unsupported audio type. Allowed: .mp3.',
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, message: 'File appears empty or unreadable.' };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      message: `${isImage ? 'Image' : 'Audio'} is too large. Limit is ${formatBytes(maxBytes)}.`,
    };
  }
  return { ok: true, message: null };
}

async function toUint8ArrayFromFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Unable to read selected file.');
  }
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

async function loadContracts() {
  if (!contractsPromise) {
    contractsPromise = import('../app/contracts/index.js');
  }
  return contractsPromise;
}

function createEmptyQuestionBlock(position) {
  return {
    blockId: createLocalId('q'),
    kind: 'question',
    position,
    prompt: {
      text: '',
      format: 'plain_text',
    },
    responseConfig: {
      inputType: 'text',
      maxLength: 200,
      displayMode: 'multi_line',
    },
  };
}

const TEXT_INPUT_TYPES = new Set(['text']);
const CANONICAL_RESPONSE_INPUT_TYPES = new Set(['text', 'number', 'boolean', 'multiple_choice']);

function mapOptionsTextToResponseOptions(rawText) {
  if (!rawText) return [];
  return String(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ id: createLocalId('opt'), value: line, label: line }));
}

function normalizeResponseOption(option, fallback = '') {
  if (isRecord(option)) {
    const id = isNonEmptyString(option.id) ? String(option.id) : createLocalId('opt');
    const value = String(option.value ?? option.label ?? fallback);
    const label = String(option.label ?? option.value ?? fallback);
    return { id, value, label, mediaRefs: normalizeMediaRefs(option.mediaRefs, 'option_audio') };
  }
  const normalized = String(option ?? fallback);
  return { id: createLocalId('opt'), value: normalized, label: normalized, mediaRefs: [] };
}

function getOptionValueForAnswerKey(option) {
  if (isRecord(option)) {
    if (option.value !== undefined && option.value !== null) {
      return String(option.value);
    }
    if (option.label !== undefined && option.label !== null) {
      return String(option.label);
    }
    return null;
  }
  if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') {
    return String(option);
  }
  return null;
}

function getOptionIdForAnswerKey(option) {
  if (isRecord(option) && isNonEmptyString(option.id)) {
    return String(option.id);
  }
  return null;
}

function getDuplicateOptionValues(options) {
  const seen = new Set();
  const duplicates = new Set();
  (Array.isArray(options) ? options : []).forEach((option, index) => {
    const normalized = normalizeResponseOption(option, `option_${index}`);
    const value = String(normalized.value ?? '').trim();
    if (!value) return;
    if (seen.has(value)) {
      duplicates.add(value);
      return;
    }
    seen.add(value);
  });
  return Array.from(duplicates);
}

function normalizeNumberRulesConfig(numberRules) {
  const source = isRecord(numberRules) ? numberRules : {};
  const allowedKinds = Array.isArray(source.allowedKinds)
    ? source.allowedKinds.filter((kind) => kind === 'integer' || kind === 'decimal')
    : ['integer', 'decimal'];
  return {
    allowedKinds: allowedKinds.length > 0 ? Array.from(new Set(allowedKinds)) : ['integer', 'decimal'],
    allowSigned: source.allowSigned !== false,
    decimalPlacesAllowed:
      Number.isInteger(source.decimalPlacesAllowed) && source.decimalPlacesAllowed >= 0
        ? source.decimalPlacesAllowed
        : null,
  };
}

function countDecimalPlaces(value) {
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();

  // Simple case: no scientific notation.
  if (!text.includes('e') && !text.includes('E')) {
    const part = text.split('.')[1];
    return part ? part.length : 0;
  }

  // Scientific notation: use mantissa and exponent to determine decimal digits.
  const [mantissa, exponentPart] = text.toLowerCase().split('e');
  const exponent = Number(exponentPart);
  if (!Number.isFinite(exponent)) return 0;

  const decimalIndex = mantissa.indexOf('.');
  const decimalDigitsInMantissa = decimalIndex === -1 ? 0 : mantissa.length - decimalIndex - 1;

  if (exponent >= 0) {
    // Positive exponent moves the decimal point to the right.
    return Math.max(decimalDigitsInMantissa - exponent, 0);
  }

  // Negative exponent moves the decimal point to the left.
  return decimalDigitsInMantissa + (-exponent);
}

function isValidNumberCorrectAnswerForConfig(value, config) {
  if (!Number.isFinite(value)) return false;
  const rules = normalizeNumberRulesConfig(config?.numberRules);
  if (!rules.allowSigned && value < 0) return false;
  const isInteger = Number.isInteger(value);
  const kind = isInteger ? 'integer' : 'decimal';
  if (!rules.allowedKinds.includes(kind)) return false;
  if (!isInteger && rules.decimalPlacesAllowed !== null && countDecimalPlaces(value) > rules.decimalPlacesAllowed) {
    return false;
  }
  if (Number.isFinite(config?.min) && value < Number(config.min)) return false;
  if (Number.isFinite(config?.max) && value > Number(config.max)) return false;
  return true;
}

function getNumberQuestionValidationErrors(config, rawValues = {}) {
  const normalizedConfig = normalizeQuestionResponseConfig({
    ...(isRecord(config) ? config : {}),
    inputType: 'number',
  });
  const errors = {
    min: null,
    max: null,
    decimalPlacesAllowed: null,
    correctAnswer: null,
  };

  const minValue = Number.isFinite(normalizedConfig.min) ? Number(normalizedConfig.min) : null;
  const maxValue = Number.isFinite(normalizedConfig.max) ? Number(normalizedConfig.max) : null;
  if (minValue !== null && maxValue !== null && maxValue < minValue) {
    const rangeMessage = 'Max must be greater than or equal to Min';
    errors.min = rangeMessage;
    errors.max = rangeMessage;
  }

  const decimalPlacesRaw = rawValues.decimalPlacesAllowed;
  let decimalPlacesAllowed = normalizedConfig.numberRules?.decimalPlacesAllowed ?? null;
  if (decimalPlacesRaw !== undefined) {
    const text = String(decimalPlacesRaw).trim();
    if (text === '') {
      decimalPlacesAllowed = null;
    } else if (!/^\d+$/.test(text)) {
      errors.decimalPlacesAllowed = 'Decimal places allowed must be a non-negative integer';
    } else {
      const parsed = Number.parseInt(text, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.decimalPlacesAllowed = 'Decimal places allowed must be a non-negative integer';
      } else {
        decimalPlacesAllowed = parsed;
      }
    }
  }

  const rawCorrectAnswer = rawValues.correctAnswer;
  const hasRawCorrectAnswer = rawCorrectAnswer !== undefined;
  const hasStoredCorrectAnswer = typeof normalizedConfig.correctAnswer === 'number'
    && Number.isFinite(normalizedConfig.correctAnswer);
  const shouldValidateCorrectAnswer = hasRawCorrectAnswer
    ? String(rawCorrectAnswer).trim() !== ''
    : hasStoredCorrectAnswer;

  if (shouldValidateCorrectAnswer) {
    const correctAnswer = hasRawCorrectAnswer ? Number(rawCorrectAnswer) : Number(normalizedConfig.correctAnswer);
    if (!Number.isFinite(correctAnswer)) {
      errors.correctAnswer = 'Correct answer must be a valid number';
      return errors;
    }

    if (!normalizedConfig.numberRules?.allowSigned && correctAnswer < 0) {
      errors.correctAnswer = 'Correct answer must be positive when signed values are disabled';
      return errors;
    }
    if (minValue !== null && correctAnswer < minValue) {
      errors.correctAnswer = 'Correct answer must be greater than or equal to Min';
      return errors;
    }
    if (maxValue !== null && correctAnswer > maxValue) {
      errors.correctAnswer = 'Correct answer must be less than or equal to Max';
      return errors;
    }
    if (
      decimalPlacesAllowed !== null
      && Number.isInteger(decimalPlacesAllowed)
      && countDecimalPlaces(correctAnswer) > decimalPlacesAllowed
    ) {
      errors.correctAnswer = 'Correct answer has more decimal places than allowed';
    }
  }

  return errors;
}


function buildViewerUrlFromCurrentLocation(currentHref, localDraftId, draftUpdatedAt = null) {
  const viewerUrl = new URL('../viewer/', currentHref);
  viewerUrl.searchParams.set('localDraftId', localDraftId);
  viewerUrl.searchParams.set('preview', '1');
  if (draftUpdatedAt) {
    viewerUrl.searchParams.set('draftUpdatedAt', draftUpdatedAt);
  }
  return viewerUrl;
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [
      {
        blockId: createLocalId('blk'),
        kind: 'content',
        position: 0,
        content: {
          text: '',
          format: 'plain_text',
        },
      },
    ];
  }

  return blocks.map((block, index) => {
    const source = isRecord(block) ? { ...block } : {};
    const hasPrompt = isRecord(source.prompt);
    const base = {
      blockId: source.blockId || createLocalId('blk'),
      kind: source.kind || (hasPrompt ? 'question' : 'content'),
      position: Number.isFinite(source.position) ? source.position : index,
    };
    const normalized = { ...source, ...base };

    if (normalized.kind === 'question' || hasPrompt) {
      normalized.kind = 'question';
      const promptSource = isRecord(source.prompt) ? source.prompt : {};
      normalized.prompt = {
        ...promptSource,
        text: String(promptSource.text || ''),
        format: promptSource.format || 'plain_text',
        mediaRefs: normalizeMediaRefs(promptSource.mediaRefs),
      };
      normalized.responseConfig = normalizeQuestionResponseConfig(source.responseConfig);
      return normalized;
    }

    const contentSource = isRecord(source.content) ? source.content : {};
    normalized.content = {
      ...contentSource,
      text: String(contentSource.text || ''),
      format: contentSource.format || 'plain_text',
    };
    return normalized;
  });
}

function createDraftRecord(overrides = {}) {
  const localId = overrides.localId || createLocalId('draft');
  const updatedAt = nowIso();

  return {
    localId,
    title: overrides.title || 'Untitled worksheet',
    blocks: normalizeBlocks(overrides.blocks),
    assets: normalizeDraftAssets(overrides.assets),
    metadata: {
      localId,
      origin: overrides.origin || 'local_created',
      updatedAt,
      createdAt: overrides.metadata?.createdAt || updatedAt,
      serverLink: overrides.metadata?.serverLink || null,
      importedFrom: overrides.metadata?.importedFrom || null,
      modelVersion: overrides.metadata?.modelVersion || 'package-compatible-v1',
    },
  };
}

function normalizeDraftAssets(assets) {
  return (Array.isArray(assets) ? assets : [])
    .map((asset) => {
      if (!isRecord(asset) || !isNonEmptyString(asset.assetId)) return null;
      return {
        assetId: String(asset.assetId),
        kind: asset.kind === 'audio' ? 'audio' : 'image',
        usage: ['question_image', 'question_audio', 'option_audio'].includes(asset.usage)
          ? asset.usage
          : 'question_image',
        mimeType: isNonEmptyString(asset.mimeType) ? asset.mimeType : null,
        path: isNonEmptyString(asset.path) ? asset.path : `media/${String(asset.assetId)}`,
      };
    })
    .filter(Boolean);
}

function cloneDraftForPersistence(draft) {
  if (typeof structuredClone === 'function') {
    return structuredClone(draft);
  }

  return JSON.parse(JSON.stringify(draft));
}

class EditorDraftSession {
  constructor(storage) {
    this.storage = storage;
    this.state = {
      draft: null,
      selectedBlockId: null,
      mode: DEFAULT_MODE,
      hash: '',
      scrollToken: null,
      autosavePending: false,
      lastSavedAt: null,
      lastPersistenceError: null,
      lastValidationWarning: null,
      lastSavedLocalValidationIssueCount: 0,
      lastContractValidationIssueCount: 0,
      validationErrors: [],
      blockValidation: {},
      lastManualSaveAt: null,
      lastExportedAt: null,
      lastImportedAt: null,
      publishPreview: null,
      draftRevision: 0,
      lastSavedRevision: 0,
      recoveryMessage: null,
      lastProtectedAction: null,
      isPristineDraft: false,
      mediaFeedback: null,
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
    this.transientQuestionBlockIds = new Set();
    this.previewAudio = null;
    this.previewAudioUrl = null;
    this.previewAudioPlayback = null;
    this._previewPlayRequestId = 0;
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  normalizeDraftForContracts(draft) {
    return {
      draftWorksheetId: draft.localId,
      title: String(draft.title || '').trim() || 'Untitled worksheet',
      blocks: normalizeBlocks(draft.blocks).map((block, index) => {
        const base = {
          blockId: block.blockId || createLocalId('blk'),
          kind: block.kind === 'question' ? 'question' : 'content',
          position: Number.isInteger(block.position) ? block.position : index,
        };

        if (base.kind === 'question') {
          return {
            ...base,
            prompt: {
              text: String(block?.prompt?.text || ''),
              format: block?.prompt?.format || 'plain_text',
              mediaRefs: normalizeMediaRefs(block?.prompt?.mediaRefs),
            },
            responseConfig: isRecord(block.responseConfig)
              ? normalizeQuestionResponseConfig(block.responseConfig, { forContract: true })
              : { inputType: 'text', maxLength: 200, displayMode: 'multi_line' },
          };
        }

        return {
          ...base,
          content: {
            text: String(block?.content?.text || ''),
            format: block?.content?.format || 'plain_text',
          },
        };
      }),
    };
  }

  validateCurrentDraft() {
    if (!this.state.draft) {
      return { valid: false, errors: ['No active draft.'], blockValidation: {} };
    }

    const normalizedDraft = this.normalizeDraftForContracts(this.state.draft);
    const errors = [];
    if (!normalizedDraft.draftWorksheetId) errors.push('draft.draftWorksheetId must be a non-empty string');
    if (!normalizedDraft.title?.trim()) errors.push('draft.title must be a non-empty string');
    if (!Array.isArray(normalizedDraft.blocks) || normalizedDraft.blocks.length === 0) {
      errors.push('draft.blocks must be a non-empty array');
    }

    normalizedDraft.blocks.forEach((block, index) => {
      if (!block.blockId) errors.push(`draft.blocks[${index}].blockId must be a non-empty string`);
      if (!Number.isInteger(block.position) || block.position < 0) {
        errors.push(`draft.blocks[${index}].position must be a non-negative integer`);
      }
      if (block.kind === 'question') {
        if (!block?.prompt?.text?.trim()) errors.push(`draft.blocks[${index}].prompt.text is required for question blocks`);
        if (!isRecord(block.responseConfig)) errors.push(`draft.blocks[${index}].responseConfig is required for question blocks`);
        if (!CANONICAL_RESPONSE_INPUT_TYPES.has(block.responseConfig?.inputType)) {
          errors.push(
            `draft.blocks[${index}].responseConfig.inputType must be one of: text, number, boolean, multiple_choice`
          );
        }
        if (block.responseConfig?.inputType === 'multiple_choice') {
          const duplicateOptionValues = getDuplicateOptionValues(block.responseConfig.options);
          if (duplicateOptionValues.length > 0) {
            errors.push(
              `draft.blocks[${index}].responseConfig.options contains duplicate values: ${duplicateOptionValues.join(', ')}`
            );
          }
        }
      } else if (!block?.content?.text?.trim()) {
        errors.push(`draft.blocks[${index}].content.text is required for content blocks`);
      }
    });

    const validation = { valid: errors.length === 0, errors };
    const blockValidation = {};

    validation.errors.forEach((message) => {
      const blockMatch = message.match(/draft\.blocks\[(\d+)\]/);
      if (!blockMatch) return;
      const index = Number.parseInt(blockMatch[1], 10);
      const blockId = normalizedDraft.blocks[index]?.blockId || `index_${index}`;
      blockValidation[blockId] = blockValidation[blockId] || [];
      blockValidation[blockId].push(message);
    });

    this.state.validationErrors = validation.errors;
    this.state.blockValidation = blockValidation;

    return { ...validation, blockValidation, normalizedDraft };
  }

  async createOrOpenByLocalDraftId(localDraftId, options = {}) {
    const draftId = localDraftId || createLocalId('draft');
    const initialMode = options?.initialMode || DEFAULT_MODE;
    const initialSelectedBlockId = options?.selectedBlockId;
    const initialHash = options?.hash;
    const initialScrollToken = options?.scrollToken;

    let existing = null;
    if (localDraftId) {
      try {
        existing = await this.storage.drafts.get(localDraftId);
      } catch (error) {
        console.warn('Unable to read draft from IndexedDB, continuing in-memory only.', error);
      }
    }

    if (existing) {
      this.state.draft = {
        ...existing,
        blocks: normalizeBlocks(existing.blocks),
      };
      this.state.isPristineDraft = false;
      const existingContractErrors = existing?.contractValidation?.errors;
      this.state.lastContractValidationIssueCount = Array.isArray(existingContractErrors)
        ? existingContractErrors.length
        : 0;
      this.state.lastSavedLocalValidationIssueCount = this.validateCurrentDraft().errors.length;
      this.state.lastValidationWarning = existing?.contractValidation?.valid === false
        ? `Draft saved locally with validation warnings (${this.state.lastContractValidationIssueCount}).`
        : null;
      this.transientQuestionBlockIds.clear();
    } else {
      this.state.draft = createDraftRecord({ localId: draftId });
      this.state.isPristineDraft = true;
      this.scheduleAutosave();
    }

    this.state.mode = initialMode;
    this.state.hash = initialHash ?? this.state.hash;
    this.state.scrollToken = initialScrollToken ?? this.state.scrollToken;

    this.state.selectedBlockId = this.state.draft.blocks[0]?.blockId || null;
    if (initialSelectedBlockId) {
      const hasSelectedBlock = this.state.draft.blocks.some((block) => block.blockId === initialSelectedBlockId);
      if (hasSelectedBlock) {
        this.state.selectedBlockId = initialSelectedBlockId;
      }
    }

    this.state.draftRevision = 1;
    this.state.lastSavedRevision = existing ? 1 : 0;
    this.validateCurrentDraft();
    this.persistRestoreMetadata();
    return this.state.draft;
  }

  updateTitle(nextTitle) {
    if (!this.state.draft) return;
    this.state.draft.title = String(nextTitle || '');
    this.touchDraft();
  }

  updateBlockContent(blockId, nextText) {
    if (!this.state.draft || !blockId) return;

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId) {
        return block;
      }

      if (block.prompt) {
        if (String(nextText || '').trim()) {
          this.transientQuestionBlockIds.delete(blockId);
        }
        return {
          ...block,
          prompt: {
            ...block.prompt,
            text: String(nextText || ''),
          },
        };
      }

      return {
        ...block,
        content: {
          ...(block.content || {}),
          text: String(nextText || ''),
        },
      };
    });

    this.touchDraft();
  }


  setMediaFeedback(message) {
    this.state.mediaFeedback = message || null;
    this.notifyStateChange();
  }

  clearMediaFeedback() {
    this.state.mediaFeedback = null;
  }

  findBlock(blockId) {
    return this.state.draft?.blocks?.find((block) => block.blockId === blockId) || null;
  }

  findAsset(assetId) {
    return normalizeDraftAssets(this.state.draft?.assets || []).find((asset) => asset.assetId === assetId) || null;
  }

  async getLocalAssetRecord(assetId) {
    if (!assetId || !this.storage.localAssets?.get) return null;
    try {
      return await this.storage.localAssets.get(assetId);
    } catch (error) {
      return null;
    }
  }

  createObjectUrlForAsset(assetRecord, fallbackMimeType = 'application/octet-stream') {
    const binary = assetRecord?.binary;
    if (!binary) return null;
    const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
    const blob = new Blob([bytes], { type: assetRecord?.metadata?.mimeType || fallbackMimeType });
    return URL.createObjectURL(blob);
  }

  finalizePreviewAudio(reason = 'interrupted') {
    const playback = this.previewAudioPlayback;
    if (!playback || playback.finalized) return;
    playback.finalized = true;

    const { audio, objectUrl, hooks } = playback;
    if (audio) {
      if (reason === 'interrupted') {
        try {
          audio.pause();
        } catch (error) {
          // no-op
        }
      }
      audio.src = '';
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    if (this.previewAudio === audio) {
      this.previewAudio = null;
    }
    if (this.previewAudioUrl === objectUrl) {
      this.previewAudioUrl = null;
    }
    this.previewAudioPlayback = null;

    if (reason === 'ended') {
      hooks?.onEnded?.();
    } else if (reason === 'error') {
      hooks?.onError?.();
    } else {
      hooks?.onInterrupted?.();
    }
  }

  stopPreviewAudio(reason = 'interrupted') {
    this.finalizePreviewAudio(reason);
  }

  async playAssetAudio(assetId, hooks = {}) {
    const requestId = ++this._previewPlayRequestId;
    const record = await this.getLocalAssetRecord(assetId);
    if (requestId !== this._previewPlayRequestId) {
      return { ok: false, reason: 'superseded' };
    }
    if (!record) {
      this.setMediaFeedback('Unable to load attached audio for preview.');
      return { ok: false, reason: 'missing-asset' };
    }
    const objectUrl = this.createObjectUrlForAsset(record, 'audio/mpeg');
    if (!objectUrl) {
      this.setMediaFeedback('Unable to load attached audio for preview.');
      return { ok: false, reason: 'missing-binary' };
    }

    this.stopPreviewAudio();
    const audio = new Audio(objectUrl);
    this.previewAudio = audio;
    this.previewAudioUrl = objectUrl;
    this.previewAudioPlayback = { audio, objectUrl, hooks, finalized: false };
    audio.addEventListener('ended', () => {
      if (this.previewAudio !== audio) return;
      this.finalizePreviewAudio('ended');
    }, { once: true });
    audio.addEventListener('error', () => {
      if (this.previewAudio !== audio) return;
      this.setMediaFeedback('Unable to play attached audio.');
      this.finalizePreviewAudio('error');
    }, { once: true });

    try {
      await audio.play();
      if (this.previewAudio !== audio) {
        return { ok: false, reason: 'superseded' };
      }
      hooks?.onStart?.();
      this.clearMediaFeedback();
      this.notifyStateChange();
      return { ok: true };
    } catch (error) {
      if (this.previewAudio !== audio) {
        return { ok: false, reason: 'superseded' };
      }
      this.finalizePreviewAudio('error');
      this.setMediaFeedback('Audio playback was blocked. Try again.');
      return { ok: false, reason: 'playback-failed' };
    }
  }

  async openAssetImage(assetId) {
    // Do NOT pass 'noopener' or 'noreferrer' in the features string: per spec
    // (and Chrome 88+) window.open returns null when those flags are set, even
    // though the tab still opens. We instead manually null out .opener below.
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) {
      this.setMediaFeedback('Image preview was blocked. Allow pop-ups and try again.');
      return { ok: false, reason: 'blocked' };
    }
    try {
      previewWindow.opener = null;
    } catch (error) {
      // Ignore cross-browser quirks when hardening the newly opened window.
    }
    try {
      previewWindow.document.title = 'Loading image preview…';
      previewWindow.document.body.textContent = 'Loading image preview…';
    } catch (error) {
      // Ignore cross-browser document access quirks for newly opened windows.
    }

    const record = await this.getLocalAssetRecord(assetId);
    if (!record) {
      previewWindow.close();
      this.setMediaFeedback('Unable to load attached image for preview.');
      return { ok: false, reason: 'missing-asset' };
    }
    const draftAsset = this.findAsset(assetId);
    const fallbackImageMimeType = draftAsset?.mimeType || 'image/png';
    const objectUrl = this.createObjectUrlForAsset(record, fallbackImageMimeType);
    if (!objectUrl) {
      previewWindow.close();
      this.setMediaFeedback('Unable to load attached image for preview.');
      return { ok: false, reason: 'missing-binary' };
    }

    let didNavigate = false;
    try {
      previewWindow.location.replace(objectUrl);
      didNavigate = true;
    } catch (error) {
      // Some browsers can block direct navigation on a noopener handle.
    }

    if (!didNavigate) {
      try {
        const doc = previewWindow.document;
        if (doc?.body && typeof doc.createElement === 'function') {
          doc.title = 'Image preview';
          doc.body.innerHTML = '';
          const image = doc.createElement('img');
          image.src = objectUrl;
          image.alt = 'Attached image preview';
          image.style.maxWidth = '100%';
          image.style.height = 'auto';
          image.style.display = 'block';
          doc.body.style.margin = '0';
          doc.body.style.padding = '12px';
          doc.body.appendChild(image);
          didNavigate = true;
        }
      } catch (error) {
        // Ignore and fail with a user-facing feedback message below.
      }
    }

    if (!didNavigate) {
      previewWindow.close();
      this.setMediaFeedback('Unable to open attached image for preview.');
      URL.revokeObjectURL(objectUrl);
      return { ok: false, reason: 'navigation-failed' };
    }

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    this.clearMediaFeedback();
    this.notifyStateChange();
    return { ok: true };
  }

  async createLocalAssetRecord(file, usage, kind) {
    const assetId = createLocalId('asset');
    const bytes = await toUint8ArrayFromFile(file);
    const mimeType = file.type || (kind === 'audio' ? 'audio/mpeg' : null);
    const extFallback = getAssetExtensionFallback(kind, mimeType);
    const asset = {
      assetId,
      kind,
      usage,
      mimeType,
      path: normalizeAssetPath(assetId, file.name, extFallback),
    };
    if (this.storage.localAssets?.put) {
      await this.storage.localAssets.put({
        localId: assetId,
        binary: bytes,
        metadata: {
          localId: assetId,
          origin: 'local_upload',
          updatedAt: nowIso(),
          mimeType: asset.mimeType,
        },
      });
    }
    return asset;
  }

  async attachQuestionMedia(blockId, usage, file, options = {}) {
    if (!this.state.draft || !blockId) return { ok: false, reason: 'missing-draft' };
    const kind = usage === 'question_image' ? 'image' : 'audio';
    const validation = validateMediaFile(file, kind);
    if (!validation.ok) {
      this.setMediaFeedback(validation.message);
      return { ok: false, reason: 'validation', message: validation.message };
    }
    const target = this.findBlock(blockId);
    if (!target || target.kind !== 'question') return { ok: false, reason: 'missing-question' };

    const currentRef = getSingleMediaRef(target.prompt?.mediaRefs, usage);
    if (currentRef && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: currentRef.assetId };
    }

    const priorRefsForUsage = normalizeMediaRefs(target.prompt?.mediaRefs, usage);
    const replacedAssetIds = priorRefsForUsage.map((ref) => ref.assetId);

    const newAsset = await this.createLocalAssetRecord(file, usage, kind);

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      return {
        ...block,
        prompt: {
          ...(isRecord(block.prompt) ? block.prompt : {}),
          mediaRefs: setSingleMediaRef(block.prompt?.mediaRefs, usage, newAsset.assetId),
        },
      };
    });

    const replacedSet = new Set(replacedAssetIds);
    const existingAssets = normalizeDraftAssets(this.state.draft.assets);
    const filtered = existingAssets.filter((asset) => !replacedSet.has(asset.assetId));
    filtered.push(newAsset);
    this.state.draft.assets = filtered;

    if (this.storage.localAssets?.remove && replacedAssetIds.length > 0) {
      await Promise.all(replacedAssetIds.map((id) => this.storage.localAssets.remove(id)));
    }

    this.clearMediaFeedback();
    this.touchDraft();
    return { ok: true, assetId: newAsset.assetId, replacedAssetId: replacedAssetIds[0] || null };
  }

  async removeQuestionMedia(blockId, usage, options = {}) {
    if (!this.state.draft || !blockId) return { ok: false, reason: 'missing-draft' };
    const target = this.findBlock(blockId);
    if (!target || target.kind !== 'question') return { ok: false, reason: 'missing-question' };
    const currentRef = getSingleMediaRef(target.prompt?.mediaRefs, usage);
    if (!currentRef) {
      this.setMediaFeedback('No media attachment found to remove.');
      return { ok: false, reason: 'missing-media' };
    }
    if (options.confirmRemove !== true) {
      return { ok: false, reason: 'confirm-remove-required', existingAssetId: currentRef.assetId };
    }

    const refsForUsage = normalizeMediaRefs(target.prompt?.mediaRefs, usage);
    const removedAssetIds = refsForUsage.map((ref) => ref.assetId);
    const removedAssetId = removedAssetIds[0];

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      return {
        ...block,
        prompt: {
          ...(isRecord(block.prompt) ? block.prompt : {}),
          mediaRefs: removeSingleMediaRef(block.prompt?.mediaRefs, usage),
        },
      };
    });

    const removedSet = new Set(removedAssetIds);
    this.state.draft.assets = normalizeDraftAssets(this.state.draft.assets).filter((asset) => !removedSet.has(asset.assetId));

    if (this.storage.localAssets?.remove && removedAssetIds.length > 0) {
      await Promise.all(removedAssetIds.map((id) => this.storage.localAssets.remove(id)));
    }

    this.clearMediaFeedback();
    this.touchDraft();
    return { ok: true, removedAssetId };
  }

  async attachOptionAudio(blockId, optionId, file, options = {}) {
    if (!this.state.draft || !blockId || !optionId) return { ok: false, reason: 'missing-input' };
    const validation = validateMediaFile(file, 'audio');
    if (!validation.ok) {
      this.setMediaFeedback(validation.message);
      return { ok: false, reason: 'validation', message: validation.message };
    }
    const block = this.findBlock(blockId);
    if (!block || block.kind !== 'question') return { ok: false, reason: 'missing-question' };
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    if (responseConfig.inputType !== 'multiple_choice') return { ok: false, reason: 'not-multiple-choice' };
    const existingOption = (responseConfig.options || []).map((option) => normalizeResponseOption(option)).find((o) => o.id === optionId);
    if (!existingOption) {
      this.setMediaFeedback('Enter option text or click Add option before attaching audio.');
      return { ok: false, reason: 'missing-option' };
    }
    const currentRef = getSingleMediaRef(existingOption.mediaRefs, 'option_audio');
    if (currentRef && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: currentRef.assetId };
    }

    const priorRefsForUsage = normalizeMediaRefs(existingOption.mediaRefs, 'option_audio');
    const replacedAssetIds = priorRefsForUsage.map((ref) => ref.assetId);

    const newAsset = await this.createLocalAssetRecord(file, 'option_audio', 'audio');
    this.state.draft.blocks = this.state.draft.blocks.map((candidate) => {
      if (candidate.blockId !== blockId || candidate.kind !== 'question') return candidate;
      const cfg = normalizeQuestionResponseConfig(candidate.responseConfig);
      const nextOptions = (cfg.options || []).map((option) => {
        const normalized = normalizeResponseOption(option);
        if (normalized.id !== optionId) return normalized;
        return {
          ...normalized,
          mediaRefs: setSingleMediaRef(normalized.mediaRefs, 'option_audio', newAsset.assetId),
        };
      });
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({ ...cfg, options: nextOptions }),
      };
    });

    const replacedSet = new Set(replacedAssetIds);
    const existingAssets = normalizeDraftAssets(this.state.draft.assets);
    const filtered = existingAssets.filter((asset) => !replacedSet.has(asset.assetId));
    filtered.push(newAsset);
    this.state.draft.assets = filtered;

    if (this.storage.localAssets?.remove && replacedAssetIds.length > 0) {
      await Promise.all(replacedAssetIds.map((id) => this.storage.localAssets.remove(id)));
    }

    this.clearMediaFeedback();
    this.touchDraft();
    return { ok: true, assetId: newAsset.assetId, replacedAssetId: replacedAssetIds[0] || null };
  }

  async removeOptionAudio(blockId, optionId, options = {}) {
    if (!this.state.draft || !blockId || !optionId) return { ok: false, reason: 'missing-input' };
    const block = this.findBlock(blockId);
    if (!block || block.kind !== 'question') return { ok: false, reason: 'missing-question' };
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    if (responseConfig.inputType !== 'multiple_choice') return { ok: false, reason: 'not-multiple-choice' };
    const existingOption = (responseConfig.options || []).map((option) => normalizeResponseOption(option)).find((o) => o.id === optionId);
    if (!existingOption) return { ok: false, reason: 'missing-option' };
    const currentRef = getSingleMediaRef(existingOption.mediaRefs, 'option_audio');
    if (!currentRef) {
      this.setMediaFeedback('No option audio attachment found to remove.');
      return { ok: false, reason: 'missing-media' };
    }
    if (options.confirmRemove !== true) {
      return { ok: false, reason: 'confirm-remove-required', existingAssetId: currentRef.assetId };
    }

    const refsForUsage = normalizeMediaRefs(existingOption.mediaRefs, 'option_audio');
    const removedAssetIds = refsForUsage.map((ref) => ref.assetId);
    const removedAssetId = removedAssetIds[0];

    this.state.draft.blocks = this.state.draft.blocks.map((candidate) => {
      if (candidate.blockId !== blockId || candidate.kind !== 'question') return candidate;
      const cfg = normalizeQuestionResponseConfig(candidate.responseConfig);
      const nextOptions = (cfg.options || []).map((option) => {
        const normalized = normalizeResponseOption(option);
        if (normalized.id !== optionId) return normalized;
        return {
          ...normalized,
          mediaRefs: removeSingleMediaRef(normalized.mediaRefs, 'option_audio'),
        };
      });
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({ ...cfg, options: nextOptions }),
      };
    });

    const removedSet = new Set(removedAssetIds);
    this.state.draft.assets = normalizeDraftAssets(this.state.draft.assets)
      .filter((asset) => !removedSet.has(asset.assetId));

    if (this.storage.localAssets?.remove && removedAssetIds.length > 0) {
      await Promise.all(removedAssetIds.map((id) => this.storage.localAssets.remove(id)));
    }

    this.clearMediaFeedback();
    this.touchDraft();
    return { ok: true, removedAssetId };
  }

  updateQuestionInputType(blockId, inputType) {
    if (!this.state.draft || !blockId) return;
    const normalizedInputType = ['text', 'number', 'boolean', 'multiple_choice'].includes(inputType)
      ? inputType
      : 'text';

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const normalizedCurrentResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      const nextResponseConfig = {
        ...normalizedCurrentResponseConfig,
        inputType: normalizedInputType,
      };
      if (normalizedInputType !== normalizedCurrentResponseConfig.inputType) {
        delete nextResponseConfig.correctAnswer;
      }
      if (TEXT_INPUT_TYPES.has(normalizedInputType) && !Number.isFinite(nextResponseConfig.maxLength)) {
        nextResponseConfig.maxLength = 200;
      }
      if (normalizedInputType !== 'multiple_choice') {
        delete nextResponseConfig.options;
        delete nextResponseConfig.selectionMode;
        delete nextResponseConfig.shuffleOptions;
      } else if (!Array.isArray(nextResponseConfig.options)) {
        nextResponseConfig.options = [];
      }

      if (normalizedInputType !== 'number') {
        delete nextResponseConfig.min;
        delete nextResponseConfig.max;
      }

      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(nextResponseConfig),
      };
    });
    this.touchDraft();
  }

  getQuestionInputTypeSwitchImpact(blockId, nextInputType) {
    if (!this.state.draft || !blockId) {
      return getSwitchImpact('text', nextInputType, null);
    }
    const block = this.state.draft.blocks.find((candidate) => candidate.blockId === blockId);
    if (!block || block.kind !== 'question') {
      return getSwitchImpact('text', nextInputType, null);
    }
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    return getSwitchImpact(responseConfig.inputType, nextInputType, block);
  }

  switchQuestionInputTypeWithImpactPolicy(blockId, nextInputType, options = {}) {
    if (!this.state.draft || !blockId) {
      return { ok: false, reason: 'invalid-question-target' };
    }
    const block = this.state.draft.blocks.find((candidate) => candidate.blockId === blockId);
    if (!block || block.kind !== 'question') {
      return { ok: false, reason: 'invalid-question-target' };
    }
    const impact = this.getQuestionInputTypeSwitchImpact(blockId, nextInputType);
    if (impact.hasMeaningfulDataLoss && options.confirmSwitch !== true) {
      return { ok: false, reason: 'confirm-switch-required', impact };
    }
    const removedAssetIds = impact.fromType === 'multiple_choice' && impact.toType !== 'multiple_choice'
      ? (Array.isArray(normalizeQuestionResponseConfig(block.responseConfig).options)
        ? normalizeQuestionResponseConfig(block.responseConfig).options
          .flatMap((option) => normalizeMediaRefs(option?.mediaRefs, 'option_audio').map((ref) => ref.assetId))
        : [])
      : [];
    this.updateQuestionInputType(blockId, nextInputType);
    if (removedAssetIds.length > 0) {
      this.pruneAssetLinks(removedAssetIds);
    }
    return { ok: true, impact };
  }

  updateQuestionMaxLength(blockId, maxLength) {
    if (!this.state.draft || !blockId) return;
    const parsed = Number.parseInt(maxLength, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Preserve existing maxLength when input is empty, non-numeric, or non-positive.
      return;
    }
    const normalized = parsed;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      return {
        ...block,
        responseConfig: {
          ...(isRecord(block.responseConfig) ? block.responseConfig : {}),
          maxLength: normalized,
        },
      };
    });
    this.touchDraft();
  }

  updateQuestionTextDisplayMode(blockId, displayMode) {
    if (!this.state.draft || !blockId) return;
    const normalizedDisplayMode = displayMode === 'single_line' ? 'single_line' : 'multi_line';
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          inputType: 'text',
          displayMode: normalizedDisplayMode,
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionNumberConfig(blockId, key, rawValue) {
    if (!this.state.draft || !blockId || !['min', 'max'].includes(key)) return;
    const parsed = Number(rawValue);
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'number') {
        return block;
      }

      const updated = { ...nextResponseConfig };
      if (rawValue === '' || rawValue === null || rawValue === undefined || !Number.isFinite(parsed)) {
        delete updated[key];
      } else {
        updated[key] = parsed;
      }

      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionNumberRulesAllowSigned(blockId, allowSigned) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'number') return block;
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          numberRules: {
            ...(isRecord(nextResponseConfig.numberRules) ? nextResponseConfig.numberRules : {}),
            allowSigned: Boolean(allowSigned),
          },
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionNumberRulesDecimalPlacesAllowed(blockId, rawValue) {
    if (!this.state.draft || !blockId) return;
    const isNonNegativeIntegerString = typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim());
    const parsed = isNonNegativeIntegerString ? Number.parseInt(rawValue.trim(), 10) : NaN;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'number') return block;
      const nextRules = {
        ...(isRecord(nextResponseConfig.numberRules) ? nextResponseConfig.numberRules : {}),
      };
      if (!isNonNegativeIntegerString || !Number.isInteger(parsed) || parsed < 0) {
        nextRules.decimalPlacesAllowed = null;
      } else {
        nextRules.decimalPlacesAllowed = parsed;
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          numberRules: nextRules,
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionCorrectAnswerBoolean(blockId, rawValue) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'boolean') {
        return block;
      }
      const updated = { ...nextResponseConfig };
      if (rawValue === 'true' || rawValue === true) {
        updated.correctAnswer = true;
      } else if (rawValue === 'false' || rawValue === false) {
        updated.correctAnswer = false;
      } else {
        delete updated.correctAnswer;
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionCorrectAnswerNumber(blockId, rawValue) {
    if (!this.state.draft || !blockId) return;
    const parsed = Number(rawValue);
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'number') {
        return block;
      }
      const updated = { ...nextResponseConfig };
      if (rawValue === '' || rawValue === null || rawValue === undefined || !Number.isFinite(parsed)) {
        delete updated.correctAnswer;
      } else {
        updated.correctAnswer = parsed;
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionCorrectAnswerChoice(blockId, optionId) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice' || nextResponseConfig.selectionMode !== 'single') {
        return block;
      }
      const updated = { ...nextResponseConfig };
      if (typeof optionId === 'string' && optionId.length > 0) {
        updated.correctAnswerOptionId = optionId;
        delete updated.correctAnswerOptionIds;
        delete updated.correctAnswer;
      } else {
        delete updated.correctAnswerOptionId;
        delete updated.correctAnswer;
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionCorrectAnswerChoices(blockId, optionIds) {
    if (!this.state.draft || !blockId) return;
    const nextOptionIds = Array.isArray(optionIds) ? optionIds.filter((optionId) => typeof optionId === 'string') : [];
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice' || nextResponseConfig.selectionMode !== 'multi') {
        return block;
      }
      const updated = {
        ...nextResponseConfig,
        correctAnswerOptionIds: nextOptionIds,
      };
      delete updated.correctAnswerOptionId;
      delete updated.correctAnswer;
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionSelectionMode(blockId, selectionMode) {
    if (!this.state.draft || !blockId) return;
    const normalizedSelectionMode = selectionMode === 'multi' ? 'multi' : 'single';
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice') return block;
      const optionIds = new Set(
        (Array.isArray(nextResponseConfig.options) ? nextResponseConfig.options : [])
          .map((option, index) => normalizeResponseOption(option, `option_${index}`).id)
          .map((optionId) => String(optionId))
      );
      const updated = {
        ...nextResponseConfig,
        selectionMode: normalizedSelectionMode,
      };
      if (
        nextResponseConfig.selectionMode === 'single'
        && normalizedSelectionMode === 'multi'
      ) {
        if (
          typeof nextResponseConfig.correctAnswerOptionId === 'string'
          && optionIds.has(nextResponseConfig.correctAnswerOptionId)
        ) {
          updated.correctAnswerOptionIds = [nextResponseConfig.correctAnswerOptionId];
        } else {
          delete updated.correctAnswerOptionIds;
        }
      }
      if (
        nextResponseConfig.selectionMode === 'multi'
        && normalizedSelectionMode === 'single'
      ) {
        const firstValid = Array.isArray(nextResponseConfig.correctAnswerOptionIds)
          ? nextResponseConfig.correctAnswerOptionIds.find((optionId) => typeof optionId === 'string' && optionIds.has(optionId))
          : null;
        if (typeof firstValid === 'string') {
          updated.correctAnswerOptionId = firstValid;
        } else {
          delete updated.correctAnswerOptionId;
        }
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig(updated),
      };
    });
    this.touchDraft();
  }

  updateQuestionShuffleOptions(blockId, enabled) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const nextResponseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (nextResponseConfig.inputType !== 'multiple_choice') return block;
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...nextResponseConfig,
          shuffleOptions: Boolean(enabled),
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionOptionsFromText(blockId, rawText) {
    if (!this.state.draft || !blockId) return;
    const normalizedOptions = mapOptionsTextToResponseOptions(rawText);
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...normalizeQuestionResponseConfig(block.responseConfig),
          inputType: 'multiple_choice',
          selectionMode: block.responseConfig?.selectionMode === 'multi' ? 'multi' : 'single',
          shuffleOptions: Boolean(block.responseConfig?.shuffleOptions),
          options: normalizedOptions,
        }),
      };
    });
    this.touchDraft();
  }

  updateQuestionOptionAtIndex(blockId, index, nextLabel) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) return;
    const normalizedLabel = String(nextLabel ?? '');
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      while (options.length <= index) {
        options.push({ id: createLocalId('opt'), value: '', label: '' });
      }
      options[index] = { ...options[index], value: normalizedLabel, label: normalizedLabel };
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    this.touchDraft();
  }

  addQuestionOption(blockId) {
    if (!this.state.draft || !blockId) return;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      options.push({ id: createLocalId('opt'), value: '', label: '' });
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    this.touchDraft();
  }

  removeQuestionOption(blockId, index) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) return;
    const removedAssetIds = [];
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      if (options[index]) {
        normalizeMediaRefs(options[index]?.mediaRefs, 'option_audio').forEach((ref) => removedAssetIds.push(ref.assetId));
      }
      options.splice(index, 1);
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    if (removedAssetIds.length > 0) {
      this.pruneAssetLinks(removedAssetIds);
    }
    this.touchDraft();
  }

  removeQuestionOptionWithPolicy(blockId, index, options = {}) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) {
      return { ok: false, reason: 'invalid-option-target' };
    }
    const block = this.state.draft.blocks.find((candidate) => candidate.blockId === blockId);
    if (!block || block.kind !== 'question') {
      return { ok: false, reason: 'invalid-option-target' };
    }
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    const option = Array.isArray(responseConfig.options) ? responseConfig.options[index] : null;
    if (!option) {
      return { ok: false, reason: 'invalid-option-target' };
    }
    const policy = getOptionDeletePolicy(option);
    if (policy.mode === 'confirm_delete' && options.confirmDelete !== true) {
      return { ok: false, reason: 'confirm-delete-required', policy };
    }
    this.removeQuestionOption(blockId, index);
    return { ok: true, policy };
  }

  createBlock(kind = 'content') {
    if (!this.state.draft) return null;

    const position = this.state.draft.blocks.length;
    const block =
      kind === 'question'
        ? createEmptyQuestionBlock(position)
        : {
            blockId: createLocalId('blk'),
            kind: 'content',
            position,
            content: {
              text: '',
              format: 'plain_text',
            },
          };

    if (kind === 'question') {
      this.transientQuestionBlockIds.add(block.blockId);
    }
    this.state.draft.blocks = [...this.state.draft.blocks, block];
    this.state.selectedBlockId = block.blockId;
    this.touchDraft();
    return block;
  }

  reorderBlockByDelta(blockId, delta) {
    if (!this.state.draft || !blockId) return;
    if (delta !== -1 && delta !== 1) return;
    const blocks = (Array.isArray(this.state.draft.blocks) ? this.state.draft.blocks : [])
      .slice()
      .sort((a, b) => a.position - b.position);
    const currentIndex = blocks.findIndex((block) => block.blockId === blockId);
    if (currentIndex < 0) return;
    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= blocks.length) return;

    const nextBlocks = blocks.slice();
    const [movedBlock] = nextBlocks.splice(currentIndex, 1);
    nextBlocks.splice(targetIndex, 0, movedBlock);
    this.state.draft.blocks = nextBlocks.map((block, index) => ({ ...block, position: index }));
    this.touchDraft();
  }

  deleteBlock(blockId) {
    if (!this.state.draft || !blockId) return;
    const removedBlock = this.state.draft.blocks.find((block) => block.blockId === blockId) || null;
    const removedAssetIds = collectQuestionAssetIds(removedBlock);
    this.transientQuestionBlockIds.delete(blockId);
    const nextBlocks = this.state.draft.blocks
      .filter((block) => block.blockId !== blockId)
      .map((block, index) => ({ ...block, position: index }));

    if (nextBlocks.length === 0) {
      nextBlocks.push({
        blockId: createLocalId('blk'),
        kind: 'content',
        position: 0,
        content: { text: '', format: 'plain_text' },
      });
    }

    this.state.draft.blocks = nextBlocks;
    if (removedAssetIds.length > 0) {
      this.pruneAssetLinks(removedAssetIds);
    }
    if (!nextBlocks.some((block) => block.blockId === this.state.selectedBlockId)) {
      this.state.selectedBlockId = nextBlocks[0].blockId;
    }
    this.touchDraft();
  }

  deleteBlockWithPolicy(blockId, options = {}) {
    if (!this.state.draft || !blockId) {
      return { ok: false, reason: 'invalid-block-target' };
    }
    const block = this.state.draft.blocks.find((candidate) => candidate.blockId === blockId);
    if (!block) {
      return { ok: false, reason: 'invalid-block-target' };
    }
    const policy = getBlockDeletePolicy(block);
    if (policy.mode === 'confirm_delete' && options.confirmDelete !== true) {
      return { ok: false, reason: 'confirm-delete-required', policy };
    }
    this.deleteBlock(blockId);
    return { ok: true, policy };
  }

  pruneAssetLinks(assetIds = []) {
    if (!this.state.draft || !Array.isArray(this.state.draft.assets)) return;
    const removeSet = new Set(assetIds.filter((id) => typeof id === 'string' && id));
    if (removeSet.size === 0) return;
    const referencedAssetIds = collectDraftQuestionAssetIds(this.state.draft);
    const removableIds = new Set(Array.from(removeSet).filter((assetId) => !referencedAssetIds.has(assetId)));
    if (removableIds.size === 0) return;
    this.state.draft.assets = this.state.draft.assets.filter((asset) => !removableIds.has(asset?.assetId));
    if (this.storage.localAssets?.remove) {
      removableIds.forEach((assetId) => {
        this.storage.localAssets.remove(assetId).catch(() => {});
      });
    }
  }

  setSelectedBlockKind(kind) {
    if (!this.state.draft || !this.state.selectedBlockId) return;

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== this.state.selectedBlockId) {
        return block;
      }

      if (kind === 'question') {
        this.transientQuestionBlockIds.add(block.blockId);
        return {
          ...block,
          kind: 'question',
          prompt: {
            text: String(block?.prompt?.text || block?.content?.text || ''),
            format: block?.prompt?.format || 'plain_text',
          },
          responseConfig: isRecord(block.responseConfig)
            ? normalizeQuestionResponseConfig(block.responseConfig)
            : { inputType: 'text', maxLength: 200, displayMode: 'multi_line' },
          content: undefined,
        };
      }

      return {
        ...block,
        kind: 'content',
        content: {
          text: String(block?.content?.text || block?.prompt?.text || ''),
          format: block?.content?.format || 'plain_text',
        },
        prompt: undefined,
        responseConfig: undefined,
      };
    });

    if (kind !== 'question') {
      this.transientQuestionBlockIds.delete(this.state.selectedBlockId);
    }

    this.touchDraft();
  }

  selectBlock(blockId) {
    this.state.selectedBlockId = blockId || null;
    this.persistRestoreMetadata();
  }

  setMode(mode) {
    this.state.mode = mode || DEFAULT_MODE;
    this.persistRestoreMetadata();
  }

  setRouteUiRestoreMetadata(partial = {}) {
    this.state.hash = partial.hash ?? this.state.hash;
    this.state.scrollToken = partial.scrollToken ?? this.state.scrollToken;
    if (partial.selectedBlockId !== undefined) {
      this.state.selectedBlockId = partial.selectedBlockId;
    }
    if (partial.mode) {
      this.state.mode = partial.mode;
    }
    this.persistRestoreMetadata();
  }

  getRouteUiRestoreMetadata() {
    return this.storage.resumeFlags.get(RESUME_FLAG_KEY);
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.state.autosavePending = true;
    this.notifyStateChange();
    this.autosaveTimer = setTimeout(() => {
      this.autosave().catch((error) => {
        console.error('Autosave failed', error);
      });
    }, AUTOSAVE_MS);
  }

  shouldSuppressTransientQuestionWarning(contractErrors, normalizedDraft) {
    if (!Array.isArray(contractErrors) || contractErrors.length === 0) return false;
    return contractErrors.every((errorMessage) => {
      const match = errorMessage.match(/^draft\.blocks\[(\d+)\]\.prompt\.text is required for question blocks$/);
      if (!match) return false;
      const index = Number.parseInt(match[1], 10);
      const blockId = normalizedDraft?.blocks?.[index]?.blockId;
      return !!blockId && this.transientQuestionBlockIds.has(blockId);
    });
  }

  async autosave() {
    if (!this.state.draft) return null;

    const revisionAtSaveStart = this.state.draftRevision;
    const updatedAt = nowIso();
    const validation = this.validateCurrentDraft();
    const normalizedDraft = validation.normalizedDraft;
    const { validateDraftSchema } = await loadContracts();
    const contractValidation = validateDraftSchema(normalizedDraft);

    const snapshotToPersist = cloneDraftForPersistence({
      ...this.state.draft,
      metadata: {
        ...this.state.draft.metadata,
        localId: this.state.draft.localId,
        origin: this.state.draft.metadata?.origin || 'local_created',
        updatedAt,
      },
      contractDraft: normalizedDraft,
      contractValidation: {
        valid: contractValidation.valid,
        errors: contractValidation.errors,
      },
    });

    this.inFlightSaveCount += 1;
    this.state.autosavePending = true;

    try {
      const persisted = await this.storage.drafts.put(snapshotToPersist);
      const shouldApplySaveStatus =
        this.state.draft?.localId === persisted.localId && revisionAtSaveStart >= this.state.lastSavedRevision;

      if (this.state.draft?.localId === persisted.localId && this.state.draftRevision === revisionAtSaveStart) {
        this.state.draft = persisted;
      }

      if (shouldApplySaveStatus) {
        const wasNeverSavedBefore = this.state.lastSavedRevision === 0;
        this.state.lastSavedRevision = revisionAtSaveStart;
        this.state.lastPersistenceError = null;
        this.state.lastSavedLocalValidationIssueCount = validation.errors.length;
        this.state.lastContractValidationIssueCount = contractValidation.errors.length;

        if (!this.state.lastSavedAt || this.state.lastSavedAt < updatedAt) {
          this.state.lastSavedAt = updatedAt;
        }

        const shouldSuppressPristineWarning = this.state.isPristineDraft && wasNeverSavedBefore;
        const shouldSuppressTransientQuestionWarning =
          this.shouldSuppressTransientQuestionWarning(contractValidation.errors, normalizedDraft);
        this.state.lastValidationWarning =
          contractValidation.valid || shouldSuppressPristineWarning || shouldSuppressTransientQuestionWarning
          ? null
          : `Draft saved locally with validation warnings (${contractValidation.errors.length}).`;
        this.persistRestoreMetadata();
        this.notifyStateChange();
      }
      return persisted;
    } catch (error) {
      const shouldApplyErrorStatus =
        this.state.draft?.localId === snapshotToPersist.metadata?.localId &&
        revisionAtSaveStart > this.state.lastSavedRevision;
      if (shouldApplyErrorStatus) {
        this.state.lastPersistenceError = error?.message || String(error);
        this.notifyStateChange();
      }
      throw error;
    } finally {
      this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.draftRevision;
      this.notifyStateChange();
    }
  }

  async importWorksheetJson(jsonInput, options = {}) {
    let parsed = jsonInput;
    if (typeof jsonInput === 'string') {
      try {
        parsed = JSON.parse(jsonInput);
      } catch (error) {
        throw new Error(`Imported worksheet JSON could not be parsed: ${error?.message || String(error)}`);
      }
    }

    const mapped = mapLegacyJsonToPackageModel(parsed);
    const importedLocalId = createLocalId('imported');
    const importedRecord = {
      localId: importedLocalId,
      worksheet: mapped.worksheet,
      packageManifest: mapped.manifest,
      metadata: {
        localId: importedLocalId,
        origin: 'legacy_json_import',
        updatedAt: nowIso(),
      },
    };

    await this.storage.importedWorksheets.put(importedRecord);

    if (options.convertToEditableDraft) {
      // Validate and extract blocks from parsed JSON
      // Clear any pending autosave before replacing the draft
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
      this.state.autosavePending = false;
      try {
        // For round-trip imports (exporting and re-importing), preserve metadata if present
        // Otherwise, use 'imported_file' as default origin
        const importedMetadata = {
          createdAt: (isRecord(mapped.worksheet.metadata) && mapped.worksheet.metadata.createdAt) || nowIso(),
          serverLink: (isRecord(mapped.worksheet.metadata) && mapped.worksheet.metadata.serverLink) || null,
          importedFrom: 'legacy_json',
          modelVersion: 'package-compatible-v1',
        };

        const draft = createDraftRecord({
          title: mapped.worksheet.title || 'Imported worksheet',
          blocks: mapped.worksheet.blocks,
          assets: [],
          origin: 'legacy_json_import',
          metadata: importedMetadata,
        });

        this.state.draft = draft;
        this.state.selectedBlockId = draft.blocks[0]?.blockId || null;
        this.state.draftRevision += 1;
        this.state.lastImportedAt = nowIso();
        this.validateCurrentDraft();
        try {
          await this.autosave();
        } catch (error) {
          console.warn('Initial autosave after import failed; draft remains in-memory.', error);
        }
        this.persistRestoreMetadata();
        return { importedRecord, draftRecord: this.state.draft };
      } catch (error) {
        this.state.autosavePending = false;
        this.notifyStateChange();
        throw error;
      }
    }

    return { importedRecord, draftRecord: null };
  }

  async importWorksheetPackageFile(file, options = {}) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new Error('A .zip worksheet package file is required.');
    }

    const parsedPackage = parseWorksheetPackage(await file.arrayBuffer());
    const importedLocalId = createLocalId('imported');
    const now = nowIso();
    const importedRecord = {
      localId: importedLocalId,
      worksheet: parsedPackage.worksheet,
      packageManifest: parsedPackage.manifest,
      assets: parsedPackage.assets.map((asset) => ({
        assetId: asset.assetId,
        path: asset.path,
        kind: asset.kind,
        usage: asset.usage,
        mimeType: asset.mimeType || null,
      })),
      metadata: {
        localId: importedLocalId,
        origin: 'imported_package',
        updatedAt: now,
      },
    };

    await this.storage.importedWorksheets.put(importedRecord);

    const assetIdRemap = new Map();
    for (const asset of parsedPackage.assets) {
      let targetId = asset.assetId;
      if (this.storage.localAssets?.get) {
        const existing = await this.storage.localAssets.get(targetId);
        if (existing) {
          targetId = createLocalId('asset_import');
        }
      }
      assetIdRemap.set(asset.assetId, targetId);
      if (!this.storage.localAssets?.put) continue;
      await this.storage.localAssets.put({
        localId: targetId,
        binary: asset.binary,
        metadata: {
          localId: targetId,
          origin: 'imported_package',
          updatedAt: now,
          mimeType: asset.mimeType || null,
        },
      });
    }

    const remapMediaRefs = (mediaRefs) => normalizeMediaRefs(mediaRefs).map((ref) => ({
      ...ref,
      assetId: assetIdRemap.get(ref.assetId) || ref.assetId,
    }));

    const remappedBlocks = normalizeBlocks(parsedPackage.worksheet.blocks).map((block) => {
      if (block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      const options = (responseConfig.options || []).map((option) => {
        const normalized = normalizeResponseOption(option);
        return { ...normalized, mediaRefs: remapMediaRefs(normalized.mediaRefs) };
      });
      return {
        ...block,
        prompt: {
          ...(isRecord(block.prompt) ? block.prompt : {}),
          mediaRefs: remapMediaRefs(block?.prompt?.mediaRefs),
        },
        responseConfig: normalizeQuestionResponseConfig({ ...responseConfig, options }),
      };
    });

    if (!options.convertToEditableDraft) {
      return { importedRecord, draftRecord: null };
    }

    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    this.state.autosavePending = false;

    const draft = createDraftRecord({
      title: parsedPackage.worksheet.title || 'Imported worksheet',
      blocks: remappedBlocks,
      assets: parsedPackage.assets.map((asset) => {
        const remappedAssetId = assetIdRemap.get(asset.assetId) || asset.assetId;
        return {
          assetId: remappedAssetId,
          path: normalizeAssetPath(remappedAssetId, asset.path, asset.kind === 'audio' ? 'mp3' : 'bin'),
          kind: asset.kind,
          usage: asset.usage,
          mimeType: asset.mimeType || null,
        };
      }),
      origin: 'imported_package',
      metadata: {
        createdAt: (isRecord(parsedPackage.worksheet.metadata) && parsedPackage.worksheet.metadata.createdAt) || now,
        serverLink: (isRecord(parsedPackage.worksheet.metadata) && parsedPackage.worksheet.metadata.serverLink) || null,
        importedFrom: 'package_zip',
        modelVersion: 'package-compatible-v1',
      },
    });

    this.state.draft = draft;
    this.state.selectedBlockId = draft.blocks[0]?.blockId || null;
    this.state.draftRevision += 1;
    this.state.lastImportedAt = nowIso();
    this.validateCurrentDraft();
    await this.autosave();
    this.persistRestoreMetadata();
    return { importedRecord, draftRecord: this.state.draft };
  }

  async saveNow() {
    const persisted = await this.autosave();
    this.state.lastManualSaveAt = nowIso();
    return persisted;
  }

  async simulateLocalPublish() {
    if (!this.state.draft) {
      throw new Error('No active draft to publish.');
    }

    const validation = this.validateCurrentDraft();
    if (!validation.valid) {
      throw new Error(`Draft validation failed: ${validation.errors.join('; ')}`);
    }

    const { mapDraftToSnapshot, validateDraftSchema } = await loadContracts();
    const contractValidation = validateDraftSchema(validation.normalizedDraft);
    if (!contractValidation.valid) {
      throw new Error(`Draft validation failed: ${contractValidation.errors.join('; ')}`);
    }

    const localWorksheetId = `ws_${this.state.draft.localId}`;
    const localSnapshotId = `snapshot_${createLocalId('pub')}`;

    const snapshot = mapDraftToSnapshot(validation.normalizedDraft, {
      // Do not assign client-generated IDs to server-owned identity fields.
      worksheetId: null,
      snapshotId: null,
      schemaVersion: 1,
      snapshotVersion: Math.max(this.state.draftRevision, 1),
      publishedAt: nowIso(),
      publishedByUserId: DEFAULT_PUBLISHER_ID,
      sourceDraftRevision: String(this.state.draftRevision),
      integrity: {
        source: 'local_publish_simulation',
        // Local-only identifiers for simulation purposes; replaced by server-issued UUIDs on real publish.
        localWorksheetId,
        localSnapshotId,
      },
    });

    // Note: validateSnapshotSchema is intentionally skipped here because worksheetId/snapshotId
    // are null pending server sync. The snapshot structure is otherwise valid.

    this.state.publishPreview = snapshot;
    return snapshot;
  }

  async exportCurrentDraftToPackageFile() {
    if (!this.state.draft) {
      throw new Error('No active draft to export.');
    }

    const timestampToken = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worksheet-package-${this.state.draft.localId}-${timestampToken}.zip`;
    const assets = new Map();
    const draftAssets = normalizeDraftAssets(this.state.draft.assets);
    for (const asset of draftAssets) {
      if (!this.storage.localAssets?.get) continue;
      const stored = await this.storage.localAssets.get(asset.assetId);
      if (stored?.binary) {
        assets.set(asset.assetId, { binary: stored.binary });
      }
    }
    const packagedDraft = {
      ...this.state.draft,
      assets: draftAssets,
      metadata: {
        ...this.state.draft.metadata,
        modelVersion: 'package-compatible-v1',
      },
    };
    const { bytes } = createWorksheetPackageFromDraft(packagedDraft, assets);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    this.state.lastExportedAt = nowIso();
    return filename;
  }

  touchDraft() {
    if (!this.state.draft) return;
    this.state.isPristineDraft = false;
    this.state.draft = {
      ...this.state.draft,
      metadata: {
        ...this.state.draft.metadata,
        updatedAt: nowIso(),
      },
    };
    this.state.draftRevision += 1;
    this.validateCurrentDraft();
    this.scheduleAutosave();
    this.persistRestoreMetadata();
  }


  async flushLocalStateForAuthRedirect() {
    if (!this.state.draft) return null;

    if (this.state.lastSavedRevision < this.state.draftRevision) {
      return this.autosave();
    }

    return this.state.draft;
  }

  getUiRestoreState() {
    return {
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken:
        this.state.scrollToken ??
        (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
    };
  }

  async restoreByLocalId(localId) {
    if (!localId) return false;
    const restored = await this.createOrOpenByLocalDraftId(localId, this.getUiRestoreState());
    return Boolean(restored);
  }

  applyUiRestoreState(ui = {}) {
    this.setRouteUiRestoreMetadata({
      mode: ui.mode ?? this.state.mode,
      selectedBlockId: ui.selectedBlockId ?? this.state.selectedBlockId,
      hash: ui.hash ?? this.state.hash,
      scrollToken: ui.scrollToken ?? this.state.scrollToken,
    });
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
      throw new Error('Auth gate is not configured for editor session.');
    }

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localDrafts',
      payload: {
        localDraftId: this.state.draft?.localId || null,
      },
    });
  }

  persistRestoreMetadata() {
    if (!this.state.draft?.localId) {
      return;
    }

    this.storage.resumeFlags.set(RESUME_FLAG_KEY, {
      localId: this.state.draft.localId,
      store: 'localDrafts',
      mode: this.state.mode,
      selectedBlockId: this.state.selectedBlockId,
      hash: this.state.hash ?? (typeof window !== 'undefined' ? window.location.hash ?? '' : ''),
      scrollToken:
        this.state.scrollToken ??
        (typeof window !== 'undefined' ? String(window.scrollY ?? 0) : null),
      updatedAt: nowIso(),
    });
  }
}

function renderEditorShell(session) {
  if (!app) return;
  const isDebugMode = new URLSearchParams(window.location.search).get('debug') === '1';

  const shell = document.createElement('div');
  shell.className = 'editor-shell';

  const topBar = document.createElement('section');
  topBar.className = 'editor-topbar';
  const saveStateEl = document.createElement('p');
  saveStateEl.className = 'editor-topbar-item';
  const lastSavedEl = document.createElement('p');
  lastSavedEl.className = 'editor-topbar-item';
  const validationEl = document.createElement('p');
  validationEl.className = 'editor-topbar-item';
  const localDraftIdEl = document.createElement('p');
  localDraftIdEl.className = 'editor-topbar-item';
  const localDraftIdLabel = document.createElement('span');
  localDraftIdLabel.className = 'editor-label';
  localDraftIdLabel.textContent = 'localDraftId:';
  const localDraftIdValue = document.createElement('span');
  localDraftIdValue.className = 'editor-id-value';
  localDraftIdEl.append(localDraftIdLabel, localDraftIdValue);

  const layout = document.createElement('section');
  layout.className = 'editor-layout';

  const leftPanel = document.createElement('aside');
  leftPanel.className = 'editor-panel left';
  const rightPanel = document.createElement('section');
  rightPanel.className = 'editor-panel right';

  const leftHeading = document.createElement('h2');
  leftHeading.textContent = 'Blocks';
  const rightHeading = document.createElement('h2');
  rightHeading.textContent = 'Block Details';

  const blockList = document.createElement('ul');
  blockList.className = 'block-list';

  const controlsRow = document.createElement('div');
  controlsRow.className = 'button-row';

  const metaRow = document.createElement('div');
  metaRow.className = 'button-row';
  metaRow.classList.add('stacked-actions');

  const statusRow = document.createElement('p');
  statusRow.className = 'muted';
  const moreActions = document.createElement('details');
  moreActions.className = 'editor-more-actions';
  const moreActionsSummary = document.createElement('summary');
  moreActionsSummary.textContent = 'More Actions';
  moreActions.appendChild(moreActionsSummary);

  const blockKind = document.createElement('select');
  blockKind.id = 'editor-block-kind';
  blockKind.className = 'control';
  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'application/zip,.zip,application/json,.json';
  importFileInput.style.display = 'none';
  const titleInput = document.createElement('input');
  titleInput.placeholder = 'Worksheet title';
  titleInput.className = 'control';
  const blockEditor = document.createElement('textarea');
  blockEditor.id = 'editor-block-editor';
  blockEditor.rows = 8;
  blockEditor.className = 'control';

  const questionInputType = document.createElement('select');
  questionInputType.id = 'editor-question-input-type';
  questionInputType.className = 'control';
  [
    { value: 'text', label: 'text' },
    { value: 'number', label: 'number' },
    { value: 'boolean', label: 'True / False' },
    { value: 'multiple_choice', label: 'multiple_choice' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionInputType.appendChild(option);
  });
  const questionTextDisplayMode = document.createElement('select');
  questionTextDisplayMode.id = 'editor-question-text-display-mode';
  questionTextDisplayMode.className = 'control';
  [
    { value: 'single_line', label: 'single_line' },
    { value: 'multi_line', label: 'multi_line' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionTextDisplayMode.appendChild(option);
  });
  const questionMaxLength = document.createElement('input');
  questionMaxLength.id = 'editor-question-max-length';
  questionMaxLength.type = 'number';
  questionMaxLength.min = '1';
  questionMaxLength.className = 'control';
  const questionOptions = document.createElement('textarea');
  questionOptions.id = 'editor-question-options';
  questionOptions.style.display = 'none';
  const questionOptionsList = document.createElement('div');
  questionOptionsList.className = 'question-options-list';
  const questionOptionWarning = document.createElement('p');
  questionOptionWarning.className = 'control-error option-warning';
  questionOptionWarning.hidden = true;
  const addOptionBtn = document.createElement('button');
  addOptionBtn.type = 'button';
  addOptionBtn.className = 'option-add-btn';
  addOptionBtn.textContent = '+ Add option';
  const questionSelectionMode = document.createElement('select');
  questionSelectionMode.id = 'editor-question-selection-mode';
  questionSelectionMode.className = 'control';
  [
    { value: 'single', label: 'single' },
    { value: 'multi', label: 'multi' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionSelectionMode.appendChild(option);
  });
  const questionShuffleOptions = document.createElement('input');
  questionShuffleOptions.id = 'editor-question-shuffle-options';
  questionShuffleOptions.type = 'checkbox';
  questionShuffleOptions.className = 'control';
  const questionMin = document.createElement('input');
  questionMin.id = 'editor-question-min';
  questionMin.type = 'number';
  questionMin.className = 'control';
  const questionMax = document.createElement('input');
  questionMax.id = 'editor-question-max';
  questionMax.type = 'number';
  questionMax.className = 'control';
  const questionNumberAllowSigned = document.createElement('input');
  questionNumberAllowSigned.id = 'editor-question-number-allow-signed';
  questionNumberAllowSigned.type = 'checkbox';
  questionNumberAllowSigned.className = 'control';
  const questionNumberDecimalPlacesAllowed = document.createElement('input');
  questionNumberDecimalPlacesAllowed.id = 'editor-question-number-decimal-places-allowed';
  questionNumberDecimalPlacesAllowed.type = 'number';
  questionNumberDecimalPlacesAllowed.min = '0';
  questionNumberDecimalPlacesAllowed.step = '1';
  questionNumberDecimalPlacesAllowed.className = 'control';
  const questionCorrectAnswerBoolean = document.createElement('select');
  questionCorrectAnswerBoolean.id = 'editor-question-correct-answer-boolean';
  questionCorrectAnswerBoolean.className = 'control';
  [
    { value: '', label: '— Unset —' },
    { value: 'true', label: 'True' },
    { value: 'false', label: 'False' },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionCorrectAnswerBoolean.appendChild(option);
  });
  const questionCorrectAnswerNumber = document.createElement('input');
  questionCorrectAnswerNumber.id = 'editor-question-correct-answer-number';
  questionCorrectAnswerNumber.type = 'number';
  questionCorrectAnswerNumber.step = 'any';
  questionCorrectAnswerNumber.className = 'control';
  const questionMinError = document.createElement('p');
  questionMinError.className = 'control-error';
  const questionMaxError = document.createElement('p');
  questionMaxError.className = 'control-error';
  const questionNumberDecimalPlacesAllowedError = document.createElement('p');
  questionNumberDecimalPlacesAllowedError.className = 'control-error';
  const questionCorrectAnswerNumberError = document.createElement('p');
  questionCorrectAnswerNumberError.className = 'control-error';
  const mediaFeedback = document.createElement('p');
  mediaFeedback.className = 'control-error';

  const questionImageInput = document.createElement('input');
  questionImageInput.type = 'file';
  questionImageInput.accept = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
  questionImageInput.style.display = 'none';
  const questionAudioInput = document.createElement('input');
  questionAudioInput.type = 'file';
  questionAudioInput.accept = '.mp3,audio/mpeg';
  questionAudioInput.style.display = 'none';
  const optionAudioInput = document.createElement('input');
  optionAudioInput.type = 'file';
  optionAudioInput.accept = '.mp3,audio/mpeg';
  optionAudioInput.style.display = 'none';
  let pendingOptionAudioTarget = null;
  let activeConfirmDialog = null;

  function closeActiveConfirmDialog(confirmed = false) {
    const dialog = activeConfirmDialog;
    if (!dialog) return;
    dialog.cleanup();
    activeConfirmDialog = null;
    dialog.resolve(Boolean(confirmed));
  }

  function showConfirmDialog({
    title,
    entityLabel,
    descriptionText,
    removalItems = [],
    confirmLabel = 'Delete',
  }) {
    if (activeConfirmDialog) {
      closeActiveConfirmDialog(false);
    }
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    overlay.setAttribute('role', 'presentation');
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    const titleId = `confirm-modal-title-${createLocalId('dlg')}`;
    heading.id = titleId;
    heading.textContent = title;
    dialog.setAttribute('aria-labelledby', titleId);
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    description.textContent = isNonEmptyString(descriptionText)
      ? descriptionText
      : `You are deleting ${entityLabel}.`;
    const detailsHeading = document.createElement('p');
    detailsHeading.className = 'confirm-modal__details-heading';
    detailsHeading.textContent = 'This will remove:';
    const detailsList = document.createElement('ul');
    detailsList.className = 'confirm-modal__details-list';
    removalItems.forEach((item) => {
      const line = document.createElement('li');
      line.textContent = item;
      detailsList.appendChild(line);
    });
    const warning = document.createElement('p');
    warning.className = 'confirm-modal__warning';
    warning.textContent = 'This action is irreversible. Undo is not available.';
    const actionRow = document.createElement('div');
    actionRow.className = 'confirm-modal__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = 'Cancel';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'confirm-modal__btn confirm-modal__btn--destructive';
    deleteBtn.textContent = confirmLabel;
    actionRow.append(cancelBtn, deleteBtn);
    dialog.append(heading, description, detailsHeading, detailsList, warning, actionRow);
    overlay.appendChild(dialog);
    shell.appendChild(overlay);

    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const getFocusable = () => Array.from(dialog.querySelectorAll(focusableSelector))
      .filter((candidate) => !candidate.hasAttribute('disabled'));
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeActiveConfirmDialog(false);
        return;
      }
      if (event.key === 'Enter' && document.activeElement === cancelBtn) {
        event.preventDefault();
        closeActiveConfirmDialog(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
        return;
      }
      if (currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    cancelBtn.addEventListener('click', () => closeActiveConfirmDialog(false));
    deleteBtn.addEventListener('click', () => closeActiveConfirmDialog(true));

    cancelBtn.focus();

    return new Promise((resolve) => {
      activeConfirmDialog = {
        resolve,
        cleanup: () => {
          dialog.removeEventListener('keydown', onKeyDown);
          overlay.remove();
          if (previousActive && typeof previousActive.focus === 'function') {
            previousActive.focus();
          }
        },
      };
    });
  }
  ['content', 'question'].forEach((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    blockKind.appendChild(option);
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save Now';
  const addContentBtn = document.createElement('button');
  addContentBtn.type = 'button';
  addContentBtn.textContent = 'Add Content';
  const addQuestionBtn = document.createElement('button');
  addQuestionBtn.type = 'button';
  addQuestionBtn.textContent = 'Add Question';
  const openViewerBtn = document.createElement('button');
  openViewerBtn.type = 'button';
  openViewerBtn.textContent = 'Open in Viewer (same tab)';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = 'Import package (.zip) / legacy JSON';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export package (.zip)';
  const localPublishBtn = document.createElement('button');
  localPublishBtn.type = 'button';
  localPublishBtn.textContent = 'Generate publish payload (debug)';
  const localPublishHint = document.createElement('p');
  localPublishHint.className = 'muted';
  localPublishHint.textContent = 'Debug only: generates a local snapshot preview and does not call server publish APIs.';
  const rewriteBtn = document.createElement('button');
  rewriteBtn.type = 'button';
  rewriteBtn.textContent = 'Rewrite (Sign-in required)';
  const t2aBtn = document.createElement('button');
  t2aBtn.type = 'button';
  t2aBtn.textContent = 'T2A (Sign-in required)';
  const syncDraftBtn = document.createElement('button');
  syncDraftBtn.type = 'button';
  syncDraftBtn.textContent = 'Sync Draft (Sign-in required)';
  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.textContent = 'Publish (Sign-in required)';
  const protectedActionsColumn = document.createElement('div');
  protectedActionsColumn.className = 'action-column';
  let detailSignature = null;
  let optionActionSignature = null;

  const updateNumberValidationFeedback = (selectedBlock) => {
    const clearFieldError = (input, errorNode) => {
      input.classList.remove('control-invalid');
      errorNode.textContent = '';
    };
    clearFieldError(questionMin, questionMinError);
    clearFieldError(questionMax, questionMaxError);
    clearFieldError(questionNumberDecimalPlacesAllowed, questionNumberDecimalPlacesAllowedError);
    clearFieldError(questionCorrectAnswerNumber, questionCorrectAnswerNumberError);

    if (!selectedBlock || selectedBlock.kind !== 'question') return;
    const responseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
    if (responseConfig.inputType !== 'number') return;

    const errors = getNumberQuestionValidationErrors(responseConfig, {
      decimalPlacesAllowed: questionNumberDecimalPlacesAllowed.value,
      correctAnswer: questionCorrectAnswerNumber.value,
    });
    const setFieldError = (input, errorNode, message) => {
      if (!message) return;
      input.classList.add('control-invalid');
      errorNode.textContent = message;
    };
    setFieldError(questionMin, questionMinError, errors.min);
    setFieldError(questionMax, questionMaxError, errors.max);
    setFieldError(
      questionNumberDecimalPlacesAllowed,
      questionNumberDecimalPlacesAllowedError,
      errors.decimalPlacesAllowed
    );
    setFieldError(questionCorrectAnswerNumber, questionCorrectAnswerNumberError, errors.correctAnswer);
  };

  const syncFormControls = () => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const selectedText = selectedBlock?.prompt?.text || selectedBlock?.content?.text || '';
    const activeElement = document.activeElement;

    if (activeElement !== titleInput) {
      titleInput.value = session.state.draft?.title || '';
    }
    if (activeElement !== blockEditor) {
      blockEditor.value = selectedText;
    }
    if (selectedBlock && activeElement !== blockKind) {
      blockKind.value = selectedBlock.kind;
    }
    if (selectedBlock?.kind === 'question') {
      const responseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
      if (activeElement !== questionInputType) {
        questionInputType.value = responseConfig.inputType || 'text';
      }
      if (activeElement !== questionMaxLength) {
        questionMaxLength.value = responseConfig.maxLength || 200;
      }
      if (activeElement !== questionTextDisplayMode) {
        questionTextDisplayMode.value = responseConfig.displayMode || 'multi_line';
      }
      if (activeElement !== questionOptions) {
        questionOptions.value = (responseConfig.options || [])
          .map((option) => String(option?.value ?? option?.label ?? ''))
          .join('\n');
      }
      if (activeElement !== questionSelectionMode) {
        questionSelectionMode.value = responseConfig.selectionMode || 'single';
      }
      if (activeElement !== questionShuffleOptions) {
        questionShuffleOptions.checked = Boolean(responseConfig.shuffleOptions);
      }
      if (activeElement !== questionMin) questionMin.value = responseConfig.min ?? '';
      if (activeElement !== questionMax) questionMax.value = responseConfig.max ?? '';
      if (activeElement !== questionNumberAllowSigned) {
        questionNumberAllowSigned.checked = responseConfig.numberRules?.allowSigned !== false;
      }
      if (activeElement !== questionNumberDecimalPlacesAllowed) {
        questionNumberDecimalPlacesAllowed.value = Number.isInteger(responseConfig.numberRules?.decimalPlacesAllowed)
          ? String(responseConfig.numberRules.decimalPlacesAllowed)
          : '';
      }
      if (activeElement !== questionCorrectAnswerBoolean) {
        if (typeof responseConfig.correctAnswer === 'boolean') {
          questionCorrectAnswerBoolean.value = responseConfig.correctAnswer ? 'true' : 'false';
        } else {
          questionCorrectAnswerBoolean.value = '';
        }
      }
      if (activeElement !== questionCorrectAnswerNumber) {
        questionCorrectAnswerNumber.value = typeof responseConfig.correctAnswer === 'number'
          ? String(responseConfig.correctAnswer)
          : '';
      }
    }
    updateNumberValidationFeedback(selectedBlock);
  };

  const renderBlockList = () => {
    blockList.innerHTML = '';
    const blocks = (session.state.draft?.blocks || []).slice().sort((a, b) => a.position - b.position);
    blocks.forEach((block, index) => {
      const isFirst = index === 0;
      const isLast = index === blocks.length - 1;
      const item = document.createElement('li');
      item.className = `block-item ${block.blockId === session.state.selectedBlockId ? 'selected' : ''}`;
      const row = document.createElement('div');
      row.className = 'block-item-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'block-select';
      const displayIndex = index + 1;
      const previewSource = block.kind === 'question' ? block?.prompt?.text : block?.content?.text;
      const preview = String(previewSource || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '—';
      button.textContent = `${displayIndex}. ${block.kind} — ${preview}`;
      button.addEventListener('click', () => {
        session.selectBlock(block.blockId);
        updateSummary();
      });
      const actions = document.createElement('div');
      actions.className = 'block-item-actions';
      const moveUpBtn = document.createElement('button');
      moveUpBtn.type = 'button';
      moveUpBtn.className = 'icon-btn';
      moveUpBtn.title = `Move block ${displayIndex} up`;
      moveUpBtn.setAttribute('aria-label', `Move block ${displayIndex} up`);
      moveUpBtn.textContent = '▲';
      moveUpBtn.disabled = isFirst;
      moveUpBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        session.reorderBlockByDelta(block.blockId, -1);
        updateSummary();
      });
      const moveDownBtn = document.createElement('button');
      moveDownBtn.type = 'button';
      moveDownBtn.className = 'icon-btn';
      moveDownBtn.title = `Move block ${displayIndex} down`;
      moveDownBtn.setAttribute('aria-label', `Move block ${displayIndex} down`);
      moveDownBtn.textContent = '▼';
      moveDownBtn.disabled = isLast;
      moveDownBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        session.reorderBlockByDelta(block.blockId, 1);
        updateSummary();
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'icon-btn danger';
      deleteBtn.title = 'Delete this block';
      deleteBtn.setAttribute('aria-label', `Delete block ${displayIndex}`);
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const outcome = session.deleteBlockWithPolicy(block.blockId);
        if (!outcome.ok && outcome.reason === 'confirm-delete-required') {
          const removalItems = [];
          if (outcome.policy.hasTypedContent) {
            removalItems.push('Block text and any question prompt or option values.');
          }
          if (outcome.policy.hasAssets) {
            removalItems.push('Any linked image/audio files and related asset metadata.');
          }
          const confirmed = await showConfirmDialog({
            title: `Delete block ${displayIndex}?`,
            entityLabel: `block ${displayIndex}`,
            removalItems,
            confirmLabel: 'Delete block',
          });
          if (!confirmed) return;
          session.deleteBlockWithPolicy(block.blockId, { confirmDelete: true });
        }
        updateSummary();
      });
      actions.append(moveUpBtn, moveDownBtn, deleteBtn);
      row.append(button, actions);
      item.appendChild(row);
      blockList.appendChild(item);
    });
  };

  const computeDetailSignature = (selectedBlock) => {
    if (!selectedBlock) {
      return 'none';
    }
    const normalizedResponseConfig = selectedBlock.kind === 'question'
      ? normalizeQuestionResponseConfig(selectedBlock.responseConfig)
      : null;
    const normalizedInputType = normalizedResponseConfig?.inputType || 'text';
    const normalizedSelectionMode = normalizedResponseConfig?.selectionMode || '';
    const normalizedPromptMediaRefs = selectedBlock.kind === 'question'
      ? JSON.stringify(normalizeMediaRefs(selectedBlock?.prompt?.mediaRefs).map((ref) => [
        String(ref?.usage ?? ''),
        String(ref?.assetId ?? ''),
      ]))
      : '[]';
    const normalizedOptionMediaRefs = selectedBlock.kind === 'question'
      ? JSON.stringify((normalizedResponseConfig?.options || []).map((opt) => {
        const normalized = normalizeResponseOption(opt);
        return [
          String(normalized.id ?? ''),
          ...normalizeMediaRefs(normalized.mediaRefs, 'option_audio').map((ref) => String(ref?.assetId ?? '')),
        ];
      }))
      : '[]';
    const normalizedCorrectAnswer = (() => {
      if (!normalizedResponseConfig || normalizedInputType !== 'multiple_choice') {
        return '';
      }
      if (normalizedSelectionMode === 'single') {
        return typeof normalizedResponseConfig.correctAnswer === 'string'
          ? normalizedResponseConfig.correctAnswer
          : '';
      }
      if (normalizedSelectionMode === 'multi') {
        const values = Array.isArray(normalizedResponseConfig.correctAnswer)
          ? normalizedResponseConfig.correctAnswer.filter((value) => typeof value === 'string').slice().sort()
          : [];
        return JSON.stringify(values);
      }
      return '';
    })();
    return [
      selectedBlock.blockId,
      selectedBlock.kind,
      normalizedInputType,
      normalizedResponseConfig?.displayMode || '',
      normalizedSelectionMode,
      normalizedResponseConfig?.shuffleOptions ? '1' : '0',
      normalizedPromptMediaRefs,
      JSON.stringify((normalizedResponseConfig?.options || []).map((opt) => [
        String(opt?.value ?? ''),
        String(opt?.label ?? ''),
      ])),
      normalizedOptionMediaRefs,
      normalizedCorrectAnswer,
    ].join(':');
  };

  const computeOptionActionSignature = (selectedBlock) => {
    if (!selectedBlock || selectedBlock.kind !== 'question') {
      return 'none';
    }
    const normalizedResponseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
    if (normalizedResponseConfig.inputType !== 'multiple_choice') {
      return `${selectedBlock.blockId}:non-multiple-choice`;
    }
    return JSON.stringify((normalizedResponseConfig.options || []).map((option, index) => {
      const normalized = normalizeResponseOption(option, `option_${index}`);
      return [
        String(normalized.id ?? ''),
        ...normalizeMediaRefs(normalized.mediaRefs, 'option_audio').map((ref) => String(ref?.assetId ?? '')),
      ];
    }));
  };

  const renderDetailEditor = ({ force = false } = {}) => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const activeOptionInput = (
      typeof HTMLInputElement !== 'undefined' &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.dataset.optionInput === '1' &&
      questionOptionsList.contains(document.activeElement)
    )
      ? document.activeElement
      : null;
    const activeOptionInputIndex = activeOptionInput
      ? Number.parseInt(activeOptionInput.dataset.optionIndex || '', 10)
      : Number.NaN;
    const activeOptionSelectionStart = activeOptionInput && Number.isInteger(activeOptionInput.selectionStart)
      ? activeOptionInput.selectionStart
      : null;
    const activeOptionSelectionEnd = activeOptionInput && Number.isInteger(activeOptionInput.selectionEnd)
      ? activeOptionInput.selectionEnd
      : null;
    const isOptionInputActive =
      typeof HTMLInputElement !== 'undefined' &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.dataset.optionInput === '1';
    const nextOptionActionSignature = computeOptionActionSignature(selectedBlock);
    if (
      !force &&
      isOptionInputActive &&
      selectedBlock?.responseConfig?.inputType === 'multiple_choice' &&
      questionOptionsList.contains(document.activeElement) &&
      nextOptionActionSignature === optionActionSignature
    ) {
      return;
    }
    const nextSignature = computeDetailSignature(selectedBlock);
    if (!force && nextSignature === detailSignature) {
      return;
    }
    detailSignature = nextSignature;
    optionActionSignature = nextOptionActionSignature;
    rightPanel.innerHTML = '';
    rightPanel.append(rightHeading, statusRow);
    if (!selectedBlock) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a block to edit.';
      rightPanel.appendChild(empty);
      return;
    }

    const kindLabel = document.createElement('label');
    kindLabel.textContent = 'Block kind';
    kindLabel.htmlFor = 'editor-block-kind';
    rightPanel.append(kindLabel, blockKind);

    if (selectedBlock.kind === 'content') {
      const contentLabel = document.createElement('label');
      contentLabel.textContent = 'Content text';
      contentLabel.htmlFor = 'editor-block-editor';
      blockEditor.placeholder = 'Content block text';
      rightPanel.append(contentLabel, blockEditor);
      return;
    }

    const promptLabel = document.createElement('label');
    promptLabel.textContent = 'Question prompt';
    promptLabel.htmlFor = 'editor-block-editor';
    blockEditor.placeholder = 'Question prompt';
    rightPanel.append(promptLabel, blockEditor);

    const promptMediaRefs = normalizeMediaRefs(selectedBlock?.prompt?.mediaRefs);
    const currentQuestionImageRef = getSingleMediaRef(promptMediaRefs, 'question_image');
    const currentQuestionAudioRef = getSingleMediaRef(promptMediaRefs, 'question_audio');

    const questionImageRow = document.createElement('div');
    questionImageRow.className = 'button-row';
    const questionImageLabel = document.createElement('label');
    questionImageLabel.textContent = currentQuestionImageRef
      ? `Question image attached (${currentQuestionImageRef.assetId})`
      : 'Question image: none attached';
    const attachImageBtn = document.createElement('button');
    attachImageBtn.type = 'button';
    attachImageBtn.className = 'media-action-btn';
    attachImageBtn.innerHTML = `<span class="media-action-btn__icon" aria-hidden="true">🖼</span><span>${currentQuestionImageRef ? 'Replace image…' : 'Attach image…'}</span>`;
    const removeImageBtn = document.createElement('button');
    removeImageBtn.type = 'button';
    removeImageBtn.className = 'media-action-btn media-action-btn--remove';
    removeImageBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">🖼</span><span>Remove image</span>';
    removeImageBtn.disabled = !currentQuestionImageRef;
    const viewImageBtn = document.createElement('button');
    viewImageBtn.type = 'button';
    viewImageBtn.className = 'media-action-btn';
    viewImageBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">👁</span><span>View image</span>';
    viewImageBtn.disabled = !currentQuestionImageRef;
    attachImageBtn.addEventListener('click', () => {
      questionImageInput.dataset.blockId = selectedBlock.blockId;
      questionImageInput.value = '';
      questionImageInput.click();
    });
    removeImageBtn.addEventListener('click', async () => {
      const confirmed = window.confirm('Remove the current question image attachment?');
      const result = await session.removeQuestionMedia(selectedBlock.blockId, 'question_image', { confirmRemove: confirmed });
      if (!result.ok && result.reason !== 'confirm-remove-required') {
        updateSummary();
      } else if (result.ok) {
        updateSummary();
      }
    });
    viewImageBtn.addEventListener('click', async () => {
      if (!currentQuestionImageRef?.assetId) return;
      await session.openAssetImage(currentQuestionImageRef.assetId);
      updateSummary();
    });
    questionImageRow.append(attachImageBtn, viewImageBtn, removeImageBtn);
    rightPanel.append(questionImageLabel, questionImageRow);

    const questionAudioRow = document.createElement('div');
    questionAudioRow.className = 'button-row';
    const questionAudioLabel = document.createElement('label');
    questionAudioLabel.textContent = currentQuestionAudioRef
      ? `Question audio attached (${currentQuestionAudioRef.assetId})`
      : 'Question audio: none attached';
    const attachQuestionAudioBtn = document.createElement('button');
    attachQuestionAudioBtn.type = 'button';
    attachQuestionAudioBtn.className = 'media-action-btn';
    attachQuestionAudioBtn.innerHTML = `<span class="media-action-btn__icon" aria-hidden="true">♪</span><span>${currentQuestionAudioRef ? 'Replace audio…' : 'Attach audio…'}</span>`;
    const removeQuestionAudioBtn = document.createElement('button');
    removeQuestionAudioBtn.type = 'button';
    removeQuestionAudioBtn.className = 'media-action-btn media-action-btn--remove';
    removeQuestionAudioBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">♪</span><span>Remove audio</span>';
    removeQuestionAudioBtn.disabled = !currentQuestionAudioRef;
    const playQuestionAudioBtn = document.createElement('button');
    playQuestionAudioBtn.type = 'button';
    playQuestionAudioBtn.className = 'media-action-btn';
    playQuestionAudioBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">▶</span><span>Play audio</span>';
    playQuestionAudioBtn.disabled = !currentQuestionAudioRef;
    attachQuestionAudioBtn.addEventListener('click', () => {
      questionAudioInput.dataset.blockId = selectedBlock.blockId;
      questionAudioInput.value = '';
      questionAudioInput.click();
    });
    removeQuestionAudioBtn.addEventListener('click', async () => {
      const confirmed = window.confirm('Remove the current question audio attachment?');
      const result = await session.removeQuestionMedia(selectedBlock.blockId, 'question_audio', { confirmRemove: confirmed });
      if (result.ok || result.reason !== 'confirm-remove-required') {
        updateSummary();
      }
    });
    playQuestionAudioBtn.addEventListener('click', async () => {
      if (!currentQuestionAudioRef?.assetId || playQuestionAudioBtn.disabled) return;
      playQuestionAudioBtn.disabled = true;
      const result = await session.playAssetAudio(currentQuestionAudioRef.assetId, {
        onEnded: () => {
          playQuestionAudioBtn.disabled = false;
        },
        onError: () => {
          playQuestionAudioBtn.disabled = false;
        },
        onInterrupted: () => {
          playQuestionAudioBtn.disabled = false;
        },
      });
      if (!result.ok) {
        playQuestionAudioBtn.disabled = false;
      }
      updateSummary();
    });
    questionAudioRow.append(attachQuestionAudioBtn, playQuestionAudioBtn, removeQuestionAudioBtn);
    rightPanel.append(questionAudioLabel, questionAudioRow, mediaFeedback);

    const inputTypeLabel = document.createElement('label');
    inputTypeLabel.textContent = 'Answer input type';
    inputTypeLabel.htmlFor = 'editor-question-input-type';
    rightPanel.append(inputTypeLabel, questionInputType);

    const activeInputType = selectedBlock.responseConfig?.inputType || 'text';
    if (TEXT_INPUT_TYPES.has(activeInputType)) {
      const maxLengthLabel = document.createElement('label');
      maxLengthLabel.textContent = 'Max length';
      maxLengthLabel.htmlFor = 'editor-question-max-length';
      rightPanel.append(maxLengthLabel, questionMaxLength);

      const displayModeLabel = document.createElement('label');
      displayModeLabel.textContent = 'Text display mode';
      displayModeLabel.htmlFor = 'editor-question-text-display-mode';
      rightPanel.append(displayModeLabel, questionTextDisplayMode);
    }

    if (activeInputType === 'number') {
      const minLabel = document.createElement('label');
      minLabel.textContent = 'Min';
      minLabel.htmlFor = 'editor-question-min';
      const maxLabel = document.createElement('label');
      maxLabel.textContent = 'Max';
      maxLabel.htmlFor = 'editor-question-max';
      rightPanel.append(minLabel, questionMin, questionMinError, maxLabel, questionMax, questionMaxError);

      const signedRow = document.createElement('label');
      signedRow.className = 'inline-toggle';
      signedRow.htmlFor = 'editor-question-number-allow-signed';
      const signedText = document.createElement('span');
      signedText.textContent = 'Allow signed values (+/-)';
      signedRow.append(signedText, questionNumberAllowSigned);
      rightPanel.append(signedRow);

      const decimalPlacesLabel = document.createElement('label');
      decimalPlacesLabel.textContent = 'Decimal places allowed (blank = unlimited)';
      decimalPlacesLabel.htmlFor = 'editor-question-number-decimal-places-allowed';
      rightPanel.append(decimalPlacesLabel, questionNumberDecimalPlacesAllowed, questionNumberDecimalPlacesAllowedError);

      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.textContent = 'Correct answer';
      correctAnswerLabel.htmlFor = 'editor-question-correct-answer-number';
      rightPanel.append(correctAnswerLabel, questionCorrectAnswerNumber, questionCorrectAnswerNumberError);
    }

    if (activeInputType === 'boolean') {
      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.textContent = 'Correct answer';
      correctAnswerLabel.htmlFor = 'editor-question-correct-answer-boolean';
      rightPanel.append(correctAnswerLabel, questionCorrectAnswerBoolean);
    }

    if (activeInputType === 'multiple_choice') {
      const selectionModeLabel = document.createElement('label');
      selectionModeLabel.textContent = 'Selection mode';
      selectionModeLabel.htmlFor = 'editor-question-selection-mode';
      rightPanel.append(selectionModeLabel, questionSelectionMode);

      const shuffleRow = document.createElement('label');
      shuffleRow.className = 'inline-toggle';
      shuffleRow.htmlFor = 'editor-question-shuffle-options';
      const shuffleText = document.createElement('span');
      shuffleText.textContent = 'Shuffle options';
      shuffleRow.append(shuffleText, questionShuffleOptions);
      rightPanel.append(shuffleRow);

      const optionsLabel = document.createElement('label');
      optionsLabel.textContent = 'Options';
      optionsLabel.htmlFor = 'editor-question-options';
      rightPanel.append(optionsLabel);

      const normalizedResponseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
      const normalizedOptions = (normalizedResponseConfig.options || []).map((option, index) =>
        normalizeResponseOption(option, `option_${index}`));
      const optionList = normalizedOptions.length > 0
        ? normalizedOptions
        : [{ id: createLocalId('opt'), value: '', label: '' }];
      const persistedOptionIds = new Set(normalizedOptions.map((option) => String(option?.id || '')));
      const isMultiSelect = normalizedResponseConfig.selectionMode === 'multi';
      const selectedOptionIds = new Set(Array.isArray(normalizedResponseConfig.correctAnswerOptionIds)
        ? normalizedResponseConfig.correctAnswerOptionIds.map((optionId) => String(optionId))
        : []);
      const hasSelectedSingleOptionId = typeof normalizedResponseConfig.correctAnswerOptionId === 'string'
        && normalizedResponseConfig.correctAnswerOptionId.length > 0;
      const selectedSingleOptionId = hasSelectedSingleOptionId
        ? normalizedResponseConfig.correctAnswerOptionId
        : '';
      const duplicateOptionValues = getDuplicateOptionValues(normalizedOptions);
      if (duplicateOptionValues.length > 0) {
        questionOptionWarning.hidden = false;
        questionOptionWarning.textContent = `Option values must be unique. Duplicate values: ${duplicateOptionValues.join(', ')}.`;
      } else if (isNonEmptyString(normalizedResponseConfig.correctAnswerMappingWarning)) {
        questionOptionWarning.hidden = false;
        questionOptionWarning.textContent = normalizedResponseConfig.correctAnswerMappingWarning;
      } else {
        questionOptionWarning.hidden = true;
        questionOptionWarning.textContent = '';
      }

      questionOptionsList.innerHTML = '';
      optionList.forEach((option, optionIndex) => {
        const optionId = String(option?.id || '');
        const optionValue = String(option?.value ?? '');
        const isPersistedOption = persistedOptionIds.has(optionId);
        const row = document.createElement('div');
        row.className = 'option-row';

        const isSelected = isMultiSelect
          ? selectedOptionIds.has(optionId)
          : hasSelectedSingleOptionId && selectedSingleOptionId === optionId;
        const correctToggle = document.createElement('button');
        correctToggle.type = 'button';
        correctToggle.className = 'option-correct-toggle';
        correctToggle.title = isMultiSelect ? 'Include in correct answers' : 'Mark as the correct answer';
        correctToggle.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        correctToggle.setAttribute(
          'aria-label',
          isMultiSelect
            ? `Toggle option ${optionIndex + 1} correct answer`
            : `Toggle option ${optionIndex + 1} as the correct answer`
        );
        correctToggle.addEventListener('click', () => {
          if (!isMultiSelect) {
            session.updateQuestionCorrectAnswerChoice(
              selectedBlock.blockId,
              isSelected ? '' : optionId
            );
            updateSummary();
            return;
          }
          const nextOptionIds = Array.from(selectedOptionIds);
          if (selectedOptionIds.has(optionId)) {
            const removeIndex = nextOptionIds.indexOf(optionId);
            if (removeIndex >= 0) {
              nextOptionIds.splice(removeIndex, 1);
            }
          } else {
            nextOptionIds.push(optionId);
          }
          session.updateQuestionCorrectAnswerChoices(selectedBlock.blockId, nextOptionIds);
          updateSummary();
        });
        const tickIcon = document.createElement('span');
        tickIcon.className = 'option-correct-toggle__tick';
        tickIcon.setAttribute('aria-hidden', 'true');
        tickIcon.textContent = '✓';
        correctToggle.appendChild(tickIcon);

        const optionInput = document.createElement('input');
        optionInput.type = 'text';
        optionInput.dataset.optionInput = '1';
        optionInput.dataset.optionIndex = String(optionIndex);
        optionInput.className = 'control';
        optionInput.placeholder = `Option ${optionIndex + 1}`;
        optionInput.value = String(option?.label ?? option?.value ?? '');
        optionInput.addEventListener('input', () => {
          session.updateQuestionOptionAtIndex(selectedBlock.blockId, optionIndex, optionInput.value);
        });
        const optionAudioRef = getSingleMediaRef(option.mediaRefs, 'option_audio');
        const optionActionsMenu = document.createElement('details');
        optionActionsMenu.className = 'option-actions-menu';
        const optionActionsToggle = document.createElement('summary');
        optionActionsToggle.className = 'icon-btn option-actions-menu__toggle';
        optionActionsToggle.setAttribute('role', 'button');
        optionActionsToggle.setAttribute('aria-label', `More actions for option ${optionIndex + 1}`);
        optionActionsToggle.title = 'More actions';
        optionActionsToggle.textContent = '⋯';
        optionActionsMenu.appendChild(optionActionsToggle);
        const optionActionsList = document.createElement('div');
        optionActionsList.className = 'option-actions-menu__list';

        const optionAudioBtn = document.createElement('button');
        optionAudioBtn.type = 'button';
        optionAudioBtn.className = 'media-action-btn option-actions-menu__item';
        optionAudioBtn.innerHTML = `<span class="media-action-btn__icon" aria-hidden="true">♪</span><span>${optionAudioRef ? 'Replace audio…' : 'Attach audio…'}</span>`;
        optionAudioBtn.title = isPersistedOption
          ? optionAudioRef ? 'Replace option audio' : 'Attach option audio'
          : 'Enter option text or click Add option before attaching audio';
        optionAudioBtn.disabled = !isPersistedOption;
        optionAudioBtn.addEventListener('click', () => {
          if (!isPersistedOption) {
            session.setMediaFeedback('Enter option text or click Add option before attaching audio.');
            updateSummary();
            return;
          }
          pendingOptionAudioTarget = { blockId: selectedBlock.blockId, optionId };
          optionActionsMenu.open = false;
          optionAudioInput.value = '';
          optionAudioInput.click();
        });
        const removeOptionAudioBtn = document.createElement('button');
        removeOptionAudioBtn.type = 'button';
        removeOptionAudioBtn.className = 'media-action-btn media-action-btn--remove option-actions-menu__item';
        removeOptionAudioBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">♪</span><span>Remove audio</span>';
        removeOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption;
        removeOptionAudioBtn.addEventListener('click', async () => {
          const confirmed = window.confirm(`Remove audio from option ${optionIndex + 1}?`);
          const result = await session.removeOptionAudio(selectedBlock.blockId, optionId, { confirmRemove: confirmed });
          if (result.ok || result.reason !== 'confirm-remove-required') {
            updateSummary();
          }
          optionActionsMenu.open = false;
        });
        const playOptionAudioBtn = document.createElement('button');
        playOptionAudioBtn.type = 'button';
        playOptionAudioBtn.className = 'media-action-btn option-actions-menu__item';
        playOptionAudioBtn.innerHTML = '<span class="media-action-btn__icon" aria-hidden="true">▶</span><span>Play audio</span>';
        playOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption;
        playOptionAudioBtn.addEventListener('click', async () => {
          if (!optionAudioRef?.assetId || playOptionAudioBtn.disabled) return;
          playOptionAudioBtn.disabled = true;
          const result = await session.playAssetAudio(optionAudioRef.assetId, {
            onEnded: () => {
              playOptionAudioBtn.disabled = false;
            },
            onError: () => {
              playOptionAudioBtn.disabled = false;
            },
            onInterrupted: () => {
              playOptionAudioBtn.disabled = false;
            },
          });
          if (!result.ok) {
            playOptionAudioBtn.disabled = false;
          }
          optionActionsMenu.open = false;
          updateSummary();
        });
        optionActionsList.append(optionAudioBtn, playOptionAudioBtn, removeOptionAudioBtn);
        optionActionsMenu.appendChild(optionActionsList);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn danger';
        removeBtn.title = 'Delete this option';
        removeBtn.setAttribute('aria-label', `Delete option ${optionIndex + 1}`);
        removeBtn.textContent = '🗑';
        removeBtn.addEventListener('click', async () => {
          const outcome = session.removeQuestionOptionWithPolicy(selectedBlock.blockId, optionIndex);
          if (!outcome.ok && outcome.reason === 'confirm-delete-required') {
            const removalItems = [];
            if (outcome.policy.hasTypedContent) {
              removalItems.push('Option value/text used in answers.');
            }
            if (outcome.policy.hasAssets) {
              removalItems.push('Option audio file and attachment metadata.');
            }
            const confirmed = await showConfirmDialog({
              title: `Delete option ${optionIndex + 1}?`,
              entityLabel: `option ${optionIndex + 1}`,
              removalItems,
              confirmLabel: 'Delete option',
            });
            if (!confirmed) return;
            session.removeQuestionOptionWithPolicy(selectedBlock.blockId, optionIndex, { confirmDelete: true });
          }
          updateSummary();
        });
        row.append(correctToggle, optionInput, optionActionsMenu, removeBtn);
        if (!isPersistedOption) {
          const optionAudioHint = document.createElement('span');
          optionAudioHint.className = 'muted option-row__meta';
          optionAudioHint.textContent = 'Enter option text or click Add option before attaching audio.';
          row.appendChild(optionAudioHint);
        }
        if (optionAudioRef) {
          const optionAudioAttached = document.createElement('span');
          optionAudioAttached.className = 'muted option-row__meta';
          optionAudioAttached.textContent = `Option audio attached (${optionAudioRef.assetId})`;
          row.appendChild(optionAudioAttached);
        }
        questionOptionsList.appendChild(row);
      });
      rightPanel.append(questionOptionsList, questionOptionWarning, addOptionBtn, questionOptions);
      if (Number.isInteger(activeOptionInputIndex)) {
        const replacementOptionInput = questionOptionsList.querySelector(`input[data-option-input="1"][data-option-index="${activeOptionInputIndex}"]`);
        if (replacementOptionInput instanceof HTMLInputElement) {
          queueMicrotask(() => {
            replacementOptionInput.focus();
            if (activeOptionSelectionStart !== null && activeOptionSelectionEnd !== null) {
              replacementOptionInput.setSelectionRange(activeOptionSelectionStart, activeOptionSelectionEnd);
            }
          });
        }
      }
    }
  };

  const updateSummary = () => {
    session.validateCurrentDraft();
    syncFormControls();
    renderBlockList();
    renderDetailEditor();

    const saveState = session.state.lastPersistenceError
      ? 'Save error'
      : session.state.autosavePending
        ? 'Saving…'
        : session.state.lastValidationWarning
          ? 'Saved (warnings)'
        : 'Saved';

    const isSaved = saveState === 'Saved';
    saveStateEl.innerHTML = `<span class="editor-label">State:</span> <span class="editor-pill ${isSaved ? 'editor-pill--ok' : 'editor-pill--warn'}"><span class="editor-dot"></span>${isSaved ? 'Saved' : saveState}</span>`;
    saveStateEl.title = session.state.lastPersistenceError || session.state.lastValidationWarning || '';
    lastSavedEl.textContent = `Last saved: ${session.state.lastSavedAt || 'Not yet saved'}`;
    const validationIssues = session.state.lastSavedLocalValidationIssueCount + session.state.lastContractValidationIssueCount;
    validationEl.innerHTML = `<span class="editor-pill ${validationIssues > 0 ? 'editor-pill--warn' : 'editor-pill--ok'}">Validation: ${validationIssues} issue${validationIssues === 1 ? '' : 's'}</span>`;
    const validationTooltip = [];
    if (session.state.lastValidationWarning) {
      validationTooltip.push(session.state.lastValidationWarning);
    }
    if (session.state.validationErrors.length > 0) {
      validationTooltip.push(...session.state.validationErrors);
    }
    validationEl.title = validationIssues > 0 ? validationTooltip.join('\n') : '';
    localDraftIdValue.textContent = session.state.draft?.localId || 'n/a';
    statusRow.textContent = `Selected block: ${session.state.selectedBlockId || 'none'}`;
    mediaFeedback.textContent = session.state.mediaFeedback || '';
  };

  session.setOnStateChange(() => {
    updateSummary();
  });

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });
  blockKind.addEventListener('change', () => {
    session.setSelectedBlockKind(blockKind.value);
    updateSummary();
  });
  blockEditor.addEventListener('input', () => {
    session.updateBlockContent(session.state.selectedBlockId, blockEditor.value);
    updateSummary();
  });
  saveBtn.addEventListener('click', async () => {
    await session.saveNow();
    updateSummary();
  });
  addContentBtn.addEventListener('click', () => {
    session.createBlock('content');
    updateSummary();
  });
  addQuestionBtn.addEventListener('click', () => {
    session.createBlock('question');
    updateSummary();
  });
  openViewerBtn.addEventListener('click', async () => {
    const localDraftId = session.state.draft?.localId;
    if (!localDraftId) return;
    await session.saveNow();
    updateSummary();
    const draftUpdatedAt = session.state.draft?.metadata?.updatedAt || null;
    const viewerUrl = buildViewerUrlFromCurrentLocation(window.location.href, localDraftId, draftUpdatedAt);
    window.location.assign(viewerUrl);
  });
  questionInputType.addEventListener('change', async () => {
    const selectedBlockId = session.state.selectedBlockId;
    if (!selectedBlockId) return;
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === selectedBlockId);
    const currentInputType = normalizeQuestionResponseConfig(selectedBlock?.responseConfig).inputType || 'text';
    const outcome = session.switchQuestionInputTypeWithImpactPolicy(selectedBlockId, questionInputType.value);
    if (!outcome.ok && outcome.reason === 'confirm-switch-required') {
      const details = [
        `${outcome.impact.optionCountToRemove} option${outcome.impact.optionCountToRemove === 1 ? '' : 's'} will be removed.`,
        `${outcome.impact.optionAttachmentCountToRemove} option attachment${outcome.impact.optionAttachmentCountToRemove === 1 ? '' : 's'} (audio/files) will be removed.`,
      ];
      if (outcome.impact.hasOptionTextLoss) {
        details.push('User-entered option text/values will be removed.');
      }
      const confirmed = await showConfirmDialog({
        title: 'Switching answer type will remove data',
        entityLabel: 'this question type',
        descriptionText: `You are switching from ${outcome.impact.fromType} to ${outcome.impact.toType}.`,
        removalItems: details,
        confirmLabel: 'Switch and Remove',
      });
      if (!confirmed) {
        questionInputType.value = currentInputType;
        updateSummary();
        return;
      }
      session.switchQuestionInputTypeWithImpactPolicy(selectedBlockId, questionInputType.value, { confirmSwitch: true });
    }
    updateSummary();
  });
  questionMaxLength.addEventListener('input', () => {
    session.updateQuestionMaxLength(session.state.selectedBlockId, questionMaxLength.value);
    updateSummary();
  });
  questionTextDisplayMode.addEventListener('change', () => {
    session.updateQuestionTextDisplayMode(session.state.selectedBlockId, questionTextDisplayMode.value);
    updateSummary();
  });
  questionMin.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'min', questionMin.value);
    updateSummary();
  });
  questionMax.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'max', questionMax.value);
    updateSummary();
  });
  questionCorrectAnswerBoolean.addEventListener('change', () => {
    session.updateQuestionCorrectAnswerBoolean(session.state.selectedBlockId, questionCorrectAnswerBoolean.value);
    updateSummary();
  });
  questionCorrectAnswerNumber.addEventListener('input', () => {
    session.updateQuestionCorrectAnswerNumber(session.state.selectedBlockId, questionCorrectAnswerNumber.value);
    updateSummary();
  });
  questionNumberAllowSigned.addEventListener('change', () => {
    session.updateQuestionNumberRulesAllowSigned(session.state.selectedBlockId, questionNumberAllowSigned.checked);
    updateSummary();
  });
  questionNumberDecimalPlacesAllowed.addEventListener('input', () => {
    session.updateQuestionNumberRulesDecimalPlacesAllowed(
      session.state.selectedBlockId,
      questionNumberDecimalPlacesAllowed.value
    );
    updateSummary();
  });
  questionSelectionMode.addEventListener('change', () => {
    session.updateQuestionSelectionMode(session.state.selectedBlockId, questionSelectionMode.value);
    updateSummary();
  });
  questionShuffleOptions.addEventListener('change', () => {
    session.updateQuestionShuffleOptions(session.state.selectedBlockId, questionShuffleOptions.checked);
    updateSummary();
  });
  questionOptions.addEventListener('input', () => {
    session.updateQuestionOptionsFromText(session.state.selectedBlockId, questionOptions.value);
    updateSummary();
  });
  addOptionBtn.addEventListener('click', () => {
    session.addQuestionOption(session.state.selectedBlockId);
    updateSummary();
  });
  questionImageInput.addEventListener('change', async () => {
    const [file] = questionImageInput.files || [];
    const blockId = questionImageInput.dataset.blockId;
    if (!file || !blockId) return;
    const currentBlock = session.findBlock(blockId);
    const hasExisting = Boolean(getSingleMediaRef(currentBlock?.prompt?.mediaRefs, 'question_image'));
    const confirmed = !hasExisting || window.confirm('Replace existing question image?');
    const result = await session.attachQuestionMedia(blockId, 'question_image', file, { confirmReplace: confirmed });
    if (result.reason === 'confirm-replace-required') {
      session.setMediaFeedback('Image replacement canceled.');
    }
    questionImageInput.value = '';
    updateSummary();
  });
  questionAudioInput.addEventListener('change', async () => {
    const [file] = questionAudioInput.files || [];
    const blockId = questionAudioInput.dataset.blockId;
    if (!file || !blockId) return;
    const currentBlock = session.findBlock(blockId);
    const hasExisting = Boolean(getSingleMediaRef(currentBlock?.prompt?.mediaRefs, 'question_audio'));
    const confirmed = !hasExisting || window.confirm('Replace existing question audio?');
    const result = await session.attachQuestionMedia(blockId, 'question_audio', file, { confirmReplace: confirmed });
    if (result.reason === 'confirm-replace-required') {
      session.setMediaFeedback('Audio replacement canceled.');
    }
    questionAudioInput.value = '';
    updateSummary();
  });
  optionAudioInput.addEventListener('change', async () => {
    const [file] = optionAudioInput.files || [];
    if (!file || !pendingOptionAudioTarget) return;
    const { blockId, optionId } = pendingOptionAudioTarget;
    pendingOptionAudioTarget = null;
    const block = session.findBlock(blockId);
    const config = normalizeQuestionResponseConfig(block?.responseConfig);
    const option = (config.options || []).map((item) => normalizeResponseOption(item)).find((item) => item.id === optionId);
    const hasExisting = Boolean(getSingleMediaRef(option?.mediaRefs, 'option_audio'));
    const confirmed = !hasExisting || window.confirm('Replace existing option audio?');
    const result = await session.attachOptionAudio(blockId, optionId, file, { confirmReplace: confirmed });
    if (result.reason === 'confirm-replace-required') {
      session.setMediaFeedback('Option audio replacement canceled.');
    }
    optionAudioInput.value = '';
    updateSummary();
  });

  importBtn.addEventListener('click', () => {
    importFileInput.click();
  });
  importFileInput.addEventListener('change', async () => {
    const [file] = importFileInput.files || [];
    if (!file) return;
    const isZipFile = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
    if (isZipFile) {
      await session.importWorksheetPackageFile(file, { convertToEditableDraft: true });
    } else {
      const fileText = await file.text();
      await session.importWorksheetJson(fileText, { convertToEditableDraft: true });
    }
    importFileInput.value = '';
    updateSummary();
  });
  exportBtn.addEventListener('click', async () => {
    await session.exportCurrentDraftToPackageFile();
    updateSummary();
  });
  localPublishBtn.addEventListener('click', async () => {
    await session.simulateLocalPublish();
    updateSummary();
  });
  rewriteBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeRewriteAfterLogin');
    updateSummary();
  });
  t2aBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeT2AAfterLogin');
    updateSummary();
  });
  syncDraftBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumeDraftSyncAfterLogin');
    updateSummary();
  });
  publishBtn.addEventListener('click', async () => {
    await session.triggerProtectedAction('resumePublishAfterLogin');
    updateSummary();
  });

  addContentBtn.textContent = '+ Add Content';
  addQuestionBtn.textContent = '+ Add Question';
  controlsRow.append(addContentBtn, addQuestionBtn);
  metaRow.append(saveBtn, exportBtn, importBtn, openViewerBtn);
  if (isDebugMode) {
    moreActions.append(localPublishHint, localPublishBtn);
  }
  protectedActionsColumn.append(syncDraftBtn, publishBtn, rewriteBtn, t2aBtn);
  moreActions.append(protectedActionsColumn);
  leftPanel.append(leftHeading, titleInput, controlsRow, blockList, moreActions, metaRow, importFileInput, questionImageInput, questionAudioInput, optionAudioInput);
  rightPanel.append(rightHeading, statusRow);
  layout.append(leftPanel, rightPanel);
  topBar.append(saveStateEl, validationEl, lastSavedEl, localDraftIdEl);
  shell.append(topBar, layout);
  app.innerHTML = '';
  app.append(shell);
  updateSummary();
}

async function bootstrapEditor() {
  const session = new EditorDraftSession(editorStorage);
  const params = new URLSearchParams(window.location.search);
  const initialRestore = session.getRouteUiRestoreMetadata();
  const localDraftId = params.get('localDraftId') || initialRestore?.localId || null;

  await session.createOrOpenByLocalDraftId(localDraftId, {
    initialMode: DEFAULT_MODE,
    selectedBlockId: initialRestore?.selectedBlockId || null,
    hash: initialRestore?.hash || window.location.hash || '',
    scrollToken: initialRestore?.scrollToken || null,
  });

  const authGate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: RESUME_FLAG_KEY,
    storage: session.storage,
    isAuthenticated: () => new URL(window.location.href).searchParams.get('auth') === '1',
    getCurrentLocalId: () => session.state.draft?.localId || null,
    getCurrentUiState: () => session.getUiRestoreState(),
    persistLocalRecord: () => session.flushLocalStateForAuthRedirect(),
    restoreByLocalId: (localIdToRestore) => session.restoreByLocalId(localIdToRestore),
    restoreUiState: (uiState) => session.applyUiRestoreState(uiState),
    validateIntent: (intent) => Boolean(intent?.actionId && session.state.draft?.localId),
    replayIntent: (intent) => session.replayProtectedAction(intent),
    onRecoveryMessage: (message) => session.setRecoveryMessage(message),
    redirectToAuth: ({ redirectTo }) => {
      const url = new URL(redirectTo);
      url.searchParams.set('auth', '1');
      window.location.assign(url.toString());
    },
  });

  session.authGate = authGate;
  await authGate.restoreAfterAuthReturn();

  session.persistRestoreMetadata();

  renderEditorShell(session);

  window.editorSession = session;
}

bootstrapEditor().catch((error) => {
  console.error('Failed to bootstrap editor', error);
  if (app) {
    app.textContent = `Editor failed to boot: ${error.message}`;
  }
});

export {
  EditorDraftSession,
  createDraftRecord,
  normalizeBlocks,
  mapOptionsTextToResponseOptions,
  buildViewerUrlFromCurrentLocation,
  getNumberQuestionValidationErrors,
};
function normalizeQuestionResponseConfig(responseConfig, options = {}) {
  const forContract = options.forContract === true;
  const source = isRecord(responseConfig) ? { ...responseConfig } : {};
  const inputType = source.inputType == null ? 'text' : source.inputType;

  const normalized = {
    ...source,
    inputType,
  };

  if (inputType === 'text') {
    normalized.maxLength = Number.isFinite(source.maxLength) ? Number(source.maxLength) : 200;
    normalized.displayMode = source.displayMode === 'single_line' ? 'single_line' : 'multi_line';
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    delete normalized.min;
    delete normalized.max;
    delete normalized.numberRules;
    delete normalized.correctAnswer;
  } else if (inputType === 'boolean') {
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    delete normalized.min;
    delete normalized.max;
    delete normalized.numberRules;
    delete normalized.maxLength;
    delete normalized.displayMode;
    if (typeof source.correctAnswer === 'boolean') {
      normalized.correctAnswer = source.correctAnswer;
    } else {
      delete normalized.correctAnswer;
    }
  } else if (inputType === 'number') {
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    if (Number.isFinite(source.min)) normalized.min = Number(source.min); else delete normalized.min;
    if (Number.isFinite(source.max)) normalized.max = Number(source.max); else delete normalized.max;
    normalized.numberRules = normalizeNumberRulesConfig(source.numberRules);
    delete normalized.maxLength;
    delete normalized.displayMode;
    if (
      typeof source.correctAnswer === 'number'
      && Number.isFinite(source.correctAnswer)
      && isValidNumberCorrectAnswerForConfig(source.correctAnswer, normalized)
    ) {
      normalized.correctAnswer = Number(source.correctAnswer);
    } else {
      delete normalized.correctAnswer;
    }
  } else if (inputType === 'multiple_choice') {
    normalized.selectionMode = source.selectionMode === 'multi' ? 'multi' : 'single';
    normalized.shuffleOptions = Boolean(source.shuffleOptions);
    const sourceOptions = Array.isArray(source.options) ? source.options : [];
    const normalizedOptions = sourceOptions
      ? sourceOptions.map((option, index) => normalizeResponseOption(option, `option_${index}`))
      : [];
    const optionById = new Map();
    const optionIdByValue = new Map();
    normalizedOptions.forEach((option, index) => {
      const optionId = getOptionIdForAnswerKey(option);
      const optionValue = getOptionValueForAnswerKey(sourceOptions[index]);
      if (!optionId || optionValue === null) return;
      optionById.set(optionId, optionValue);
      if (!optionIdByValue.has(optionValue)) {
        optionIdByValue.set(optionValue, []);
      }
      optionIdByValue.get(optionValue).push(optionId);
    });
    const consumeOptionIdByValue = (optionValue, consumedIds) => {
      const candidates = optionIdByValue.get(optionValue) || [];
      const available = candidates.find((candidateId) => !consumedIds.has(candidateId));
      if (available) {
        consumedIds.add(available);
        return available;
      }
      return null;
    };

    const ambiguousFromValueMigration = new Set();
    const consumedIds = new Set();
    let selectedSingleOptionId = null;
    let selectedMultiOptionIds = [];

    if (typeof source.correctAnswerOptionId === 'string' && optionById.has(source.correctAnswerOptionId)) {
      selectedSingleOptionId = source.correctAnswerOptionId;
    } else if (typeof source.correctAnswer === 'string') {
      const candidates = optionIdByValue.get(source.correctAnswer) || [];
      if (candidates.length > 1) {
        ambiguousFromValueMigration.add(source.correctAnswer);
      }
      selectedSingleOptionId = consumeOptionIdByValue(source.correctAnswer, consumedIds);
    }

    if (Array.isArray(source.correctAnswerOptionIds)) {
      const dedupedIds = [];
      const seenIds = new Set();
      source.correctAnswerOptionIds.forEach((optionId) => {
        if (typeof optionId !== 'string' || seenIds.has(optionId) || !optionById.has(optionId)) return;
        seenIds.add(optionId);
        dedupedIds.push(optionId);
      });
      selectedMultiOptionIds = dedupedIds;
    } else if (Array.isArray(source.correctAnswer)) {
      const dedupedIds = [];
      const seenIds = new Set();
      source.correctAnswer.forEach((optionValue) => {
        if (typeof optionValue !== 'string') return;
        const candidates = optionIdByValue.get(optionValue) || [];
        if (candidates.length > 1) {
          ambiguousFromValueMigration.add(optionValue);
        }
        const mappedId = consumeOptionIdByValue(optionValue, consumedIds);
        if (!mappedId || seenIds.has(mappedId)) return;
        seenIds.add(mappedId);
        dedupedIds.push(mappedId);
      });
      selectedMultiOptionIds = dedupedIds;
    }

    normalized.options = forContract
      ? normalizedOptions.map((option) => ({ value: option.value, label: option.label }))
      : normalizedOptions;

    if (normalized.selectionMode === 'single') {
      if (selectedSingleOptionId && optionById.has(selectedSingleOptionId)) {
        normalized.correctAnswerOptionId = selectedSingleOptionId;
        normalized.correctAnswer = optionById.get(selectedSingleOptionId);
      } else {
        delete normalized.correctAnswerOptionId;
        delete normalized.correctAnswer;
      }
      delete normalized.correctAnswerOptionIds;
    } else {
      const validOptionIds = selectedMultiOptionIds.filter((optionId) => optionById.has(optionId));
      normalized.correctAnswerOptionIds = validOptionIds;
      normalized.correctAnswer = validOptionIds.map((optionId) => optionById.get(optionId));
      delete normalized.correctAnswerOptionId;
    }
    if (!forContract && ambiguousFromValueMigration.size > 0) {
      normalized.correctAnswerMappingWarning = `Ambiguous value-to-option mapping for duplicate values: ${Array.from(ambiguousFromValueMigration).join(', ')}.`;
    } else {
      delete normalized.correctAnswerMappingWarning;
    }
    delete normalized.maxLength;
    delete normalized.displayMode;
    delete normalized.min;
    delete normalized.max;
    delete normalized.numberRules;
    if (forContract) {
      delete normalized.correctAnswerOptionId;
      delete normalized.correctAnswerOptionIds;
      delete normalized.correctAnswerMappingWarning;
    }
  } else {
    delete normalized.correctAnswerOptionId;
    delete normalized.correctAnswerOptionIds;
    delete normalized.correctAnswerMappingWarning;
    delete normalized.maxLength;
    delete normalized.displayMode;
    delete normalized.options;
    delete normalized.selectionMode;
    delete normalized.shuffleOptions;
    delete normalized.min;
    delete normalized.max;
    delete normalized.numberRules;
    delete normalized.correctAnswer;
  }

  return normalized;
}
