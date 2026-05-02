import { editorStorage } from './storage/index.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';
import { createServerApiClient } from '../app/api/server-api-client.js';
import {
  createWorksheetPackageFromDraft,
  mapLegacyJsonToPackageModel,
  parseWorksheetPackage,
} from './worksheet-package.js';
import { MEDIA_LIMITS, IMAGE_MIME_TYPES, IMAGE_EXTENSIONS, AUDIO_MIME_TYPES, AUDIO_EXTENSIONS } from './media-config.js';
import { probeSession } from '../app/auth/session-readiness.js';
import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from '../app/auth/auth-popup-flow.js';
import { getAvailableLocales, getLocale, resolveInitialLocale, setLocale, t } from '../app/i18n/index.js';

const app = document.getElementById('app');
setLocale(resolveInitialLocale(), { persist: false });

const AUTOSAVE_MS = 1000;
const ACTIVITY_VISIBLE_INITIAL = 30;
const ACTIVITY_MAX_STORED = 200;
const ACTIVE_NOTIFICATIONS_MAX_STORED = 200;
const T2A_TEXT_MAX_LENGTH = 200;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';
let contractsPromise;

function nowIso() {
  return new Date().toISOString();
}

function formatUploadedDraftTimestamp(createdAt, locale = undefined) {
  if (!isNonEmptyString(createdAt)) return t('common.values.unknownUploadTime');
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return t('common.values.unknownUploadTime');
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function toUploadedDraftDisplay(item, locale = undefined) {
  const title = isNonEmptyString(item?.title) ? item.title.trim() : t('common.values.untitled');
  return {
    title,
    uploadedLabel: t('common.meta.uploaded', { value: formatUploadedDraftTimestamp(item?.created_at, locale) }),
  };
}

function normalizeDraftPublishState(item) {
  const explicitState = isNonEmptyString(item?.publish_state) ? item.publish_state.trim() : '';
  if (explicitState === 'current_version_published' || explicitState === 'unpublished_changes' || explicitState === 'draft_only') {
    return explicitState;
  }
  const artifactSha = isNonEmptyString(item?.artifact_sha256) ? item.artifact_sha256.trim() : '';
  const lastPublishedArtifactSha = isNonEmptyString(item?.last_published_artifact_sha256)
    ? item.last_published_artifact_sha256.trim()
    : '';
  if (!lastPublishedArtifactSha) return 'draft_only';
  return artifactSha && artifactSha === lastPublishedArtifactSha ? 'current_version_published' : 'unpublished_changes';
}

function getUploadedDraftPublishBadge(item) {
  const publishState = normalizeDraftPublishState(item);
  const hasPublishedPackage = isNonEmptyString(item?.published_package_id);
  if (publishState === 'current_version_published') {
    return {
      className: hasPublishedPackage
        ? 'editor-pill editor-pill--ok uploaded-draft-published-badge'
        : 'editor-pill editor-pill--warn uploaded-draft-published-badge',
      text: hasPublishedPackage ? t('editor.uploadedDraft.publishBadge.live') : t('editor.uploadedDraft.publishBadge.deleted'),
      helperText: hasPublishedPackage
        ? t('editor.uploadedDraft.publishBadge.liveHelp')
        : t('editor.uploadedDraft.publishBadge.deletedHelp'),
    };
  }
  if (publishState === 'unpublished_changes') {
    return {
      className: 'editor-pill editor-pill--warn uploaded-draft-published-badge',
      text: t('editor.uploadedDraft.publishBadge.updated'),
      helperText: '',
    };
  }
  return {
    className: 'editor-pill uploaded-draft-published-badge',
    text: t('editor.uploadedDraft.publishBadge.notPublished'),
    helperText: '',
  };
}

function buildPublishedPackageViewerUrl(publishedPackageId) {
  const url = new URL('../viewer/index.html', window.location.href);
  url.searchParams.set('publishedPackageId', String(publishedPackageId || '').trim());
  return url.toString();
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

function getT2ATextEligibility(text, maxLength = T2A_TEXT_MAX_LENGTH) {
  const trimmedText = String(text ?? '').trim();
  const hasText = trimmedText.length > 0;
  const exceedsLimit = trimmedText.length > maxLength;
  return {
    trimmedText,
    hasText,
    exceedsLimit,
    eligible: hasText && !exceedsLimit,
  };
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

function formatBytes(bytes, options = {}) {
  const unit = options?.unit === 'mb' ? 'mb' : 'auto';
  const invalid = typeof options?.invalid === 'string' ? options.invalid : '0 B';
  if (!Number.isFinite(bytes) || bytes < 0) return invalid;
  if (unit === 'mb') return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMegabytes(bytes) {
  return formatBytes(bytes, { unit: 'mb', invalid: '0.0 MB' });
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

function createZipFileFromBytes(bytes, name) {
  if (typeof File === 'function') {
    return new File([bytes], name, { type: 'application/zip' });
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  Object.defineProperty(blob, 'name', {
    value: String(name || 'worksheet-package.zip'),
    configurable: true,
  });
  return blob;
}

function createAudioFileFromBytes(bytes, name = 'generated-question-audio.mp3') {
  if (typeof File === 'function') {
    return new File([bytes], name, { type: 'audio/mpeg' });
  }
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  Object.defineProperty(blob, 'name', {
    value: String(name || 'generated-question-audio.mp3'),
    configurable: true,
  });
  return blob;
}

function toValidGeneratedAudioBytes(candidate) {
  if (!(candidate instanceof Uint8Array) || candidate.byteLength <= 0) {
    return null;
  }
  return candidate;
}

function createEditorIcon(name) {
  const svgAttrs = 'class="editor-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  const icons = {
    audio: `<svg ${svgAttrs}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`,
    audioAttached: `<svg ${svgAttrs}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="m16 19 2 2 4-4"></path></svg>`,
    check: `<svg ${svgAttrs}><path d="M20 6 9 17l-5-5"></path></svg>`,
    chevronUp: `<svg ${svgAttrs}><path d="m18 15-6-6-6 6"></path></svg>`,
    chevronDown: `<svg ${svgAttrs}><path d="m6 9 6 6 6-6"></path></svg>`,
    grip: `<svg ${svgAttrs}><circle cx="9" cy="5" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>`,
    moreHorizontal: `<svg ${svgAttrs}><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>`,
    filePlus: `<svg ${svgAttrs}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M12 18v-6"></path><path d="M9 15h6"></path></svg>`,
    eye: `<svg ${svgAttrs}><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
    info: `<svg ${svgAttrs}><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>`,
    image: `<svg ${svgAttrs}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path></svg>`,
    list: `<svg ${svgAttrs}><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>`,
    loading: `<svg ${svgAttrs}><path d="M21 12a9 9 0 1 1-9-9"></path></svg>`,
    pencil: `<svg ${svgAttrs}><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>`,
    play: `<svg ${svgAttrs}><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`,
    question: `<svg ${svgAttrs}><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 1 1 5.8 1c-.7 1.1-2 1.4-2.5 2.4"></path><path d="M12 17h.01"></path></svg>`,
    save: `<svg ${svgAttrs}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>`,
    shield: `<svg ${svgAttrs}><path d="M20 13c0 5-3.5 7.5-7.4 8.8a2 2 0 0 1-1.2 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.5a1.3 1.3 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path></svg>`,
    upload: `<svg ${svgAttrs}><path d="M12 15V3"></path><path d="m7 8 5-5 5 5"></path><path d="M5 21h14"></path></svg>`,
    generate: `<svg ${svgAttrs}><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="m17.8 11.8 1.4 1.4"></path><path d="m17.8 6.2 1.4-1.4"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 13.6 4.8"></path><path d="m4.8 19.2 1.4-1.4"></path></svg>`,
    refresh: `<svg ${svgAttrs}><path d="M3 12a9 9 0 0 1 15.2-6.5L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.2 6.5L3 16"></path><path d="M3 21v-5h5"></path></svg>`,
    trash: `<svg ${svgAttrs}><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>`,
  };
  return icons[name] || icons.audio;
}

function setIconButtonContent(button, iconName) {
  button.innerHTML = createEditorIcon(iconName);
}

function setMediaActionButtonContent(button, iconName, label) {
  const spinClass = iconName === 'loading' ? ' media-action-btn__icon--spin' : '';
  const icon = document.createElement('span');
  icon.className = `media-action-btn__icon${spinClass}`;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = createEditorIcon(iconName);
  const text = document.createElement('span');
  text.textContent = label;
  button.replaceChildren(icon, text);
}

function createLanguageSelector({ onChange } = {}) {
  const wrapper = document.createElement('label');
  wrapper.className = 'editor-topbar-item language-selector';
  const label = document.createElement('span');
  label.className = 'editor-label';
  label.textContent = t('common.language.label');
  const select = document.createElement('select');
  select.className = 'control language-selector__control';
  select.value = getLocale();
  getAvailableLocales().forEach((locale) => {
    const option = document.createElement('option');
    option.value = locale;
    option.textContent = locale === 'zh-Hant' ? t('common.language.zhHant') : t('common.language.en');
    select.appendChild(option);
  });
  select.value = getLocale();
  select.addEventListener('change', () => {
    setLocale(select.value);
    if (typeof onChange === 'function') {
      onChange(select.value);
    }
  });
  wrapper.append(label, select);
  return wrapper;
}

async function flushLocaleChangeBeforeReload(session, source = 'editor') {
  if (!session || typeof session.flushLocalStateForAuthRedirect !== 'function') {
    return;
  }
  try {
    await session.flushLocalStateForAuthRedirect();
  } catch (error) {
    console.error(`Failed to flush local draft before locale change (${source})`, error);
  }
}

function setOptionAudioMenuTriggerState(trigger, { hasAudio = false, isGenerating = false, isPersisted = true } = {}) {
  if (!(trigger instanceof HTMLElement)) return;
  const iconName = isGenerating ? 'loading' : hasAudio ? 'audioAttached' : 'audio';
  const label = isGenerating
    ? 'Option audio actions, generating'
    : hasAudio ? 'Option audio actions, audio attached' : 'Option audio actions';
  trigger.innerHTML = `<span class="option-actions-menu__icon${isGenerating ? ' option-actions-menu__icon--spin' : ''}" aria-hidden="true">${createEditorIcon(iconName)}</span>`;
  trigger.title = isPersisted
    ? label
    : 'Enter option text or click Add option before using audio actions';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-disabled', isPersisted ? 'false' : 'true');
  trigger.dataset.audioState = isGenerating ? 'generating' : hasAudio ? 'attached' : 'empty';
}

function toTitleCaseLabel(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getBlockKindLabel(kind) {
  if (kind === 'question') return 'Question';
  if (kind === 'content') return 'Content';
  return toTitleCaseLabel(kind || 'Block');
}

function getAnswerInputTypeLabel(inputType) {
  const labels = {
    text: 'Text',
    number: 'Number',
    boolean: 'True / False',
    multiple_choice: 'Multiple choice',
  };
  return labels[inputType] || toTitleCaseLabel(inputType);
}

function getSelectionModeLabel(selectionMode) {
  if (selectionMode === 'single') return 'Single';
  if (selectionMode === 'multi') return 'Multiple';
  return toTitleCaseLabel(selectionMode);
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
  const hasRangeError = Boolean(errors.min || errors.max);

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
  const hasDecimalPlacesError = Boolean(errors.decimalPlacesAllowed);

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
    if (!hasRangeError) {
      if (minValue !== null && correctAnswer < minValue) {
        errors.correctAnswer = 'Correct answer must be greater than or equal to Min';
        return errors;
      }
      if (maxValue !== null && correctAnswer > maxValue) {
        errors.correctAnswer = 'Correct answer must be less than or equal to Max';
        return errors;
      }
    }
    if (
      !hasDecimalPlacesError
      && decimalPlacesAllowed !== null
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
      subject: String(overrides.metadata?.subject || ''),
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
  constructor(storage, options = {}) {
    this.storage = storage;
    this.apiClient = options.apiClient || createServerApiClient();
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
      draftRevision: 0,
      lastSavedRevision: 0,
      // Deprecated compatibility fields; derived from notifications.
      recoveryMessage: null,
      lastProtectedAction: null,
      isPristineDraft: false,
      mediaFeedback: null,
      serverSession: {
        status: 'checking',
        user: null,
        error: null,
      },
      notifications: [],
      activityLog: [],
      serverActionMessage: null,
      lastUploadedDraft: null,
      lastPublishedPackage: null,
      uploadedDrafts: [],
      uploadedDraftSlotLimit: 3,
      isUploadingDraft: false,
      uploadDraftProgress: null,
      isUploadDraftFlowActive: false,
      isLoadingUploadedDrafts: false,
      publishingDraftIds: new Set(),
      openingPublishedPackageIds: new Set(),
      publishedBrowseQuery: '',
    };

    this.autosaveTimer = null;
    this.inFlightSaveCount = 0;
    this.onStateChange = null;
    this.transientQuestionBlockIds = new Set();
    this.previewAudio = null;
    this.previewAudioUrl = null;
    this.previewAudioPlayback = null;
    this._previewPlayRequestId = 0;
    this._authPopupWindow = null;
    this._authPopupFlow = null;
    this._activeAuthFlowId = null;
    this._loadUploadedDraftsWithPreflightPromise = null;
    this._loadUploadedDraftsWithoutPreflightPromise = null;
    this._loadUploadedDraftsActiveCount = 0;
    this._promptT2AInFlightTargets = new Set();
    this._optionT2AInFlightTargets = new Set();
  }

  setOnStateChange(handler) {
    this.onStateChange = typeof handler === 'function' ? handler : null;
  }

  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  getLatestNotification({ categories = null } = {}) {
    const normalizedCategories = Array.isArray(categories) && categories.length > 0
      ? new Set(categories.map((value) => String(value || '').trim()).filter(Boolean))
      : null;
    for (let index = this.state.notifications.length - 1; index >= 0; index -= 1) {
      const candidate = this.state.notifications[index];
      if (!candidate) continue;
      if (normalizedCategories && !normalizedCategories.has(String(candidate.category || ''))) continue;
      return candidate;
    }
    return null;
  }

  syncDeprecatedMessageFieldsFromNotifications() {
    // Compatibility shim for existing UI bindings; remove once notifications render directly in the UI.
    this.state.serverActionMessage = this.getLatestNotification({ categories: ['server'] })?.text || null;
    this.state.mediaFeedback = this.getLatestNotification({ categories: ['media'] })?.text || null;
    this.state.recoveryMessage = this.getLatestNotification({ categories: ['recovery'] })?.text || null;
  }

  pushNotification({
    kind = 'info',
    text = '',
    source = 'editor',
    ttlMs = null,
    category = 'server',
    actionLabel = null,
    logActivity = true,
  } = {}) {
    this.pruneExpiredNotifications();
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return null;
    const normalizedKind = kind === 'warning' ? 'warn' : kind;
    const notification = {
      id: createLocalId('notif'),
      kind: normalizedKind,
      category: String(category || 'server'),
      text: normalizedText,
      source: String(source || 'editor'),
      actionLabel: isNonEmptyString(actionLabel) ? actionLabel.trim() : null,
      ttlMs: Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : null,
      logActivity: logActivity !== false,
      createdAt: nowIso(),
    };
    this.state.notifications = [...this.state.notifications, notification]
      .slice(-ACTIVE_NOTIFICATIONS_MAX_STORED);
    // Notification policy:
    // - transient progress events stay in active notifications/toasts only
    // - historical terminal events are recorded in activityLog
    if (notification.logActivity !== false) {
      this.state.activityLog = [...this.state.activityLog, notification]
        .slice(-ACTIVITY_MAX_STORED);
    }
    this.syncDeprecatedMessageFieldsFromNotifications();
    return notification;
  }

  pruneExpiredNotifications({ nowMs = Date.now() } = {}) {
    if (!Array.isArray(this.state.notifications) || this.state.notifications.length === 0) return 0;
    const previousLength = this.state.notifications.length;
    this.state.notifications = this.state.notifications.filter((item) => {
      const ttlMs = Number.isFinite(Number(item?.ttlMs)) && Number(item.ttlMs) > 0
        ? Number(item.ttlMs)
        : null;
      if (!ttlMs) return true;
      const createdAtMs = new Date(item?.createdAt || '').getTime();
      if (!Number.isFinite(createdAtMs)) return true;
      return createdAtMs + ttlMs > nowMs;
    });
    const removedCount = Math.max(0, previousLength - this.state.notifications.length);
    if (removedCount > 0) {
      this.syncDeprecatedMessageFieldsFromNotifications();
    }
    return removedCount;
  }

  consumeNotification() {
    if (!Array.isArray(this.state.notifications) || this.state.notifications.length === 0) {
      this.syncDeprecatedMessageFieldsFromNotifications();
      return null;
    }
    const [nextNotification, ...remaining] = this.state.notifications;
    this.state.notifications = remaining;
    this.syncDeprecatedMessageFieldsFromNotifications();
    return nextNotification;
  }

  clearNotificationsBySource(source) {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) return 0;
    const previousLength = this.state.notifications.length;
    this.state.notifications = this.state.notifications
      .filter((item) => item?.source !== normalizedSource);
    this.syncDeprecatedMessageFieldsFromNotifications();
    return Math.max(0, previousLength - this.state.notifications.length);
  }

  clearNotificationsByCategory(category) {
    const normalizedCategory = String(category || '').trim();
    if (!normalizedCategory) return 0;
    const previousLength = this.state.notifications.length;
    this.state.notifications = this.state.notifications
      .filter((item) => item?.category !== normalizedCategory);
    this.syncDeprecatedMessageFieldsFromNotifications();
    return Math.max(0, previousLength - this.state.notifications.length);
  }

  setNotificationForSource({
    source = 'editor',
    category = 'server',
    kind = 'info',
    text = '',
    ttlMs = null,
    actionLabel = null,
  } = {}) {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) return null;
    const normalizedText = String(text || '').trim();
    const existing = this.state.notifications.find((item) => item?.source === normalizedSource) || null;

    if (!normalizedText) {
      if (existing) {
        this.clearNotificationsBySource(normalizedSource);
      }
      return null;
    }

    const normalizedKind = kind === 'warning' ? 'warn' : kind;
    const normalizedCategory = String(category || 'server');
    if (
      existing &&
      existing.kind === normalizedKind &&
      existing.category === normalizedCategory &&
      existing.text === normalizedText
    ) {
      return existing;
    }

    this.clearNotificationsBySource(normalizedSource);
    return this.pushNotification({
      source: normalizedSource,
      category: normalizedCategory,
      kind: normalizedKind,
      text: normalizedText,
      ttlMs,
      actionLabel,
    });
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

  updateSubject(nextSubject) {
    if (!this.state.draft) return;
    this.state.draft.metadata = {
      ...this.state.draft.metadata,
      subject: String(nextSubject || ''),
    };
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
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      this.clearMediaFeedback();
      return;
    }
    this.pushNotification({
      kind: 'warn',
      category: 'media',
      source: 'media.feedback',
      text: normalizedMessage,
    });
    this.notifyStateChange();
  }

  clearMediaFeedback() {
    this.clearNotificationsByCategory('media');
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

    this.reorderBlockToIndex(blockId, targetIndex);
  }

  reorderBlockToIndex(blockId, targetIndex) {
    if (!this.state.draft || !blockId) return;
    const blocks = (Array.isArray(this.state.draft.blocks) ? this.state.draft.blocks : [])
      .slice()
      .sort((a, b) => a.position - b.position);
    const currentIndex = blocks.findIndex((block) => block.blockId === blockId);
    if (
      currentIndex < 0
      || !Number.isInteger(targetIndex)
      || targetIndex < 0
      || targetIndex >= blocks.length
      || targetIndex === currentIndex
    ) return;

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
        this.setNotificationForSource({
          source: 'autosave.persistence',
          category: 'editor',
          kind: 'error',
          text: this.state.lastPersistenceError,
        });
        this.setNotificationForSource({
          source: 'autosave.validation',
          category: 'editor',
          kind: 'warn',
          text: this.state.lastValidationWarning,
        });
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
        this.setNotificationForSource({
          source: 'autosave.persistence',
          category: 'editor',
          kind: 'error',
          text: this.state.lastPersistenceError,
        });
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
    try {
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
            subject: (isRecord(mapped.worksheet.metadata) && mapped.worksheet.metadata.subject) || '',
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
          const successMessage = `Imported legacy_json worksheet (importedId: ${importedRecord.localId}, draftId: ${this.state.draft.localId}).`;
          this.pushNotification({ kind: 'success', category: 'editor', source: 'import.legacy_json', text: successMessage });
          this.notifyStateChange();
          return { importedRecord, draftRecord: this.state.draft };
        } catch (error) {
          this.state.autosavePending = false;
          this.notifyStateChange();
          throw error;
        }
      }

      const successMessage = `Imported legacy_json worksheet (importedId: ${importedRecord.localId}, draftId: none).`;
      this.pushNotification({ kind: 'success', category: 'editor', source: 'import.legacy_json', text: successMessage });
      this.notifyStateChange();
      return { importedRecord, draftRecord: null };
    } catch (error) {
      this.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'import.legacy_json',
        text: error?.message || 'Unable to import worksheet JSON.',
      });
      this.notifyStateChange();
      throw error;
    }
  }

  async importWorksheetPackageFile(file, options = {}) {
    try {
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
        const successMessage = `Imported package_zip worksheet (importedId: ${importedRecord.localId}, draftId: none).`;
        this.pushNotification({ kind: 'success', category: 'editor', source: 'import.package_zip', text: successMessage });
        this.notifyStateChange();
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
        subject: (isRecord(parsedPackage.worksheet.metadata) && parsedPackage.worksheet.metadata.subject) || '',
      },
    });

      this.state.draft = draft;
      this.state.selectedBlockId = draft.blocks[0]?.blockId || null;
      this.state.draftRevision += 1;
      this.state.lastImportedAt = nowIso();
      this.validateCurrentDraft();
      await this.autosave();
      this.persistRestoreMetadata();
      const successMessage = `Imported package_zip worksheet (importedId: ${importedRecord.localId}, draftId: ${this.state.draft.localId}).`;
      this.pushNotification({ kind: 'success', category: 'editor', source: 'import.package_zip', text: successMessage });
      this.notifyStateChange();
      return { importedRecord, draftRecord: this.state.draft };
    } catch (error) {
      this.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'import.package_zip',
        text: error?.message || 'Unable to import worksheet package.',
      });
      this.notifyStateChange();
      throw error;
    }
  }

  async saveNow() {
    try {
      const persisted = await this.autosave();
      this.state.lastManualSaveAt = nowIso();
      this.setNotificationForSource({
        kind: 'success',
        category: 'editor',
        source: 'save.manual',
        text: `Saved draft ${persisted?.localId || this.state.draft?.localId || 'unknown'}.`,
      });
      this.notifyStateChange();
      return persisted;
    } catch (error) {
      console.error('Manual save failed', error);
      this.setNotificationForSource({
        kind: 'error',
        category: 'editor',
        source: 'save.manual',
        text: error?.message || 'Manual save failed.',
      });
      this.notifyStateChange();
      throw error;
    }
  }

  async exportCurrentDraftToPackageFile() {
    let objectUrl = null;
    let link = null;
    try {
      if (!this.state.draft) {
        throw new Error('No active draft to export.');
      }

      const timestampToken = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `worksheet-package-${this.state.draft.localId}-${timestampToken}.zip`;
      const bytes = await this.buildCurrentDraftPackageZipBytes();
      const blob = new Blob([bytes], { type: 'application/zip' });
      objectUrl = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      this.state.lastExportedAt = nowIso();
      this.pushNotification({
        kind: 'success',
        category: 'editor',
        source: 'export.package_zip',
        text: `Exported package ${filename}.`,
      });
      this.notifyStateChange();
      return filename;
    } catch (error) {
      this.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'export.package_zip',
        text: error?.message || 'Unable to export package.',
      });
      this.notifyStateChange();
      throw error;
    } finally {
      if (link?.remove) {
        link.remove();
      }
      if (objectUrl && URL?.revokeObjectURL) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  async buildCurrentDraftPackageZipBytes() {
    if (!this.state.draft) {
      throw new Error('No active draft to export.');
    }
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
    return createWorksheetPackageFromDraft(packagedDraft, assets).bytes;
  }

  beginServerSignIn() {
    if (this._authPopupFlow?.cancel) {
      this._authPopupFlow.cancel();
    }
    this.clearNotificationsBySource('auth.popup');
    this.clearNotificationsBySource('auth.status');
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
      source: 'editor',
      authFlowId,
      pollIntervalMs: AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs,
      pollTimeoutMs: AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs,
      shouldContinue: () => this._activeAuthFlowId === authFlowId,
      onPopupBlocked: () => {
        this.pushNotification({
          kind: 'error',
          category: 'server',
          source: 'auth.popup',
          text: 'Sign-in popup was blocked. Allow popups for this site, then try again.',
        });
        this.notifyStateChange();
      },
      onStatusMessage: (message) => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (message === 'Complete sign-in in the popup. Session will refresh automatically.') {
          this.pushNotification({
            kind: 'info',
            category: 'server',
            source: 'auth.status',
            text: message,
            logActivity: false,
          });
          this.notifyStateChange();
        }
      },
      onSessionReady: async () => {
        if (this._activeAuthFlowId !== authFlowId) return;
        this.pushNotification({
          kind: 'info',
          category: 'server',
          source: 'auth.status',
          text: 'Sign-in completed. Refreshing server session…',
          logActivity: false,
        });
        this.notifyStateChange();
        const result = await this.probeServerSessionSilently({ force: true });
        if (result.ok && this.state.serverSession.status === 'ready') {
          await this.loadUploadedDrafts({ preflight: false });
          this.clearNotificationsBySource('auth.status');
          this.notifyStateChange();
          finalizeFlow();
          return;
        }
        this.pushNotification({
          kind: 'error',
          category: 'server',
          source: 'auth.status',
          text: result.error?.message || 'Sign-in completed, but session is still not ready.',
        });
        this.notifyStateChange();
        finalizeFlow();
      },
      onSessionNotReady: (result) => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (result?.final === false && result?.waitingForCallback === true) {
          this.pushNotification({
            kind: 'info',
            category: 'server',
            source: 'auth.status',
            text: 'Still waiting for sign-in confirmation from the popup…',
            logActivity: false,
          });
          this.notifyStateChange();
          return;
        }
        if (result?.error?.code === 'SESSION_WAIT_CANCELLED') {
          finalizeFlow();
          return;
        }
        const blockedPopupActive = this.state.notifications
          .some((item) => item?.source === 'auth.popup');
        if (blockedPopupActive) {
          finalizeFlow();
          return;
        }
        if (result?.error?.message) {
          this.pushNotification({
            kind: 'error',
            category: 'server',
            source: 'auth.status',
            text: result.error.message,
          });
        }
        this.notifyStateChange();
        finalizeFlow();
      },
    });
    this._authPopupWindow = this._authPopupFlow?.popupWindow || null;
  }

  async refreshServerSession() {
    this.state.serverSession = {
      status: 'checking',
      user: null,
      error: null,
    };
    this.notifyStateChange();
    return this.probeServerSessionSilently({ force: true });
  }

  async probeServerSessionSilently({ force = false } = {}) {
    const result = await probeSession({ apiClient: this.apiClient, force });
    if (result.status !== 'ready') {
      this.state.serverSession = {
        status: result.status === 'error' ? 'error' : 'not_ready',
        user: null,
        error: result.error?.message || 'Sign-in is required before using server features.',
      };
      this.notifyStateChange();
      return result;
    }
    this.state.serverSession = {
      status: 'ready',
      user: result.user || null,
      error: null,
    };
    this.notifyStateChange();
    return result;
  }

  async ensureServerSessionReady(notReadyMessage = 'Sign-in is required before using server features.') {
    const result = await this.probeServerSessionSilently({ force: true });
    if (result.ok && this.state.serverSession.status === 'ready') {
      return { ok: true, result };
    }
    const authStatus = Number(result.error?.status);
    const authErrorCode = String(result.error?.code || '').toUpperCase();
    const hasAuthStatus = Number.isFinite(authStatus);
    const isExplicitAuthFailure = result.status === 'not_ready' && (
      authErrorCode === 'AUTH_REQUIRED'
      || (result.error?.requiresSignIn && (!hasAuthStatus || authStatus === 401 || authStatus === 403))
      || authStatus === 401
      || authStatus === 403
    );
    const authMessage = isExplicitAuthFailure
      ? 'Sign-in session expired. Please sign in again.'
      : (result.error?.message || notReadyMessage);
    this.pushNotification({
      kind: isExplicitAuthFailure ? 'warn' : 'error',
      category: 'server',
      source: 'auth.session',
      text: authMessage,
    });
    this.notifyStateChange();
    return { ok: false, result };
  }

  async uploadCurrentDraftToServer(options = {}) {
    if (this.state.isUploadingDraft) {
      return {
        ok: false,
        skipped: true,
        error: { message: 'Upload already in progress.' },
      };
    }
    this.state.isUploadingDraft = true;
    this.state.uploadDraftProgress = null;
    this.pushNotification({
      kind: 'info',
      category: 'server',
      source: 'upload.status',
      text: 'Uploading draft package...',
      logActivity: false,
    });
    this.notifyStateChange();
    try {
      if (options.preflight !== false) {
        const sessionReady = await this.ensureServerSessionReady();
        if (!sessionReady.ok) return sessionReady.result;
      }
      const zipBytes = await this.buildCurrentDraftPackageZipBytes();
      let lastProgressRenderKey = null;
      const result = await this.apiClient.uploadDraftPackage(zipBytes, {
        title: this.state.draft?.title || '',
        subject: this.state.draft?.metadata?.subject || '',
        conflictAction: options.conflictAction || '',
      }, {
        onProgress: (progress) => {
          const loaded = Number(progress?.loaded || 0);
          const total = Number(progress?.total || 0);
          const lengthComputable = Boolean(progress?.lengthComputable) && total > 0;
          const loadedInTenthsMb = Math.round((loaded / (1024 * 1024)) * 10);
          const progressRenderKey = lengthComputable
            ? `${Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))}:${loadedInTenthsMb}:${Math.round((total / (1024 * 1024)) * 10)}`
            : `${loadedInTenthsMb}`;
          if (progressRenderKey === lastProgressRenderKey) {
            return;
          }
          lastProgressRenderKey = progressRenderKey;
          this.state.uploadDraftProgress = {
            loaded,
            total: lengthComputable ? total : null,
            lengthComputable,
          };
          this.notifyStateChange();
        },
      });
      if (!result.ok) {
        if (String(result?.error?.code || '').toUpperCase() === 'DRAFT_SLOT_LIMIT_REACHED') {
          const slotLimit = Number(result?.error?.details?.slotLimit);
          if (Number.isFinite(slotLimit) && slotLimit > 0) {
            this.state.uploadedDraftSlotLimit = slotLimit;
          }
        }
        const isTransportFailure = String(result?.error?.code || '') === 'NETWORK_ERROR';
        const errorText = isTransportFailure
          ? 'Upload failed before completion. Your local draft is still safe. Please retry when the network is stable.'
          : result.error.message;
        this.pushNotification({ kind: 'error', category: 'server', source: 'upload.status', text: errorText });
        this.notifyStateChange();
        return result;
      }
      this.state.lastUploadedDraft = result.data;
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'upload.status',
        text: `Uploaded draft ${result.data.uploaded_draft_id}.`,
      });
      const refreshResult = await this.loadUploadedDrafts({ preflight: false });
      if (refreshResult?.ok) {
        const uploadedDraftId = String(result.data?.uploaded_draft_id || '').trim();
        const refreshedItems = Array.isArray(refreshResult?.data?.items) ? refreshResult.data.items : [];
        const foundUploadedDraft = uploadedDraftId
          ? refreshedItems.some((item) => String(item?.uploaded_draft_id || '').trim() === uploadedDraftId)
          : false;
        this.pushNotification({
          kind: 'success',
          category: 'server',
          source: 'upload.refresh',
          text: foundUploadedDraft ? 'Uploaded drafts refreshed.' : 'Upload succeeded. Draft list refreshed.',
        });
      } else {
        this.pushNotification({
          kind: 'warn',
          category: 'server',
          source: 'upload.refresh',
          text: refreshResult?.error?.message || 'Unable to refresh uploaded drafts.',
        });
      }
      this.notifyStateChange();
      return result;
    } finally {
      this.state.isUploadingDraft = false;
      this.state.uploadDraftProgress = null;
      this.notifyStateChange();
    }
  }

  async publishUploadedDraftToServer(uploadedDraftId, metadata = {}) {
    const normalizedUploadedDraftId = String(uploadedDraftId || '').trim();
    if (!normalizedUploadedDraftId) {
      return { ok: false, error: { message: 'Uploaded draft ID is required.' } };
    }
    if (this.state.publishingDraftIds.has(normalizedUploadedDraftId)) {
      return {
        ok: false,
        skipped: true,
        error: { message: `Publish already in progress for uploaded draft ${normalizedUploadedDraftId}.` },
      };
    }
    this.state.publishingDraftIds.add(normalizedUploadedDraftId);
    this.pushNotification({ kind: 'info', category: 'server', source: 'publish.status', text: 'Publishing…', logActivity: false });
    this.notifyStateChange();
    try {
      const sessionReady = await this.ensureServerSessionReady();
      if (!sessionReady.ok) return sessionReady.result;
      const publishResult = await this.apiClient.publishFromUploadedDraft(normalizedUploadedDraftId, {
        title: metadata.title || '',
        subject: metadata.subject || '',
      });
      if (!publishResult.ok) {
        this.pushNotification({ kind: 'error', category: 'server', source: 'publish.status', text: publishResult.error.message });
        this.notifyStateChange();
        return publishResult;
      }
      this.state.lastPublishedPackage = publishResult.data;
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'publish.status',
        text: `Published package ${publishResult.data.published_package_id}.`,
      });
      const refreshResult = await this.loadUploadedDrafts({ preflight: false });
      if (refreshResult?.ok) {
        this.pushNotification({
          kind: 'success',
          category: 'server',
          source: 'publish.refresh',
          text: 'Uploaded drafts refreshed.',
        });
      } else {
        this.pushNotification({
          kind: 'warn',
          category: 'server',
          source: 'publish.refresh',
          text: refreshResult?.error?.message || 'Unable to refresh uploaded drafts.',
        });
      }
      this.notifyStateChange();
      return publishResult;
    } finally {
      this.state.publishingDraftIds.delete(normalizedUploadedDraftId);
      this.notifyStateChange();
    }
  }

  async loadUploadedDrafts(options = {}) {
    const shouldPreflight = options.preflight !== false;
    const inflightKey = shouldPreflight
      ? '_loadUploadedDraftsWithPreflightPromise'
      : '_loadUploadedDraftsWithoutPreflightPromise';
    if (this[inflightKey]) {
      return this[inflightKey];
    }

    const loadPromise = (async () => {
      if (shouldPreflight) {
        const sessionReady = await this.ensureServerSessionReady();
        if (!sessionReady.ok) return sessionReady.result;
      }

      this._loadUploadedDraftsActiveCount += 1;
      this.state.isLoadingUploadedDrafts = this._loadUploadedDraftsActiveCount > 0;
      this.pushNotification({ kind: 'info', category: 'server', source: 'uploadedDrafts.refresh', text: 'Refreshing…', logActivity: false });
      this.notifyStateChange();

      try {
        const result = await this.apiClient.listUploadedDrafts();
        if (!result.ok) {
          this.pushNotification({ kind: 'warn', category: 'server', source: 'uploadedDrafts.refresh', text: result.error.message });
          this.notifyStateChange();
          return result;
        }

        this.state.uploadedDrafts = Array.isArray(result.data?.items) ? result.data.items : [];
        const slotLimit = Number(result?.data?.draftSlotLimit || result?.data?.slotLimit);
        if (Number.isFinite(slotLimit) && slotLimit > 0) {
          this.state.uploadedDraftSlotLimit = slotLimit;
        }
        this.notifyStateChange();
        return result;
      } finally {
        this._loadUploadedDraftsActiveCount = Math.max(0, this._loadUploadedDraftsActiveCount - 1);
        this.state.isLoadingUploadedDrafts = this._loadUploadedDraftsActiveCount > 0;
        if (this._loadUploadedDraftsActiveCount === 0) {
          this.state.notifications = this.state.notifications.filter((item) => !(
            item?.source === 'uploadedDrafts.refresh' && item?.kind === 'info'
          ));
          this.syncDeprecatedMessageFieldsFromNotifications();
        }
        this.notifyStateChange();
      }
    })();
    this[inflightKey] = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this[inflightKey] === loadPromise) {
        this[inflightKey] = null;
      }
    }
  }

  async reopenUploadedDraftAsLocalCopy(uploadedDraftId) {
    const sessionReady = await this.ensureServerSessionReady();
    if (!sessionReady.ok) return sessionReady.result;
    const artifact = await this.apiClient.fetchUploadedDraftArtifact(uploadedDraftId);
    if (!artifact.ok) {
      this.pushNotification({ kind: 'error', category: 'server', source: 'uploadedDraft.open', text: artifact.error.message });
      this.notifyStateChange();
      return artifact;
    }
    const imported = await this.importWorksheetPackageFile(
      createZipFileFromBytes(artifact.data, `uploaded-draft-${uploadedDraftId}.zip`),
      { convertToEditableDraft: true }
    );
    this.pushNotification({
      kind: 'success',
      category: 'server',
      source: 'uploadedDraft.open',
      text: `Opened uploaded draft ${uploadedDraftId} as a new local draft copy.`,
    });
    this.notifyStateChange();
    return { ok: true, data: imported };
  }

  async reopenPublishedPackageAsLocalCopy(publishedPackageId) {
    const normalizedPublishedPackageId = String(publishedPackageId || '').trim();
    if (!normalizedPublishedPackageId) {
      return { ok: false, error: { message: 'Published package ID is required.' } };
    }
    if (this.state.openingPublishedPackageIds.has(normalizedPublishedPackageId)) {
      return {
        ok: false,
        skipped: true,
        error: { message: `Open already in progress for published package ${normalizedPublishedPackageId}.` },
      };
    }
    this.state.openingPublishedPackageIds.add(normalizedPublishedPackageId);
    this.pushNotification({ kind: 'info', category: 'server', source: 'publishedPackage.open', text: 'Opening published package…', logActivity: false });
    this.notifyStateChange();
    try {
      const sessionReady = await this.ensureServerSessionReady();
      if (!sessionReady.ok) return sessionReady.result;
      const artifact = await this.apiClient.fetchPublishedPackageArtifact(normalizedPublishedPackageId);
      if (!artifact.ok) {
        this.pushNotification({ kind: 'error', category: 'server', source: 'publishedPackage.open', text: artifact.error.message });
        this.notifyStateChange();
        return artifact;
      }
      const imported = await this.importWorksheetPackageFile(
        createZipFileFromBytes(artifact.data, `published-package-${normalizedPublishedPackageId}.zip`),
        { convertToEditableDraft: true }
      );
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'publishedPackage.open',
        text: `Opened published package ${normalizedPublishedPackageId} as a new local draft copy.`,
      });
      this.notifyStateChange();
      return { ok: true, data: imported };
    } finally {
      this.state.openingPublishedPackageIds.delete(normalizedPublishedPackageId);
      this.notifyStateChange();
    }
  }

  async deleteUploadedDraft(uploadedDraftId) {
    const sessionReady = await this.ensureServerSessionReady();
    if (!sessionReady.ok) return sessionReady.result;
    const result = await this.apiClient.deleteUploadedDraft(uploadedDraftId);
    if (!result.ok) {
      this.pushNotification({ kind: 'error', category: 'server', source: 'uploadedDraft.delete', text: result.error.message });
      this.notifyStateChange();
      return result;
    }
    const successMessage = 'Uploaded draft deleted.';
    this.pushNotification({ kind: 'success', category: 'server', source: 'uploadedDraft.delete', text: successMessage });
    const refreshResult = await this.loadUploadedDrafts({ preflight: false });
    if (refreshResult && refreshResult.ok) {
      this.pushNotification({ kind: 'success', category: 'server', source: 'uploadedDraft.delete.refresh', text: 'Uploaded drafts refreshed.' });
    } else if (refreshResult && !refreshResult.ok) {
      const refreshMessage = refreshResult.error?.message || 'Uploaded drafts refresh failed.';
      this.pushNotification({ kind: 'warn', category: 'server', source: 'uploadedDraft.delete.refresh', text: refreshMessage });
    }
    this.notifyStateChange();
    return {
      ...result,
      refreshResult,
    };
  }

  async deletePublishedPackage(publishedPackageId) {
    const normalizedPublishedPackageId = String(publishedPackageId || '').trim();
    if (!normalizedPublishedPackageId) {
      return { ok: false, error: { message: 'Published package ID is required.' } };
    }
    const sessionReady = await this.ensureServerSessionReady();
    if (!sessionReady.ok) return sessionReady.result;
    const result = await this.apiClient.deletePublishedPackage(normalizedPublishedPackageId);
    if (!result.ok) {
      this.pushNotification({ kind: 'error', category: 'server', source: 'publishedPackage.delete', text: result.error.message });
      this.notifyStateChange();
      return result;
    }
    this.pushNotification({ kind: 'success', category: 'server', source: 'publishedPackage.delete', text: 'Published package deleted.' });
    this.notifyStateChange();
    return result;
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
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
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
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      this.clearNotificationsByCategory('recovery');
      this.notifyStateChange();
      return;
    }
    this.pushNotification({
      kind: 'info',
      category: 'recovery',
      source: 'auth.recovery',
      text: normalizedMessage,
    });
    this.notifyStateChange();
  }

  async replayProtectedAction(intent) {
    const actionId = typeof intent?.actionId === 'string' ? intent.actionId : '';
    const payload = intent?.payload && typeof intent.payload === 'object' ? intent.payload : {};
    this.state.lastProtectedAction = actionId || null;

    switch (actionId) {
      case 'editorPromptT2A':
      case 'resumeT2AAfterLogin':
        return this.replayEditorPromptT2AIntent(payload);
      case 'editorOptionT2A':
        return this.replayEditorOptionT2AIntent(payload);
      case 'resumeRewriteAfterLogin':
        this.setRecoveryMessage('Rewrite recovery is not available yet. Please run Rewrite again.');
        return { ok: true, status: 'deferred_editor_rewrite' };
      default:
        this.setRecoveryMessage(null);
        return { ok: true, status: 'noop_unsupported_action' };
    }
  }

  validateEditorPromptT2AIntentPayload(payload = {}) {
    const localDraftId = this.state.draft?.localId || null;
    const intentDraftId = typeof payload.localDraftId === 'string' ? payload.localDraftId : null;
    if (!localDraftId || !intentDraftId || localDraftId !== intentDraftId) {
      return {
        ok: false,
        message: 'Audio recovery context is stale. Please retry from the current draft.',
      };
    }
    if (payload.target !== 'question_prompt') {
      return {
        ok: false,
        message: 'Audio recovery target mismatch. Please retry from the prompt control.',
      };
    }
    const blockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const block = blockId ? this.findBlock(blockId) : null;
    if (!block || block.kind !== 'question') {
      return {
        ok: false,
        message: 'Audio recovery target block is no longer available.',
      };
    }
    return { ok: true };
  }

  async replayEditorPromptT2AIntent(payload = {}) {
    const validation = this.validateEditorPromptT2AIntentPayload(payload);
    if (!validation.ok) {
      this.setRecoveryMessage(validation.message);
      console.warn('[editor] Ignoring stale/invalid prompt t2a recovery intent.', {
        action: 'editorPromptT2A',
        payload,
      });
      return { ok: false, status: 'invalid_context' };
    }
    const blockId = String(payload.blockId);
    const block = this.findBlock(blockId);
    const promptText = String(block?.prompt?.text || '').trim();
    const inFlightKey = `prompt:${blockId}`;
    if (this._promptT2AInFlightTargets.has(inFlightKey)) {
      const message = 'Question prompt audio generation is already in progress.';
      this.setRecoveryMessage(message);
      this.pushNotification({
        kind: 'info',
        category: 'editor',
        source: 'prompt.t2a',
        text: message,
      });
      this.notifyStateChange();
      return { ok: false, status: 'already_in_flight', error: { message } };
    }
    if (!promptText) {
      const message = 'Enter a prompt before generating audio.';
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'missing_prompt_text',
        error: { message },
      };
    }
    if (promptText.length > T2A_TEXT_MAX_LENGTH) {
      const message = `Prompt must be ${T2A_TEXT_MAX_LENGTH} characters or fewer to generate audio.`;
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'prompt_too_long',
        error: { message },
      };
    }
    this._promptT2AInFlightTargets.add(inFlightKey);
    try {
      const audioResult = await this.apiClient.generateAudioFromText(promptText);
      if (!audioResult?.ok) {
        const detail = String(audioResult?.error?.message || '').trim();
        const message = detail
          ? `Audio generation failed. Existing audio is unchanged. ${detail}`
          : 'Audio generation failed. Existing audio is unchanged.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'prompt.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { message } };
      }
      const audioBytes = toValidGeneratedAudioBytes(audioResult.data);
      if (!audioBytes) {
        const message = 'Audio generation failed. Existing audio is unchanged. Bridge returned invalid audio data.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'prompt.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { message } };
      }
      const generatedFile = createAudioFileFromBytes(audioBytes, `${blockId}_prompt.mp3`);
      const hasExistingQuestionAudio = Boolean(getSingleMediaRef(block?.prompt?.mediaRefs, 'question_audio'));
      const attachResult = await this.attachQuestionMedia(blockId, 'question_audio', generatedFile, {
        confirmReplace: hasExistingQuestionAudio,
      });
      if (!attachResult?.ok) {
        const message = String(attachResult?.error?.message || '').trim() || 'Could not attach generated audio to this question.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'prompt.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'attach_failed', error: { message } };
      }
      this.setRecoveryMessage('Question prompt audio generated and attached.');
      this.pushNotification({
        kind: 'success',
        category: 'editor',
        source: 'prompt.t2a',
        text: 'Question prompt audio generated and attached.',
      });
      this.notifyStateChange();
      return { ok: true, status: 'generated_editor_prompt_t2a', data: { blockId } };
    } finally {
      this._promptT2AInFlightTargets.delete(inFlightKey);
    }
  }

  validateEditorOptionT2AIntentPayload(payload = {}) {
    const localDraftId = this.state.draft?.localId || null;
    const intentDraftId = typeof payload.localDraftId === 'string' ? payload.localDraftId : null;
    if (!localDraftId || !intentDraftId || localDraftId !== intentDraftId) {
      return {
        ok: false,
        message: 'Option audio recovery context is stale. Please retry from the current draft.',
      };
    }
    if (payload.target !== 'option') {
      return {
        ok: false,
        message: 'Option audio recovery target mismatch. Please retry from an option control.',
      };
    }
    const blockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const optionId = typeof payload.optionId === 'string' ? payload.optionId : null;
    const block = blockId ? this.findBlock(blockId) : null;
    if (!block || block.kind !== 'question') {
      return {
        ok: false,
        message: 'Option audio recovery block is no longer available.',
      };
    }
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    const options = Array.isArray(responseConfig.options) ? responseConfig.options : [];
    const hasOption = Boolean(
      optionId
      && options
        .map((item, index) => normalizeResponseOption(item, `option_${index}`))
        .find((item) => item.id === optionId)
    );
    if (!hasOption) {
      return {
        ok: false,
        message: 'Option audio recovery target is no longer available.',
      };
    }
    return { ok: true };
  }

  async replayEditorOptionT2AIntent(payload = {}) {
    const validation = this.validateEditorOptionT2AIntentPayload(payload);
    if (!validation.ok) {
      this.setRecoveryMessage(validation.message);
      console.warn('[editor] Ignoring stale/invalid option t2a recovery intent.', {
        action: 'editorOptionT2A',
        payload,
      });
      return { ok: false, status: 'invalid_context' };
    }
    const blockId = String(payload.blockId);
    const optionId = String(payload.optionId);
    const inFlightKey = `option:${blockId}:${optionId}`;
    if (this._optionT2AInFlightTargets.has(inFlightKey)) {
      const message = 'Option audio generation is already in progress.';
      this.setRecoveryMessage(message);
      this.pushNotification({
        kind: 'info',
        category: 'editor',
        source: 'option.t2a',
        text: message,
      });
      this.notifyStateChange();
      return { ok: false, status: 'already_in_flight', error: { message } };
    }
    const block = this.findBlock(blockId);
    const responseConfig = normalizeQuestionResponseConfig(block?.responseConfig);
    const normalizedOptions = (responseConfig.options || []).map((item, index) =>
      normalizeResponseOption(item, `option_${index}`));
    const selectedOption = normalizedOptions.find((item) => item.id === optionId) || null;
    const optionText = String(selectedOption?.label ?? selectedOption?.value ?? '').trim();
    if (!optionText) {
      const message = 'Enter option text before generating audio.';
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'missing_option_text',
        error: { message },
      };
    }
    if (optionText.length > T2A_TEXT_MAX_LENGTH) {
      const message = `Option text must be ${T2A_TEXT_MAX_LENGTH} characters or fewer to generate audio.`;
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'option_text_too_long',
        error: { message },
      };
    }
    this._optionT2AInFlightTargets.add(inFlightKey);
    try {
      const audioResult = await this.apiClient.generateAudioFromText(optionText);
      if (!audioResult?.ok) {
        const detail = String(audioResult?.error?.message || '').trim();
        const message = detail
          ? `Audio generation failed. Existing audio is unchanged. ${detail}`
          : 'Audio generation failed. Existing audio is unchanged.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'option.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { message } };
      }
      const audioBytes = toValidGeneratedAudioBytes(audioResult.data);
      if (!audioBytes) {
        const message = 'Audio generation failed. Existing audio is unchanged. Bridge returned invalid audio data.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'option.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { message } };
      }
      const generatedFile = createAudioFileFromBytes(audioBytes, `${blockId}_${optionId}.mp3`);
      const hasExistingOptionAudio = Boolean(getSingleMediaRef(selectedOption?.mediaRefs, 'option_audio'));
      const attachResult = await this.attachOptionAudio(blockId, optionId, generatedFile, {
        confirmReplace: hasExistingOptionAudio,
      });
      if (!attachResult?.ok) {
        const message = String(attachResult?.error?.message || '').trim() || 'Could not attach generated audio to this option.';
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'option.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'attach_failed', error: { message } };
      }
      this.setRecoveryMessage('Option audio generated and attached.');
      this.pushNotification({
        kind: 'success',
        category: 'editor',
        source: 'option.t2a',
        text: 'Option audio generated and attached.',
      });
      this.notifyStateChange();
      return { ok: true, status: 'generated_editor_option_t2a', data: { blockId, optionId } };
    } finally {
      this._optionT2AInFlightTargets.delete(inFlightKey);
    }
  }

  async triggerProtectedAction(actionId, intentPayload = {}) {
    if (!this.authGate) {
      throw new Error('Auth gate is not configured for editor session.');
    }

    const payload = {
      ...(intentPayload && typeof intentPayload === 'object' ? intentPayload : {}),
      localDraftId: this.state.draft?.localId || null,
    };

    return this.authGate.runProtectedAction({
      actionId,
      recordStore: 'localDrafts',
      payload,
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
  localDraftIdLabel.textContent = t('editor.labels.localDraftId');
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
  leftHeading.textContent = t('editor.sections.blocks');
  const rightHeading = document.createElement('h2');
  rightHeading.textContent = t('editor.sections.blockDetails');

  const blockList = document.createElement('ul');
  blockList.className = 'block-list';

  const controlsRow = document.createElement('div');
  controlsRow.className = 'sidebar-add-actions';

  const metaRow = document.createElement('div');
  metaRow.className = 'button-row';
  metaRow.classList.add('stacked-actions');

  const statusRow = document.createElement('p');
  statusRow.className = 'muted';
  const moreActions = document.createElement('details');
  moreActions.className = 'editor-more-actions';
  const moreActionsSummary = document.createElement('summary');
  moreActionsSummary.textContent = t('editor.actions.more');
  moreActions.appendChild(moreActionsSummary);

  const blockKind = document.createElement('select');
  blockKind.id = 'editor-block-kind';
  blockKind.className = 'control';
  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'application/zip,.zip,application/json,.json';
  importFileInput.style.display = 'none';
  const metadataSection = document.createElement('section');
  metadataSection.className = 'editor-metadata-section';
  const metadataHeading = document.createElement('h3');
  metadataHeading.textContent = t('editor.sections.draftInfo');
  const titleField = document.createElement('div');
  titleField.className = 'editor-field';
  const titleLabel = document.createElement('label');
  titleLabel.setAttribute('for', 'editor-title-input');
  titleLabel.textContent = t('editor.form.title.label');
  const titleInput = document.createElement('input');
  titleInput.id = 'editor-title-input';
  titleInput.placeholder = t('editor.form.title.placeholder');
  titleInput.className = 'control';
  titleField.append(titleLabel, titleInput);
  const subjectField = document.createElement('div');
  subjectField.className = 'editor-field';
  const subjectLabel = document.createElement('label');
  subjectLabel.setAttribute('for', 'editor-subject-input');
  subjectLabel.textContent = t('editor.form.subject.label');
  const subjectInput = document.createElement('input');
  subjectInput.id = 'editor-subject-input';
  subjectInput.placeholder = t('editor.form.subject.placeholder');
  subjectInput.className = 'control';
  subjectField.append(subjectLabel, subjectInput);
  metadataSection.append(metadataHeading, titleField, subjectField);
  const blockEditor = document.createElement('textarea');
  blockEditor.id = 'editor-block-editor';
  blockEditor.rows = 8;
  blockEditor.className = 'control';

  const questionInputType = document.createElement('select');
  questionInputType.id = 'editor-question-input-type';
  questionInputType.className = 'control';
  [
    { value: 'text', label: getAnswerInputTypeLabel('text') },
    { value: 'number', label: getAnswerInputTypeLabel('number') },
    { value: 'boolean', label: getAnswerInputTypeLabel('boolean') },
    { value: 'multiple_choice', label: getAnswerInputTypeLabel('multiple_choice') },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionInputType.appendChild(option);
  });
  const questionTextDisplayMode = document.createElement('div');
  questionTextDisplayMode.id = 'editor-question-text-display-mode';
  questionTextDisplayMode.className = 'answer-toggle';
  questionTextDisplayMode.setAttribute('role', 'group');
  questionTextDisplayMode.setAttribute('aria-labelledby', 'editor-question-text-display-mode-label');
  const questionTextDisplayModeButtons = [
    { value: 'single_line', label: 'Single line' },
    { value: 'multi_line', label: 'Multi line' },
  ].map(({ value, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-toggle__btn';
    button.dataset.textDisplayMode = value;
    button.setAttribute('aria-pressed', 'false');
    const tick = document.createElement('span');
    tick.className = 'answer-toggle__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.innerHTML = createEditorIcon('check');
    const text = document.createElement('span');
    text.textContent = label;
    button.append(tick, text);
    questionTextDisplayMode.appendChild(button);
    return button;
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
  addOptionBtn.textContent = t('editor.option.add');
  const questionSelectionMode = document.createElement('select');
  questionSelectionMode.id = 'editor-question-selection-mode';
  questionSelectionMode.className = 'control';
  [
    { value: 'single', label: getSelectionModeLabel('single') },
    { value: 'multi', label: getSelectionModeLabel('multi') },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionSelectionMode.appendChild(option);
  });
  const questionShuffleOptions = document.createElement('input');
  questionShuffleOptions.id = 'editor-question-shuffle-options';
  questionShuffleOptions.type = 'checkbox';
  questionShuffleOptions.hidden = true;
  const questionShuffleToggle = document.createElement('button');
  questionShuffleToggle.type = 'button';
  questionShuffleToggle.className = 'option-correct-toggle inline-toggle__tick-btn';
  questionShuffleToggle.setAttribute('aria-label', t('editor.question.toggleShuffleAria'));
  questionShuffleToggle.setAttribute('aria-pressed', 'false');
  const questionShuffleTick = document.createElement('span');
  questionShuffleTick.className = 'option-correct-toggle__tick';
  questionShuffleTick.setAttribute('aria-hidden', 'true');
  questionShuffleTick.innerHTML = createEditorIcon('check');
  questionShuffleToggle.appendChild(questionShuffleTick);
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
  questionNumberAllowSigned.hidden = true;
  const questionNumberAllowSignedToggle = document.createElement('button');
  questionNumberAllowSignedToggle.type = 'button';
  questionNumberAllowSignedToggle.className = 'option-correct-toggle inline-toggle__tick-btn';
  questionNumberAllowSignedToggle.setAttribute('aria-label', t('editor.question.toggleSignedValuesAria'));
  questionNumberAllowSignedToggle.setAttribute('aria-pressed', 'false');
  const questionNumberAllowSignedTick = document.createElement('span');
  questionNumberAllowSignedTick.className = 'option-correct-toggle__tick';
  questionNumberAllowSignedTick.setAttribute('aria-hidden', 'true');
  questionNumberAllowSignedTick.innerHTML = createEditorIcon('check');
  questionNumberAllowSignedToggle.appendChild(questionNumberAllowSignedTick);
  const questionNumberDecimalPlacesAllowed = document.createElement('input');
  questionNumberDecimalPlacesAllowed.id = 'editor-question-number-decimal-places-allowed';
  questionNumberDecimalPlacesAllowed.type = 'number';
  questionNumberDecimalPlacesAllowed.min = '0';
  questionNumberDecimalPlacesAllowed.step = '1';
  questionNumberDecimalPlacesAllowed.className = 'control';
  const questionCorrectAnswerBoolean = document.createElement('div');
  questionCorrectAnswerBoolean.id = 'editor-question-correct-answer-boolean';
  questionCorrectAnswerBoolean.className = 'boolean-answer-toggle';
  questionCorrectAnswerBoolean.setAttribute('role', 'group');
  questionCorrectAnswerBoolean.setAttribute('aria-labelledby', 'editor-question-correct-answer-boolean-label');
  const questionCorrectAnswerBooleanButtons = ['true', 'false'].map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'boolean-answer-toggle__btn';
    button.dataset.booleanAnswerValue = value;
    button.setAttribute('aria-pressed', 'false');
    const tick = document.createElement('span');
    tick.className = 'boolean-answer-toggle__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.innerHTML = createEditorIcon('check');
    const text = document.createElement('span');
    text.textContent = value === 'true' ? 'True' : 'False';
    button.append(tick, text);
    questionCorrectAnswerBoolean.appendChild(button);
    return button;
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
  let promptT2AInFlightBlockId = null;
  let optionT2AInFlightKey = null;
  const promptT2AInFlightBlockIds = new Set();
  const optionT2AInFlightKeys = new Set();
  let promptT2AUiRefs = null;
  let activeConfirmDialog = null;
  let mediaActionInFlight = false;

  const restoreLegacyPromptInFlightMarker = () => {
    promptT2AInFlightBlockId = promptT2AInFlightBlockIds.values().next().value || null;
  };

  const restoreLegacyOptionInFlightMarker = () => {
    optionT2AInFlightKey = optionT2AInFlightKeys.values().next().value || null;
  };

  function closeActiveConfirmDialog(confirmed = false) {
    const dialog = activeConfirmDialog;
    if (!dialog) return;
    dialog.cleanup();
    activeConfirmDialog = null;
    dialog.resolve(Boolean(confirmed));
  }

  function showConfirmDialog({
    title,
    bodyText,
    entityLabel,
    descriptionText,
    removalItems = [],
    confirmLabel = t('common.actions.delete'),
    cancelLabel = t('common.actions.cancel'),
    variant = 'danger',
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
    const resolvedBodyText = isNonEmptyString(bodyText) ? bodyText : descriptionText;
    const fallbackDescription = isNonEmptyString(entityLabel)
      ? t('editor.modal.confirm.deleteEntity', { entity: entityLabel })
      : t('editor.modal.confirm.defaultDescription');
    description.textContent = isNonEmptyString(resolvedBodyText)
      ? resolvedBodyText
      : fallbackDescription;
    const detailsHeading = document.createElement('p');
    detailsHeading.className = 'confirm-modal__details-heading';
    detailsHeading.textContent = t('editor.modal.confirm.thisWillRemove');
    const detailsList = document.createElement('ul');
    detailsList.className = 'confirm-modal__details-list';
    removalItems.forEach((item) => {
      const line = document.createElement('li');
      line.textContent = item;
      detailsList.appendChild(line);
    });
    const warning = document.createElement('p');
    warning.className = 'confirm-modal__warning';
    warning.textContent = t('editor.modal.confirm.irreversibleWarning');
    const actionRow = document.createElement('div');
    actionRow.className = 'confirm-modal__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-modal__btn';
    cancelBtn.textContent = cancelLabel;
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = variant === 'danger'
      ? 'confirm-modal__btn confirm-modal__btn--destructive'
      : 'confirm-modal__btn';
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

  // Launcher editor policy: do not use native window.confirm in UI flows.
  // Always route confirmations through showConfirmDialog for consistent keyboard/focus behavior.
  async function confirmDangerAction({
    title,
    bodyText,
    confirmLabel,
    removalItems = [],
  }) {
    if (!isNonEmptyString(bodyText)) {
      return false;
    }
    return showConfirmDialog({
      title,
      bodyText,
      removalItems,
      confirmLabel,
      cancelLabel: t('common.actions.cancel'),
      variant: 'danger',
      entityLabel: '',
    });
  }

  async function runMediaAction(action) {
    if (mediaActionInFlight) return false;
    mediaActionInFlight = true;
    try {
      await action();
      return true;
    } finally {
      mediaActionInFlight = false;
    }
  }

  function getProtectedActionErrorMessage(result, fallbackText) {
    const status = String(result?.status || '').trim();
    const detail = String(result?.error?.message || result?.result?.error?.message || '').trim();
    if (detail) {
      return detail;
    }
    if (status === 'blocked_no_local_id') {
      return 'Could not continue because no local draft is active. Please refresh and try again.';
    }
    if (status === 'blocked_session_probe') {
      return 'Unable to verify sign-in status right now. Please try again.';
    }
    if (status === 'invalid_context' || status === 'invalid_intent' || status === 'intent_invalid') {
      return 'Could not continue this action because the draft context changed. Please refresh and try again.';
    }
    return fallbackText;
  }

  async function copyTextToClipboard(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_error) {
        return false;
      }
    }
    return false;
  }

  function notifyClipboardResult({ copied, successText, failureText, source }) {
    session.pushNotification({
      kind: copied ? 'success' : 'warn',
      category: 'editor',
      source,
      text: copied ? successText : failureText,
    });
    session.notifyStateChange();
  }

  async function guardServerMenuAction(button, action) {
    if (button?.disabled) return null;
    const sessionReady = await session.ensureServerSessionReady();
    if (!sessionReady.ok) {
      updateSummary();
      return sessionReady.result;
    }
    return action();
  }

  function createCopyIdMenu({ triggerKind = 'info', triggerText = '', title, idValue, copyLabel, source }) {
    const details = document.createElement('details');
    details.className = `id-copy-menu id-copy-menu--${triggerKind}`;
    const summary = document.createElement('summary');
    summary.className = triggerKind === 'badge'
      ? 'asset-status-badge'
      : 'icon-btn id-copy-menu__summary';
    summary.setAttribute('role', 'button');
    summary.setAttribute('aria-label', `${title}: show copy action`);
    if (triggerKind === 'badge') {
      summary.textContent = triggerText || 'Attached';
    } else {
      summary.innerHTML = createEditorIcon('info');
      summary.title = title;
    }

    const body = document.createElement('div');
    body.className = 'id-copy-menu__body';
    const label = document.createElement('p');
    label.className = 'id-copy-menu__label';
    label.textContent = title;
    const value = document.createElement('p');
    value.className = 'editor-id-value id-copy-menu__value';
    value.textContent = idValue || 'n/a';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'id-copy-menu__copy';
    copyBtn.textContent = copyLabel;
    copyBtn.disabled = !isNonEmptyString(idValue);
    copyBtn.addEventListener('click', async () => {
      const copied = await copyTextToClipboard(idValue);
      copyBtn.textContent = copied ? 'Copied' : copyLabel;
      notifyClipboardResult({
        copied,
        source,
        successText: `${title} copied.`,
        failureText: 'Clipboard copy is unavailable in this browser.',
      });
      window.setTimeout(() => {
        copyBtn.textContent = copyLabel;
      }, 1400);
    });
    body.append(label, value, copyBtn);
    details.append(summary, body);
    return details;
  }

  function createEditorSectionHeader({ icon = 'info', title, className = '' }) {
    const header = document.createElement('div');
    header.className = `editor-section-header ${className}`.trim();
    const iconWrap = document.createElement('span');
    iconWrap.className = 'editor-section-header__icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.innerHTML = createEditorIcon(icon);
    const heading = document.createElement('h3');
    heading.textContent = title;
    header.append(iconWrap, heading);
    return header;
  }

  function formatLastSavedLabel(lastSavedAt) {
    if (!isNonEmptyString(lastSavedAt)) return 'Not yet saved';
    const savedTime = new Date(lastSavedAt).getTime();
    if (!Number.isFinite(savedTime)) return lastSavedAt;
    const elapsedMs = Date.now() - savedTime;
    if (elapsedMs < 0) return `${lastSavedAt} (in the future)`;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds} seconds ago`;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours} hour${elapsedHours === 1 ? '' : 's'} ago`;
    return lastSavedAt;
  }

  function emitServerNotification({ kind = 'info', text = '', source = 'editor.server' } = {}) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return;
    session.pushNotification({
      kind,
      category: 'server',
      source,
      text: normalizedText,
    });
    session.notifyStateChange();
  }

  function emitPublishedBrowseNotification({ kind = 'info', text = '', source = 'browse.published' } = {}) {
    emitServerNotification({ kind, text, source });
  }

  function showPublishModal({ uploadedDraft, initialTitle = null, initialSubject = null }) {
    return new Promise((resolve) => {
      const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement('div');
      overlay.className = 'confirm-modal-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h3');
      heading.textContent = t('editor.modal.publish.title');
      const description = document.createElement('p');
      description.className = 'confirm-modal__description';
      description.textContent = t('editor.modal.publish.description');
      const publishTitleField = document.createElement('div');
      publishTitleField.className = 'editor-field';
      const publishTitleLabel = document.createElement('label');
      publishTitleLabel.textContent = t('editor.modal.publish.publishedTitle');
      const publishTitleInput = document.createElement('input');
      publishTitleInput.className = 'control';
      publishTitleInput.value = initialTitle !== null
        ? String(initialTitle)
        : String(uploadedDraft?.title || '');
      publishTitleField.append(publishTitleLabel, publishTitleInput);
      const publishSubjectField = document.createElement('div');
      publishSubjectField.className = 'editor-field';
      const publishSubjectLabel = document.createElement('label');
      publishSubjectLabel.textContent = t('editor.modal.publish.publishedSubject');
      const publishSubjectInput = document.createElement('input');
      publishSubjectInput.className = 'control';
      publishSubjectInput.value = initialSubject !== null
        ? String(initialSubject)
        : String(uploadedDraft?.subject || '');
      publishSubjectField.append(publishSubjectLabel, publishSubjectInput);
      const actions = document.createElement('div');
      actions.className = 'confirm-modal__actions confirm-modal__actions--publish';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-modal__btn';
      cancelBtn.textContent = t('common.actions.cancel');
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'confirm-modal__btn confirm-modal__btn--primary';
      confirmBtn.textContent = t('common.actions.publish');
      actions.append(cancelBtn, confirmBtn);
      dialog.append(heading, description, publishTitleField, publishSubjectField, actions);
      overlay.appendChild(dialog);
      shell.appendChild(overlay);

      const getFocusable = () => [
        publishTitleInput,
        publishSubjectInput,
        cancelBtn,
        confirmBtn,
      ].filter((node) => !node.disabled);
      const cleanup = () => {
        dialog.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        if (previousActive && typeof previousActive.focus === 'function') {
          previousActive.focus();
        }
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
          resolve({ confirmed: false });
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
        if (currentIndex === focusable.length - 1 || currentIndex === -1) {
          event.preventDefault();
          focusable[0].focus();
        }
      };
      dialog.addEventListener('keydown', onKeyDown);
      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve({ confirmed: false });
      });
      confirmBtn.addEventListener('click', () => {
        cleanup();
        resolve({
          confirmed: true,
          title: publishTitleInput.value,
          subject: publishSubjectInput.value,
        });
      });
      publishTitleInput.focus();
    });
  }

  function showPublishedPackageConflictModal() {
    return new Promise((resolve) => {
      const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement('div');
      overlay.className = 'confirm-modal-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const heading = document.createElement('h3');
      heading.textContent = t('editor.modal.publishConflict.title');
      const description = document.createElement('p');
      description.className = 'confirm-modal__description';
      description.textContent = t('editor.modal.publishConflict.description');
      const warning = document.createElement('p');
      warning.className = 'confirm-modal__warning';
      warning.textContent = t('editor.modal.publishConflict.warning');

      const actions = document.createElement('div');
      actions.className = 'confirm-modal__actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-modal__btn';
      cancelBtn.textContent = t('common.actions.cancel');
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'confirm-modal__btn confirm-modal__btn--destructive';
      editBtn.textContent = t('editor.modal.publishConflict.editNameSubject');
      actions.append(cancelBtn, editBtn);
      dialog.append(heading, description, warning, actions);
      overlay.appendChild(dialog);
      shell.appendChild(overlay);

      const getFocusable = () => [cancelBtn, editBtn].filter((node) => !node.disabled);
      const cleanup = () => {
        dialog.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
          resolve({ action: 'cancel' });
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
        if (currentIndex === focusable.length - 1 || currentIndex === -1) {
          event.preventDefault();
          focusable[0].focus();
        }
      };
      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve({ action: 'cancel' });
      });
      editBtn.addEventListener('click', () => {
        cleanup();
        resolve({ action: 'edit' });
      });
      dialog.addEventListener('keydown', onKeyDown);
      editBtn.focus();
    });
  }

  function showUploadConflictModal({ existingDraft }) {
    return new Promise((resolve) => {
      const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement('div');
      overlay.className = 'confirm-modal-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h3');
      heading.textContent = t('editor.modal.uploadConflict.title');
      const description = document.createElement('p');
      description.className = 'confirm-modal__description';
      description.textContent = t('editor.modal.uploadConflict.description', {
        title: existingDraft?.title || t('common.values.untitled'),
      });
      const details = document.createElement('div');
      details.className = 'muted uploaded-draft-details-body';
      const subjectLine = document.createElement('div');
      subjectLine.textContent = t('common.meta.subject', { value: existingDraft?.subject || '-' });
      const uploadedLine = document.createElement('div');
      uploadedLine.textContent = t('common.meta.uploaded', { value: formatUploadedDraftTimestamp(existingDraft?.created_at) });
      const statusLine = document.createElement('div');
      statusLine.textContent = existingDraft?.published_package_id
        ? t('common.meta.status', { value: t('editor.modal.uploadConflict.statusAlreadyPublished') })
        : t('common.meta.status', { value: t('editor.modal.uploadConflict.statusDraftOnly') });
      details.append(subjectLine, uploadedLine, statusLine);
      const warning = document.createElement('p');
      warning.className = 'confirm-modal__warning';
      warning.textContent = existingDraft?.published_package_id
        ? t('editor.modal.uploadConflict.warningPublishedCopyUnaffected')
        : t('editor.modal.uploadConflict.warningReplaceArtifact');
      const actions = document.createElement('div');
      actions.className = 'confirm-modal__actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-modal__btn';
      cancelBtn.textContent = t('common.actions.cancel');
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'confirm-modal__btn';
      copyBtn.textContent = t('editor.modal.uploadConflict.saveAsNewCopy');
      const replaceBtn = document.createElement('button');
      replaceBtn.type = 'button';
      replaceBtn.className = 'confirm-modal__btn confirm-modal__btn--destructive';
      replaceBtn.textContent = t('editor.modal.uploadConflict.replaceUploadedDraft');
      actions.append(cancelBtn, copyBtn, replaceBtn);
      dialog.append(heading, description, details, warning, actions);
      overlay.appendChild(dialog);
      shell.appendChild(overlay);
      let resolved = false;
      const cleanup = () => {
        overlay.remove();
        if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
      };
      const choose = (action) => {
        if (resolved) return;
        resolved = true;
        cancelBtn.disabled = true;
        copyBtn.disabled = true;
        replaceBtn.disabled = true;
        cleanup();
        resolve({ action });
      };
      cancelBtn.addEventListener('click', () => {
        choose('cancel');
      });
      copyBtn.addEventListener('click', () => {
        choose('copy');
      });
      replaceBtn.addEventListener('click', () => {
        choose('replace');
      });
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          choose('cancel');
        }
      });
      cancelBtn.focus();
    });
  }

  async function showSlotFullModal({ uploadedDrafts = [] } = {}) {
    const rows = Array.isArray(uploadedDrafts) && uploadedDrafts.length > 0
      ? uploadedDrafts
      : session.state.uploadedDrafts;
    return new Promise((resolve) => {
      const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement('div');
      overlay.className = 'confirm-modal-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-modal browse-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h3');
      heading.textContent = t('editor.modal.slotLimit.title');
      const description = document.createElement('p');
      description.className = 'confirm-modal__description';
      description.textContent = t('editor.modal.slotLimit.description');
      const list = document.createElement('div');
      list.className = 'browse-results';
      rows.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'published-result-row';
        const title = document.createElement('strong');
        title.className = 'published-result-title';
        title.textContent = item.title || t('common.values.untitled');
        const meta = document.createElement('div');
        meta.className = 'muted published-result-subject-owner';
        meta.textContent = `${item.subject || '-'} • ${formatUploadedDraftTimestamp(item.created_at)}`;
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'uploaded-draft-action uploaded-draft-action--danger';
        deleteBtn.textContent = t('common.actions.delete');
        deleteBtn.addEventListener('click', async () => {
          const confirmed = await showConfirmDialog({
            title: t('editor.uploadedDraft.deleteDialog.title'),
            entityLabel: item.title || t('common.values.untitled'),
            descriptionText: item.published_package_id
              ? t('editor.uploadedDraft.deleteDialog.publishedDescription')
              : t('editor.uploadedDraft.deleteDialog.draftDescription'),
            removalItems: [t('editor.uploadedDraft.deleteDialog.removeArtifact'), t('editor.uploadedDraft.deleteDialog.removeMetadata')],
            confirmLabel: t('editor.uploadedDraft.deleteDialog.confirm'),
          });
          if (!confirmed) return;
          const result = await session.deleteUploadedDraft(item.uploaded_draft_id);
          if (result?.ok) {
            overlay.remove();
            if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
            resolve({ deleted: true });
          }
        });
        row.append(title, meta, deleteBtn);
        list.appendChild(row);
      });
      const actions = document.createElement('div');
      actions.className = 'confirm-modal__actions';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'confirm-modal__btn';
      closeBtn.textContent = t('common.actions.cancel');
      closeBtn.addEventListener('click', () => {
        overlay.remove();
        if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
        resolve({ deleted: false });
      });
      actions.appendChild(closeBtn);
      dialog.append(heading, description, list, actions);
      overlay.appendChild(dialog);
      shell.appendChild(overlay);
      closeBtn.focus();
    });
  }

  async function runPublishedSearch(options = {}) {
    const append = options.append === true;
    const sessionReady = await session.ensureServerSessionReady();
    if (!sessionReady.ok) {
      const notReadyMessage = session.state.serverActionMessage || 'Sign in for server features, then retry this action.';
      browsePublishedState = {
        ...browsePublishedState,
        loading: false,
        error: notReadyMessage,
        items: [],
        hasMore: false,
        nextOffset: null,
      };
      emitPublishedBrowseNotification({
        kind: 'warn',
        source: 'browse.published.search',
        text: notReadyMessage,
      });
      renderPublishedBrowserModal();
      return;
    }
    browsePublishedState = {
      ...browsePublishedState,
      loading: true,
      error: null,
    };
    renderPublishedBrowserModal();
    const result = await session.apiClient.listPublishedPackages({
      title: browsePublishedState.title,
      subject: browsePublishedState.subject,
      owner: browsePublishedState.owner,
      limit: 20,
      offset: append && Number.isFinite(Number(browsePublishedState.nextOffset))
        ? Number(browsePublishedState.nextOffset)
        : 0,
    });
    if (!result.ok) {
      browsePublishedState = {
        ...browsePublishedState,
        loading: false,
        error: result.error.message,
        hasMore: false,
        nextOffset: null,
      };
      emitPublishedBrowseNotification({
        kind: 'error',
        source: 'browse.published.search',
        text: result.error.message,
      });
      renderPublishedBrowserModal();
      return;
    }
    const resultItems = Array.isArray(result.data?.items) ? result.data.items : [];
    browsePublishedState = {
      ...browsePublishedState,
      loading: false,
      items: append ? [...browsePublishedState.items, ...resultItems] : resultItems,
      hasMore: result.data?.hasMore === true,
      nextOffset: Number.isFinite(Number(result.data?.nextOffset)) ? Number(result.data.nextOffset) : null,
      error: null,
    };
    emitPublishedBrowseNotification({
      kind: 'success',
      source: 'browse.published.search',
      text: append
        ? `Loaded ${resultItems.length} more published package${resultItems.length === 1 ? '' : 's'}.`
        : `Found ${resultItems.length} published package${resultItems.length === 1 ? '' : 's'}.`,
    });
    renderPublishedBrowserModal();
  }

  function renderPublishedBrowserModal() {
    browsePublishedModalRoot.innerHTML = '';
    if (!browsePublishedDialogOpen) return;
    const serverReady = session.state.serverSession?.status === 'ready';
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal browse-modal';
    const heading = document.createElement('h3');
    heading.textContent = t('editor.published.browse');
    const filterRow = document.createElement('div');
    filterRow.className = 'browse-modal__filters';
    const titleFilter = document.createElement('input');
    titleFilter.className = 'control';
    titleFilter.placeholder = t('common.publishedBrowser.filterByTitle');
    titleFilter.value = browsePublishedState.title;
    const subjectFilter = document.createElement('input');
    subjectFilter.className = 'control';
    subjectFilter.placeholder = t('common.publishedBrowser.filterBySubject');
    subjectFilter.value = browsePublishedState.subject;
    const ownerFilter = document.createElement('input');
    ownerFilter.className = 'control';
    ownerFilter.placeholder = t('common.publishedBrowser.filterByOwnerEmail');
    ownerFilter.value = browsePublishedState.owner;
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'browse-modal__search-btn';
    searchBtn.innerHTML = '<svg class="browse-modal__search-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.25" stroke="currentColor" stroke-width="1.6"></circle><path d="M12.5 12.5L16.25 16.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';
    searchBtn.setAttribute('aria-label', t('common.publishedBrowser.searchAriaLabel'));
    searchBtn.disabled = browsePublishedState.loading;
    filterRow.append(titleFilter, subjectFilter, ownerFilter, searchBtn);
    const results = document.createElement('div');
    results.className = 'browse-results';
    if (browsePublishedState.error) {
      const error = document.createElement('p');
      error.className = 'control-error';
      error.textContent = browsePublishedState.error;
      results.appendChild(error);
    } else if (browsePublishedState.loading) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = t('common.publishedBrowser.loading');
      results.appendChild(loading);
    } else if (browsePublishedState.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('common.publishedBrowser.empty');
      results.appendChild(empty);
    } else {
      browsePublishedState.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'published-result-row';
        const titleLine = document.createElement('div');
        titleLine.className = 'published-result-title-line';
        const title = document.createElement('strong');
        title.className = 'published-result-title';
        title.textContent = item.title || t('common.values.untitled');
        const publishedDate = document.createElement('span');
        publishedDate.className = 'published-result-date muted';
        publishedDate.textContent = formatUploadedDraftTimestamp(item.published_at);
        titleLine.append(title, publishedDate);
        const subjectOwner = document.createElement('div');
        subjectOwner.className = 'muted published-result-subject-owner';
        subjectOwner.textContent = t('editor.published.metaSubjectOwner', {
          subject: item.subject || '—',
          owner: item.owner_email || item.owner_name || item.owner_sub || '—',
        });
        const publishedMeta = document.createElement('div');
        publishedMeta.className = 'muted published-result-id';
        publishedMeta.textContent = t('common.meta.packageId', { value: item.published_package_id });
        row.append(titleLine, subjectOwner, publishedMeta);
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'uploaded-draft-action published-result-action';
        copyBtn.textContent = t('editor.published.copyViewerLink');
        copyBtn.addEventListener('click', async () => {
          const viewerUrl = buildPublishedPackageViewerUrl(item.published_package_id);
          const copied = await copyTextToClipboard(viewerUrl);
          emitServerNotification({
            kind: copied ? 'success' : 'warn',
            source: 'clipboard.publishedId',
            text: copied
              ? t('editor.notifications.viewerLinkCopied')
              : t('common.clipboard.unavailable'),
          });
        });
        const openInEditorBtn = document.createElement('button');
        openInEditorBtn.type = 'button';
        openInEditorBtn.className = 'uploaded-draft-action published-result-action';
        const isOpening = session.state.openingPublishedPackageIds.has(item.published_package_id);
        openInEditorBtn.textContent = isOpening ? t('editor.published.openingInEditor') : t('editor.published.openInEditor');
        openInEditorBtn.disabled = !serverReady || browsePublishedState.loading || isOpening;
        openInEditorBtn.addEventListener('click', async () => {
          if (session.state.openingPublishedPackageIds.has(item.published_package_id)) return;
          const reopenPromise = session.reopenPublishedPackageAsLocalCopy(item.published_package_id);
          renderPublishedBrowserModal();
          const reopenResult = await reopenPromise;
          if (reopenResult?.ok) {
            emitPublishedBrowseNotification({
              kind: 'success',
              source: 'browse.published.open',
              text: t('editor.notifications.openedPublishedPackageInEditor', { id: item.published_package_id }),
            });
            browsePublishedDialogOpen = false;
          } else {
            const openError = session.state.serverActionMessage || reopenResult?.error?.message || t('editor.notifications.failedOpenPublishedPackage');
            browsePublishedState = {
              ...browsePublishedState,
              error: openError,
            };
            emitPublishedBrowseNotification({
              kind: 'error',
              source: 'browse.published.open',
              text: openError,
            });
          }
          renderPublishedBrowserModal();
          updateSummary();
        });
        const actionRow = document.createElement('div');
        actionRow.className = 'published-result-actions';
        actionRow.append(copyBtn, openInEditorBtn);
        const currentUserSub = session.state.serverSession?.user?.sub || '';
        if (currentUserSub && item.owner_sub === currentUserSub) {
          const deletePublishedBtn = document.createElement('button');
          deletePublishedBtn.type = 'button';
          deletePublishedBtn.className = 'uploaded-draft-action uploaded-draft-action--danger published-result-action';
          deletePublishedBtn.textContent = t('common.actions.delete');
          deletePublishedBtn.addEventListener('click', async () => {
            const confirmed = await showConfirmDialog({
              title: 'Delete published package?',
              entityLabel: item.title || 'Untitled',
              descriptionText: 'This deletes the published package. Existing viewer links for this package will stop working.',
              removalItems: ['Published package ZIP artifact', 'Published package metadata'],
              confirmLabel: 'Delete package',
            });
            if (!confirmed) return;
            const result = await session.deletePublishedPackage(item.published_package_id);
            if (result?.ok) {
              await runPublishedSearch();
            }
          });
          actionRow.appendChild(deletePublishedBtn);
        }
        row.appendChild(actionRow);
        results.appendChild(row);
      });
    }
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'confirm-modal__btn';
    loadMoreBtn.textContent = browsePublishedState.loading ? t('common.actions.loading') : t('common.actions.loadMore');
    loadMoreBtn.hidden = !browsePublishedState.hasMore;
    loadMoreBtn.disabled = browsePublishedState.loading || !serverReady;
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'confirm-modal__btn';
    refreshBtn.textContent = t('common.actions.refresh');
    refreshBtn.disabled = browsePublishedState.loading || !serverReady;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'confirm-modal__btn';
    closeBtn.textContent = t('common.actions.close');
    actions.append(loadMoreBtn, refreshBtn, closeBtn);
    dialog.append(heading, filterRow, results, actions);
    overlay.appendChild(dialog);
    browsePublishedModalRoot.appendChild(overlay);

    const captureFilters = () => {
      browsePublishedState = {
        ...browsePublishedState,
        title: titleFilter.value,
        subject: subjectFilter.value,
        owner: ownerFilter.value,
      };
    };
    searchBtn.addEventListener('click', async () => {
      captureFilters();
      await runPublishedSearch();
    });
    loadMoreBtn.addEventListener('click', async () => {
      await runPublishedSearch({ append: true });
    });
    refreshBtn.addEventListener('click', async () => {
      captureFilters();
      await runPublishedSearch();
    });
    closeBtn.addEventListener('click', () => {
      browsePublishedDialogOpen = false;
      renderPublishedBrowserModal();
    });
  }
  ['content', 'question'].forEach((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = getBlockKindLabel(kind);
    blockKind.appendChild(option);
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'sidebar-action-btn';
  setMediaActionButtonContent(saveBtn, 'save', t('editor.actions.saveLocalDraft'));
  const addContentBtn = document.createElement('button');
  addContentBtn.type = 'button';
  addContentBtn.className = 'sidebar-action-btn';
  setMediaActionButtonContent(addContentBtn, 'filePlus', t('editor.actions.addContent'));
  const addQuestionBtn = document.createElement('button');
  addQuestionBtn.type = 'button';
  addQuestionBtn.className = 'sidebar-action-btn';
  setMediaActionButtonContent(addQuestionBtn, 'question', t('editor.actions.addQuestion'));
  const openViewerBtn = document.createElement('button');
  openViewerBtn.type = 'button';
  openViewerBtn.textContent = t('editor.actions.openViewer');
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = t('editor.actions.importPackage');
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('editor.actions.exportPackage');
  const syncDraftBtn = document.createElement('button');
  syncDraftBtn.type = 'button';
  syncDraftBtn.textContent = t('editor.server.uploadDraft');
  const browsePublishedBtn = document.createElement('button');
  browsePublishedBtn.type = 'button';
  browsePublishedBtn.textContent = t('editor.published.browse');
  const manageUploadedDraftsBtn = document.createElement('button');
  manageUploadedDraftsBtn.type = 'button';
  manageUploadedDraftsBtn.textContent = t('editor.uploadedDraft.manage');
  const signInBtn = document.createElement('button');
  signInBtn.type = 'button';
  signInBtn.textContent = t('auth.signInForServerFeatures');
  const serverSessionStatus = document.createElement('p');
  serverSessionStatus.className = 'muted';
  const activityFeed = document.createElement('section');
  activityFeed.className = 'notification-feed';
  const activityFeedToggle = document.createElement('details');
  activityFeedToggle.className = 'editor-activity-panel';
  const activityFeedHeading = document.createElement('summary');
  activityFeedHeading.className = 'editor-activity-panel__summary';
  activityFeedHeading.textContent = t('common.sections.activity');
  const activityFeedList = document.createElement('div');
  activityFeedList.className = 'notification-feed__list';
  const activityFeedSummary = document.createElement('p');
  activityFeedSummary.className = 'muted';
  const loadOlderActivityBtn = document.createElement('button');
  loadOlderActivityBtn.type = 'button';
  loadOlderActivityBtn.textContent = t('editor.activity.loadOlder');
  activityFeed.append(activityFeedSummary, activityFeedList, loadOlderActivityBtn);
  activityFeedToggle.append(activityFeedHeading, activityFeed);
  const toastContainer = document.createElement('div');
  toastContainer.className = 'notification-toast-container';
  const browsePublishedModalRoot = document.createElement('div');
  const manageUploadedDraftsModalRoot = document.createElement('div');
  const protectedActionsColumn = document.createElement('div');
  protectedActionsColumn.className = 'action-column';
  let browsePublishedState = {
    title: '',
    subject: '',
    owner: '',
    loading: false,
    items: [],
    hasMore: false,
    nextOffset: null,
    error: null,
  };
  let browsePublishedDialogOpen = false;
  let manageUploadedDraftsDialogOpen = false;
  let detailSignature = null;
  let optionActionSignature = null;
  let visibleActivityCount = ACTIVITY_VISIBLE_INITIAL;
  const dismissedToastIds = new Set();
  const toastTimers = new Map();
  const DEFAULT_TOAST_TTL_MS = 5000;

  const getNotificationAriaLive = (kind) => (kind === 'error' ? 'assertive' : 'polite');
  const getNotificationRole = (kind) => (kind === 'error' ? 'alert' : 'status');
  const formatNotificationTimestamp = (isoValue) => {
    if (!isNonEmptyString(isoValue)) return '';
    const parsed = new Date(isoValue);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  const renderNotificationCard = (notification, className, { announce = true } = {}) => {
    const item = document.createElement('article');
    const severity = ['success', 'info', 'warn', 'error'].includes(notification?.kind) ? notification.kind : 'info';
    item.className = `${className} ${className}--${severity}`;
    if (announce) {
      item.setAttribute('aria-live', getNotificationAriaLive(severity));
      item.setAttribute('role', getNotificationRole(severity));
    } else {
      item.setAttribute('aria-live', 'off');
    }
    const message = document.createElement('div');
    message.className = `${className}__text`;
    message.textContent = notification?.text || '';
    const meta = document.createElement('div');
    meta.className = `${className}__meta`;
    const timestamp = document.createElement('time');
    timestamp.className = `${className}__time`;
    timestamp.dateTime = notification?.createdAt || '';
    timestamp.textContent = formatNotificationTimestamp(notification?.createdAt) || 'just now';
    meta.appendChild(timestamp);
    if (isNonEmptyString(notification?.actionLabel)) {
      const action = document.createElement('span');
      action.className = `${className}__action`;
      action.textContent = notification.actionLabel.trim();
      meta.appendChild(action);
    }
    item.append(message, meta);
    return item;
  };

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
    if (activeElement !== subjectInput) {
      subjectInput.value = session.state.draft?.metadata?.subject || '';
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
      const activeDisplayMode = responseConfig.displayMode === 'single_line' ? 'single_line' : 'multi_line';
      questionTextDisplayModeButtons.forEach((button) => {
        button.setAttribute(
          'aria-pressed',
          button.dataset.textDisplayMode === activeDisplayMode ? 'true' : 'false'
        );
      });
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
      questionShuffleToggle.setAttribute('aria-pressed', questionShuffleOptions.checked ? 'true' : 'false');
      if (activeElement !== questionMin) questionMin.value = responseConfig.min ?? '';
      if (activeElement !== questionMax) questionMax.value = responseConfig.max ?? '';
      if (activeElement !== questionNumberAllowSigned) {
        questionNumberAllowSigned.checked = responseConfig.numberRules?.allowSigned !== false;
      }
      questionNumberAllowSignedToggle.setAttribute(
        'aria-pressed',
        questionNumberAllowSigned.checked ? 'true' : 'false'
      );
      if (activeElement !== questionNumberDecimalPlacesAllowed) {
        questionNumberDecimalPlacesAllowed.value = Number.isInteger(responseConfig.numberRules?.decimalPlacesAllowed)
          ? String(responseConfig.numberRules.decimalPlacesAllowed)
          : '';
      }
      questionCorrectAnswerBooleanButtons.forEach((button) => {
        const isSelected = typeof responseConfig.correctAnswer === 'boolean'
          && button.dataset.booleanAnswerValue === String(responseConfig.correctAnswer);
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
      if (activeElement !== questionCorrectAnswerNumber) {
        questionCorrectAnswerNumber.value = typeof responseConfig.correctAnswer === 'number'
          ? String(responseConfig.correctAnswer)
          : '';
      }
    }
    updateNumberValidationFeedback(selectedBlock);
  };

  let draggedBlockId = null;
  let closeActiveBlockReorderMenu = null;
  let activeBlockReorderAnchor = null;
  const clearBlockDragState = () => {
    blockList.querySelectorAll('.block-item--dragging, .block-item--drop-before, .block-item--drop-after')
      .forEach((node) => {
        node.classList.remove('block-item--dragging', 'block-item--drop-before', 'block-item--drop-after');
      });
  };
  const closeBlockReorderMenu = () => {
    if (typeof closeActiveBlockReorderMenu === 'function') {
      closeActiveBlockReorderMenu();
      closeActiveBlockReorderMenu = null;
    }
    if (activeBlockReorderAnchor) {
      activeBlockReorderAnchor.setAttribute('aria-expanded', 'false');
      activeBlockReorderAnchor = null;
    }
  };
  const positionBlockReorderMenu = (menu, anchor) => {
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const belowTop = anchorRect.bottom + 6;
    const aboveTop = anchorRect.top - menuRect.height - 6;
    const hasRoomBelow = belowTop + menuRect.height <= window.innerHeight - viewportPadding;
    const top = hasRoomBelow ? belowTop : Math.max(viewportPadding, aboveTop);
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - viewportPadding)
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  const openBlockReorderMenu = ({ anchor, block, displayIndex, isFirst, isLast }) => {
    closeBlockReorderMenu();
    const menu = document.createElement('div');
    menu.className = 'block-reorder-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('editor.reorder.menuAriaLabel', { index: displayIndex }));

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'block-reorder-menu__item';
    moveUpBtn.title = t('editor.reorder.moveUpTitle', { index: displayIndex });
    moveUpBtn.textContent = t('editor.reorder.moveUp');
    moveUpBtn.disabled = isFirst;
    moveUpBtn.setAttribute('role', 'menuitem');
    moveUpBtn.addEventListener('click', () => {
      closeBlockReorderMenu();
      session.reorderBlockByDelta(block.blockId, -1);
      updateSummary();
    });

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'block-reorder-menu__item';
    moveDownBtn.title = t('editor.reorder.moveDownTitle', { index: displayIndex });
    moveDownBtn.textContent = t('editor.reorder.moveDown');
    moveDownBtn.disabled = isLast;
    moveDownBtn.setAttribute('role', 'menuitem');
    moveDownBtn.addEventListener('click', () => {
      closeBlockReorderMenu();
      session.reorderBlockByDelta(block.blockId, 1);
      updateSummary();
    });

    const body = document.createElement('div');
    body.className = 'block-reorder-menu__body';
    body.append(moveUpBtn, moveDownBtn);
    menu.appendChild(body);
    document.body.appendChild(menu);
    activeBlockReorderAnchor = anchor;
    positionBlockReorderMenu(menu, anchor);

    const onPointerDown = (event) => {
      if (menu.contains(event.target) || anchor.contains(event.target)) return;
      closeBlockReorderMenu();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBlockReorderMenu();
      }
    };
    const onScrollOrResize = () => closeBlockReorderMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    closeActiveBlockReorderMenu = () => {
      menu.remove();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  };

  const renderBlockList = () => {
    closeBlockReorderMenu();
    blockList.innerHTML = '';
    const blocks = (session.state.draft?.blocks || []).slice().sort((a, b) => a.position - b.position);
    blocks.forEach((block, index) => {
      const isFirst = index === 0;
      const isLast = index === blocks.length - 1;
      const item = document.createElement('li');
      item.className = `block-item ${block.blockId === session.state.selectedBlockId ? 'selected' : ''}`;
      item.dataset.blockId = block.blockId;
      item.dataset.blockIndex = String(index);
      const row = document.createElement('div');
      row.className = 'block-item-row';
      const dragHandle = document.createElement('button');
      dragHandle.type = 'button';
      dragHandle.className = 'block-drag-handle';
      dragHandle.title = t('editor.reorder.dragHandleTitle', { index: index + 1 });
      dragHandle.setAttribute('aria-label', t('editor.reorder.dragHandleAriaLabel', { index: index + 1 }));
      dragHandle.setAttribute('draggable', 'true');
      dragHandle.innerHTML = createEditorIcon('grip');
      dragHandle.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      dragHandle.addEventListener('dragstart', (event) => {
        draggedBlockId = block.blockId;
        item.classList.add('block-item--dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', block.blockId);
        }
      });
      dragHandle.addEventListener('dragend', () => {
        draggedBlockId = null;
        clearBlockDragState();
      });
      item.addEventListener('dragover', (event) => {
        if (!draggedBlockId || draggedBlockId === block.blockId) return;
        event.preventDefault();
        blockList.querySelectorAll('.block-item--drop-before, .block-item--drop-after')
          .forEach((node) => {
            if (node !== item) node.classList.remove('block-item--drop-before', 'block-item--drop-after');
          });
        const rect = item.getBoundingClientRect();
        const dropAfter = event.clientY > rect.top + rect.height / 2;
        item.classList.toggle('block-item--drop-before', !dropAfter);
        item.classList.toggle('block-item--drop-after', dropAfter);
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('block-item--drop-before', 'block-item--drop-after');
      });
      item.addEventListener('drop', (event) => {
        if (!draggedBlockId || draggedBlockId === block.blockId) return;
        event.preventDefault();
        const sourceIndex = blocks.findIndex((entry) => entry.blockId === draggedBlockId);
        if (sourceIndex < 0) return;
        const rect = item.getBoundingClientRect();
        const dropAfter = event.clientY > rect.top + rect.height / 2;
        let targetIndex = dropAfter ? index + 1 : index;
        if (sourceIndex < targetIndex) targetIndex -= 1;
        targetIndex = Math.max(0, Math.min(targetIndex, blocks.length - 1));
        session.reorderBlockToIndex(draggedBlockId, targetIndex);
        draggedBlockId = null;
        clearBlockDragState();
        updateSummary();
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'block-select';
      const displayIndex = index + 1;
      const previewSource = block.kind === 'question' ? block?.prompt?.text : block?.content?.text;
      const preview = String(previewSource || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '—';
      const blockIndex = document.createElement('span');
      blockIndex.className = 'block-select__index';
      blockIndex.textContent = `${displayIndex}.`;
      const blockTitle = document.createElement('span');
      blockTitle.className = 'block-select__title';
      blockTitle.textContent = preview;
      const blockBadge = document.createElement('span');
      blockBadge.className = `block-kind-badge block-kind-badge--${block.kind}`;
      blockBadge.textContent = getBlockKindLabel(block.kind);
      button.append(blockIndex, blockTitle, blockBadge);
      button.addEventListener('click', () => {
        session.selectBlock(block.blockId);
        updateSummary();
      });
      const actions = document.createElement('div');
      actions.className = 'block-item-actions';
      const reorderMenuBtn = document.createElement('button');
      reorderMenuBtn.type = 'button';
      reorderMenuBtn.className = 'icon-btn';
      reorderMenuBtn.title = t('editor.reorder.moreActionsTitle', { index: displayIndex });
      reorderMenuBtn.setAttribute('aria-label', t('editor.reorder.moreActionsAriaLabel', { index: displayIndex }));
      reorderMenuBtn.setAttribute('aria-haspopup', 'menu');
      reorderMenuBtn.setAttribute('aria-expanded', 'false');
      reorderMenuBtn.innerHTML = createEditorIcon('moreHorizontal');
      reorderMenuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpenForThisButton = activeBlockReorderAnchor === reorderMenuBtn;
        closeBlockReorderMenu();
        if (!isOpenForThisButton) {
          reorderMenuBtn.setAttribute('aria-expanded', 'true');
          openBlockReorderMenu({ anchor: reorderMenuBtn, block, displayIndex, isFirst, isLast });
        }
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'icon-btn danger';
      deleteBtn.title = t('editor.block.deleteThisBlock');
      deleteBtn.setAttribute('aria-label', t('editor.block.deleteBlockAriaLabel', { index: displayIndex }));
      setIconButtonContent(deleteBtn, 'trash');
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
            title: t('editor.block.deleteDialogTitle', { index: displayIndex }),
            entityLabel: t('editor.block.entityLabel', { index: displayIndex }),
            removalItems,
            confirmLabel: t('editor.block.deleteConfirm'),
          });
          if (!confirmed) return;
          session.deleteBlockWithPolicy(block.blockId, { confirmDelete: true });
        }
        updateSummary();
      });
      actions.append(reorderMenuBtn, deleteBtn);
      row.append(dragHandle, button, actions);
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
    const scopedPromptT2AInFlight = selectedBlock.kind === 'question'
      && (
        promptT2AInFlightBlockIds.has(selectedBlock.blockId)
        || promptT2AInFlightBlockId === selectedBlock.blockId
      )
      ? '1'
      : '0';
    const scopedOptionT2AInFlight = selectedBlock.kind === 'question'
      && (normalizeQuestionResponseConfig(selectedBlock.responseConfig).options || [])
        .map((opt, index) => normalizeResponseOption(opt, `option_${index}`))
        .some((opt) => {
          const optionId = String(opt?.id || '');
          if (!optionId) return false;
          const key = `${selectedBlock.blockId}:${optionId}`;
          return optionT2AInFlightKeys.has(key) || optionT2AInFlightKey === key;
        })
      ? '1'
      : '0';
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
      scopedPromptT2AInFlight,
      scopedOptionT2AInFlight,
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
      const optionTextState = getT2ATextEligibility(normalized?.label ?? normalized?.value ?? '');
      const optionT2AKey = `${selectedBlock.blockId}:${String(normalized?.id ?? '')}`;
      const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey
        || optionT2AInFlightKeys.has(optionT2AKey);
      return [
        String(normalized.id ?? ''),
        ...normalizeMediaRefs(normalized.mediaRefs, 'option_audio').map((ref) => String(ref?.assetId ?? '')),
        optionTextState.eligible ? '1' : '0',
        optionTextState.exceedsLimit ? '1' : '0',
        isOptionT2AInFlight ? '1' : '0',
      ];
    }));
  };

  const refreshPromptT2AControlsForSelectedBlock = () => {
    if (!promptT2AUiRefs) return;
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    if (!selectedBlock || selectedBlock.kind !== 'question' || selectedBlock.blockId !== promptT2AUiRefs.blockId) {
      return;
    }
    const promptTextState = getT2ATextEligibility(selectedBlock?.prompt?.text || '');
    const promptMediaRefs = normalizeMediaRefs(selectedBlock?.prompt?.mediaRefs);
    const currentQuestionAudioRef = getSingleMediaRef(promptMediaRefs, 'question_audio');
    const isPromptT2AInFlight = promptT2AInFlightBlockIds.has(selectedBlock.blockId)
      || promptT2AInFlightBlockId === selectedBlock.blockId;
    const promptT2ALabel = isPromptT2AInFlight
      ? 'Generating…'
      : currentQuestionAudioRef ? 'Regenerate audio' : 'Generate audio';
    const promptT2AIcon = isPromptT2AInFlight ? 'loading' : currentQuestionAudioRef ? 'refresh' : 'generate';
    setMediaActionButtonContent(promptT2AUiRefs.generateBtn, promptT2AIcon, promptT2ALabel);
    promptT2AUiRefs.generateBtn.disabled = !promptTextState.eligible || isPromptT2AInFlight;
    promptT2AUiRefs.hint.textContent = promptTextState.exceedsLimit
      ? `Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters).`
      : '';
    promptT2AUiRefs.hint.hidden = !promptTextState.exceedsLimit;
    promptT2AUiRefs.attachBtn.disabled = isPromptT2AInFlight;
    promptT2AUiRefs.playBtn.disabled = !currentQuestionAudioRef || isPromptT2AInFlight;
    promptT2AUiRefs.removeBtn.disabled = !currentQuestionAudioRef || isPromptT2AInFlight;
  };

  const refreshOptionRowT2AControls = (selectedBlockId, optionId, row) => {
    if (!row || !selectedBlockId || !optionId) return;
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === selectedBlockId);
    if (!selectedBlock || selectedBlock.kind !== 'question') return;
    const responseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
    if (responseConfig.inputType !== 'multiple_choice') return;
    const normalizedOptions = (responseConfig.options || []).map((option, index) =>
      normalizeResponseOption(option, `option_${index}`));
    const option = normalizedOptions.find((item) => String(item?.id || '') === optionId) || null;
    if (!option) return;
    const optionAudioRef = getSingleMediaRef(option.mediaRefs, 'option_audio');
    const optionTextState = getT2ATextEligibility(option?.label ?? option?.value ?? '');
    const optionT2AKey = `${selectedBlockId}:${optionId}`;
    const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey || optionT2AInFlightKeys.has(optionT2AKey);

    const optionAudioBtn = row.querySelector('[data-option-audio-btn="1"]');
    const optionT2ABtn = row.querySelector('[data-option-t2a-btn="1"]');
    const playOptionAudioBtn = row.querySelector('[data-option-play-btn="1"]');
    const removeOptionAudioBtn = row.querySelector('[data-option-remove-audio-btn="1"]');
    const optionT2AHint = row.querySelector('[data-option-t2a-hint="1"]');
    const optionAudioAttached = row.querySelector('[data-option-audio-attached="1"]');
    const optionAudioMenuTrigger = row.querySelector('[data-option-audio-menu-trigger="1"]');
    const isPersistedOption = row.dataset.persistedOption === '1';

    setOptionAudioMenuTriggerState(optionAudioMenuTrigger, {
      hasAudio: Boolean(optionAudioRef),
      isGenerating: isOptionT2AInFlight,
      isPersisted: isPersistedOption,
    });
    if (optionAudioBtn instanceof HTMLButtonElement) {
      optionAudioBtn.disabled = !isPersistedOption || isOptionT2AInFlight;
      setMediaActionButtonContent(optionAudioBtn, 'upload', optionAudioRef ? 'Replace audio…' : 'Attach audio…');
    }
    if (optionT2ABtn instanceof HTMLButtonElement) {
      const optionT2ALabel = isOptionT2AInFlight
        ? 'Generating…'
        : optionAudioRef ? 'Regenerate audio' : 'Generate audio';
      const optionT2AIcon = isOptionT2AInFlight ? 'loading' : optionAudioRef ? 'refresh' : 'generate';
      setMediaActionButtonContent(optionT2ABtn, optionT2AIcon, optionT2ALabel);
      optionT2ABtn.disabled = !isPersistedOption || !optionTextState.eligible || isOptionT2AInFlight;
    }
    if (playOptionAudioBtn instanceof HTMLButtonElement) {
      playOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;
    }
    if (removeOptionAudioBtn instanceof HTMLButtonElement) {
      removeOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;
    }
    if (optionT2AHint instanceof HTMLElement) {
      optionT2AHint.hidden = !isPersistedOption || !optionTextState.exceedsLimit;
      optionT2AHint.textContent = optionTextState.exceedsLimit
        ? `Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters).`
        : '';
    }
    if (optionAudioAttached instanceof HTMLElement) {
      optionAudioAttached.hidden = true;
      optionAudioAttached.textContent = '';
    }
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
    const nextSignature = computeDetailSignature(selectedBlock);
    if (
      !force &&
      isOptionInputActive &&
      selectedBlock?.responseConfig?.inputType === 'multiple_choice' &&
      questionOptionsList.contains(document.activeElement) &&
      nextOptionActionSignature === optionActionSignature &&
      nextSignature === detailSignature
    ) {
      return;
    }
    if (!force && nextSignature === detailSignature) {
      return;
    }
    detailSignature = nextSignature;
    optionActionSignature = nextOptionActionSignature;
    rightPanel.innerHTML = '';
    const detailHeader = document.createElement('div');
    detailHeader.className = 'block-detail-header';
    const detailTitleGroup = document.createElement('div');
    detailTitleGroup.className = 'block-detail-header__title';
    detailTitleGroup.appendChild(rightHeading);
    const detailActions = document.createElement('div');
    detailActions.className = 'block-detail-header__actions';
    if (!selectedBlock) {
      promptT2AUiRefs = null;
      const empty = document.createElement('p');
      empty.textContent = t('editor.block.emptyState');
      detailHeader.append(detailTitleGroup);
      rightPanel.append(detailHeader);
      rightPanel.append(statusRow);
      rightPanel.appendChild(empty);
      return;
    }

    detailActions.append(
      blockKind,
      createCopyIdMenu({
        title: t('editor.block.blockIdLabel'),
        idValue: selectedBlock.blockId,
        copyLabel: t('editor.block.copyBlockId'),
        source: 'clipboard.blockId',
      })
    );
    detailHeader.append(detailTitleGroup, detailActions);
    rightPanel.append(detailHeader);
    rightPanel.append(statusRow);

    if (selectedBlock.kind === 'content') {
      promptT2AUiRefs = null;
      rightPanel.appendChild(createEditorSectionHeader({ icon: 'pencil', title: t('editor.block.contentSectionTitle') }));
      const contentLabel = document.createElement('label');
      contentLabel.textContent = t('editor.block.contentTextLabel');
      contentLabel.htmlFor = 'editor-block-editor';
      blockEditor.placeholder = t('editor.block.contentTextPlaceholder');
      rightPanel.append(contentLabel, blockEditor);
      return;
    }

    rightPanel.appendChild(createEditorSectionHeader({ icon: 'pencil', title: t('editor.block.questionSectionTitle') }));
    const promptLabel = document.createElement('label');
    promptLabel.textContent = t('editor.block.promptLabel');
    promptLabel.htmlFor = 'editor-block-editor';
    blockEditor.placeholder = t('editor.block.promptPlaceholder');
    rightPanel.append(promptLabel, blockEditor);

    const promptMediaRefs = normalizeMediaRefs(selectedBlock?.prompt?.mediaRefs);
    const currentQuestionImageRef = getSingleMediaRef(promptMediaRefs, 'question_image');
    const currentQuestionAudioRef = getSingleMediaRef(promptMediaRefs, 'question_audio');

    const mediaSection = document.createElement('section');
    mediaSection.className = 'editor-detail-section media-section';
    mediaSection.appendChild(createEditorSectionHeader({ icon: 'image', title: t('editor.block.promptMediaTitle') }));
    const mediaRows = document.createElement('div');
    mediaRows.className = 'media-row-list';
    const questionImageRow = document.createElement('div');
    questionImageRow.className = 'media-row';
    const questionImageMeta = document.createElement('div');
    questionImageMeta.className = 'media-row__meta';
    const questionImageLabel = document.createElement('span');
    questionImageLabel.className = 'media-row__title';
    questionImageLabel.textContent = t('editor.block.promptImageLabel');
    questionImageMeta.appendChild(questionImageLabel);
    if (currentQuestionImageRef) {
      questionImageMeta.appendChild(createCopyIdMenu({
        triggerKind: 'badge',
        triggerText: t('editor.block.attachedBadge'),
        title: t('editor.block.promptImageAssetId'),
        idValue: currentQuestionImageRef.assetId,
        copyLabel: t('editor.block.copyAssetId'),
        source: 'clipboard.imageAssetId',
      }));
    } else {
      const emptyImageBadge = document.createElement('span');
      emptyImageBadge.className = 'asset-status-badge asset-status-badge--empty';
      emptyImageBadge.textContent = t('common.values.none');
      questionImageMeta.appendChild(emptyImageBadge);
    }
    const questionImageActions = document.createElement('div');
    questionImageActions.className = 'media-row__actions';
    const attachImageBtn = document.createElement('button');
    attachImageBtn.type = 'button';
    attachImageBtn.className = 'media-action-btn';
    setMediaActionButtonContent(attachImageBtn, 'image', currentQuestionImageRef ? 'Replace' : 'Attach');
    const removeImageBtn = document.createElement('button');
    removeImageBtn.type = 'button';
    removeImageBtn.className = 'media-action-btn media-action-btn--remove';
    setMediaActionButtonContent(removeImageBtn, 'trash', 'Remove');
    removeImageBtn.disabled = !currentQuestionImageRef;
    const viewImageBtn = document.createElement('button');
    viewImageBtn.type = 'button';
    viewImageBtn.className = 'media-action-btn';
    setMediaActionButtonContent(viewImageBtn, 'eye', 'View');
    viewImageBtn.disabled = !currentQuestionImageRef;
    attachImageBtn.addEventListener('click', () => {
      questionImageInput.dataset.blockId = selectedBlock.blockId;
      questionImageInput.value = '';
      questionImageInput.click();
    });
    removeImageBtn.addEventListener('click', async () => {
      await runMediaAction(async () => {
        const confirmed = await confirmDangerAction({
          title: 'Remove question image?',
          bodyText: 'This will remove the current question image attachment.',
          confirmLabel: 'Remove image',
          removalItems: ['Current image file attachment for this question.'],
        });
        if (!confirmed) return;
        const result = await session.removeQuestionMedia(selectedBlock.blockId, 'question_image', { confirmRemove: true });
        if (!result.ok && result.reason !== 'confirm-remove-required') {
          updateSummary();
        } else if (result.ok) {
          updateSummary();
        }
      });
    });
    viewImageBtn.addEventListener('click', async () => {
      if (!currentQuestionImageRef?.assetId) return;
      await session.openAssetImage(currentQuestionImageRef.assetId);
      updateSummary();
    });
    questionImageActions.append(attachImageBtn, viewImageBtn, removeImageBtn);
    questionImageRow.append(questionImageMeta, questionImageActions);

    const questionAudioRow = document.createElement('div');
    questionAudioRow.className = 'media-row';
    const questionAudioMeta = document.createElement('div');
    questionAudioMeta.className = 'media-row__meta';
    const questionAudioLabel = document.createElement('span');
    questionAudioLabel.className = 'media-row__title';
    questionAudioLabel.textContent = t('editor.block.promptAudioLabel');
    questionAudioMeta.appendChild(questionAudioLabel);
    if (currentQuestionAudioRef) {
      questionAudioMeta.appendChild(createCopyIdMenu({
        triggerKind: 'badge',
        triggerText: t('editor.block.attachedBadge'),
        title: t('editor.block.promptAudioAssetId'),
        idValue: currentQuestionAudioRef.assetId,
        copyLabel: t('editor.block.copyAssetId'),
        source: 'clipboard.audioAssetId',
      }));
    } else {
      const emptyAudioBadge = document.createElement('span');
      emptyAudioBadge.className = 'asset-status-badge asset-status-badge--empty';
      emptyAudioBadge.textContent = t('common.values.none');
      questionAudioMeta.appendChild(emptyAudioBadge);
    }
    const questionAudioActions = document.createElement('div');
    questionAudioActions.className = 'media-row__actions';
    const promptTextState = getT2ATextEligibility(selectedBlock?.prompt?.text || '');
    const promptExceedsT2ALimit = promptTextState.exceedsLimit;
    const promptT2AEligible = promptTextState.eligible;
    const isPromptT2AInFlight = promptT2AInFlightBlockIds.has(selectedBlock.blockId)
      || promptT2AInFlightBlockId === selectedBlock.blockId;
    const attachQuestionAudioBtn = document.createElement('button');
    attachQuestionAudioBtn.type = 'button';
    attachQuestionAudioBtn.className = 'media-action-btn';
    setMediaActionButtonContent(attachQuestionAudioBtn, 'upload', currentQuestionAudioRef ? 'Replace' : 'Attach');
    const removeQuestionAudioBtn = document.createElement('button');
    removeQuestionAudioBtn.type = 'button';
    removeQuestionAudioBtn.className = 'media-action-btn media-action-btn--remove';
    setMediaActionButtonContent(removeQuestionAudioBtn, 'trash', 'Remove');
    removeQuestionAudioBtn.disabled = !currentQuestionAudioRef;
    const playQuestionAudioBtn = document.createElement('button');
    playQuestionAudioBtn.type = 'button';
    playQuestionAudioBtn.className = 'media-action-btn';
    setMediaActionButtonContent(playQuestionAudioBtn, 'play', 'Play');
    playQuestionAudioBtn.disabled = !currentQuestionAudioRef;
    const generateQuestionAudioBtn = document.createElement('button');
    generateQuestionAudioBtn.type = 'button';
    generateQuestionAudioBtn.className = 'media-action-btn';
    setMediaActionButtonContent(
      generateQuestionAudioBtn,
      isPromptT2AInFlight ? 'loading' : currentQuestionAudioRef ? 'refresh' : 'generate',
      isPromptT2AInFlight ? 'Generating…' : currentQuestionAudioRef ? 'Regenerate' : 'Generate'
    );
    generateQuestionAudioBtn.disabled = !promptT2AEligible || isPromptT2AInFlight;
    const questionAudioHint = document.createElement('p');
    questionAudioHint.className = 'muted';
    questionAudioHint.textContent = promptExceedsT2ALimit
      ? `Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters).`
      : '';
    if (!promptExceedsT2ALimit) {
      questionAudioHint.hidden = true;
    }
    if (isPromptT2AInFlight) {
      attachQuestionAudioBtn.disabled = true;
      playQuestionAudioBtn.disabled = true;
      removeQuestionAudioBtn.disabled = true;
    }
    promptT2AUiRefs = {
      blockId: selectedBlock.blockId,
      attachBtn: attachQuestionAudioBtn,
      generateBtn: generateQuestionAudioBtn,
      playBtn: playQuestionAudioBtn,
      removeBtn: removeQuestionAudioBtn,
      hint: questionAudioHint,
    };
    attachQuestionAudioBtn.addEventListener('click', () => {
      questionAudioInput.dataset.blockId = selectedBlock.blockId;
      questionAudioInput.value = '';
      questionAudioInput.click();
    });
    removeQuestionAudioBtn.addEventListener('click', async () => {
      await runMediaAction(async () => {
        const confirmed = await confirmDangerAction({
          title: 'Remove question audio?',
          bodyText: 'This will remove the current question audio attachment.',
          confirmLabel: 'Remove audio',
          removalItems: ['Current audio file attachment for this question.'],
        });
        if (!confirmed) return;
        const result = await session.removeQuestionMedia(selectedBlock.blockId, 'question_audio', { confirmRemove: true });
        if (result.ok || result.reason !== 'confirm-remove-required') {
          updateSummary();
        }
      });
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
    generateQuestionAudioBtn.addEventListener('click', async () => {
      const latestBlock = session.state.draft?.blocks?.find((block) => block.blockId === selectedBlock.blockId);
      const latestPromptState = getT2ATextEligibility(latestBlock?.prompt?.text || '');
      if (!latestPromptState.eligible || promptT2AInFlightBlockIds.has(selectedBlock.blockId)) return;
      const sessionReady = await session.ensureServerSessionReady();
      if (!sessionReady.ok) {
        return;
      }
      promptT2AInFlightBlockIds.add(selectedBlock.blockId);
      promptT2AInFlightBlockId = selectedBlock.blockId;
      updateSummary();
      if (currentQuestionAudioRef) {
        const confirmed = await confirmDangerAction({
          title: 'Regenerate question audio?',
          bodyText: 'Regenerating will discard the currently attached question audio.',
          confirmLabel: 'Regenerate audio',
          removalItems: ['Current audio file attachment for this question.'],
        });
        if (!confirmed) {
          promptT2AInFlightBlockIds.delete(selectedBlock.blockId);
          restoreLegacyPromptInFlightMarker();
          session.setMediaFeedback('Audio regeneration canceled.');
          updateSummary();
          return;
        }
      }

      try {
        const result = await session.triggerProtectedAction('editorPromptT2A', {
          blockId: selectedBlock.blockId,
          target: 'question_prompt',
          localDraftId: session.state.draft?.localId || null,
        });
        const status = String(result?.status || '').trim();
        if (status !== 'executed' && status !== 'redirected' && result?.ok !== true) {
          session.pushNotification({
            kind: 'error',
            category: 'editor',
            source: 'prompt.t2a',
            text: getProtectedActionErrorMessage(result, 'Unable to start audio generation. Please try again.'),
          });
          session.notifyStateChange();
        }
      } catch (error) {
        const detail = String(error?.message || '').trim();
        const text = detail
          ? `Audio generation failed. Existing audio is unchanged. ${detail}`
          : 'Audio generation failed. Existing audio is unchanged.';
        session.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'prompt.t2a',
          text,
        });
        session.notifyStateChange();
      } finally {
        promptT2AInFlightBlockIds.delete(selectedBlock.blockId);
        restoreLegacyPromptInFlightMarker();
        updateSummary();
      }
    });
    questionAudioActions.append(attachQuestionAudioBtn, generateQuestionAudioBtn, playQuestionAudioBtn, removeQuestionAudioBtn);
    questionAudioRow.append(questionAudioMeta, questionAudioActions);
    mediaRows.append(questionImageRow, questionAudioRow);
    mediaSection.append(mediaRows, questionAudioHint, mediaFeedback);
    rightPanel.appendChild(mediaSection);

    const answerSection = document.createElement('section');
    answerSection.className = 'editor-detail-section answer-section';
    answerSection.appendChild(createEditorSectionHeader({ icon: 'list', title: t('editor.question.answerSectionTitle') }));
    const answerGrid = document.createElement('div');
    answerGrid.className = 'answer-grid';
    const inputTypeLabel = document.createElement('label');
    inputTypeLabel.textContent = t('editor.question.answerInputType');
    inputTypeLabel.htmlFor = 'editor-question-input-type';
    const inputTypeField = document.createElement('div');
    inputTypeField.className = 'editor-field';
    inputTypeField.append(inputTypeLabel, questionInputType);
    answerGrid.appendChild(inputTypeField);

    const activeInputType = selectedBlock.responseConfig?.inputType || 'text';
    if (activeInputType === 'multiple_choice') {
      const selectionModeLabel = document.createElement('label');
      selectionModeLabel.textContent = t('editor.question.selectionMode');
      selectionModeLabel.htmlFor = 'editor-question-selection-mode';
      const selectionModeField = document.createElement('div');
      selectionModeField.className = 'editor-field';
      selectionModeField.append(selectionModeLabel, questionSelectionMode);
      answerGrid.appendChild(selectionModeField);
    }
    answerSection.appendChild(answerGrid);
    if (TEXT_INPUT_TYPES.has(activeInputType)) {
      const textSettingsRow = document.createElement('div');
      textSettingsRow.className = 'text-answer-settings';
      const maxLengthField = document.createElement('div');
      maxLengthField.className = 'editor-field';
      const maxLengthLabel = document.createElement('label');
      maxLengthLabel.textContent = t('editor.question.maxLength');
      maxLengthLabel.htmlFor = 'editor-question-max-length';
      maxLengthField.append(maxLengthLabel, questionMaxLength);

      const displayModeField = document.createElement('div');
      displayModeField.className = 'editor-field';
      const displayModeLabel = document.createElement('label');
      displayModeLabel.id = 'editor-question-text-display-mode-label';
      displayModeLabel.textContent = t('editor.question.responseFormat');
      displayModeField.append(displayModeLabel, questionTextDisplayMode);
      textSettingsRow.append(maxLengthField, displayModeField);
      answerSection.appendChild(textSettingsRow);
    }

    if (activeInputType === 'number') {
      const minLabel = document.createElement('label');
      minLabel.textContent = t('editor.question.min');
      minLabel.htmlFor = 'editor-question-min';
      const minField = document.createElement('div');
      minField.className = 'editor-field';
      minField.append(minLabel, questionMin, questionMinError);
      const maxLabel = document.createElement('label');
      maxLabel.textContent = t('editor.question.max');
      maxLabel.htmlFor = 'editor-question-max';
      const maxField = document.createElement('div');
      maxField.className = 'editor-field';
      maxField.append(maxLabel, questionMax, questionMaxError);
      const rangeRow = document.createElement('div');
      rangeRow.className = 'number-answer-range';
      rangeRow.append(minField, maxField);
      answerSection.append(rangeRow);

      const rulesRow = document.createElement('div');
      rulesRow.className = 'number-answer-rules';
      const signedField = document.createElement('div');
      signedField.className = 'editor-field number-answer-signed-field';
      const signedRow = document.createElement('div');
      signedRow.className = 'inline-toggle inline-toggle--custom';
      const signedText = document.createElement('span');
      signedText.textContent = t('editor.question.allowSignedValues');
      signedRow.append(questionNumberAllowSignedToggle, questionNumberAllowSigned, signedText);
      signedField.append(signedRow);

      const decimalPlacesField = document.createElement('div');
      decimalPlacesField.className = 'editor-field';
      const decimalPlacesLabel = document.createElement('label');
      decimalPlacesLabel.textContent = t('editor.question.decimalPlaces');
      decimalPlacesLabel.htmlFor = 'editor-question-number-decimal-places-allowed';
      const decimalPlacesHint = document.createElement('p');
      decimalPlacesHint.className = 'muted number-answer-hint';
      decimalPlacesHint.textContent = t('editor.question.decimalPlacesHint');
      decimalPlacesField.append(
        decimalPlacesLabel,
        questionNumberDecimalPlacesAllowed,
        decimalPlacesHint,
        questionNumberDecimalPlacesAllowedError
      );
      rulesRow.append(signedField, decimalPlacesField);
      answerSection.append(rulesRow);

      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.textContent = t('editor.question.correctAnswer');
      correctAnswerLabel.htmlFor = 'editor-question-correct-answer-number';
      answerSection.append(correctAnswerLabel, questionCorrectAnswerNumber, questionCorrectAnswerNumberError);
    }

    if (activeInputType === 'boolean') {
      const correctAnswerLabel = document.createElement('label');
      correctAnswerLabel.id = 'editor-question-correct-answer-boolean-label';
      correctAnswerLabel.textContent = t('editor.question.correctAnswer');
      answerSection.append(correctAnswerLabel, questionCorrectAnswerBoolean);
    }

    if (activeInputType !== 'multiple_choice') {
      rightPanel.appendChild(answerSection);
    }

    if (activeInputType === 'multiple_choice') {
      const shuffleRow = document.createElement('div');
      shuffleRow.className = 'inline-toggle inline-toggle--custom';
      const shuffleText = document.createElement('span');
      shuffleText.textContent = t('editor.question.shuffleOptions');
      shuffleRow.append(questionShuffleToggle, questionShuffleOptions, shuffleText);
      answerSection.append(shuffleRow);

      rightPanel.appendChild(answerSection);
      rightPanel.appendChild(createEditorSectionHeader({ icon: 'list', title: t('editor.option.sectionTitle') }));

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
        const optionDisplayText = String(option?.label ?? option?.value ?? '');
        const optionTextState = getT2ATextEligibility(optionDisplayText);
        const isPersistedOption = persistedOptionIds.has(optionId);
        const optionTextExceedsT2ALimit = optionTextState.exceedsLimit;
        const optionTextEligibleForT2A = optionTextState.eligible;
        const optionT2AKey = `${selectedBlock.blockId}:${optionId}`;
        const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey || optionT2AInFlightKeys.has(optionT2AKey);
        const row = document.createElement('div');
        row.className = 'option-row';
        row.dataset.persistedOption = isPersistedOption ? '1' : '0';
        row.dataset.optionId = optionId;

        const isSelected = isMultiSelect
          ? selectedOptionIds.has(optionId)
          : hasSelectedSingleOptionId && selectedSingleOptionId === optionId;
        const correctToggle = document.createElement('button');
        correctToggle.type = 'button';
        correctToggle.className = 'option-correct-toggle';
        correctToggle.title = isMultiSelect
          ? t('editor.option.includeInCorrectAnswers')
          : t('editor.option.markAsCorrectAnswer');
        correctToggle.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        correctToggle.setAttribute(
          'aria-label',
          isMultiSelect
            ? t('editor.option.toggleCorrectAnswerAriaLabelMulti', { index: optionIndex + 1 })
            : t('editor.option.toggleCorrectAnswerAriaLabelSingle', { index: optionIndex + 1 })
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
        tickIcon.innerHTML = createEditorIcon('check');
        correctToggle.appendChild(tickIcon);

        const optionInput = document.createElement('input');
        optionInput.type = 'text';
        optionInput.dataset.optionInput = '1';
        optionInput.dataset.optionIndex = String(optionIndex);
        optionInput.className = 'control';
        optionInput.placeholder = t('editor.option.placeholder', { index: optionIndex + 1 });
        optionInput.value = String(option?.label ?? option?.value ?? '');
        let isOptionInputComposing = false;
        const commitOptionInputValue = () => {
          session.updateQuestionOptionAtIndex(selectedBlock.blockId, optionIndex, optionInput.value);
          refreshOptionRowT2AControls(selectedBlock.blockId, optionId, row);
          updateSummary({ preserveDetailEditor: true });
        };
        optionInput.addEventListener('compositionstart', () => {
          isOptionInputComposing = true;
        });
        optionInput.addEventListener('compositionend', () => {
          isOptionInputComposing = false;
          commitOptionInputValue();
        });
        optionInput.addEventListener('input', (event) => {
          if (isOptionInputComposing || event.isComposing) return;
          commitOptionInputValue();
        });
        const optionAudioRef = getSingleMediaRef(option.mediaRefs, 'option_audio');
        const optionActionsMenu = document.createElement('details');
        optionActionsMenu.className = 'option-actions-menu option-audio-menu';
        const optionAudioMenuTrigger = document.createElement('summary');
        optionAudioMenuTrigger.className = 'icon-btn option-actions-menu__toggle option-audio-menu__toggle';
        optionAudioMenuTrigger.dataset.optionAudioMenuTrigger = '1';
        optionAudioMenuTrigger.setAttribute('role', 'button');
        setOptionAudioMenuTriggerState(optionAudioMenuTrigger, {
          hasAudio: Boolean(optionAudioRef),
          isGenerating: isOptionT2AInFlight,
          isPersisted: isPersistedOption,
        });
        const optionActionsRow = document.createElement('div');
        optionActionsRow.className = 'option-actions-menu__list option-audio-menu__list';

        const optionAudioBtn = document.createElement('button');
        optionAudioBtn.type = 'button';
        optionAudioBtn.className = 'media-action-btn option-actions-menu__item';
        optionAudioBtn.dataset.optionAudioBtn = '1';
        setMediaActionButtonContent(optionAudioBtn, 'upload', optionAudioRef ? 'Replace audio…' : 'Attach audio…');
        optionAudioBtn.title = isPersistedOption
          ? optionAudioRef ? 'Replace option audio' : 'Attach option audio'
          : 'Enter option text or click Add option before attaching audio';
        optionAudioBtn.disabled = !isPersistedOption || isOptionT2AInFlight;
        optionAudioBtn.addEventListener('click', () => {
          if (!isPersistedOption) {
            session.setMediaFeedback('Enter option text or click Add option before attaching audio.');
            updateSummary();
            return;
          }
          pendingOptionAudioTarget = { blockId: selectedBlock.blockId, optionId };
          optionAudioInput.value = '';
          optionAudioInput.click();
        });
        const removeOptionAudioBtn = document.createElement('button');
        removeOptionAudioBtn.type = 'button';
        removeOptionAudioBtn.className = 'media-action-btn media-action-btn--remove option-actions-menu__item';
        removeOptionAudioBtn.dataset.optionRemoveAudioBtn = '1';
        setMediaActionButtonContent(removeOptionAudioBtn, 'trash', 'Remove audio');
        removeOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;
        removeOptionAudioBtn.addEventListener('click', async () => {
          await runMediaAction(async () => {
            const confirmed = await confirmDangerAction({
              title: `Remove option ${optionIndex + 1} audio?`,
              bodyText: `This will remove the audio attachment for option ${optionIndex + 1}.`,
              confirmLabel: 'Remove audio',
              removalItems: ['Current audio file attachment for this option.'],
            });
            if (!confirmed) return;
            const result = await session.removeOptionAudio(selectedBlock.blockId, optionId, { confirmRemove: true });
            if (result.ok || result.reason !== 'confirm-remove-required') {
              updateSummary();
            }
          });
        });
        const playOptionAudioBtn = document.createElement('button');
        playOptionAudioBtn.type = 'button';
        playOptionAudioBtn.className = 'media-action-btn option-actions-menu__item';
        playOptionAudioBtn.dataset.optionPlayBtn = '1';
        setMediaActionButtonContent(playOptionAudioBtn, 'play', 'Play audio');
        playOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;
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
          updateSummary();
        });
        const optionT2ABtn = document.createElement('button');
        optionT2ABtn.type = 'button';
        optionT2ABtn.className = 'media-action-btn option-actions-menu__item';
        optionT2ABtn.dataset.optionT2aBtn = '1';
        const optionT2ALabel = isOptionT2AInFlight
          ? 'Generating…'
          : optionAudioRef ? 'Regenerate audio' : 'Generate audio';
        setMediaActionButtonContent(
          optionT2ABtn,
          isOptionT2AInFlight ? 'loading' : optionAudioRef ? 'refresh' : 'generate',
          optionT2ALabel
        );
        optionT2ABtn.disabled = !isPersistedOption || !optionTextEligibleForT2A || isOptionT2AInFlight;
        optionT2ABtn.addEventListener('click', async () => {
          if (!isPersistedOption) {
            session.setMediaFeedback('Enter option text or click Add option before attaching audio.');
            updateSummary();
            return;
          }
          const latestBlock = session.state.draft?.blocks?.find((block) => block.blockId === selectedBlock.blockId);
          const latestResponseConfig = normalizeQuestionResponseConfig(latestBlock?.responseConfig);
          const latestOptions = (latestResponseConfig.options || []).map((item, index) =>
            normalizeResponseOption(item, `option_${index}`));
          const latestOption = latestOptions.find((item) => String(item?.id || '') === optionId) || null;
          const latestOptionTextState = getT2ATextEligibility(latestOption?.label ?? latestOption?.value ?? '');
          if (!latestOptionTextState.eligible || optionT2AInFlightKeys.has(optionT2AKey)) return;
          const sessionReady = await session.ensureServerSessionReady();
          if (!sessionReady.ok) {
            return;
          }
          optionT2AInFlightKeys.add(optionT2AKey);
          optionT2AInFlightKey = optionT2AKey;
          updateSummary();
          if (optionAudioRef) {
            const confirmed = await confirmDangerAction({
              title: `Regenerate option ${optionIndex + 1} audio?`,
              bodyText: `Regenerating will discard the current audio attachment for option ${optionIndex + 1}.`,
              confirmLabel: 'Regenerate audio',
              removalItems: ['Current audio file attachment for this option.'],
            });
            if (!confirmed) {
              optionT2AInFlightKeys.delete(optionT2AKey);
              restoreLegacyOptionInFlightMarker();
              session.setMediaFeedback('Option audio regeneration canceled.');
              updateSummary();
              return;
            }
          }
          try {
            const result = await session.triggerProtectedAction('editorOptionT2A', {
              blockId: selectedBlock.blockId,
              optionId,
              target: 'option',
              localDraftId: session.state.draft?.localId || null,
            });
            const status = String(result?.status || '').trim();
            if (status !== 'executed' && status !== 'redirected' && result?.ok !== true) {
              session.pushNotification({
                kind: 'error',
                category: 'editor',
                source: 'option.t2a',
                text: getProtectedActionErrorMessage(result, 'Unable to start audio generation. Please try again.'),
              });
              session.notifyStateChange();
            }
          } catch (error) {
            const detail = String(error?.message || '').trim();
            const text = detail
              ? `Audio generation failed. Existing audio is unchanged. ${detail}`
              : 'Audio generation failed. Existing audio is unchanged.';
            session.pushNotification({
              kind: 'error',
              category: 'editor',
              source: 'option.t2a',
              text,
            });
            session.notifyStateChange();
          } finally {
            optionT2AInFlightKeys.delete(optionT2AKey);
            restoreLegacyOptionInFlightMarker();
            updateSummary();
          }
        });
        optionActionsRow.append(optionAudioBtn, optionT2ABtn, playOptionAudioBtn, removeOptionAudioBtn);
        optionActionsMenu.append(optionAudioMenuTrigger, optionActionsRow);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn danger';
        removeBtn.title = 'Delete this option';
        removeBtn.setAttribute('aria-label', `Delete option ${optionIndex + 1}`);
        setIconButtonContent(removeBtn, 'trash');
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
        const optionT2AHint = document.createElement('span');
        optionT2AHint.className = 'muted option-row__meta';
        optionT2AHint.dataset.optionT2aHint = '1';
        optionT2AHint.textContent = optionTextExceedsT2ALimit
          ? `Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters).`
          : '';
        optionT2AHint.hidden = !isPersistedOption || !optionTextExceedsT2ALimit;
        row.appendChild(optionT2AHint);
        const optionAudioAttached = document.createElement('span');
        optionAudioAttached.className = 'muted option-row__meta';
        optionAudioAttached.dataset.optionAudioAttached = '1';
        optionAudioAttached.hidden = true;
        row.appendChild(optionAudioAttached);
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

  function renderUploadedDraftRows(container) {
    const serverReady = session.state.serverSession?.status === 'ready';
    container.innerHTML = '';
    if (session.state.uploadedDrafts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = session.state.isLoadingUploadedDrafts
        ? t('editor.uploadedDraft.loading')
        : t('editor.uploadedDraft.empty');
      container.appendChild(empty);
      return;
    }
    session.state.uploadedDrafts.forEach((item) => {
      const display = toUploadedDraftDisplay(item);
      const row = document.createElement('div');
      row.className = 'uploaded-draft-row';
      const meta = document.createElement('div');
      meta.className = 'uploaded-draft-meta';
      const titleLine = document.createElement('strong');
      titleLine.textContent = display.title;
      const uploadedAtLine = document.createElement('div');
      uploadedAtLine.className = 'muted uploaded-draft-uploaded-at';
      uploadedAtLine.textContent = display.uploadedLabel;
      const subjectLine = document.createElement('div');
      subjectLine.className = 'muted uploaded-draft-uploaded-at';
      subjectLine.textContent = t('common.meta.subject', { value: item.subject || '-' });
      meta.append(titleLine, subjectLine, uploadedAtLine);
      const publishedPackageId = isNonEmptyString(item.published_package_id) ? item.published_package_id : null;
      const publishState = normalizeDraftPublishState(item);
      const badgeConfig = getUploadedDraftPublishBadge(item);
      const badge = document.createElement('span');
      badge.className = badgeConfig.className;
      badge.textContent = badgeConfig.text;
      meta.appendChild(badge);
      const details = document.createElement('details');
      details.className = 'uploaded-draft-details uploaded-draft-details--draft';
      const summary = document.createElement('summary');
      summary.textContent = t('common.sections.details');
      const body = document.createElement('div');
      body.className = 'muted uploaded-draft-details-body';
      const draftIdLine = document.createElement('div');
      draftIdLine.textContent = t('editor.uploadedDraft.metaDraftId', { value: item.uploaded_draft_id || '-' });
      const publishedIdLine = document.createElement('div');
      publishedIdLine.textContent = t('editor.uploadedDraft.metaPublishedId', { value: publishedPackageId || '-' });
      const publishStateLine = document.createElement('div');
      publishStateLine.textContent = t('editor.uploadedDraft.metaPublishState', { value: publishState });
      body.append(draftIdLine, publishedIdLine, publishStateLine);
      if (badgeConfig.helperText) {
        const helperLine = document.createElement('div');
        helperLine.textContent = badgeConfig.helperText;
        body.appendChild(helperLine);
      }
      details.append(summary, body);
      meta.appendChild(details);
      const actions = document.createElement('div');
      actions.className = 'uploaded-draft-actions';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
      openBtn.textContent = t('common.actions.open');
      openBtn.disabled = !serverReady;
      openBtn.addEventListener('click', async () => {
        await guardServerMenuAction(openBtn, () => session.reopenUploadedDraftAsLocalCopy(item.uploaded_draft_id));
        updateSummary();
      });
      actions.appendChild(openBtn);
      if (publishedPackageId) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
        copyBtn.textContent = t('editor.published.copyViewerLink');
        copyBtn.disabled = !serverReady;
        copyBtn.addEventListener('click', async () => {
          const copied = await copyTextToClipboard(buildPublishedPackageViewerUrl(publishedPackageId));
          emitServerNotification({
            kind: copied ? 'success' : 'warn',
            source: 'clipboard.publishedViewerLink',
            text: copied ? t('editor.notifications.viewerLinkCopied') : t('common.clipboard.unavailable'),
          });
        });
        actions.appendChild(copyBtn);
      }

      if (publishState !== 'current_version_published') {
        const isPublishing = session.state.publishingDraftIds.has(item.uploaded_draft_id);
        const publishBtn = document.createElement('button');
        publishBtn.type = 'button';
        publishBtn.className = 'uploaded-draft-action uploaded-draft-action--primary';
        publishBtn.textContent = isPublishing
          ? t('editor.uploadedDraft.publishing')
          : publishState === 'unpublished_changes'
            ? t('editor.uploadedDraft.publishNewVersion')
            : t('common.actions.publish');
        publishBtn.disabled = !serverReady || isPublishing;
        publishBtn.addEventListener('click', async () => {
          if (session.state.publishingDraftIds.has(item.uploaded_draft_id)) return;
          await guardServerMenuAction(publishBtn, async () => {
            let attemptedTitle = String(item?.title || '');
            let attemptedSubject = String(item?.subject || '');
            while (true) {
              const modal = await showPublishModal({
                uploadedDraft: item,
                initialTitle: attemptedTitle,
                initialSubject: attemptedSubject,
              });
              if (!modal.confirmed) return null;
              attemptedTitle = String(modal.title ?? '');
              attemptedSubject = String(modal.subject ?? '');
              const result = await session.publishUploadedDraftToServer(item.uploaded_draft_id, {
                title: attemptedTitle,
                subject: attemptedSubject,
              });
              if (result?.ok || result?.error?.code !== 'PUBLISHED_PACKAGE_CONFLICT') return result;
              const conflictAction = await showPublishedPackageConflictModal();
              if (conflictAction?.action !== 'edit') return result;
            }
          });
          updateSummary();
        });
        actions.appendChild(publishBtn);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'uploaded-draft-action uploaded-draft-action--danger';
      deleteBtn.textContent = t('common.actions.delete');
      deleteBtn.disabled = !serverReady;
      deleteBtn.addEventListener('click', async () => {
        await guardServerMenuAction(deleteBtn, async () => {
          const confirmed = await showConfirmDialog({
            title: t('editor.uploadedDraft.deleteDialog.title'),
            entityLabel: isNonEmptyString(item.title) ? item.title.trim() : t('common.values.untitled'),
            descriptionText: publishedPackageId
              ? t('editor.uploadedDraft.deleteDialog.publishedDescription')
              : t('editor.uploadedDraft.deleteDialog.draftDescription'),
            removalItems: [t('editor.uploadedDraft.deleteDialog.removeArtifact'), t('editor.uploadedDraft.deleteDialog.removeMetadata')],
            confirmLabel: t('editor.uploadedDraft.deleteDialog.confirm'),
          });
          if (!confirmed) return null;
          return session.deleteUploadedDraft(item.uploaded_draft_id);
        });
        updateSummary();
      });
      actions.appendChild(deleteBtn);
      row.append(meta, actions);
      container.appendChild(row);
    });
  }

  function renderManageUploadedDraftsModal() {
    manageUploadedDraftsModalRoot.innerHTML = '';
    if (!manageUploadedDraftsDialogOpen) return;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal browse-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = t('editor.uploadedDraft.manage');
    const slotUsage = document.createElement('p');
    slotUsage.className = 'confirm-modal__description';
    const slotLimit = Number(session.state.uploadedDraftSlotLimit) || 3;
    slotUsage.textContent = t('editor.uploadedDraft.slotUsage', {
      used: session.state.uploadedDrafts.length,
      limit: slotLimit,
    });
    const list = document.createElement('div');
    list.className = 'browse-results';
    renderUploadedDraftRows(list);
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'confirm-modal__btn';
    refreshBtn.textContent = session.state.isLoadingUploadedDrafts ? t('common.actions.refreshing') : t('common.actions.refresh');
    refreshBtn.disabled = session.state.isLoadingUploadedDrafts;
    refreshBtn.addEventListener('click', async () => {
      await session.loadUploadedDrafts({ preflight: false });
      renderManageUploadedDraftsModal();
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'confirm-modal__btn';
    closeBtn.textContent = t('common.actions.close');
    closeBtn.addEventListener('click', () => {
      manageUploadedDraftsDialogOpen = false;
      renderManageUploadedDraftsModal();
    });
    actions.append(refreshBtn, closeBtn);
    dialog.append(heading, slotUsage, list, actions);
    overlay.appendChild(dialog);
    manageUploadedDraftsModalRoot.appendChild(overlay);
    closeBtn.focus();
  }

  const updateSummary = ({ preserveDetailEditor = false } = {}) => {
    session.pruneExpiredNotifications();
    session.validateCurrentDraft();
    syncFormControls();
    renderBlockList();
    if (!preserveDetailEditor) {
      renderDetailEditor();
    }

    const saveState = session.state.lastPersistenceError
      ? 'Save error'
      : session.state.autosavePending
        ? 'Saving…'
        : session.state.lastValidationWarning
          ? 'Saved (warnings)'
        : 'Saved';

    const isSaved = saveState === 'Saved';
    saveStateEl.innerHTML = `<span class="editor-pill ${isSaved ? 'editor-pill--ok' : 'editor-pill--warn'}">${createEditorIcon('check')}${isSaved ? 'Saved' : saveState}</span>`;
    saveStateEl.title = session.state.lastPersistenceError || session.state.lastValidationWarning || '';
    const lastSavedLabel = document.createElement('span');
    lastSavedLabel.className = 'editor-label';
    lastSavedLabel.textContent = t('editor.labels.lastSaved');
    lastSavedEl.replaceChildren(lastSavedLabel, document.createTextNode(` ${formatLastSavedLabel(session.state.lastSavedAt)}`));
    const validationIssues = session.state.lastSavedLocalValidationIssueCount + session.state.lastContractValidationIssueCount;
    validationEl.innerHTML = `<span class="editor-pill ${validationIssues > 0 ? 'editor-pill--warn' : 'editor-pill--ok'}">${createEditorIcon('shield')}${validationIssues} issue${validationIssues === 1 ? '' : 's'}</span>`;
    const validationTooltip = [];
    if (session.state.lastValidationWarning) {
      validationTooltip.push(session.state.lastValidationWarning);
    }
    if (session.state.validationErrors.length > 0) {
      validationTooltip.push(...session.state.validationErrors);
    }
    validationEl.title = validationIssues > 0 ? validationTooltip.join('\n') : '';
    localDraftIdValue.textContent = session.state.draft?.localId || t('common.values.na');
    statusRow.textContent = t('editor.status.selectedBlock', {
      value: session.state.selectedBlockId || t('common.values.noneLowercase'),
    });
    const renderNotification = (element, categories) => {
      const notification = session.getLatestNotification({ categories });
      element.textContent = notification?.text || '';
      if (notification?.kind) {
        element.dataset.notificationKind = notification.kind;
      } else {
        delete element.dataset.notificationKind;
      }
    };

    renderNotification(mediaFeedback, ['media']);
    const sessionStatus = session.state.serverSession?.status || 'checking';
    const userLabel = session.state.serverSession?.user?.email || session.state.serverSession?.user?.sub || 'unknown';
    if (sessionStatus === 'ready') {
      serverSessionStatus.textContent = `Server session: ready (${userLabel})`;
    } else if (sessionStatus === 'checking') {
      serverSessionStatus.textContent = 'Server session: checking…';
    } else {
      serverSessionStatus.textContent = `Server session: not ready. ${session.state.serverSession?.error || 'Sign in for server features.'}`;
    }
    const isUploadingDraft = session.state.isUploadingDraft;
    const isUploadDraftFlowActive = session.state.isUploadDraftFlowActive;
    const isRefreshingUploadedDrafts = session.state.isLoadingUploadedDrafts;
    const activePublishCount = session.state.publishingDraftIds?.size || 0;

    const totalActivity = Array.isArray(session.state.activityLog) ? session.state.activityLog.length : 0;
    visibleActivityCount = Math.min(
      Math.max(ACTIVITY_VISIBLE_INITIAL, visibleActivityCount),
      Math.max(totalActivity, ACTIVITY_VISIBLE_INITIAL)
    );
    const feedNotifications = (Array.isArray(session.state.activityLog) ? session.state.activityLog : [])
      .slice(-visibleActivityCount)
      .reverse();
    activityFeedList.innerHTML = '';
    activityFeedSummary.textContent = totalActivity > 0
      ? `Showing ${Math.min(visibleActivityCount, totalActivity)} of ${totalActivity} recent activities.`
      : 'Showing 0 of 0 recent activities.';
    if (feedNotifications.length === 0) {
      const emptyFeed = document.createElement('p');
      emptyFeed.className = 'muted';
      emptyFeed.textContent = t('common.activity.empty');
      activityFeedList.appendChild(emptyFeed);
    } else {
      feedNotifications.forEach((notification) => {
        activityFeedList.appendChild(renderNotificationCard(notification, 'notification-feed-item', { announce: false }));
      });
    }
    const hasOlderActivity = totalActivity > visibleActivityCount;
    loadOlderActivityBtn.hidden = !hasOlderActivity;
    loadOlderActivityBtn.disabled = !hasOlderActivity;

    const activeNotificationIds = new Set(session.state.notifications.map((item) => item?.id).filter(Boolean));
    Array.from(toastTimers.keys()).forEach((notificationId) => {
      if (!activeNotificationIds.has(notificationId)) {
        window.clearTimeout(toastTimers.get(notificationId));
        toastTimers.delete(notificationId);
        dismissedToastIds.delete(notificationId);
      }
    });
    const toastNotifications = session.state.notifications
      .filter((notification) => notification?.id && !dismissedToastIds.has(notification.id))
      .slice(-4);
    toastContainer.innerHTML = '';
    toastNotifications.forEach((notification) => {
      const ttlMs = Number.isFinite(Number(notification?.ttlMs)) && Number(notification.ttlMs) > 0
        ? Number(notification.ttlMs)
        : DEFAULT_TOAST_TTL_MS;
      if (!toastTimers.has(notification.id)) {
        const timerHandle = window.setTimeout(() => {
          dismissedToastIds.add(notification.id);
          toastTimers.delete(notification.id);
          updateSummary();
        }, ttlMs);
        toastTimers.set(notification.id, timerHandle);
      }
      toastContainer.appendChild(renderNotificationCard(notification, 'notification-toast'));
    });

    const serverReady = sessionStatus === 'ready';
    if (isUploadingDraft) {
      const progress = session.state.uploadDraftProgress;
      if (progress?.lengthComputable && Number(progress?.total) > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((progress.loaded / progress.total) * 100)));
        syncDraftBtn.textContent = t('editor.server.uploadingDraftPackageProgress', {
          percent,
          loaded: formatMegabytes(progress.loaded),
          total: formatMegabytes(progress.total),
        });
      } else if (Number(progress?.loaded) > 0) {
        syncDraftBtn.textContent = t('editor.server.uploadingDraftPackageLoaded', { loaded: formatMegabytes(progress.loaded) });
      } else {
        syncDraftBtn.textContent = t('editor.server.uploadingDraftPackage');
      }
    } else {
      syncDraftBtn.textContent = t('editor.server.uploadDraft');
    }
    syncDraftBtn.disabled = !serverReady || isUploadingDraft || isUploadDraftFlowActive;
    browsePublishedBtn.disabled = !serverReady;
    manageUploadedDraftsBtn.textContent = isRefreshingUploadedDrafts ? t('common.actions.refreshing') : t('editor.uploadedDraft.manage');
    manageUploadedDraftsBtn.disabled = !serverReady || isRefreshingUploadedDrafts;
    signInBtn.hidden = serverReady;
    if (manageUploadedDraftsDialogOpen) renderManageUploadedDraftsModal();
  };

  session.setOnStateChange(() => {
    updateSummary();
    if (browsePublishedDialogOpen) {
      renderPublishedBrowserModal();
    }
    if (manageUploadedDraftsDialogOpen) {
      renderManageUploadedDraftsModal();
    }
  });

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });
  subjectInput.addEventListener('input', () => {
    session.updateSubject(subjectInput.value);
    updateSummary();
  });
  blockKind.addEventListener('change', () => {
    session.setSelectedBlockKind(blockKind.value);
    updateSummary();
  });
  blockEditor.addEventListener('input', () => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    session.updateBlockContent(session.state.selectedBlockId, blockEditor.value);
    if (selectedBlock?.kind === 'question') {
      refreshPromptT2AControlsForSelectedBlock();
      updateSummary({ preserveDetailEditor: true });
      return;
    }
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
  questionTextDisplayModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      session.updateQuestionTextDisplayMode(
        session.state.selectedBlockId,
        button.dataset.textDisplayMode || 'multi_line'
      );
      updateSummary();
    });
  });
  questionMin.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'min', questionMin.value);
    updateSummary();
  });
  questionMax.addEventListener('input', () => {
    session.updateQuestionNumberConfig(session.state.selectedBlockId, 'max', questionMax.value);
    updateSummary();
  });
  questionCorrectAnswerBooleanButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const selectedValue = button.dataset.booleanAnswerValue || '';
      const nextValue = button.getAttribute('aria-pressed') === 'true' ? '' : selectedValue;
      session.updateQuestionCorrectAnswerBoolean(session.state.selectedBlockId, nextValue);
      updateSummary();
    });
  });
  questionCorrectAnswerNumber.addEventListener('input', () => {
    session.updateQuestionCorrectAnswerNumber(session.state.selectedBlockId, questionCorrectAnswerNumber.value);
    updateSummary();
  });
  questionNumberAllowSignedToggle.addEventListener('click', () => {
    session.updateQuestionNumberRulesAllowSigned(session.state.selectedBlockId, !questionNumberAllowSigned.checked);
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
  questionShuffleToggle.addEventListener('click', () => {
    session.updateQuestionShuffleOptions(session.state.selectedBlockId, !questionShuffleOptions.checked);
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
    await runMediaAction(async () => {
      const [file] = questionImageInput.files || [];
      const blockId = questionImageInput.dataset.blockId;
      if (!file || !blockId) return;
      const currentBlock = session.findBlock(blockId);
      const hasExisting = Boolean(getSingleMediaRef(currentBlock?.prompt?.mediaRefs, 'question_image'));
      if (hasExisting) {
        const confirmed = await confirmDangerAction({
          title: 'Replace question image?',
          bodyText: 'Replacing will discard the currently attached question image.',
          confirmLabel: 'Replace image',
          removalItems: ['Current image file attachment for this question.'],
        });
        if (!confirmed) {
          session.setMediaFeedback('Image replacement canceled.');
          questionImageInput.value = '';
          updateSummary();
          return;
        }
      }
      await session.attachQuestionMedia(blockId, 'question_image', file, { confirmReplace: true });
      questionImageInput.value = '';
      updateSummary();
    });
  });
  questionAudioInput.addEventListener('change', async () => {
    await runMediaAction(async () => {
      const [file] = questionAudioInput.files || [];
      const blockId = questionAudioInput.dataset.blockId;
      if (!file || !blockId) return;
      const currentBlock = session.findBlock(blockId);
      const hasExisting = Boolean(getSingleMediaRef(currentBlock?.prompt?.mediaRefs, 'question_audio'));
      if (hasExisting) {
        const confirmed = await confirmDangerAction({
          title: 'Replace question audio?',
          bodyText: 'Replacing will discard the currently attached question audio.',
          confirmLabel: 'Replace audio',
          removalItems: ['Current audio file attachment for this question.'],
        });
        if (!confirmed) {
          session.setMediaFeedback('Audio replacement canceled.');
          questionAudioInput.value = '';
          updateSummary();
          return;
        }
      }
      await session.attachQuestionMedia(blockId, 'question_audio', file, { confirmReplace: true });
      questionAudioInput.value = '';
      updateSummary();
    });
  });
  optionAudioInput.addEventListener('change', async () => {
    await runMediaAction(async () => {
      const [file] = optionAudioInput.files || [];
      if (!file || !pendingOptionAudioTarget) return;
      const { blockId, optionId } = pendingOptionAudioTarget;
      pendingOptionAudioTarget = null;
      const block = session.findBlock(blockId);
      const config = normalizeQuestionResponseConfig(block?.responseConfig);
      const option = (config.options || []).map((item) => normalizeResponseOption(item)).find((item) => item.id === optionId);
      const hasExisting = Boolean(getSingleMediaRef(option?.mediaRefs, 'option_audio'));
      if (hasExisting) {
        const confirmed = await confirmDangerAction({
          title: 'Replace option audio?',
          bodyText: 'Replacing will discard the currently attached option audio.',
          confirmLabel: 'Replace audio',
          removalItems: ['Current audio file attachment for this option.'],
        });
        if (!confirmed) {
          session.setMediaFeedback('Option audio replacement canceled.');
          optionAudioInput.value = '';
          updateSummary();
          return;
        }
      }
      await session.attachOptionAudio(blockId, optionId, file, { confirmReplace: true });
      optionAudioInput.value = '';
      updateSummary();
    });
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
  syncDraftBtn.addEventListener('click', async () => {
    if (session.state.isUploadDraftFlowActive || session.state.isUploadingDraft) return;
    let uploadFlowStarted = false;
    try {
      const result = await guardServerMenuAction(syncDraftBtn, () => {
        session.state.isUploadDraftFlowActive = true;
        uploadFlowStarted = true;
        updateSummary();
        return session.uploadCurrentDraftToServer({ preflight: false });
      });
      if (!result?.ok && result?.error?.code === 'DRAFT_NAME_CONFLICT') {
        const choice = await showUploadConflictModal({ existingDraft: result.error.details?.existingDraft });
        if (choice.action === 'replace' || choice.action === 'copy') {
          const retry = await session.uploadCurrentDraftToServer({ preflight: false, conflictAction: choice.action });
          if (!retry?.ok && retry?.error?.code === 'DRAFT_SLOT_LIMIT_REACHED') {
            const slotChoice = await showSlotFullModal({ uploadedDrafts: retry.error.details?.uploadedDrafts });
            if (slotChoice.deleted) {
              // Keep slot-limit recovery in one continuous upload flow.
              await session.uploadCurrentDraftToServer({ preflight: false, conflictAction: choice.action });
            }
          }
        }
      } else if (!result?.ok && result?.error?.code === 'DRAFT_SLOT_LIMIT_REACHED') {
        const slotChoice = await showSlotFullModal({ uploadedDrafts: result.error.details?.uploadedDrafts });
        if (slotChoice.deleted) {
          // Keep slot-limit recovery in one continuous upload flow.
          await session.uploadCurrentDraftToServer({ preflight: false });
        }
      }
    } finally {
      if (uploadFlowStarted) {
        session.state.isUploadDraftFlowActive = false;
      }
      updateSummary();
    }
  });
  browsePublishedBtn.addEventListener('click', async () => {
    await guardServerMenuAction(browsePublishedBtn, async () => {
      browsePublishedDialogOpen = true;
      renderPublishedBrowserModal();
      await runPublishedSearch();
    });
  });
  signInBtn.addEventListener('click', () => {
    session.beginServerSignIn();
    updateSummary();
  });
  manageUploadedDraftsBtn.addEventListener('click', async () => {
    await guardServerMenuAction(manageUploadedDraftsBtn, async () => {
      manageUploadedDraftsDialogOpen = true;
      renderManageUploadedDraftsModal();
      await session.loadUploadedDrafts({ preflight: false });
      renderManageUploadedDraftsModal();
    });
    updateSummary();
  });
  loadOlderActivityBtn.addEventListener('click', () => {
    const totalActivity = Array.isArray(session.state.activityLog) ? session.state.activityLog.length : 0;
    visibleActivityCount = Math.min(totalActivity, visibleActivityCount + ACTIVITY_VISIBLE_INITIAL);
    updateSummary();
  });

  controlsRow.append(addContentBtn, addQuestionBtn);
  metaRow.append(saveBtn, exportBtn, importBtn, openViewerBtn);
  protectedActionsColumn.append(
    serverSessionStatus,
    signInBtn,
    syncDraftBtn,
    manageUploadedDraftsBtn,
    browsePublishedBtn
  );
  moreActions.append(protectedActionsColumn);
  leftPanel.append(
    leftHeading,
    metadataSection,
    controlsRow,
    blockList,
    moreActions,
    activityFeedToggle,
    metaRow,
    importFileInput,
    questionImageInput,
    questionAudioInput,
    optionAudioInput
  );
  rightPanel.append(rightHeading, statusRow);
  layout.append(leftPanel, rightPanel);
  const languageSelector = createLanguageSelector({
    onChange: async () => {
      await flushLocaleChangeBeforeReload(session, 'editor.shell');
      window.location.reload?.();
    },
  });
  topBar.append(saveStateEl, validationEl, lastSavedEl, localDraftIdEl, languageSelector);
  shell.append(topBar, layout);
  shell.appendChild(browsePublishedModalRoot);
  shell.appendChild(manageUploadedDraftsModalRoot);
  shell.appendChild(toastContainer);
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

  const hasOnlyAllowedKeys = (payload, allowedKeys) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    return Object.keys(payload).every((key) => allowedKeys.has(key));
  };
  const validateEditorIntent = (intent) => {
    const actionId = typeof intent?.actionId === 'string' ? intent.actionId : '';
    if (!actionId || !session.state.draft?.localId) return false;
    const payload = intent?.payload;

    if (actionId === 'editorPromptT2A' || actionId === 'resumeT2AAfterLogin') {
      const allowed = new Set(['localDraftId', 'blockId', 'target']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      if (typeof payload.localDraftId !== 'string' || typeof payload.blockId !== 'string') return false;
      if (payload.target !== 'question_prompt') return false;
      return session.validateEditorPromptT2AIntentPayload(payload).ok;
    }

    if (actionId === 'editorOptionT2A') {
      const allowed = new Set(['localDraftId', 'blockId', 'target', 'optionId']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      if (
        typeof payload.localDraftId !== 'string'
        || typeof payload.blockId !== 'string'
        || typeof payload.optionId !== 'string'
      ) {
        return false;
      }
      if (payload.target !== 'option') return false;
      return session.validateEditorOptionT2AIntentPayload(payload).ok;
    }

    if (actionId === 'resumeRewriteAfterLogin') {
      const allowed = new Set(['localDraftId', 'blockId', 'target']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      if (typeof payload.localDraftId !== 'string' || typeof payload.blockId !== 'string') return false;
      if (payload.target !== 'question_prompt') return false;
      const block = session.findBlock(payload.blockId);
      return payload.localDraftId === session.state.draft?.localId && Boolean(block && block.kind === 'question');
    }

    return false;
  };

  const authGate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: RESUME_FLAG_KEY,
    storage: session.storage,
    checkSessionReady: async () => session.ensureServerSessionReady(),
    getCurrentLocalId: () => session.state.draft?.localId || null,
    getCurrentUiState: () => session.getUiRestoreState(),
    persistLocalRecord: () => session.flushLocalStateForAuthRedirect(),
    restoreByLocalId: (localIdToRestore) => session.restoreByLocalId(localIdToRestore),
    restoreUiState: (uiState) => session.applyUiRestoreState(uiState),
    validateIntent: (intent) => validateEditorIntent(intent),
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
  await session.refreshServerSession();
  if (session.state.serverSession.status === 'ready') {
    await session.loadUploadedDrafts();
  }

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
  formatUploadedDraftTimestamp,
  toUploadedDraftDisplay,
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
