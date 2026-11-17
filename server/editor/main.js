import { createPublishedBrowserView } from './published-browser-view.js';
import { createUploadedDraftsView, formatUploadedDraftTimestamp, toUploadedDraftDisplay, normalizeDraftPublishState, getUploadedDraftPublishBadge } from './uploaded-drafts-view.js';
import { createStatusPanel } from './status-panel.js';
import { createMultipleChoiceControls } from './multiple-choice-controls.js';
import { createEditorDialogs } from './dialogs.js';
import { createAnswerSettings } from './answer-settings.js';
import { createNotificationPanel, getNotificationToastRemainingMs } from './notification-panel.js';
import { validateWorksheetReadiness } from '../app/contracts/worksheet-readiness.js';
import { createFeedbackEditor, feedbackStarIcon } from './feedback-editor.js';
import { feedbackEnabled, cloneFeedback } from '../app/worksheet-feedback.js';
import { questionTextConversion, passageToPrompt } from './question-type-conversion.js';
import { createBlankPassageEditor } from './fill-in-blanks-editor.js';
import { isFillInBlanks, emptyBlankConfig } from '../app/fill-in-blanks.js';
import { isLongText, textLimitCeiling, STANDARD_TEXT_LIMIT, LONG_TEXT_LIMIT } from '../app/text-answer.js';
import { imageQuestions, imageBudget } from '../app/image-response.js';
import { mountOptionImageEditor } from './option-image-editor.js';
import { optionImageRef, imageDescription } from '../app/option-images.js';
import { runPublicationFlow, runPublicationAttempt } from '../app/api/publication-flow.js';
import { runAudioGeneration, waitForAudioAttachment, AUDIO_GENERATION_PHASE_TIMEOUT_MS } from '../app/bridge/audio-generation.js';
import { prepareMutation } from '../app/auth/mutation-auth.js';
import { createSilentSessionStateAdapter } from '../app/auth/session-state-adapter.js';
import { redirectReadSignIn, takeReadAuthReturn } from '../app/auth/read-auth-return.js';
import { runOwnedSessionProbe } from '../app/auth/session-coordinator.js';
import { createReadAuthFlow } from '../app/auth/read-auth-flow.js';
import { promptForReadSignIn } from '../app/auth/read-auth-prompt.js';
import { runDeletionFlow } from '../app/api/deletion-flow.js';
import { runUploadRecoveryFlow } from '../app/api/upload-recovery-flow.js';
import { getApiErrorMessage } from '../app/api/error-presentation.js';
import { UploadOperationSlot, canceledUploadResult } from '../app/api/upload-operation-lifecycle.js';
import { classifyUploadResult } from '../app/api/upload-result.js';
import { installPageRecovery } from '../app/storage/recovery-journal.js';
import { getNumberCorrectAnswerConfigViolation } from '../app/contracts/number-input-validator.js';
import { PackageLoadProgress } from '../viewer/package-load-progress.js';
import { createBlockNavigation } from './block-navigation.js';
import { editorStorage } from './storage/index.js';
import { SharedAuthGate } from '../app/auth/shared-auth-gate.js';
import { createServerApiClient } from '../app/api/server-api-client.js';
import {
  createWorksheetPackageFromDraft,
  parseWorksheetPackage,
} from './worksheet-package.js';
import { collectAudioTrackAssetIds, normalizeAudioTracks } from './audio-tracks.js';
import { MARKDOWN_FORMAT, PROMPT_TEXT_LIMIT, promptTextState, copyWorksheetText, assertWorksheetTextFormats, worksheetTextToPlain, installWorksheetTextStyles } from '../app/worksheet-text.js';
import { createRichTextEditor } from './rich-text-editor.js';
import { getWorksheetT2ALanguagePresetById } from './t2a-language-presets.js';
import { MEDIA_LIMITS, IMAGE_MIME_TYPES, IMAGE_EXTENSIONS, AUDIO_MIME_TYPES, AUDIO_EXTENSIONS } from './media-config.js';
import { probeSession } from '../app/auth/session-readiness.js';
import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from '../app/auth/auth-popup-flow.js';
import { getAvailableLocales, getLocale, resolveInitialLocale, setLocale, t } from '../app/i18n/index.js';

const app = document.getElementById('app');
installWorksheetTextStyles(document);
setLocale(resolveInitialLocale(), { persist: false });

const AUTOSAVE_MS = 1000;
const ACTIVITY_MAX_STORED = 200;
const ACTIVE_NOTIFICATIONS_MAX_STORED = 200;
const T2A_TEXT_MAX_LENGTH = 200;
const DEFAULT_MODE = 'edit';
const RESUME_FLAG_KEY = 'editor:lastSession';
const AUDIO_TRACK_LANGUAGE_IDS = Object.freeze(['cantonese', 'mandarin', 'english']);
let contractsPromise;

function nowIso() {
  return new Date().toISOString();
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

function editorNotification(key, params = {}) {
  return t(`editor.notifications.${key}`, params);
}

function normalizeMediaUsage(usage) {
  if (usage === 'option_image') return 'option_image';
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
  collectAudioTrackAssetIds(block?.prompt?.audioTracks).forEach((assetId) => ids.add(assetId));
  const options = Array.isArray(block?.responseConfig?.options) ? block.responseConfig.options : [];
  options.forEach((option) => {
    normalizeMediaRefs(option?.mediaRefs).forEach((ref) => ids.add(ref.assetId));
    collectAudioTrackAssetIds(option?.audioTracks).forEach((assetId) => ids.add(assetId));
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
  const exceedsLimit = Array.from(trimmedText).length > maxLength;
  return {
    trimmedText,
    hasText,
    exceedsLimit,
    eligible: hasText && !exceedsLimit,
  };
}

function isAudioTrackLanguage(language) {
  return AUDIO_TRACK_LANGUAGE_IDS.includes(language);
}

function getAudioTrackLanguageLabel(language) {
  const key = isAudioTrackLanguage(language) ? language : 'cantonese';
  return t(`editor.media.audioTracks.languages.${key}`);
}

// This is a change detector, not a security primitive. Keeping it synchronous
// lets stale-state rendering remain deterministic while authors type.
function getAudioSourceTextHash(text) {
  const value = String(text ?? '').trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function getAudioTrack(audioTracks, language) {
  return normalizeAudioTracks(audioTracks).find((track) => track.language === language) || null;
}

function setAudioTrack(audioTracks, nextTrack) {
  return normalizeAudioTracks([
    ...normalizeAudioTracks(audioTracks).filter((track) => track.language !== nextTrack.language),
    nextTrack,
  ]);
}

function removeAudioTrack(audioTracks, language) {
  return normalizeAudioTracks(audioTracks).filter((track) => track.language !== language);
}

function getTextLanguageMismatch(text, language) {
  const value = String(text ?? '');
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const total = han + latin;
  if (total < 8) return null;
  if (language === 'english' && han / total >= 0.7) return 'chinese_text_for_english';
  if ((language === 'cantonese' || language === 'mandarin') && latin / total >= 0.7) return 'english_text_for_chinese';
  return null;
}

function collectLegacyAudioTargets(blocks) {
  const targets = [];
  normalizeBlocks(blocks).forEach((block) => {
    if (block.kind !== 'question') return;
    const promptRef = getSingleMediaRef(block.prompt?.mediaRefs, 'question_audio');
    if (promptRef) targets.push({ blockId: block.blockId, target: 'prompt', optionId: null, assetId: promptRef.assetId, text: block.prompt?.text || '' });
    const config = normalizeQuestionResponseConfig(block.responseConfig);
    (config.options || []).map((option) => normalizeResponseOption(option)).forEach((option) => {
      const optionRef = getSingleMediaRef(option.mediaRefs, 'option_audio');
      if (optionRef) targets.push({ blockId: block.blockId, target: 'option', optionId: option.id, assetId: optionRef.assetId, text: option.label ?? option.value ?? '' });
    });
  });
  return targets;
}

function migrateLegacyAudioBlocks(blocks, choice) {
  const normalizedChoice = choice === 'discard' ? 'discard' : choice;
  if (normalizedChoice !== 'discard' && !isAudioTrackLanguage(normalizedChoice)) {
    throw new Error('A legacy audio migration choice is required.');
  }
  const legacyTargets = collectLegacyAudioTargets(blocks);
  if (normalizedChoice !== 'discard') {
    for (const item of legacyTargets) {
      const block = normalizeBlocks(blocks).find((candidate) => candidate.blockId === item.blockId);
      const blockOptions = normalizeQuestionResponseConfig(block?.responseConfig).options || [];
      const tracks = item.target === 'prompt'
        ? block?.prompt?.audioTracks
        : blockOptions.find((option) => option.id === item.optionId)?.audioTracks;
      if (getAudioTrack(tracks, normalizedChoice)) {
        throw new Error(`Legacy audio conflicts with an existing ${normalizedChoice} track.`);
      }
    }
  }
  const migrated = normalizeBlocks(blocks).map((block) => {
    if (block.kind !== 'question') return block;
    const promptRef = getSingleMediaRef(block.prompt?.mediaRefs, 'question_audio');
    const prompt = {
      ...block.prompt,
      mediaRefs: removeSingleMediaRef(block.prompt?.mediaRefs, 'question_audio'),
      audioTracks: promptRef && normalizedChoice !== 'discard'
        ? setAudioTrack(block.prompt?.audioTracks, { language: normalizedChoice, assetId: promptRef.assetId, voicePresetId: null, sourceTextHash: getAudioSourceTextHash(block.prompt?.text) })
        : normalizeAudioTracks(block.prompt?.audioTracks),
    };
    const config = normalizeQuestionResponseConfig(block.responseConfig);
    const options = (config.options || []).map((option) => {
      const normalized = normalizeResponseOption(option);
      const audioRef = getSingleMediaRef(normalized.mediaRefs, 'option_audio');
      return {
        ...normalized,
        mediaRefs: removeSingleMediaRef(normalized.mediaRefs, 'option_audio'),
        audioTracks: audioRef && normalizedChoice !== 'discard'
          ? setAudioTrack(normalized.audioTracks, { language: normalizedChoice, assetId: audioRef.assetId, voicePresetId: null, sourceTextHash: getAudioSourceTextHash(normalized.label ?? normalized.value) })
          : normalizeAudioTracks(normalized.audioTracks),
      };
    });
    return { ...block, prompt, responseConfig: normalizeQuestionResponseConfig({ ...config, options }) };
  });
  return { blocks: migrated, legacyCount: legacyTargets.length };
}

function getLegacyAudioMigrationAction(choice) {
  const isDiscard = choice === 'discard';
  return {
    buttonClassName: isDiscard
      ? 'confirm-modal__btn confirm-modal__btn--destructive'
      : 'confirm-modal__btn confirm-modal__btn--warning',
    buttonLabelKey: isDiscard
      ? 'editor.media.audioTracks.migration.discardAndOpen'
      : 'editor.media.audioTracks.migration.convertAndOpen',
    descriptionKey: isDiscard
      ? 'editor.media.audioTracks.migration.discardConfirm'
      : 'editor.media.audioTracks.migration.description',
  };
}

function showLegacyAudioMigrationDialog({ count, required = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'confirm-modal legacy-audio-migration-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('h3');
    title.textContent = t('editor.media.audioTracks.migration.title');
    const description = document.createElement('p');
    description.className = 'confirm-modal__description';
    description.textContent = t('editor.media.audioTracks.migration.description', { count });
    const choices = document.createElement('div');
    choices.className = 'legacy-audio-migration-modal__choices';
    const choiceDefinitions = [
      ['cantonese', t('editor.media.audioTracks.languages.cantonese')],
      ['mandarin', t('editor.media.audioTracks.languages.mandarin')],
      ['english', t('editor.media.audioTracks.languages.english')],
      ['discard', t('editor.media.audioTracks.migration.discard')],
    ];
    choiceDefinitions.forEach(([value, label], index) => {
      const row = document.createElement('label');
      row.className = 'legacy-audio-migration-modal__choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'legacy-audio-migration-choice';
      input.value = value;
      input.checked = index === 0;
      const text = document.createElement('span');
      text.textContent = label;
      row.append(input, text);
      choices.appendChild(row);
    });
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-modal__btn';
    cancel.textContent = t('common.actions.cancel');
    cancel.hidden = required;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'confirm-modal__btn confirm-modal__btn--warning';
    confirm.textContent = t('editor.media.audioTracks.migration.convertAndOpen');
    actions.append(cancel, confirm);
    dialog.append(title, description, choices, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const close = (value) => { overlay.remove(); resolve(value); };
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => {
      const selected = choices.querySelector('input:checked')?.value || 'cantonese';
      close(selected);
    });
    const updateConfirmAction = () => {
      const selected = choices.querySelector('input:checked')?.value || 'cantonese';
      const action = getLegacyAudioMigrationAction(selected);
      confirm.className = action.buttonClassName;
      confirm.textContent = t(action.buttonLabelKey);
      description.textContent = t(action.descriptionKey, { count });
    };
    choices.addEventListener('change', updateConfirmAction);
    updateConfirmAction();
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !required) close(null);
    });
    choices.querySelector('input:checked')?.focus();
  });
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
  const hasPassageText = isFillInBlanks(block.responseConfig) && hasTypedText(passageToPrompt(block).text);
  const hasTypedContent = hasTypedText(promptText) || hasTypedText(contentText) || hasOptionText || hasPassageText;
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
  const hasAssets = normalizeMediaRefs(normalized.mediaRefs).length > 0
    || collectAudioTrackAssetIds(normalized.audioTracks).length > 0;
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
    ? normalizedOptions.reduce(
      (count, option) => count
        + normalizeMediaRefs(option.mediaRefs).length
        + collectAudioTrackAssetIds(option.audioTracks).length,
      0
    )
    : 0;
  const hasOptionTextLoss = shouldRemoveOptions
    ? normalizedOptions.some((option) => hasTypedText(option.label) || hasTypedText(option.value))
    : false;
  const hasMeaningfulDataLoss = hasOptionTextLoss || optionAttachmentCountToRemove > 0 || (normalizedFromType === 'fill_in_blanks' && normalizedToType !== normalizedFromType);
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
    worksheetPlus: `<svg ${svgAttrs}><rect x="3" y="4" width="13" height="16" rx="2"></rect><path d="M7 8h5"></path><path d="M7 12h5"></path><path d="M7 16h3"></path><path d="M19 14v6"></path><path d="M16 17h6"></path></svg>`,
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
    close: `<svg ${svgAttrs}><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`,
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

function createAudioTrackMoreMenu({ languageLabel, actionButtons = [], className = '' } = {}) {
  const menu = document.createElement('details');
  menu.className = `audio-track-more-menu${className ? ` ${className}` : ''}`;
  const trigger = document.createElement('summary');
  trigger.className = 'icon-btn audio-track-more-menu__toggle';
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('aria-haspopup', 'menu');
  const triggerLabel = t('editor.media.audioTracks.moreActions', { language: languageLabel });
  trigger.title = triggerLabel;
  trigger.setAttribute('aria-label', triggerLabel);
  setIconButtonContent(trigger, 'moreHorizontal');
  trigger.addEventListener('click', (event) => {
    if (trigger.getAttribute('aria-disabled') !== 'true') return;
    event.preventDefault();
  });

  const list = document.createElement('div');
  list.className = 'audio-track-more-menu__list';
  list.setAttribute('role', 'menu');
  actionButtons.forEach((button) => {
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      menu.open = false;
    });
    list.appendChild(button);
  });
  menu.append(trigger, list);
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    const scope = menu.closest('.media-section, .option-audio-menu__list');
    scope?.querySelectorAll('details.audio-track-more-menu[open]').forEach((otherMenu) => {
      if (otherMenu !== menu) otherMenu.open = false;
    });
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    menu.open = false;
    trigger.focus();
  });
  return menu;
}

function setAudioTrackMoreMenuDisabled(menu, disabled) {
  const trigger = menu?.querySelector('.audio-track-more-menu__toggle');
  if (!(trigger instanceof HTMLElement)) return;
  trigger.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  menu.classList.toggle('is-disabled', Boolean(disabled));
  if (disabled) menu.open = false;
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

function setOptionAudioMenuTriggerState(trigger, { hasAudio = false, isGenerating = false, isPersisted = true } = {}) {
  if (!(trigger instanceof HTMLElement)) return;
  const iconName = isGenerating ? 'loading' : hasAudio ? 'audioAttached' : 'audio';
  const label = isGenerating
    ? t('editor.media.optionAudioMenuGenerating')
    : hasAudio ? t('editor.media.optionAudioMenuAttached') : t('editor.media.optionAudioMenu');
  trigger.innerHTML = `<span class="option-actions-menu__icon${isGenerating ? ' option-actions-menu__icon--spin' : ''}" aria-hidden="true">${createEditorIcon(iconName)}</span>`;
  trigger.title = isPersisted
    ? label
    : t('editor.media.enterOptionTextBeforeAudioActions');
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
  if (kind === 'question') return t('editor.block.kind.question');
  if (kind === 'content') return t('editor.block.kind.content');
  return t('editor.block.kind.fallback', { value: toTitleCaseLabel(kind || 'Block') });
}

function getAnswerInputTypeLabel(inputType) {
  const keys = {
    text: 'editor.question.inputTypes.text',
    number: 'editor.question.inputTypes.number',
    boolean: 'editor.question.inputTypes.boolean',
    multiple_choice: 'editor.question.inputTypes.multipleChoice',
    fill_in_blanks: 'fillBlanks.type',
    image_response: 'imageResponse.type',
  };
  return keys[inputType] ? t(keys[inputType]) : toTitleCaseLabel(inputType);
}

function getSelectionModeLabel(selectionMode) {
  if (selectionMode === 'single') return t('editor.question.selectionModes.single');
  if (selectionMode === 'multi') return t('editor.question.selectionModes.multiple');
  return toTitleCaseLabel(selectionMode);
}

function getTextDisplayModeLabel(displayMode) {
  if (displayMode === 'single_line') return t('editor.question.textDisplayModes.singleLine');
  if (displayMode === 'multi_line') return t('editor.question.textDisplayModes.multiLine');
  return toTitleCaseLabel(displayMode);
}

function getBooleanAnswerLabel(value) {
  if (value === 'true') return t('editor.question.booleanValues.true');
  if (value === 'false') return t('editor.question.booleanValues.false');
  return toTitleCaseLabel(value);
}

function getEditorTextTooLongForAudioLabel(max) {
  return t('editor.media.textTooLongForAudio', { max });
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
      format: MARKDOWN_FORMAT,
    },
    responseConfig: {
      inputType: 'text',
      textMode: 'standard',
      maxLength: 200,
      displayMode: 'multi_line',
    },
  };
}

const TEXT_INPUT_TYPES = new Set(['text']);
const CANONICAL_RESPONSE_INPUT_TYPES = new Set(['text', 'number', 'boolean', 'multiple_choice', 'image_response', 'fill_in_blanks']);

function mapOptionsTextToLines(rawText) {
  if (!rawText) return [];
  return String(rawText)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function mapOptionsTextToResponseOptions(rawText) {
  return mapOptionsTextToLines(rawText)
    .map((line) => ({ id: createLocalId('opt'), value: line, label: line }));
}

function normalizeResponseOption(option, fallback = '') {
  if (isRecord(option)) {
    const id = isNonEmptyString(option.id) ? String(option.id) : createLocalId('opt');
    const value = String(option.value ?? option.label ?? fallback) || (optionImageRef(option) ? id : '');
    const label = String(option.label ?? option.value ?? fallback);
    return {
      id,
      value,
      label,
      mediaRefs: normalizeMediaRefs(option.mediaRefs).filter(ref => ['option_audio', 'option_image'].includes(ref.usage)),
      ...(option.imageDescription !== undefined ? { imageDescription: imageDescription(option.imageDescription) } : {}),
      audioTracks: normalizeAudioTracks(option.audioTracks),
    };
  }
  const normalized = String(option ?? fallback);
  return { id: createLocalId('opt'), value: normalized, label: normalized, mediaRefs: [], audioTracks: [] };
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
  return getNumberCorrectAnswerConfigViolation(value, config) === null;
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
          format: MARKDOWN_FORMAT,
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
        audioTracks: normalizeAudioTracks(promptSource.audioTracks),
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
    ...(overrides.feedback !== undefined ? { feedback: cloneFeedback(overrides.feedback) } : {}),
    blocks: normalizeBlocks(overrides.blocks),
    assets: normalizeDraftAssets(overrides.assets),
    metadata: {
      localId,
      origin: overrides.origin || 'local_created',
      updatedAt,
      createdAt: overrides.metadata?.createdAt || updatedAt,
      serverLink: overrides.metadata?.serverLink || null,
      importedFrom: overrides.metadata?.importedFrom || null,
      modelVersion: overrides.metadata?.modelVersion || 'package-compatible-v2',
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
        usage: ['question_image', 'question_audio', 'option_audio', 'option_image'].includes(asset.usage)
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
    this.resolveLegacyAudioMigration = options.resolveLegacyAudioMigration || showLegacyAudioMigrationDialog;
    this.packageLoad = new PackageLoadProgress();
    this.packageDownloadIdleMs = options.packageDownloadIdleMs ?? 60_000;
    this.packageSessionTimeoutMs = options.packageSessionTimeoutMs ?? 15_000;
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
    this.saveSequence = 0;
    this.lastAppliedSaveSequence = 0;
    this.lastFailedSaveSequence = 0;
    this.autosaveGeneration = 0;
    this.deletedDraftIds = new Set();
    this.inFlightSaveCountsByDraftId = new Map();
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
    this._audioOperations = new Map();
    this.audioPhaseTimeoutMs = AUDIO_GENERATION_PHASE_TIMEOUT_MS;
    this._promptT2AInFlightTargets = new Set();
    this._optionT2AInFlightTargets = new Set();
    this._audioDraftGeneration = 0;
  }

  registerInFlightDraftSave(localDraftId) {
    if (!localDraftId) return;
    const currentCount = this.inFlightSaveCountsByDraftId.get(localDraftId) || 0;
    this.inFlightSaveCountsByDraftId.set(localDraftId, currentCount + 1);
  }

  unregisterInFlightDraftSave(localDraftId) {
    if (!localDraftId) return;
    const currentCount = this.inFlightSaveCountsByDraftId.get(localDraftId) || 0;
    if (currentCount <= 1) {
      this.inFlightSaveCountsByDraftId.delete(localDraftId);
      return;
    }
    this.inFlightSaveCountsByDraftId.set(localDraftId, currentCount - 1);
  }

  getInFlightDraftSaveCount(localDraftId) {
    return localDraftId ? (this.inFlightSaveCountsByDraftId.get(localDraftId) || 0) : 0;
  }

  clearDeletedDraftTombstoneIfIdle(localDraftId) {
    if (!localDraftId || this.getInFlightDraftSaveCount(localDraftId) > 0) return;
    this.deletedDraftIds.delete(localDraftId);
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
    activityText = null,
    activityReplaceSource = null,
    showToast = true,
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
      activityReplaceSource: isNonEmptyString(activityReplaceSource) ? activityReplaceSource.trim() : null,
      showToast: showToast !== false,
      createdAt: nowIso(),
    };
    this.state.notifications = [...this.state.notifications, notification]
      .slice(-ACTIVE_NOTIFICATIONS_MAX_STORED);
    // Notification policy:
    // - transient progress events stay in active notifications/toasts only
    // - historical terminal events are recorded in activityLog
    if (notification.logActivity !== false) {
      const activityNotification = {
        ...notification,
        text: isNonEmptyString(activityText) ? activityText.trim() : notification.text,
      };
      const previousActivity = Array.isArray(this.state.activityLog) ? this.state.activityLog : [];
      const retainedActivity = activityNotification.activityReplaceSource
        ? previousActivity.filter((item) => item?.source !== activityNotification.activityReplaceSource)
        : previousActivity;
      this.state.activityLog = [...retainedActivity, activityNotification]
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
    activityText = null,
    activityReplaceSource = null,
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
      activityText,
      activityReplaceSource,
    });
  }

  replaceNotificationForSource({
    source = 'editor',
    category = 'server',
    kind = 'info',
    text = '',
    ttlMs = null,
    actionLabel = null,
    activityText = null,
    activityReplaceSource = null,
  } = {}) {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) return null;
    this.clearNotificationsBySource(normalizedSource);
    return this.pushNotification({
      source: normalizedSource,
      category,
      kind,
      text,
      ttlMs,
      actionLabel,
      activityText,
      activityReplaceSource,
    });
  }

  normalizeDraftForContracts(draft) {
    return {
      draftWorksheetId: draft.localId,
      ...(draft.feedback !== undefined ? { feedback: cloneFeedback(draft.feedback) } : {}),
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
              ...copyWorksheetText(block.prompt),
              mediaRefs: normalizeMediaRefs(block?.prompt?.mediaRefs),
              audioTracks: normalizeAudioTracks(block?.prompt?.audioTracks),
            },
            responseConfig: isRecord(block.responseConfig)
              ? normalizeQuestionResponseConfig(block.responseConfig, { forContract: true })
              : { inputType: 'text', textMode: 'standard', maxLength: 200, displayMode: 'multi_line' },
          };
        }

        return {
          ...base,
          content: {
            ...copyWorksheetText(block.content),
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
    const errors = validateWorksheetReadiness({ ...this.state.draft, title: String(this.state.draft.title || 'Untitled worksheet') }, { authoring: true }).errors;
    normalizedDraft.blocks.forEach((block, index) => {
      if (block.kind === 'question' && promptTextState(block.prompt).exceedsLimit) {
        errors.push(`draft.blocks[${index}]: ${t('formatting.promptTooLong', { max: PROMPT_TEXT_LIMIT })}`);
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
    this._audioDraftGeneration += 1;
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
      assertWorksheetTextFormats(existing.blocks);
      const legacyTargets = collectLegacyAudioTargets(existing.blocks);
      if (legacyTargets.length > 0) {
        const choice = await this.resolveLegacyAudioMigration({ count: legacyTargets.length, required: true, source: 'local' });
        if (!choice) return null;
        const migrated = migrateLegacyAudioBlocks(existing.blocks, choice);
        existing = { ...existing, blocks: migrated.blocks };
        const referencedIds = collectDraftQuestionAssetIds(existing);
        const removedIds = normalizeDraftAssets(existing.assets)
          .map((asset) => asset.assetId)
          .filter((assetId) => !referencedIds.has(assetId));
        existing.assets = normalizeDraftAssets(existing.assets).filter((asset) => referencedIds.has(asset.assetId));
        await this.storage.drafts.put(existing);
        await Promise.all(removedIds.map(async (assetId) => {
          try {
            await this.storage.localAssets?.remove?.(assetId);
          } catch (_error) {
            // The migrated draft no longer references this asset. A failed cache
            // cleanup must not make the otherwise atomic migration unusable.
          }
        }));
      }
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
        ? t('editor.localSaveValidationWarning', { count: this.state.lastContractValidationIssueCount })
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
    const savedAt = existing?.metadata?.updatedAt;
    this.state.lastSavedAt = isNonEmptyString(savedAt) && Number.isFinite(Date.parse(savedAt)) ? savedAt : null;
    this.state.lastPersistenceError = null;
    this.validateCurrentDraft();
    this.persistRestoreMetadata();
    return this.state.draft;
  }

  async startNewWorksheet() {
    if (this.packageLoad.current) return null;
    this._audioDraftGeneration += 1;
    const loadToken = this.packageLoad.start('new');
    this.packageLoad.update(loadToken, 'creating');
    try {
      const previousDraft = this.state.draft;
      const previousDraftId = previousDraft?.localId || null;
      this.discardingDraftId = previousDraftId;
      const referencedAssetIds = previousDraft ? Array.from(collectDraftQuestionAssetIds(previousDraft)) : [];

      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;

      if (previousDraftId) {
        this.autosaveGeneration += 1;
        this.deletedDraftIds.add(previousDraftId);
        try {
          await this.storage.drafts.remove(previousDraftId);
        } catch (error) {
          // The worksheet remains active: it must remain saveable as well.
          this.deletedDraftIds.delete(previousDraftId);
          this.scheduleAutosave();
          throw error;
        }
        this.clearDeletedDraftTombstoneIfIdle(previousDraftId);
      }

      await Promise.all(referencedAssetIds.map(async (assetId) => {
        try {
          await this.storage.localAssets.remove(assetId);
        } catch (error) {
          console.warn('Unable to remove local asset while starting a new worksheet.', error);
        }
      }));

      const draft = createDraftRecord();
      this.state.draft = draft;
      this.state.selectedBlockId = draft.blocks[0]?.blockId || null;
      this.state.draftRevision = 1;
      this.state.lastSavedRevision = 0;
      this.state.lastSavedAt = null;
      this.state.lastManualSaveAt = null;
      this.state.lastExportedAt = null;
      this.state.lastImportedAt = null;
      this.state.lastPersistenceError = null;
      this.state.lastValidationWarning = null;
      this.state.lastContractValidationIssueCount = 0;
      this.state.lastSavedLocalValidationIssueCount = 0;
      this.state.isPristineDraft = true;
      this.transientQuestionBlockIds.clear();
      this.validateCurrentDraft();
      this.scheduleAutosave();
      this.persistRestoreMetadata();
      return draft;
    } finally {
      this.discardingDraftId = null;
      this.packageLoad.finish(loadToken);
    }
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
    const block = this.state.draft?.blocks.find(item => item.blockId === blockId);
    const previous = block?.prompt || block?.content || {};
    this.updateBlockTextField(this.state.draft?.localId, blockId, {
      text: String(nextText || ''), format: previous.format === 'rich-text-v1' ? 'plain_text' : previous.format || 'plain_text',
    });
  }

  updateBlockTextField(draftId, blockId, field) {
    if (!this.state.draft || this.state.draft.localId !== draftId) return;
    const block = this.state.draft.blocks.find(item => item.blockId === blockId);
    if (!block) return;
    assertWorksheetTextFormats([{ kind: 'content', content: field }]);
    const key = block.kind === 'question' ? 'prompt' : 'content';
    const { document: _oldDocument, ...previous } = block[key] || {};
    block[key] = { ...previous, ...copyWorksheetText(field) };
    if (key === 'prompt' && field.text.trim()) this.transientQuestionBlockIds.delete(blockId);
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
    this._previewPlayRequestId += 1;
    this.finalizePreviewAudio(reason);
  }

  async playAssetAudio(assetId, hooks = {}) {
    const requestId = ++this._previewPlayRequestId;
    const record = await this.getLocalAssetRecord(assetId);
    if (requestId !== this._previewPlayRequestId) {
      return { ok: false, reason: 'superseded' };
    }
    if (!record) {
      this.setMediaFeedback(editorNotification('media.audioPreviewLoadFailed'));
      return { ok: false, reason: 'missing-asset' };
    }
    const objectUrl = this.createObjectUrlForAsset(record, 'audio/mpeg');
    if (!objectUrl) {
      this.setMediaFeedback(editorNotification('media.audioPreviewLoadFailed'));
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
      this.setMediaFeedback(editorNotification('media.audioPreviewPlayFailed'));
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
      this.setMediaFeedback(editorNotification('media.audioPlaybackBlocked'));
      return { ok: false, reason: 'playback-failed' };
    }
  }

  async openAssetImage(assetId) {
    // Do NOT pass 'noopener' or 'noreferrer' in the features string: per spec
    // (and Chrome 88+) window.open returns null when those flags are set, even
    // though the tab still opens. We instead manually null out .opener below.
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) {
      this.setMediaFeedback(t('editor.media.feedback.imagePreviewBlocked'));
      return { ok: false, reason: 'blocked' };
    }
    try {
      previewWindow.opener = null;
    } catch (error) {
      // Ignore cross-browser quirks when hardening the newly opened window.
    }
    try {
      previewWindow.document.title = t('editor.media.preview.loadingImagePreview');
      previewWindow.document.body.textContent = t('editor.media.preview.loadingImagePreview');
    } catch (error) {
      // Ignore cross-browser document access quirks for newly opened windows.
    }

    const record = await this.getLocalAssetRecord(assetId);
    if (!record) {
      previewWindow.close();
      this.setMediaFeedback(t('editor.media.feedback.imagePreviewLoadFailed'));
      return { ok: false, reason: 'missing-asset' };
    }
    const draftAsset = this.findAsset(assetId);
    const fallbackImageMimeType = draftAsset?.mimeType || 'image/png';
    const objectUrl = this.createObjectUrlForAsset(record, fallbackImageMimeType);
    if (!objectUrl) {
      previewWindow.close();
      this.setMediaFeedback(t('editor.media.feedback.imagePreviewLoadFailed'));
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
          doc.title = t('editor.media.preview.imagePreviewTitle');
          doc.body.innerHTML = '';
          const image = doc.createElement('img');
          image.src = objectUrl;
          image.alt = t('editor.media.preview.attachedImageAlt');
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
      this.setMediaFeedback(t('editor.media.feedback.imagePreviewOpenFailed'));
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
    if (options.isCurrent && !options.isCurrent()) return { ok: false, reason: 'stale-target' };
    if (!this.state.draft || !blockId) return { ok: false, reason: 'missing-draft' };
    const kind = usage === 'question_image' ? 'image' : 'audio';
    const validation = validateMediaFile(file, kind);
    if (!validation.ok) {
      this.setMediaFeedback(validation.message);
      return { ok: false, reason: 'validation', message: validation.message };
    }
    const target = this.findBlock(blockId);
    if (!target || target.kind !== 'question') return { ok: false, reason: 'missing-question' };

    const draftId = this.state.draft.localId;
    const generation = this._audioDraftGeneration;
    const currentRef = getSingleMediaRef(target.prompt?.mediaRefs, usage);
    if (currentRef && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: currentRef.assetId };
    }

    const priorRefsForUsage = normalizeMediaRefs(target.prompt?.mediaRefs, usage);
    const replacedAssetIds = priorRefsForUsage.map((ref) => ref.assetId);

    const newAsset = await this.createLocalAssetRecord(file, usage, kind);

    const currentTarget = this.findBlock(blockId);
    if ((options.isCurrent && !options.isCurrent()) || this.state.draft?.localId !== draftId || this._audioDraftGeneration !== generation
      || currentTarget?.kind !== 'question'
      || JSON.stringify(normalizeMediaRefs(currentTarget.prompt?.mediaRefs, usage)) !== JSON.stringify(priorRefsForUsage)) {
      await this.storage.localAssets?.remove?.(newAsset.assetId);
      return { ok: false, reason: 'stale-target' };
    }

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
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    const filtered = existingAssets.filter((asset) => !replacedSet.has(asset.assetId) || referenced.has(asset.assetId));
    filtered.push(newAsset);
    this.state.draft.assets = filtered;

    this.clearMediaFeedback();
    this.touchDraft();
    const result = { ok: true, assetId: newAsset.assetId, replacedAssetId: replacedAssetIds[0] || null };
    options.onCommitted?.(result);
    this.cleanupReplacedMedia(replacedAssetIds);
    return result;
  }

  // Cleanup cannot change the outcome of an already committed attachment.
  cleanupReplacedMedia(assetIds) {
    const assets = this.storage.localAssets;
    if (!assets?.remove) return;
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    for (const id of assetIds) {
      if (referenced.has(id)) continue;
      Promise.resolve().then(() => {
        if (!collectDraftQuestionAssetIds(this.state.draft).has(id)) return assets.remove(id);
      }).catch(() => {
        console.warn('Unable to remove replaced local media.');
      });
    }
  }

  async removeQuestionMedia(blockId, usage, options = {}) {
    if (!this.state.draft || !blockId) return { ok: false, reason: 'missing-draft' };
    const target = this.findBlock(blockId);
    if (!target || target.kind !== 'question') return { ok: false, reason: 'missing-question' };
    const currentRef = getSingleMediaRef(target.prompt?.mediaRefs, usage);
    if (!currentRef) {
      this.setMediaFeedback(editorNotification('media.noMediaAttachment'));
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
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    this.state.draft.assets = normalizeDraftAssets(this.state.draft.assets)
      .filter((asset) => !removedSet.has(asset.assetId) || referenced.has(asset.assetId));

    this.clearMediaFeedback();
    this.touchDraft();
    this.cleanupReplacedMedia(removedAssetIds);
    return { ok: true, removedAssetId };
  }

  async attachOptionAudio(blockId, optionId, file, options = {}) {
    if (options.isCurrent && !options.isCurrent()) return { ok: false, reason: 'stale-target' };
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
      this.setMediaFeedback(editorNotification('media.optionTextRequired'));
      return { ok: false, reason: 'missing-option' };
    }
    const currentRef = getSingleMediaRef(existingOption.mediaRefs, 'option_audio');
    if (currentRef && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: currentRef.assetId };
    }

    const draftId = this.state.draft.localId;
    const generation = this._audioDraftGeneration;
    const priorRefsForUsage = normalizeMediaRefs(existingOption.mediaRefs, 'option_audio');
    const replacedAssetIds = priorRefsForUsage.map((ref) => ref.assetId);

    const newAsset = await this.createLocalAssetRecord(file, 'option_audio', 'audio');
    const latestBlock = this.findBlock(blockId);
    const latestConfig = normalizeQuestionResponseConfig(latestBlock?.responseConfig);
    const latestOption = (latestConfig.options || []).map(item => normalizeResponseOption(item)).find(item => item.id === optionId);
    if ((options.isCurrent && !options.isCurrent()) || this.state.draft?.localId !== draftId
      || this._audioDraftGeneration !== generation || latestBlock?.kind !== 'question'
      || latestConfig.inputType !== 'multiple_choice' || !latestOption
      || JSON.stringify(normalizeMediaRefs(latestOption.mediaRefs, 'option_audio')) !== JSON.stringify(priorRefsForUsage)) {
      await this.storage.localAssets?.remove?.(newAsset.assetId);
      return { ok: false, reason: 'stale-target' };
    }
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
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    const filtered = existingAssets.filter((asset) => !replacedSet.has(asset.assetId) || referenced.has(asset.assetId));
    filtered.push(newAsset);
    this.state.draft.assets = filtered;

    this.clearMediaFeedback();
    this.touchDraft();
    const result = { ok: true, assetId: newAsset.assetId, replacedAssetId: replacedAssetIds[0] || null };
    options.onCommitted?.(result);
    this.cleanupReplacedMedia(replacedAssetIds);
    return result;
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
      this.setMediaFeedback(t('editor.media.feedback.noOptionAudioToRemove'));
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
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    this.state.draft.assets = normalizeDraftAssets(this.state.draft.assets)
      .filter((asset) => !removedSet.has(asset.assetId) || referenced.has(asset.assetId));

    this.clearMediaFeedback();
    this.touchDraft();
    this.cleanupReplacedMedia(removedAssetIds);
    return { ok: true, removedAssetId };
  }

  async attachOptionImage(blockId, optionId, file, options = {}) {
    if (options.isCurrent && !options.isCurrent()) return { ok: false, reason: 'stale-target' };
    if (!this.state.draft || !blockId || !optionId) return { ok: false, reason: 'missing-input' };
    const validation = validateMediaFile(file, 'image');
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
      this.setMediaFeedback(editorNotification('media.optionTextRequired'));
      return { ok: false, reason: 'missing-option' };
    }
    const currentRef = getSingleMediaRef(existingOption.mediaRefs, 'option_image');
    if (currentRef && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: currentRef.assetId };
    }

    const draftId = this.state.draft.localId;
    const generation = this._audioDraftGeneration;
    const priorRefsForUsage = normalizeMediaRefs(existingOption.mediaRefs, 'option_image');
    const replacedAssetIds = priorRefsForUsage.map((ref) => ref.assetId);

    const newAsset = await this.createLocalAssetRecord(file, 'option_image', 'image');
    const latestBlock = this.findBlock(blockId);
    const latestConfig = normalizeQuestionResponseConfig(latestBlock?.responseConfig);
    const latestOption = (latestConfig.options || []).map(item => normalizeResponseOption(item)).find(item => item.id === optionId);
    if ((options.isCurrent && !options.isCurrent()) || this.state.draft?.localId !== draftId
      || this._audioDraftGeneration !== generation || latestBlock?.kind !== 'question'
      || latestConfig.inputType !== 'multiple_choice' || !latestOption
      || JSON.stringify(normalizeMediaRefs(latestOption.mediaRefs, 'option_image')) !== JSON.stringify(priorRefsForUsage)) {
      await this.storage.localAssets?.remove?.(newAsset.assetId);
      return { ok: false, reason: 'stale-target' };
    }
    this.state.draft.blocks = this.state.draft.blocks.map((candidate) => {
      if (candidate.blockId !== blockId || candidate.kind !== 'question') return candidate;
      const cfg = normalizeQuestionResponseConfig(candidate.responseConfig);
      const nextOptions = (cfg.options || []).map((option) => {
        const normalized = normalizeResponseOption(option);
        if (normalized.id !== optionId) return normalized;
        return {
          ...normalized,
          mediaRefs: setSingleMediaRef(normalized.mediaRefs, 'option_image', newAsset.assetId),
          value: normalized.value || normalized.id,
          imageDescription: '',
        };
      });
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({ ...cfg, options: nextOptions }),
      };
    });

    const replacedSet = new Set(replacedAssetIds);
    const existingAssets = normalizeDraftAssets(this.state.draft.assets);
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    const filtered = existingAssets.filter((asset) => !replacedSet.has(asset.assetId) || referenced.has(asset.assetId));
    filtered.push(newAsset);
    this.state.draft.assets = filtered;

    this.clearMediaFeedback();
    this.touchDraft();
    const result = { ok: true, assetId: newAsset.assetId, replacedAssetId: replacedAssetIds[0] || null };
    options.onCommitted?.(result);
    this.cleanupReplacedMedia(replacedAssetIds);
    return result;
  }

  async removeOptionImage(blockId, optionId, options = {}) {
    if (!this.state.draft || !blockId || !optionId) return { ok: false, reason: 'missing-input' };
    const block = this.findBlock(blockId);
    if (!block || block.kind !== 'question') return { ok: false, reason: 'missing-question' };
    const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
    if (responseConfig.inputType !== 'multiple_choice') return { ok: false, reason: 'not-multiple-choice' };
    const existingOption = (responseConfig.options || []).map((option) => normalizeResponseOption(option)).find((o) => o.id === optionId);
    if (!existingOption) return { ok: false, reason: 'missing-option' };
    const currentRef = getSingleMediaRef(existingOption.mediaRefs, 'option_image');
    if (!currentRef) {
      this.setMediaFeedback(t('optionImages.unavailable'));
      return { ok: false, reason: 'missing-media' };
    }
    if (options.confirmRemove !== true) {
      return { ok: false, reason: 'confirm-remove-required', existingAssetId: currentRef.assetId };
    }

    const refsForUsage = normalizeMediaRefs(existingOption.mediaRefs, 'option_image');
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
          mediaRefs: removeSingleMediaRef(normalized.mediaRefs, 'option_image'),
          imageDescription: '',
        };
      });
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({ ...cfg, options: nextOptions }),
      };
    });

    const removedSet = new Set(removedAssetIds);
    const referenced = collectDraftQuestionAssetIds(this.state.draft);
    this.state.draft.assets = normalizeDraftAssets(this.state.draft.assets)
      .filter((asset) => !removedSet.has(asset.assetId) || referenced.has(asset.assetId));

    this.clearMediaFeedback();
    this.touchDraft();
    this.cleanupReplacedMedia(removedAssetIds);
    return { ok: true, removedAssetId };
  }

  updateOptionImageDescription(blockId, optionId, text) {
    const block = this.findBlock(blockId);
    if (!block || block.responseConfig?.inputType !== 'multiple_choice') return;
    const option = block.responseConfig.options?.find(option => option.id === optionId);
    if (!optionImageRef(option)) return;
    option.imageDescription = imageDescription(text);
    this.touchDraft();
  }

  getAudioTrackTarget(blockId, target, optionId = null) {
    const block = this.findBlock(blockId);
    if (!block || block.kind !== 'question') return null;
    if (target === 'prompt') {
      return { block, text: worksheetTextToPlain(block.prompt), audioTracks: normalizeAudioTracks(block.prompt?.audioTracks) };
    }
    const config = normalizeQuestionResponseConfig(block.responseConfig);
    const option = (config.options || []).map((item) => normalizeResponseOption(item)).find((item) => item.id === optionId);
    if (!option) return null;
    return { block, option, text: String(option.label ?? option.value ?? ''), audioTracks: normalizeAudioTracks(option.audioTracks) };
  }

  async attachAudioTrack(blockId, target, language, file, options = {}) {
    if (!isAudioTrackLanguage(language) || !this.state.draft) return { ok: false, reason: 'invalid-language' };
    const validation = validateMediaFile(file, 'audio');
    if (!validation.ok) return { ok: false, reason: 'validation', message: validation.message };
    const optionId = options.optionId || null;
    const draftId = this.state.draft.localId;
    const generation = this._audioDraftGeneration;
    const isCurrentDraft = () => (!options.isCurrent || options.isCurrent()) && this.state.draft?.localId === draftId
      && this._audioDraftGeneration === generation
      && (!options.expectedDraft || (options.expectedDraft.localId === draftId
        && options.expectedDraft.generation === generation));
    if (!isCurrentDraft()) return { ok: false, reason: 'draft-changed' };
    const current = this.getAudioTrackTarget(blockId, target, optionId);
    if (!current) return { ok: false, reason: 'missing-target' };
    if (
      options.expectedSourceTextHash
      && getAudioSourceTextHash(current.text) !== options.expectedSourceTextHash
    ) {
      return {
        ok: false,
        reason: 'source-text-changed',
        error: { message: editorNotification('audioGeneration.sourceTextChangedDuringGeneration') },
      };
    }
    const existingTrack = getAudioTrack(current.audioTracks, language);
    if (existingTrack && options.confirmReplace !== true) {
      return { ok: false, reason: 'confirm-replace-required', existingAssetId: existingTrack.assetId };
    }
    const newAsset = await this.createLocalAssetRecord(file, target === 'prompt' ? 'question_audio' : 'option_audio', 'audio');
    const latest = isCurrentDraft() && this.getAudioTrackTarget(blockId, target, optionId);
    const latestTrack = latest && getAudioTrack(latest.audioTracks, language);
    const staleReason = !isCurrentDraft() ? 'draft-changed' : !latest ? 'missing-target'
      : getAudioSourceTextHash(latest.text) !== getAudioSourceTextHash(current.text) ? 'source-text-changed'
        : (latestTrack?.assetId || null) !== (existingTrack?.assetId || null) ? 'track-changed' : null;
    if (staleReason) {
      await this.storage.localAssets?.remove?.(newAsset.assetId);
      return { ok: false, reason: staleReason, error: { message: editorNotification('audioGeneration.sourceTextChangedDuringGeneration') } };
    }
    const nextTrack = {
      language,
      assetId: newAsset.assetId,
      voicePresetId: options.voicePresetId === language ? language : null,
      sourceTextHash: getAudioSourceTextHash(current.text),
    };
    this.state.draft.blocks = this.state.draft.blocks.map((candidate) => {
      if (candidate.blockId !== blockId || candidate.kind !== 'question') return candidate;
      if (target === 'prompt') {
        return { ...candidate, prompt: { ...candidate.prompt, audioTracks: setAudioTrack(candidate.prompt?.audioTracks, nextTrack) } };
      }
      const config = normalizeQuestionResponseConfig(candidate.responseConfig);
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({
          ...config,
          options: (config.options || []).map((item) => {
            const normalized = normalizeResponseOption(item);
            return normalized.id === optionId ? { ...normalized, audioTracks: setAudioTrack(normalized.audioTracks, nextTrack) } : normalized;
          }),
        }),
      };
    });
    this.state.draft.assets = [...normalizeDraftAssets(this.state.draft.assets), newAsset];
    if (existingTrack) this.pruneAssetLinks([existingTrack.assetId]);
    this.clearMediaFeedback();
    this.touchDraft();
    const result = { ok: true, assetId: newAsset.assetId, replacedAssetId: existingTrack?.assetId || null };
    options.onCommitted?.(result);
    return result;
  }

  removeAudioTrack(blockId, target, language, options = {}) {
    if (!isAudioTrackLanguage(language) || !this.state.draft) return { ok: false, reason: 'invalid-language' };
    const optionId = options.optionId || null;
    const current = this.getAudioTrackTarget(blockId, target, optionId);
    const existingTrack = current && getAudioTrack(current.audioTracks, language);
    if (!existingTrack) return { ok: false, reason: 'missing-track' };
    if (options.confirmRemove !== true) return { ok: false, reason: 'confirm-remove-required', existingAssetId: existingTrack.assetId };
    this.state.draft.blocks = this.state.draft.blocks.map((candidate) => {
      if (candidate.blockId !== blockId || candidate.kind !== 'question') return candidate;
      if (target === 'prompt') return { ...candidate, prompt: { ...candidate.prompt, audioTracks: removeAudioTrack(candidate.prompt?.audioTracks, language) } };
      const config = normalizeQuestionResponseConfig(candidate.responseConfig);
      return {
        ...candidate,
        responseConfig: normalizeQuestionResponseConfig({
          ...config,
          options: (config.options || []).map((item) => {
            const normalized = normalizeResponseOption(item);
            return normalized.id === optionId ? { ...normalized, audioTracks: removeAudioTrack(normalized.audioTracks, language) } : normalized;
          }),
        }),
      };
    });
    this.pruneAssetLinks([existingTrack.assetId]);
    this.touchDraft();
    return { ok: true, removedAssetId: existingTrack.assetId };
  }

  captureAudioTarget(blockId, target, optionId = null, language = null) {
    const localId = this.state.draft?.localId, generation = this._audioDraftGeneration;
    const signature = () => {
      const value = this.getAudioTrackTarget(blockId, target, optionId);
      if (!value) return null;
      return JSON.stringify([value.text, language
        ? getAudioTrack(value.audioTracks, language)?.assetId || null
        : normalizeMediaRefs(target === 'prompt' ? value.block.prompt?.mediaRefs : value.option?.mediaRefs,
          target === 'prompt' ? 'question_audio' : 'option_audio')]);
    };
    const original = signature();
    return () => Boolean(original) && this.state.draft?.localId === localId
      && this._audioDraftGeneration === generation && signature() === original;
  }

  cancelAudioGeneration(blockId, optionId = null) {
    this._audioOperations.get(JSON.stringify([blockId, optionId]))?.abort();
  }

  async requestGeneratedAudio(text, voice, isCurrent, signal) {
    const auth = {
      ensure: async options => {
        const prepared = await prepareMutation(this.readAuth, {
          isCurrent: options.isCurrent, signal: options.signal,
          intent: { kind: 'mutation', operation: 'generateAudio', id: this.state.draft?.localId },
        });
        // Authentication recovery has already received explicit confirmation.
        // Pass only its account lease to the one-shot provider boundary.
        return prepared.ok ? { ok: true, isCurrent: prepared.isCurrent } : prepared.result;
      },
      observe: result => this.readAuth.observe?.(result),
    };
    return runAudioGeneration({ auth, api: this.apiClient, text, voice, isCurrent,
      signal, phaseTimeoutMs: this.audioPhaseTimeoutMs });
  }

  async generateAudioTrack(blockId, target, language, options = {}) {
    if (!isAudioTrackLanguage(language)) return { ok: false, reason: 'invalid-language' };
    const optionId = options.optionId || null;
    const current = this.getAudioTrackTarget(blockId, target, optionId);
    if (!current) return { ok: false, reason: 'missing-target' };
    const textState = getT2ATextEligibility(current.text, target === 'prompt' ? PROMPT_TEXT_LIMIT : T2A_TEXT_MAX_LENGTH);
    if (!textState.eligible) return { ok: false, reason: textState.hasText ? 'text-too-long' : 'missing-text' };
    const preset = getWorksheetT2ALanguagePresetById(language);
    if (!preset) return { ok: false, reason: 'missing-preset' };
    this.stopPreviewAudio();
    const existingTrack = getAudioTrack(current.audioTracks, language);
    if (existingTrack && options.confirmReplace !== true) return { ok: false, reason: 'confirm-replace-required', existingAssetId: existingTrack.assetId };
    const expectedSourceTextHash = getAudioSourceTextHash(current.text);
    const expectedDraft = { localId: this.state.draft.localId, generation: this._audioDraftGeneration };
    const isCurrent = this.captureAudioTarget(blockId, target, optionId, language);
    const audioResult = await this.requestGeneratedAudio(textState.trimmedText, preset.options, isCurrent, options.signal);
    if (this.state.draft?.localId !== expectedDraft.localId || this._audioDraftGeneration !== expectedDraft.generation) {
      return { ok: false, reason: 'draft-changed' };
    }
    if (audioResult.kind === 'superseded' && getAudioSourceTextHash(this.getAudioTrackTarget(blockId, target, optionId)?.text || '') !== expectedSourceTextHash) return { ok: false, reason: 'source-text-changed' };
    if (['cancelled', 'superseded'].includes(audioResult?.kind)) return { ok: false, cancelled: true, status: 'cancelled', error: audioResult.error };
    if (!audioResult?.ok) return { ok: false, reason: 'generation-failed', error: audioResult?.error || null, source: audioResult?.source };
    const audioBytes = toValidGeneratedAudioBytes(audioResult.data);
    if (!audioBytes) return { ok: false, reason: 'invalid-audio-data' };
    const fileName = target === 'prompt' ? `${blockId}_${language}.mp3` : `${blockId}_${optionId}_${language}.mp3`;
    return waitForAudioAttachment(onCommitted => this.attachAudioTrack(blockId, target, language, createAudioFileFromBytes(audioBytes, fileName), {
      optionId,
      confirmReplace: true,
      voicePresetId: language,
      expectedSourceTextHash,
      expectedDraft,
      isCurrent: audioResult.isCurrent, onCommitted,
    }), options.signal);
  }

  migrateLegacyAudioInDraft(choice) {
    if (!this.state.draft) return { ok: false, reason: 'missing-draft' };
    const migrated = migrateLegacyAudioBlocks(this.state.draft.blocks, choice);
    const priorAssetIds = collectDraftQuestionAssetIds(this.state.draft);
    this.state.draft.blocks = migrated.blocks;
    this.pruneAssetLinks(Array.from(priorAssetIds));
    this.touchDraft();
    return { ok: true, ...migrated };
  }

  updateQuestionInputType(blockId, inputType, { promptPlacement } = {}) {
    if (!this.state.draft || !blockId) return;
    if (inputType === 'image_response' && this.state.draft.blocks.find(b=>b.blockId===blockId)?.responseConfig?.inputType !== inputType && imageQuestions(this.state.draft.blocks).length >= 3) return;
    const normalizedInputType = ['text', 'number', 'boolean', 'multiple_choice', 'image_response', 'fill_in_blanks'].includes(inputType)
      ? inputType
      : 'text';

    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') {
        return block;
      }
      const conversion = questionTextConversion(block, normalizedInputType, promptPlacement);
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
        nextResponseConfig.textMode = 'standard';
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
        prompt: conversion.prompt,
        responseConfig: conversion.responseConfig || normalizeQuestionResponseConfig(nextResponseConfig),
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
          .flatMap((option) => [
            ...normalizeMediaRefs(option?.mediaRefs).map((ref) => ref.assetId),
            ...collectAudioTrackAssetIds(option?.audioTracks),
          ])
        : [])
      : [];
    this.updateQuestionInputType(blockId, nextInputType, options);
    if (removedAssetIds.length > 0) {
      this.pruneAssetLinks(removedAssetIds);
    }
    return { ok: true, impact };
  }

  updateQuestionTextMode(blockId, longText, { confirmReduction = false } = {}) {
    const block = this.state.draft?.blocks.find(item => item.blockId === blockId && item.kind === 'question');
    if (block?.responseConfig?.inputType !== 'text') return { ok: false };
    const current = block.responseConfig;
    if (isLongText(current) === longText) return { ok: true };
    const nextLimit = longText ? LONG_TEXT_LIMIT : Math.min(current.maxLength || 200, STANDARD_TEXT_LIMIT);
    if (!longText && current.maxLength > nextLimit && !confirmReduction) {
      return { ok: false, reason: 'confirm-reduction', max: nextLimit };
    }
    block.responseConfig = { ...current, textMode: longText ? 'long' : 'standard', maxLength: nextLimit,
      displayMode: longText ? 'multi_line' : current.displayMode };
    this.touchDraft();
    return { ok: true };
  }

  updateQuestionMaxLength(blockId, maxLength) {
    if (!this.state.draft || !blockId) return;
    const parsed = Number(maxLength);
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
          textMode: isLongText(block.responseConfig) ? 'long' : 'standard',
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

  updateQuestionOptionAtIndex(blockId, index, nextLabel, settings = {}) {
    if (!this.state.draft || !blockId || !Number.isInteger(index) || index < 0) return null;
    const normalizedLabel = String(nextLabel ?? '');
    const preferredOptionId = isNonEmptyString(settings.optionId) ? settings.optionId : null;
    let persistedOptionId = null;
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const options = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];
      while (options.length <= index) {
        const nextIndex = options.length;
        options.push({
          id: nextIndex === index && preferredOptionId ? preferredOptionId : createLocalId('opt'),
          value: '',
          label: '',
        });
      }
      options[index] = { ...options[index], value: optionImageRef(options[index]) ? (options[index].value || options[index].id) : normalizedLabel, label: normalizedLabel };
      persistedOptionId = String(options[index].id || '');
      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options,
        }),
      };
    });
    this.touchDraft();
    return persistedOptionId || null;
  }

  applyQuestionOptionMultilinePaste(blockId, startIndex, rawText, options = {}) {
    if (!this.state.draft || !blockId || !Number.isInteger(startIndex) || startIndex < 0) {
      return { ok: false, reason: 'invalid-target' };
    }
    const labels = mapOptionsTextToLines(rawText);
    if (labels.length <= 1) {
      return { ok: false, reason: 'not-multiline' };
    }

    const targetBlock = this.findBlock(blockId);
    if (!targetBlock || targetBlock.kind !== 'question') {
      return { ok: false, reason: 'invalid-target' };
    }
    const targetConfig = normalizeQuestionResponseConfig(targetBlock.responseConfig);
    if (targetConfig.inputType !== 'multiple_choice') {
      return { ok: false, reason: 'not-multiple-choice' };
    }

    const existingOptions = Array.isArray(targetConfig.options)
      ? targetConfig.options.map((option) => normalizeResponseOption(option))
      : [];
    const overwrittenOptions = labels
      .map((_, offset) => existingOptions[startIndex + offset])
      .filter(Boolean);
    const audioBackedOptions = overwrittenOptions.filter((option) => {
      return normalizeMediaRefs(option.mediaRefs, 'option_audio').length > 0;
    });

    if (audioBackedOptions.length > 0 && options.confirmRemoveAudio !== true) {
      return {
        ok: false,
        reason: 'confirm-audio-removal-required',
        audioOptionCount: audioBackedOptions.length,
      };
    }

    const removedAssetIds = [];
    this.state.draft.blocks = this.state.draft.blocks.map((block) => {
      if (block.blockId !== blockId || block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      if (responseConfig.inputType !== 'multiple_choice') return block;
      const nextOptions = Array.isArray(responseConfig.options)
        ? responseConfig.options.map((option) => normalizeResponseOption(option))
        : [];

      labels.forEach((label, offset) => {
        const optionIndex = startIndex + offset;
        const existing = nextOptions[optionIndex]
          ? normalizeResponseOption(nextOptions[optionIndex])
          : { id: createLocalId('opt'), value: '', label: '', mediaRefs: [] };
        normalizeMediaRefs(existing.mediaRefs, 'option_audio').forEach((ref) => {
          removedAssetIds.push(ref.assetId);
        });
        nextOptions[optionIndex] = {
          ...existing,
          value: optionImageRef(existing) ? (existing.value || existing.id) : label,
          label,
          mediaRefs: removeSingleMediaRef(existing.mediaRefs, 'option_audio'),
        };
      });

      return {
        ...block,
        responseConfig: normalizeQuestionResponseConfig({
          ...responseConfig,
          options: nextOptions,
        }),
      };
    });
    if (removedAssetIds.length > 0) {
      this.pruneAssetLinks(removedAssetIds);
    }
    this.touchDraft();
    return {
      ok: true,
      addedOptionCount: Math.max(0, startIndex + labels.length - existingOptions.length),
      updatedOptionCount: labels.length,
      removedAudioCount: new Set(removedAssetIds).size,
    };
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
        normalizeMediaRefs(options[index]?.mediaRefs).forEach((ref) => removedAssetIds.push(ref.assetId));
        collectAudioTrackAssetIds(options[index]?.audioTracks).forEach((assetId) => removedAssetIds.push(assetId));
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
              format: MARKDOWN_FORMAT,
            },
          };

    if (kind === 'question') {
      this.transientQuestionBlockIds.add(block.blockId);
    }
    this.state.draft.blocks = [...this.state.draft.blocks, block];
    this.state.feedbackSettingsDraftId = null;
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
        content: { text: '', format: MARKDOWN_FORMAT },
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
            ...copyWorksheetText(block.prompt || block.content),
          },
          responseConfig: isRecord(block.responseConfig)
            ? normalizeQuestionResponseConfig(block.responseConfig)
            : { inputType: 'text', textMode: 'standard', maxLength: 200, displayMode: 'multi_line' },
          content: undefined,
        };
      }

      return {
        ...block,
        kind: 'content',
        content: {
          ...copyWorksheetText(isFillInBlanks(block.responseConfig) ? passageToPrompt(block) : (block.content || block.prompt)),
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
    this.state.feedbackSettingsDraftId = null;
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

  createRecoveryRecord() {
    if (!this.state.draft || this.state.draft.localId === this.discardingDraftId) return null;
    return cloneDraftForPersistence({ ...this.state.draft, metadata: {
      ...this.state.draft.metadata, localId: this.state.draft.localId,
      origin: this.state.draft.metadata?.origin || 'local_created', updatedAt: nowIso(),
    } });
  }

  async autosave() {
    if (!this.state.draft || this.state.draft.localId === this.discardingDraftId) return null;

    const saveSequence = ++this.saveSequence;
    const revisionAtSaveStart = this.state.draftRevision;
    const draftIdAtSaveStart = this.state.draft.localId || null;
    const generationAtSaveStart = this.autosaveGeneration;
    const draftGenerationAtSaveStart = this._audioDraftGeneration;
    const draftAtSaveStart = cloneDraftForPersistence(this.state.draft);
    const updatedAt = nowIso();
    let saveCountRegistered = false;
    let snapshotToPersist = null;
    let validation = null;
    let normalizedDraft = null;
    let contractValidation = null;
    let staleCleanupSucceeded = false;
    this.registerInFlightDraftSave(draftIdAtSaveStart);

    try {
      validation = this.validateCurrentDraft();
      normalizedDraft = validation.normalizedDraft;
      const { validateDraftSchema } = await loadContracts();
      contractValidation = validateDraftSchema(normalizedDraft);

      snapshotToPersist = cloneDraftForPersistence({
        ...draftAtSaveStart,
        metadata: {
          ...draftAtSaveStart.metadata,
          localId: draftAtSaveStart.localId,
          origin: draftAtSaveStart.metadata?.origin || 'local_created',
          updatedAt,
        },
        contractDraft: normalizedDraft,
        contractValidation: {
          valid: contractValidation.valid,
          errors: contractValidation.errors,
        },
      });

      this.state.autosavePending = true;

      if (
        generationAtSaveStart !== this.autosaveGeneration ||
        this.deletedDraftIds.has(draftIdAtSaveStart)
      ) {
        return null;
      }

      this.inFlightSaveCount += 1;
      saveCountRegistered = true;
      const persisted = await this.storage.drafts.put(snapshotToPersist);
      if (this.deletedDraftIds.has(persisted.localId)) {
        await this.storage.drafts.remove(persisted.localId);
        staleCleanupSucceeded = true;
        return null;
      }

      const shouldApplySaveStatus =
        this._audioDraftGeneration === draftGenerationAtSaveStart
        && this.state.draft?.localId === persisted.localId
        && revisionAtSaveStart >= this.state.lastSavedRevision
        && saveSequence > this.lastAppliedSaveSequence;

      if (shouldApplySaveStatus && this.state.draftRevision === revisionAtSaveStart) {
        this.state.draft = persisted;
      }

      if (shouldApplySaveStatus) {
        this.lastAppliedSaveSequence = saveSequence;
        const wasNeverSavedBefore = this.state.lastSavedRevision === 0;
        this.state.lastSavedRevision = revisionAtSaveStart;
        // A delayed older success records what was saved without hiding a newer failure.
        if (saveSequence > this.lastFailedSaveSequence) this.state.lastPersistenceError = null;
        this.state.lastSavedLocalValidationIssueCount = validation.errors.length;
        this.state.lastContractValidationIssueCount = contractValidation.errors.length;

        // Order completed saves by invocation, not wall-clock time: the clock
        // may have been corrected since the persisted draft was last saved.
        this.state.lastSavedAt = updatedAt;

        const shouldSuppressPristineWarning = this.state.isPristineDraft && wasNeverSavedBefore;
        const shouldSuppressTransientQuestionWarning =
          this.shouldSuppressTransientQuestionWarning(contractValidation.errors, normalizedDraft);
        this.state.lastValidationWarning =
          contractValidation.valid || shouldSuppressPristineWarning || shouldSuppressTransientQuestionWarning
          ? null
          : t('editor.localSaveValidationWarning', { count: contractValidation.errors.length });
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
        this._audioDraftGeneration === draftGenerationAtSaveStart &&
        this.state.draft?.localId === draftIdAtSaveStart &&
        generationAtSaveStart === this.autosaveGeneration &&
        !this.deletedDraftIds.has(draftIdAtSaveStart) &&
        revisionAtSaveStart >= this.state.lastSavedRevision &&
        saveSequence > Math.max(this.lastAppliedSaveSequence, this.lastFailedSaveSequence);
      if (shouldApplyErrorStatus) {
        this.lastFailedSaveSequence = saveSequence;
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
      if (saveCountRegistered) {
        this.inFlightSaveCount = Math.max(0, this.inFlightSaveCount - 1);
      }
      this.unregisterInFlightDraftSave(draftIdAtSaveStart);
      if (
        staleCleanupSucceeded ||
        (!saveCountRegistered && this.deletedDraftIds.has(draftIdAtSaveStart))
      ) {
        this.clearDeletedDraftTombstoneIfIdle(draftIdAtSaveStart);
      }
      this.state.autosavePending =
        this.inFlightSaveCount > 0 || this.state.lastSavedRevision < this.state.draftRevision;
      this.notifyStateChange();
    }
  }

  async importWorksheetPackageFile(file, options = {}) {
    if (this.packageLoad.current && this.packageLoad.current !== options.loadToken) {
      return { canceled: true, importedRecord: null, draftRecord: null };
    }
    const loadToken = options.loadToken || this.packageLoad.start('local');
    const stage = async name => {
      this.packageLoad.update(loadToken, name);
      // Give the status a rendering opportunity before synchronous ZIP parsing.
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    const stagedAssetIds = [];
    let stagedImportedId = null, stagedDraftId = null, committed = false;
    try {
      if (!file || typeof file.arrayBuffer !== 'function') {
        throw new Error(editorNotification('import.zipRequired'));
      }

      await stage('opening');
      const parsedPackage = parseWorksheetPackage(await file.arrayBuffer());
      const legacyTargets = collectLegacyAudioTargets(parsedPackage.worksheet.blocks);
      if (legacyTargets.length > 0) {
        const choice = await this.resolveLegacyAudioMigration({
          count: legacyTargets.length,
          required: false,
          source: options.migrationSource || 'package',
        });
        if (!choice) {
          return { canceled: true, importedRecord: null, draftRecord: null };
        }
        const migrated = migrateLegacyAudioBlocks(parsedPackage.worksheet.blocks, choice);
        parsedPackage.worksheet = { ...parsedPackage.worksheet, blocks: migrated.blocks };
        const referencedIds = collectDraftQuestionAssetIds({ blocks: migrated.blocks });
        parsedPackage.assets = parsedPackage.assets.filter((asset) => referencedIds.has(asset.assetId));
      }
      if (options.isCurrent && !options.isCurrent()) return { canceled: true };
      if (options.convertToEditableDraft) {
        await stage('saving');
        await this.saveBeforeWorksheetReplacement();
        await stage('opening');
      }
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

      const assetIdRemap = new Map();
      for (const asset of parsedPackage.assets) {
      if (options.isCurrent && !options.isCurrent()) return { canceled: true };
      const targetId = createLocalId('asset_import');
      assetIdRemap.set(asset.assetId, targetId);
      if (!this.storage.localAssets?.put) continue;
      stagedAssetIds.push(targetId);
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
      const remapAudioTracks = (audioTracks) => normalizeAudioTracks(audioTracks).map((track) => ({
        ...track,
        assetId: assetIdRemap.get(track.assetId) || track.assetId,
      }));

      const remappedBlocks = normalizeBlocks(parsedPackage.worksheet.blocks).map((block) => {
      if (block.kind !== 'question') return block;
      const responseConfig = normalizeQuestionResponseConfig(block.responseConfig);
      const options = (responseConfig.options || []).map((option) => {
        const normalized = normalizeResponseOption(option);
        return {
          ...normalized,
          mediaRefs: remapMediaRefs(normalized.mediaRefs),
          audioTracks: remapAudioTracks(normalized.audioTracks),
        };
      });
      return {
        ...block,
        prompt: {
          ...(isRecord(block.prompt) ? block.prompt : {}),
          mediaRefs: remapMediaRefs(block?.prompt?.mediaRefs),
          audioTracks: remapAudioTracks(block?.prompt?.audioTracks),
        },
        responseConfig: normalizeQuestionResponseConfig({ ...responseConfig, options }),
      };
    });

      importedRecord.worksheet = { ...parsedPackage.worksheet, blocks: remappedBlocks };
      importedRecord.assets = importedRecord.assets.map(asset => ({ ...asset,
        assetId: assetIdRemap.get(asset.assetId) || asset.assetId,
      }));
      importedRecord.packageManifest = { ...parsedPackage.manifest,
        assets: (parsedPackage.manifest?.assets || []).map(asset => ({ ...asset,
          assetId: assetIdRemap.get(asset.assetId) || asset.assetId,
        })),
      };
      if (options.isCurrent && !options.isCurrent()) return { canceled: true };
      stagedImportedId = importedRecord.localId;
      await this.storage.importedWorksheets.put(importedRecord);
      if (options.isCurrent && !options.isCurrent()) return { canceled: true };

      if (!options.convertToEditableDraft) {
        const successMessage = editorNotification('import.importedPackageZip');
        this.pushNotification({ kind: 'success', category: 'editor', source: 'import.package_zip', text: successMessage });
        this.notifyStateChange();
        committed = true;
        return { importedRecord, draftRecord: null };
      }

      const draft = createDraftRecord({
      title: parsedPackage.worksheet.title || 'Imported worksheet',
      feedback: parsedPackage.worksheet.feedback,
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
        modelVersion: 'package-compatible-v2',
        subject: (isRecord(parsedPackage.worksheet.metadata) && parsedPackage.worksheet.metadata.subject) || '',
      },
    });

      // Persist the incoming record without exposing it as the active worksheet.
      // A quota/storage failure must leave the outgoing editor state intact.
      const normalizedDraft = this.normalizeDraftForContracts(draft);
      const { validateDraftSchema } = await loadContracts();
      const contractValidation = validateDraftSchema(normalizedDraft);
      stagedDraftId = draft.localId;
      const persisted = await this.storage.drafts.put(cloneDraftForPersistence({
        ...draft,
        contractDraft: normalizedDraft,
        contractValidation,
      }));
      // Include edits made while asset/incoming-record persistence was pending.
      await stage('saving');
      await this.saveBeforeWorksheetReplacement();
      if (options.isCurrent && !options.isCurrent()) return { canceled: true };
      this.packageLoad.update(loadToken, 'opening');
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
      this._audioDraftGeneration += 1;
      this.state.draft = persisted;
      committed = true;
      this.state.selectedBlockId = persisted.blocks[0]?.blockId || null;
      this.state.draftRevision += 1;
      this.state.lastSavedRevision = this.state.draftRevision;
      this.state.lastSavedAt = persisted.metadata.updatedAt;
      this.state.lastPersistenceError = null;
      this.state.autosavePending = false;
      this.state.lastImportedAt = nowIso();
      this.state.lastSavedLocalValidationIssueCount = this.validateCurrentDraft().errors.length;
      this.state.lastContractValidationIssueCount = contractValidation.errors.length;
      this.state.lastValidationWarning = contractValidation.valid ? null
        : t('editor.localSaveValidationWarning', { count: contractValidation.errors.length });
      this.setNotificationForSource({ source: 'autosave.persistence', category: 'editor', kind: 'error', text: null });
      this.setNotificationForSource({ source: 'autosave.validation', category: 'editor', kind: 'warn', text: this.state.lastValidationWarning });
      this.persistRestoreMetadata();
      const successMessage = editorNotification('import.importedPackageZip');
      this.pushNotification({ kind: 'success', category: 'editor', source: 'import.package_zip', text: successMessage });
      this.notifyStateChange();
      return { importedRecord, draftRecord: this.state.draft };
    } catch (error) {
      this.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'import.package_zip',
        text: error?.message || editorNotification('import.unableToImportPackage'),
      });
      this.notifyStateChange();
      throw error;
    } finally {
      if (!committed) {
        const cleanup = async (store, id) => { if (id) { try { await store?.remove?.(id); } catch { /* Keep the original import error. */ } } };
        await Promise.all(stagedAssetIds.map(id => cleanup(this.storage.localAssets, id)));
        await cleanup(this.storage.importedWorksheets, stagedImportedId);
        await cleanup(this.storage.drafts, stagedDraftId);
      }
      if (!options.loadToken) this.packageLoad.finish(loadToken);
    }
  }

  async saveNow() {
    const draftId = this.state.draft?.localId;
    const generation = this._audioDraftGeneration;
    let sequence;
    const ownsStatus = () => this.state.draft?.localId === draftId
      && this._audioDraftGeneration === generation
      && sequence === Math.max(this.lastAppliedSaveSequence, this.lastFailedSaveSequence);
    try {
      const saving = this.autosave();
      sequence = this.saveSequence;
      const persisted = await saving;
      if (!persisted || !ownsStatus()) return persisted;
      this.state.lastManualSaveAt = nowIso();
      this.replaceNotificationForSource({
        kind: 'success',
        category: 'editor',
        source: 'save.manual',
        text: editorNotification('save.savedDraft', {
          id: persisted?.localId || this.state.draft?.localId || t('common.values.unknown'),
        }),
        activityText: editorNotification('save.savedLocalDraft'),
        activityReplaceSource: 'save.manual',
      });
      this.notifyStateChange();
      return persisted;
    } catch (error) {
      if (!ownsStatus()) throw error;
      console.error('Manual save failed', error);
      this.replaceNotificationForSource({
        kind: 'error',
        category: 'editor',
        source: 'save.manual',
        text: error?.message || editorNotification('save.manualSaveFailed'),
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
        throw new Error(editorNotification('export.noActiveDraft'));
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
        text: editorNotification('export.exportedPackage', { filename }),
      });
      this.notifyStateChange();
      return filename;
    } catch (error) {
      this.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'export.package_zip',
        text: error?.message || editorNotification('export.unableToExportPackage'),
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

  requireReadyWorksheet(draft = this.state.draft) {
    const validation = validateWorksheetReadiness({ ...draft, title: String(draft?.title || 'Untitled worksheet') }, { authoring: true });
    if (validation.valid) return;
    const messages = validation.errors.map(message => {
      const match = message.match(/draft\.blocks\[(\d+)\]/);
      const number = match ? Number(match[1]) + 1 : null;
      if (message.startsWith('feedback:')) return t('feedback.invalidConfig');
      if (number && /Text maxLength|Long text requires|Invalid textMode/.test(message)) {
        const config = draft.blocks[number - 1]?.responseConfig;
        return t('worksheetValidation.block', { number, reason: t(isLongText(config) ? 'textAnswer.invalidLong' : 'textAnswer.invalid', { max: textLimitCeiling(config) }) });
      }
      if (message.includes('.content.text is required')) return t('worksheetValidation.emptyReading', { number });
      if (message.includes('.prompt.text is required')) return t('worksheetValidation.emptyPrompt', { number });
      return number ? t('worksheetValidation.block', { number, reason: message.replace(/^draft\.blocks\[\d+\]\.?/, '') }) : message;
    });
    const firstBlock = validation.errors.find(message => /draft\.blocks\[\d+\]/.test(message));
    if (draft?.localId === this.state.draft?.localId) {
      if (firstBlock) {
        const index = Number(firstBlock.match(/draft\.blocks\[(\d+)\]/)[1]);
        this.selectBlock(draft.blocks[index]?.blockId);
      } else if (validation.errors.some(message => /feedback/i.test(message))) {
        this.state.feedbackSettingsDraftId = draft.localId;
      }
    }
    const error = new Error(t('worksheetValidation.fixBeforeContinuing', { details: messages.join('\n') }));
    error.code = 'WORKSHEET_NOT_READY';
    throw error;
  }

  async buildCurrentDraftPackageZipBytes(draft = cloneDraftForPersistence(this.state.draft)) {
    if (!draft) {
      throw new Error(editorNotification('export.noActiveDraft'));
    }
    this.requireReadyWorksheet(draft);
    if (collectLegacyAudioTargets(draft.blocks).length > 0) {
      throw new Error('Legacy audio must be migrated before preview, export, or upload.');
    }
    const assets = new Map();
    const draftAssets = normalizeDraftAssets(draft.assets);
    for (const asset of draftAssets) {
      if (!this.storage.localAssets?.get) continue;
      const stored = await this.storage.localAssets.get(asset.assetId);
      if (stored?.binary) {
        assets.set(asset.assetId, { binary: stored.binary });
      }
    }
    const packagedDraft = {
      ...draft,
      assets: draftAssets,
      metadata: {
        ...draft.metadata,
        modelVersion: 'package-compatible-v2',
      },
    };
    return createWorksheetPackageFromDraft(packagedDraft, assets).bytes;
  }

  beginServerSignIn({ readRecovery = false } = {}) {
    if (this._authPopupFlow) return this._authPopupFlow.promise;
    const previousFlow = this._authPopupFlow;
    this.clearNotificationsBySource('auth.popup');
    this.clearNotificationsBySource('auth.status');
    const authFlowId = createLocalId('auth_flow');
    this._activeAuthFlowId = authFlowId;
    const isCurrent = () => this._activeAuthFlowId === authFlowId;
    // Invalidate the old callbacks before cancellation can invoke them.
    previousFlow?.cancel?.();
    this._authPopupFlow = null;
    this._authPopupWindow = null;

    const finalizeFlow = () => {
      if (!isCurrent()) return;
      this._activeAuthFlowId = null;
      this._authPopupWindow = null;
      this._authPopupFlow = null;
    };

    const flow = startAuthPopupFlow({
      apiClient: this.apiClient,
      source: 'editor',
      authFlowId,
      pollIntervalMs: AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs,
      pollTimeoutMs: AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs,
      shouldContinue: isCurrent,
      onPopupBlocked: () => {
        if (!isCurrent()) return;
        this.pushNotification({
          kind: 'error',
          category: 'server',
          source: 'auth.popup',
          text: editorNotification('auth.signInPopupBlocked'),
        });
        this.notifyStateChange();
      },
      onStatusMessage: (message, status) => {
        if (this._activeAuthFlowId !== authFlowId) return;
        if (status === 'pending') {
          this.pushNotification({
            kind: 'info',
            category: 'server',
            source: 'auth.status',
            text: editorNotification('auth.completeSignInPopup'),
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
          text: editorNotification('auth.signInRefreshing'),
          logActivity: false,
        });
        this.notifyStateChange();
        const result = await this.probeServerSessionSilently({ force: true, isCurrent });
        if (!isCurrent()) return;
        if (result.ok && this.state.serverSession.status === 'ready') {
          if (!readRecovery) await this.loadUploadedDrafts({ preflight: false, isCurrent, recoverAuth: false });
          if (!isCurrent()) return;
          this.clearNotificationsBySource('auth.status');
          this.notifyStateChange();
          finalizeFlow();
          return;
        }
        this.pushNotification({
          kind: 'error',
          category: 'server',
          source: 'auth.status',
          text: getApiErrorMessage(result, 'session'),
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
            text: editorNotification('auth.stillWaitingForPopup'),
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
        if (result?.error || result?.result?.error) {
          this.pushNotification({
            kind: 'error',
            category: 'server',
            source: 'auth.status',
            text: getApiErrorMessage(result, 'session'),
          });
        }
        this.notifyStateChange();
        finalizeFlow();
      },
    });
    // A blocked-popup override may finalize synchronously during startup.
    if (isCurrent()) {
      this._authPopupFlow = flow;
      this._authPopupWindow = flow?.popupWindow || null;
    } else {
      flow?.cancel?.();
    }
    return flow.promise;
  }

  get readAuth() {
    if (!this._readAuth) this._readAuth = createReadAuthFlow({
      probe: options => this.probeServerSessionSilently({ force: true, ...options }),
      subject: () => this.state.serverSession?.user?.sub,
      signIn: () => this.beginServerSignIn({ readRecovery: true }),
      prompt: options => promptForReadSignIn(options),
      redirect: ({ intent, isCurrent, subject }) => redirectReadSignIn({
        app: 'editor', intent, isCurrent, subject: () => subject,
        save: () => this.saveBeforeWorksheetReplacement(),
        localId: () => this.state.draft?.localId,
      }),
      invalidate: reason => {
          this._returnedMutation = null;
          this.state.uploadedDrafts = [];
          this.state.uploadedDraftsError = t(reason === 'account_changed' ? 'readAuth.accountChanged' : 'apiErrors.authRequired');
          if (reason === 'signed_out') this.state.serverSession = { status: 'not_ready', user: null, error: t('apiErrors.authRequired') };
          this._onReadAuthInvalidated?.(reason);
          this.notifyStateChange();
      },
    });
    return this._readAuth;
  }

  async ensureMutationSessionReady(options = {}) {
    const ready = await prepareMutation(this.readAuth, options);
    if (!ready.ok && !ready.result?.skipped && !ready.result?.cancelled && (options.isCurrent?.() ?? true)) {
      this.state.serverActionMessage = getApiErrorMessage(ready.result, 'session');
      this.pushNotification({ kind: 'warn', category: 'server', source: 'session.mutation', text: this.state.serverActionMessage });
      this.notifyStateChange();
    }
    return ready;
  }

  async ensureReadSessionReady(options = {}) {
    const result = await this.readAuth.ensure({ ...options, withContext: true });
    if (!result.ok && !result.skipped && !result.cancelled && (options.isCurrent?.() ?? true)) {
      this.state.serverActionMessage = getApiErrorMessage(result, 'session');
      this.pushNotification({ kind: 'warn', category: 'server', source: 'session.read', text: this.state.serverActionMessage });
      this.notifyStateChange();
    }
    return { ok: result.ok === true, result, isCurrent: result.isCurrent };
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

  async probeServerSessionSilently({ force = false, timeoutMs = null, isCurrent = () => true } = {}) {
    this._sessionStateAdapter ??= createSilentSessionStateAdapter({
      readState: () => this.state.serverSession,
      writeState: state => { this.state.serverSession = state; this.notifyStateChange(); },
    });
    const result = await runOwnedSessionProbe({
      ...this._sessionStateAdapter,
      probe: () => probeSession({ apiClient: this.apiClient, force, timeoutMs: timeoutMs ?? 15000 }),
      presentError: result => getApiErrorMessage(result, 'session'),
      isCurrent,
    });
    this._readAuth?.observe(result);
    return result;
  }

  async ensureServerSessionReady(_legacyMessage = undefined, options = {}) {
    const isCurrent = options.isCurrent || (() => true);
    const result = await this.probeServerSessionSilently({ force: true, timeoutMs: options.timeoutMs, isCurrent });
    if (result.skipped) return { ok: false, result };
    if (!isCurrent()) return { ok: false, result: { ok: false, skipped: true, status: 'superseded' } };
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
      ? editorNotification('auth.sessionExpired')
      : getApiErrorMessage(result, 'session');
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
        error: { message: editorNotification('uploadDraft.alreadyInProgress') },
      };
    }
    const packageFlow = this._uploadPackageFlow;
    if (packageFlow && !packageFlow.canPublish()) return { ok: false, skipped: true, status: 'stale_upload' };
    const draftId = this.state.draft?.localId;
    const generation = this._audioDraftGeneration;
    let accountCurrent = () => true;
    const contextIsCurrent = () => accountCurrent() && (!packageFlow || packageFlow.canPublish()) && this.state.draft?.localId === draftId && this._audioDraftGeneration === generation;
    this.uploadOperations ??= new UploadOperationSlot();
    const operation = this.uploadOperations.begin(contextIsCurrent);
    if (!operation) return { ok: false, skipped: true, status: 'upload_in_progress' };
    this.uploadController = operation.controller;
    this.state.isUploadingDraft = true;
    this.state.uploadDraftProgress = null;
    this.pushNotification({
      kind: 'info',
      category: 'server',
      source: 'upload.status',
      text: editorNotification('uploadDraft.uploading'),
      logActivity: false,
    });
    this.notifyStateChange();
    try {
      // Retain content across user-approved conflict/slot retries, not across
      // separate Save actions. The API client still assigns each request its ID.
      let prepared = packageFlow?.preparedPackage;
      const uploadDraft = prepared ? null : cloneDraftForPersistence(this.state.draft);
      if (uploadDraft) this.requireReadyWorksheet(uploadDraft);
      if (options.preflight !== false) {
        const sessionReady = await this.ensureMutationSessionReady({ isCurrent: () => operation.canPublish(), signal: operation.signal, intent: { kind: 'mutation', operation: 'upload' } });
        if (sessionReady.ok) accountCurrent = sessionReady.isCurrent;
        if (!sessionReady.ok) return sessionReady.result;
      }
      if (!operation.canPublish()) return { ok: false, skipped: true, status: 'stale_upload' };
      if (!prepared && !operation.signal.aborted) {
        prepared = {
          bytes: await this.buildCurrentDraftPackageZipBytes(uploadDraft),
          title: uploadDraft?.title || '',
          subject: uploadDraft?.metadata?.subject || '',
        };
        if (packageFlow?.canPublish()) packageFlow.preparedPackage = prepared;
      }
      if (!operation.canPublish()) return { ok: false, skipped: true, status: 'stale_upload' };
      let lastProgressRenderKey = null;
      const result = operation.signal.aborted ? canceledUploadResult() : await this.apiClient.uploadDraftPackage(prepared.bytes, {
        title: prepared.title,
        subject: prepared.subject,
        conflictAction: options.conflictAction || '',
      }, {
        signal: operation.signal,
        onProgress: (progress) => {
          if (!operation.canProgress()) return;
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
      if (!operation.canPublish()) return result;
      const outcome = classifyUploadResult(result, 'worksheet-draft');
      if (outcome.kind !== 'success') {
        if (outcome.kind === 'slot_limit') {
          const slotLimit = Number(result?.error?.details?.slotLimit);
          if (Number.isFinite(slotLimit) && slotLimit > 0) {
            this.state.uploadedDraftSlotLimit = slotLimit;
          }
        }
        const errorText = getApiErrorMessage(result, 'upload');
        this.pushNotification({ kind: 'error', category: 'server', source: 'upload.status', text: errorText });
        this.notifyStateChange();
        this.readAuth.observe(result);
        return result;
      }
      this.state.lastUploadedDraft = result.data;
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'upload.status',
        text: editorNotification('uploadDraft.uploaded', { id: result.data.uploaded_draft_id }),
      });
      const refreshResult = await this.loadUploadedDrafts({ preflight: false, force: true, signal: operation.signal });
      if (!operation.canPublish()) return result;
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
          text: foundUploadedDraft ? editorNotification('uploadDraft.listRefreshed') : editorNotification('uploadDraft.refreshSucceeded'),
        });
      } else if (refreshResult?.status !== 'superseded') {
        this.pushNotification({
          kind: 'warn',
          category: 'server',
          source: 'upload.refresh',
          text: getApiErrorMessage(refreshResult, 'list'),
        });
      }
      this.notifyStateChange();
      return result;
    } finally {
      if (operation.finish()) {
        this.uploadController = null;
        this.state.isUploadingDraft = false;
        this.state.uploadDraftProgress = null;
        this.notifyStateChange();
      }
    }
  }

  async publishUploadedDraftToServer(uploadedDraftId, metadata = {}, { isCurrent: ownerCurrent = () => true, onPrepared } = {}) {
    const normalizedUploadedDraftId = String(uploadedDraftId || '').trim();
    if (!normalizedUploadedDraftId) {
      return { ok: false, error: { message: editorNotification('uploadDraft.draftIdRequired') } };
    }
    if (this.state.publishingDraftIds.has(normalizedUploadedDraftId)) {
      return {
        ok: false,
        skipped: true,
        error: { message: editorNotification('uploadDraft.publishAlreadyInProgress', { id: normalizedUploadedDraftId }) },
      };
    }
    const generation = this._audioDraftGeneration;
    let accountCurrent = () => true;
    const isCurrent = () => ownerCurrent() && generation === this._audioDraftGeneration && accountCurrent();
    this.state.publishingDraftIds.add(normalizedUploadedDraftId);
    this.pushNotification({ kind: 'info', category: 'server', source: 'publish.status', text: editorNotification('publishedPackage.publishing'), logActivity: false });
    this.notifyStateChange();
    try {
      const outcome = await runPublicationAttempt({
        isCurrent,
        preflight: async () => {
          const ready = await this.ensureMutationSessionReady({ isCurrent, intent: { kind: 'mutation', operation: 'publish', id: normalizedUploadedDraftId, filters: metadata } });
          if (ready.ok) {
            accountCurrent = ready.isCurrent;
            onPrepared?.(accountCurrent);
          }
          return ready;
        },
        submit: () => this.apiClient.publishFromUploadedDraft(normalizedUploadedDraftId, {
          title: metadata.title || '', subject: metadata.subject || '',
        }),
        onSubmitted: publishResult => {
          if (!publishResult.ok) {
            this.pushNotification({ kind: 'error', category: 'server', source: 'publish.status', text: getApiErrorMessage(publishResult, 'publish') });
            this.notifyStateChange();
            this.readAuth.observe(publishResult);
            return;
          }
          this.state.lastPublishedPackage = publishResult.data;
          this.pushNotification({ kind: 'success', category: 'server', source: 'publish.status',
            text: editorNotification('publishedPackage.published', { id: publishResult.data.published_package_id }) });
        },
        refresh: () => this.loadUploadedDrafts({ preflight: false, force: true, isCurrent }),
      });
      if (!isCurrent()) return outcome;
      if (outcome.refreshStatus === 'succeeded') {
        this.pushNotification({ kind: 'success', category: 'server', source: 'publish.refresh',
          text: editorNotification('uploadDraft.publishedRefreshSucceeded') });
      } else if (outcome.refreshStatus === 'failed') {
        this.pushNotification({ kind: 'warn', category: 'server', source: 'publish.refresh',
          text: getApiErrorMessage(outcome.refreshResult, 'list') });
      }
      this.notifyStateChange();
      return outcome;
    } finally {
      this.state.publishingDraftIds.delete(normalizedUploadedDraftId);
      this.notifyStateChange();
    }
  }

  async loadUploadedDrafts(options = {}) {
    const isCurrent = options.isCurrent || (() => true);
    if (!isCurrent()) return { ok: false, status: 'superseded' };
    const shouldPreflight = options.preflight !== false;
    const inflightKey = options.signal ? '_loadUploadedDraftsCancelablePromise' : shouldPreflight
      ? '_loadUploadedDraftsWithPreflightPromise'
      : '_loadUploadedDraftsWithoutPreflightPromise';
    if (!options.force && !options.signal && !options.isCurrent && this[inflightKey]
      && this[`${inflightKey}Owner`] === this._uploadedDraftsRequest) {
      return this[inflightKey];
    }

    const request = {};
    this._uploadedDraftsRequest = request;
    const ownsRequest = () => isCurrent() && this._uploadedDraftsRequest === request;
    const superseded = () => ({ ok: false, skipped: true, status: 'superseded' });
    const loadPromise = (async () => {
      this.state.isLoadingUploadedDrafts = true;
      this.state.uploadedDraftsError = null;
      this.pushNotification({ kind: 'info', category: 'server', source: 'uploadedDrafts.refresh', text: editorNotification('uploadDraft.refreshing'), logActivity: false });
      this.notifyStateChange();

      try {
        let sessionReady = options.prepared || null;
        if (shouldPreflight) {
          sessionReady = await this.ensureReadSessionReady({ isCurrent: ownsRequest, intent: { kind: 'drafts' } });
          if (!ownsRequest()) return superseded();
          if (sessionReady.result?.skipped) return sessionReady.result;
          if (!sessionReady.ok) {
            this.state.uploadedDraftsError = getApiErrorMessage(sessionReady.result, 'list');
            this.state.uploadedDrafts = []; this.notifyStateChange();
            return sessionReady.result;
          }
        }

        const fetchRows = () => this.apiClient.listUploadedDrafts({ signal: options.signal });
        const result = await this.readAuth.read(fetchRows, { preflight: false, prepared: sessionReady, recoverAuth: options.recoverAuth !== false, isCurrent: ownsRequest, signal: options.signal, intent: { kind: 'drafts' } });
        if (!ownsRequest()) return superseded();
        if (result.skipped) return result;
        if (result.ok && !result.isCurrent?.()) return superseded();
        if (!result.ok) {
          this.state.uploadedDraftsError = getApiErrorMessage(result, 'list');
          this.state.uploadedDrafts = [];
          this.pushNotification({ kind: 'warn', category: 'server', source: 'uploadedDrafts.refresh', text: getApiErrorMessage(result, 'list') });
          this.notifyStateChange();
          return result;
        }

        this.state.uploadedDraftsError = null;
        this.state.uploadedDrafts = Array.isArray(result.data?.items) ? result.data.items : [];
        const slotLimit = Number(result?.data?.draftSlotLimit || result?.data?.slotLimit);
        if (Number.isFinite(slotLimit) && slotLimit > 0) {
          this.state.uploadedDraftSlotLimit = slotLimit;
        }
        this.notifyStateChange();
        return result;
      } catch (error) {
        if (!ownsRequest()) return superseded();
        throw error;
      } finally {
        // A dismissed/superseded request must not keep a newer manager busy.
        if (this._uploadedDraftsRequest === request) {
          this.state.isLoadingUploadedDrafts = false;
          this.state.notifications = this.state.notifications.filter((item) => !(
            item?.source === 'uploadedDrafts.refresh' && item?.kind === 'info'
          ));
          this.syncDeprecatedMessageFieldsFromNotifications();
        }
        this.notifyStateChange();
      }
    })();
    if (!options.isCurrent && !options.signal) {
      this[inflightKey] = loadPromise;
      this[`${inflightKey}Owner`] = request;
    }
    try {
      return await loadPromise;
    } finally {
      if (this[inflightKey] === loadPromise) {
        this[inflightKey] = null;
      }
    }
  }

  async downloadWorksheetArtifact(loadToken, fetchArtifact) {
    const controller = new AbortController();
    let timer, timedOut = false, finished = false, lastLoaded = 0;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectTimeout(Object.assign(new Error(t('editor.packageLoad.timeout')), { code: 'DOWNLOAD_TIMEOUT' }));
      }, this.packageDownloadIdleMs);
    };
    resetTimer();
    this.packageLoad.update(loadToken, 'downloading');
    try {
      return await Promise.race([timeout, fetchArtifact({
        signal: controller.signal,
        onProgress: progress => {
          if (finished || timedOut || this.packageLoad.current !== loadToken) return;
          if (Number(progress?.loaded) > lastLoaded) {
            lastLoaded = Number(progress.loaded);
            resetTimer();
          }
          this.packageLoad.update(loadToken, 'downloading', progress);
        },
      })]);
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  }

  async reopenUploadedDraftAsLocalCopy(uploadedDraftId, { isCurrent: callerCurrent = () => true } = {}) {
    if (this.packageLoad.current) return { ok: false, skipped: true };
    const loadToken = this.packageLoad.start(`uploaded:${uploadedDraftId}`);
    const isCurrent = () => this.packageLoad.current === loadToken && callerCurrent();
    try {
      const sessionReady = await this.ensureReadSessionReady({ isCurrent, timeoutMs: this.packageSessionTimeoutMs, intent: { kind: 'draft', id: uploadedDraftId } });
      if (!sessionReady.ok) return sessionReady.result;
      const artifact = await this.readAuth.read(
        () => this.downloadWorksheetArtifact(loadToken, options => this.apiClient.fetchUploadedDraftArtifact(uploadedDraftId, options)),
        { preflight: false, prepared: sessionReady, isCurrent, intent: { kind: 'draft', id: uploadedDraftId } });
      if (artifact.skipped) return artifact;
      if (!artifact.ok) {
        this.pushNotification({ kind: 'error', category: 'server', source: 'uploadedDraft.open', text: getApiErrorMessage(artifact, 'open') });
        this.notifyStateChange();
        return artifact;
      }
      const accountCurrent = artifact.isCurrent || (() => false);
      if (!isCurrent() || !accountCurrent()) return { ok: false, skipped: true, status: 'superseded' };
      const imported = await this.importWorksheetPackageFile(
        createZipFileFromBytes(artifact.data, `uploaded-draft-${uploadedDraftId}.zip`),
        { convertToEditableDraft: true, migrationSource: 'uploaded-draft', loadToken, isCurrent: () => isCurrent() && accountCurrent() }
      );
      if (imported?.canceled) return { ok: false, canceled: true, error: { message: 'Opening canceled. No worksheet was imported or changed.' } };
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'uploadedDraft.open',
        text: editorNotification('uploadDraft.openedAsLocalCopy', { id: uploadedDraftId }),
      });
      this.notifyStateChange();
      return { ok: true, data: imported };
    } finally {
      this.packageLoad.finish(loadToken);
    }
  }

  async reopenPublishedPackageAsLocalCopy(publishedPackageId, { isCurrent: callerCurrent = () => true } = {}) {
    const normalizedPublishedPackageId = String(publishedPackageId || '').trim();
    if (!normalizedPublishedPackageId) {
      return { ok: false, error: { message: editorNotification('publishedPackage.idRequired') } };
    }
    if (this.packageLoad.current || this.state.openingPublishedPackageIds.has(normalizedPublishedPackageId)) {
      return {
        ok: false,
        skipped: true,
        error: { message: editorNotification('publishedPackage.openAlreadyInProgress', { id: normalizedPublishedPackageId }) },
      };
    }
    const loadToken = this.packageLoad.start(`published:${normalizedPublishedPackageId}`);
    this.state.openingPublishedPackageIds.add(normalizedPublishedPackageId);
    this.pushNotification({ kind: 'info', category: 'server', source: 'publishedPackage.open', text: editorNotification('publishedPackage.opening'), logActivity: false });
    this.notifyStateChange();
    const isCurrent = () => this.packageLoad.current === loadToken && callerCurrent();
    try {
      const sessionReady = await this.ensureReadSessionReady({ isCurrent, timeoutMs: this.packageSessionTimeoutMs, intent: { kind: 'publication', id: normalizedPublishedPackageId } });
      if (!sessionReady.ok) return sessionReady.result;
      const artifact = await this.readAuth.read(
        () => this.downloadWorksheetArtifact(loadToken, options => this.apiClient.fetchPublishedPackageArtifact(normalizedPublishedPackageId, options)),
        { preflight: false, prepared: sessionReady, isCurrent, intent: { kind: 'publication', id: normalizedPublishedPackageId } });
      if (artifact.skipped) return artifact;
      if (!artifact.ok) {
        this.pushNotification({ kind: 'error', category: 'server', source: 'publishedPackage.open', text: getApiErrorMessage(artifact, 'open') });
        this.notifyStateChange();
        return artifact;
      }
      const accountCurrent = artifact.isCurrent || (() => false);
      if (!isCurrent() || !accountCurrent()) return { ok: false, skipped: true, status: 'superseded' };
      const imported = await this.importWorksheetPackageFile(
        createZipFileFromBytes(artifact.data, `published-package-${normalizedPublishedPackageId}.zip`),
        { convertToEditableDraft: true, migrationSource: 'published-package', loadToken, isCurrent: () => isCurrent() && accountCurrent() }
      );
      if (imported?.canceled) {
        this.clearNotificationsBySource('publishedPackage.open');
        return { ok: false, canceled: true, error: { message: 'Opening canceled. No worksheet was imported or changed.' } };
      }
      this.pushNotification({
        kind: 'success',
        category: 'server',
        source: 'publishedPackage.open',
        text: editorNotification('publishedPackage.openedAsLocalCopy', { id: normalizedPublishedPackageId }),
      });
      this.notifyStateChange();
      return { ok: true, data: imported };
    } finally {
      this.state.openingPublishedPackageIds.delete(normalizedPublishedPackageId);
      this.packageLoad.finish(loadToken);
      this.notifyStateChange();
    }
  }

  async deleteUploadedDraft(uploadedDraftId, { isCurrent = () => true, confirm } = {}) {
    if (!uploadedDraftId) return { ok: false, skipped: true };
    this._deletingUploadedDraftIds ??= new Set();
    const ownerCurrent = isCurrent;
    let accountCurrent = this.readAuth.captureIdentity();
    isCurrent = () => ownerCurrent() && accountCurrent();
    const result = await runDeletionFlow({
      pending: this._deletingUploadedDraftIds, key: uploadedDraftId, isCurrent, confirm,
      preflight: async () => {
        const ready = await this.ensureMutationSessionReady({ isCurrent, intent: { kind: 'mutation', operation: 'delete-draft', id: uploadedDraftId } });
        if (ready.ok) accountCurrent = ready.isCurrent;
        return ready;
      },
      remove: () => this.apiClient.deleteUploadedDraft(uploadedDraftId),
      refresh: () => this.loadUploadedDrafts({ preflight: false, force: true, isCurrent }),
    });
    if (!isCurrent() || result.skipped || (result.deletionStatus === 'preflight_failed' && !result.cause)) return result;
    this.pushNotification({ kind: result.ok ? 'success' : 'error', category: 'server', source: 'uploadedDraft.delete',
      text: result.ok ? editorNotification('uploadDraft.uploadedDraftDeleted') : getApiErrorMessage(result, 'delete') });
    if (result.refreshStatus === 'succeeded') {
      this.pushNotification({ kind: 'success', category: 'server', source: 'uploadedDraft.delete.refresh', text: editorNotification('uploadDraft.listRefreshed') });
    } else if (result.refreshStatus === 'failed') {
      this.pushNotification({ kind: 'warn', category: 'server', source: 'uploadedDraft.delete.refresh', text: t('apiErrors.deleteRefreshFailed') });
    }
    this.notifyStateChange();
    this.readAuth.observe(result);
    return result;
  }

  async deletePublishedPackage(publishedPackageId, { confirm, isCurrent = () => true, refresh } = {}) {
    const id = String(publishedPackageId || '').trim();
    if (!id) return { ok: false, error: { message: editorNotification('publishedPackage.idRequired') } };
    this._deletingPublishedPackageIds ??= new Set();
    const ownerCurrent = isCurrent;
    let accountCurrent = this.readAuth.captureIdentity();
    isCurrent = () => ownerCurrent() && accountCurrent();
    const result = await runDeletionFlow({
      pending: this._deletingPublishedPackageIds, key: id, confirm, isCurrent, refresh,
      preflight: async () => {
        const ready = await this.ensureMutationSessionReady({ isCurrent, intent: { kind: 'mutation', operation: 'delete-publication', id } });
        if (ready.ok) accountCurrent = ready.isCurrent;
        return ready;
      },
      remove: () => this.apiClient.deletePublishedPackage(id),
    });
    if (!isCurrent() || result.skipped || (result.deletionStatus === 'preflight_failed' && !result.cause)) return result;
    this.pushNotification({ kind: result.ok ? 'success' : 'error', category: 'server', source: 'publishedPackage.delete',
      text: result.ok ? editorNotification('publishedPackage.deleted') : getApiErrorMessage(result, 'delete') });
    if (result.refreshStatus === 'failed') {
      this.pushNotification({ kind: 'warn', category: 'server', source: 'publishedPackage.delete.refresh', text: t('apiErrors.deleteRefreshFailed') });
    }
    this.notifyStateChange();
    this.readAuth.observe(result);
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


  async saveBeforeWorksheetReplacement() {
    if (!this.state.draft) return;
    // Always save at least once: the outgoing draft may not yet be persisted.
    do {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
      const saved = await this.autosave();
      if (!saved) throw new Error(editorNotification('save.manualSaveFailed'));
    } while (this.state.lastSavedRevision < this.state.draftRevision);
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

  async replayProtectedAction(intent, request = {}) {
    const actionId = typeof intent?.actionId === 'string' ? intent.actionId : '';
    const payload = intent?.payload && typeof intent.payload === 'object' ? intent.payload : {};
    this.state.lastProtectedAction = actionId || null;

    switch (actionId) {
      case 'editorPromptT2A':
      case 'resumeT2AAfterLogin':
        return this.replayEditorPromptT2AIntent(payload, request);
      case 'editorOptionT2A':
        return this.replayEditorOptionT2AIntent(payload, request);
      case 'resumeRewriteAfterLogin':
        this.setRecoveryMessage(editorNotification('recovery.rewriteUnavailable'));
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
        message: editorNotification('recovery.audioPromptContextStale'),
      };
    }
    if (payload.target !== 'question_prompt') {
      return {
        ok: false,
        message: editorNotification('recovery.audioPromptTargetMismatch'),
      };
    }
    const blockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const block = blockId ? this.findBlock(blockId) : null;
    if (!block || block.kind !== 'question') {
      return {
        ok: false,
        message: editorNotification('recovery.audioPromptTargetBlockUnavailable'),
      };
    }
    if (payload.language !== undefined && !isAudioTrackLanguage(payload.language)) {
      return { ok: false, message: 'Unsupported worksheet audio language.' };
    }
    return { ok: true };
  }

  async replayEditorPromptT2AIntent(payload = {}, { signal } = {}) {
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
    const promptText = worksheetTextToPlain(block?.prompt).trim();
    const inFlightKey = `prompt:${blockId}`;
    if (this._promptT2AInFlightTargets.has(inFlightKey)) {
      const message = editorNotification('audioGeneration.promptAlreadyInProgress');
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
      const message = editorNotification('audioGeneration.promptRequired');
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'missing_prompt_text',
        error: { message },
      };
    }
    if (Array.from(promptText).length > PROMPT_TEXT_LIMIT) {
      const message = editorNotification('audioGeneration.promptTextTooLong', { max: PROMPT_TEXT_LIMIT });
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
      if (isAudioTrackLanguage(payload.language)) {
        const result = await this.generateAudioTrack(blockId, 'prompt', payload.language, { confirmReplace: true, signal });
        if (result.cancelled) return result;
        if (!result.ok) {
          const message = result.reason === 'generation-failed' ? getApiErrorMessage(result, result.source === 'repository-api' ? 'session' : 'audio', result.source || 'bridge') : (result.error?.message || editorNotification('audioGeneration.failed'));
          this.setRecoveryMessage(message);
          return { ok: false, status: 'generation_failed', error: { ...result.error, message } };
        }
        this.setRecoveryMessage(editorNotification('audioGeneration.promptGenerated'));
        this.pushNotification({ kind: 'success', category: 'editor', source: 'prompt.t2a', text: editorNotification('audioGeneration.promptGenerated') });
        this.notifyStateChange();
        return { ok: true, status: 'generated_editor_prompt_t2a_track', data: { blockId, language: payload.language } };
      }
      const isCurrent = this.captureAudioTarget(blockId, 'prompt', null);
      const audioResult = await this.requestGeneratedAudio(promptText, {}, isCurrent, signal);
      if (['cancelled', 'superseded'].includes(audioResult?.kind)) return { ok: false, cancelled: true, status: 'cancelled', error: audioResult.error };
      if (!audioResult?.ok) {
        const message = getApiErrorMessage(audioResult, audioResult.source === 'repository-api' ? 'session' : 'audio', audioResult.source || 'bridge');
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'prompt.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { ...audioResult.error, message } };
      }
      const audioBytes = toValidGeneratedAudioBytes(audioResult.data);
      if (!audioBytes) {
        const message = editorNotification('audioGeneration.invalidAudioData');
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
      const attachResult = await waitForAudioAttachment(onCommitted => this.attachQuestionMedia(blockId, 'question_audio', generatedFile, {
        confirmReplace: hasExistingQuestionAudio,
        isCurrent: audioResult.isCurrent, onCommitted,
      }), signal);
      if (!attachResult?.ok) {
        const message = attachResult?.error?.code === 'ABORTED' ? getApiErrorMessage(attachResult, 'audio', 'bridge') : String(attachResult?.error?.message || '').trim() || editorNotification('audioGeneration.attachPromptFailed');
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
      this.setRecoveryMessage(editorNotification('audioGeneration.promptGenerated'));
      this.pushNotification({
        kind: 'success',
        category: 'editor',
        source: 'prompt.t2a',
        text: editorNotification('audioGeneration.promptGenerated'),
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
        message: editorNotification('recovery.audioOptionContextStale'),
      };
    }
    if (payload.target !== 'option') {
      return {
        ok: false,
        message: editorNotification('recovery.audioOptionTargetMismatch'),
      };
    }
    const blockId = typeof payload.blockId === 'string' ? payload.blockId : null;
    const optionId = typeof payload.optionId === 'string' ? payload.optionId : null;
    const block = blockId ? this.findBlock(blockId) : null;
    if (!block || block.kind !== 'question') {
      return {
        ok: false,
        message: editorNotification('recovery.audioPromptTargetBlockUnavailable'),
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
        message: editorNotification('recovery.audioOptionTargetUnavailable'),
      };
    }
    if (payload.language !== undefined && !isAudioTrackLanguage(payload.language)) {
      return { ok: false, message: 'Unsupported worksheet audio language.' };
    }
    return { ok: true };
  }

  async replayEditorOptionT2AIntent(payload = {}, { signal } = {}) {
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
      const message = editorNotification('audioGeneration.optionAlreadyInProgress');
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
      const message = editorNotification('audioGeneration.optionTextRequired');
      this.setRecoveryMessage(message);
      this.notifyStateChange();
      return {
        ok: false,
        status: 'missing_option_text',
        error: { message },
      };
    }
    if (optionText.length > T2A_TEXT_MAX_LENGTH) {
      const message = editorNotification('audioGeneration.optionTextTooLong', { max: T2A_TEXT_MAX_LENGTH });
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
      if (isAudioTrackLanguage(payload.language)) {
        const result = await this.generateAudioTrack(blockId, 'option', payload.language, { optionId, confirmReplace: true, signal });
        if (result.cancelled) return result;
        if (!result.ok) {
          const message = result.reason === 'generation-failed' ? getApiErrorMessage(result, result.source === 'repository-api' ? 'session' : 'audio', result.source || 'bridge') : (result.error?.message || editorNotification('audioGeneration.failed'));
          this.setRecoveryMessage(message);
          return { ok: false, status: 'generation_failed', error: { ...result.error, message } };
        }
        this.setRecoveryMessage(editorNotification('audioGeneration.optionGenerated'));
        this.pushNotification({
          kind: 'success',
          category: 'editor',
          source: 'option.t2a',
          text: editorNotification('audioGeneration.optionGenerated'),
          showToast: false,
        });
        this.notifyStateChange();
        return { ok: true, status: 'generated_editor_option_t2a_track', data: { blockId, optionId, language: payload.language } };
      }
      const isCurrent = this.captureAudioTarget(blockId, 'option', optionId);
      const audioResult = await this.requestGeneratedAudio(optionText, {}, isCurrent, signal);
      if (['cancelled', 'superseded'].includes(audioResult?.kind)) return { ok: false, cancelled: true, status: 'cancelled', error: audioResult.error };
      if (!audioResult?.ok) {
        const message = getApiErrorMessage(audioResult, audioResult.source === 'repository-api' ? 'session' : 'audio', audioResult.source || 'bridge');
        this.setRecoveryMessage(message);
        this.pushNotification({
          kind: 'error',
          category: 'editor',
          source: 'option.t2a',
          text: message,
        });
        this.notifyStateChange();
        return { ok: false, status: 'generation_failed', error: { ...audioResult.error, message } };
      }
      const audioBytes = toValidGeneratedAudioBytes(audioResult.data);
      if (!audioBytes) {
        const message = editorNotification('audioGeneration.invalidAudioData');
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
      const attachResult = await waitForAudioAttachment(onCommitted => this.attachOptionAudio(blockId, optionId, generatedFile, {
        confirmReplace: hasExistingOptionAudio,
        isCurrent: audioResult.isCurrent, onCommitted,
      }), signal);
      if (!attachResult?.ok) {
        const message = attachResult?.error?.code === 'ABORTED' ? getApiErrorMessage(attachResult, 'audio', 'bridge') : String(attachResult?.error?.message || '').trim() || editorNotification('audioGeneration.attachOptionFailed');
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
      this.setRecoveryMessage(editorNotification('audioGeneration.optionGenerated'));
      this.pushNotification({
        kind: 'success',
        category: 'editor',
        source: 'option.t2a',
        text: editorNotification('audioGeneration.optionGenerated'),
        showToast: false,
      });
      this.notifyStateChange();
      return { ok: true, status: 'generated_editor_option_t2a', data: { blockId, optionId } };
    } finally {
      this._optionT2AInFlightTargets.delete(inFlightKey);
    }
  }

  async restoreProtectedAction(intent) {
    if (['editorPromptT2A', 'editorOptionT2A', 'resumeT2AAfterLogin'].includes(intent?.actionId)) {
      this.setRecoveryMessage(t('apiErrors.audioRetryRequired'));
      return { ok: true, status: 'explicit_retry_required' };
    }
    return this.replayProtectedAction(intent);
  }

  async triggerProtectedAction(actionId, intentPayload = {}) {
    const payload = {
      ...(intentPayload && typeof intentPayload === 'object' ? intentPayload : {}),
      localDraftId: this.state.draft?.localId || null,
    };

    if (['editorPromptT2A', 'editorOptionT2A'].includes(actionId)) {
      const key = JSON.stringify([payload.blockId, actionId === 'editorOptionT2A' ? payload.optionId : null]);
      if (this._audioOperations.has(key)) return { ok: false, status: 'already_in_flight' };
      const controller = new AbortController();
      this._audioOperations.set(key, controller);
      try {
        const result = await this.replayProtectedAction({ actionId, payload }, { signal: controller.signal });
        return result;
      } finally {
        if (this._audioOperations.get(key) === controller) this._audioOperations.delete(key);
      }
    }
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
  session.destroyEditorDialogs?.();
  session.destroyTextEditor?.();
  session.destroyBlockNavigation?.();
  session.destroyAnswerSettings?.();
  session.destroyMultipleChoiceControls?.();
  session.destroyNotificationPanel?.();
  session.destroyStatusPanel?.();
  session.destroyUploadedDraftsView?.();
  session.destroyPublishedBrowserView?.();
  if (!app) return;

  const shell = document.createElement('div');
  shell.className = 'editor-shell';
  const dialogs = createEditorDialogs({ host: shell, t, createLocalId, formatUploadedDraftTimestamp });
  const { showConfirmDialog, showPublishModal, showPublishedPackageConflictModal, showUploadConflictModal } = dialogs;
  const dialogEvents = new AbortController();
  let shellDisposed = false;
  session.destroyEditorDialogs = () => {
    shellDisposed = true;
    dialogEvents.abort();
    dialogs.destroy();
  };

  const topBar = document.createElement('section');
  topBar.className = 'editor-topbar';
  const layout = document.createElement('section');
  layout.className = 'editor-layout';

  const leftPanel = document.createElement('aside');
  leftPanel.className = 'editor-panel left';
  const rightPanel = document.createElement('section');
  rightPanel.className = 'editor-panel right';
  const feedbackEditor = createFeedbackEditor({
    t,
    changed: () => session.touchDraft(),
    confirm: (options) => showConfirmDialog(options),
    createTargetId: () => createLocalId('target'),
  });
  const feedbackButton = document.createElement('button');
  feedbackButton.type = 'button';
  feedbackButton.id = 'editor-feedback-nav';
  feedbackButton.className = 'sidebar-action-btn';
  const feedbackCaption = document.createElement('span');
  feedbackCaption.className = 'feedback-nav-caption';
  feedbackCaption.innerHTML = feedbackStarIcon;
  const feedbackLabel = document.createElement('span');
  feedbackLabel.textContent = t('feedback.title');
  feedbackCaption.append(feedbackLabel);
  const feedbackBadge = document.createElement('span');
  feedbackBadge.className = 'feedback-config-badge';
  feedbackButton.append(feedbackCaption, feedbackBadge);
  feedbackButton.onclick = () => {
    session.state.feedbackSettingsDraftId = session.state.draft?.localId;
    updateSummary();
  };

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
  moreActionsSummary.textContent = t('feedback.serverFeatures');
  moreActions.appendChild(moreActionsSummary);

  const blockKind = document.createElement('select');
  blockKind.id = 'editor-block-kind';
  blockKind.className = 'control';
  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'application/zip,.zip';
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
  const textEditor = createRichTextEditor(t, (identity, field) => {
    session.updateBlockTextField(identity.draftId, identity.blockId, field);
    refreshPromptT2AControlsForSelectedBlock();
    updateSummary({ preserveDetailEditor: true });
  });
  const blankEditor = createBlankPassageEditor(t, (identity, config) => {
    if (session.state.draft?.localId !== identity.draftId) return;
    const block = session.state.draft.blocks.find(b => b.blockId === identity.blockId);
    if (!isFillInBlanks(block?.responseConfig)) return;
    block.responseConfig = structuredClone(config); session.touchDraft();
    updateSummary({ preserveDetailEditor: true });
  }, options => showConfirmDialog(options));
  session.destroyTextEditor = () => { textEditor.destroy(); blankEditor.destroy(); };

  const questionInputType = document.createElement('select');
  questionInputType.id = 'editor-question-input-type';
  questionInputType.className = 'control';
  [
    { value: 'text', label: getAnswerInputTypeLabel('text') },
    { value: 'number', label: getAnswerInputTypeLabel('number') },
    { value: 'boolean', label: getAnswerInputTypeLabel('boolean') },
    { value: 'multiple_choice', label: getAnswerInputTypeLabel('multiple_choice') },
    { value: 'image_response', label: t('imageResponse.type') },
    { value: 'fill_in_blanks', label: t('fillBlanks.type') },
  ].forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    questionInputType.appendChild(option);
  });
  const answerSettings = createAnswerSettings({
    t, createEditorIcon, getTextDisplayModeLabel, getBooleanAnswerLabel, getNumberQuestionValidationErrors,
    onTextModeChange: async (id, nextMode, restoreLongMode) => {
      const draft = session.state.draft;
      const draftGeneration = session._audioDraftGeneration;
      const configAtClick = JSON.stringify(draft.blocks.find(block => block.blockId === id)?.responseConfig);
      const outcome = session.updateQuestionTextMode(id, nextMode);
      if (outcome.reason === 'confirm-reduction') {
        restoreLongMode();
        const confirmed = await showConfirmDialog({
          title: t('textAnswer.switchTitle'), descriptionText: t('textAnswer.switchDescription', { max: outcome.max }),
          confirmLabel: t('textAnswer.switchConfirm'),
        });
        if (confirmed && session.state.draft?.localId === draft.localId
          && session._audioDraftGeneration === draftGeneration && session.state.selectedBlockId === id
          && JSON.stringify(session.state.draft.blocks.find(block => block.blockId === id)?.responseConfig) === configAtClick) {
          session.updateQuestionTextMode(id, nextMode, { confirmReduction: true });
        }
      }
      updateSummary();
      if (session.state.selectedBlockId === id) rightPanel.querySelector('#editor-question-long-text')?.focus();
    },
    onMaxLengthChange: (id, value) => { session.updateQuestionMaxLength(id, value); updateSummary(); },
    onDisplayModeChange: (id, value) => { session.updateQuestionTextDisplayMode(id, value); updateSummary(); },
    onNumberRangeChange: (id, key, value) => { session.updateQuestionNumberConfig(id, key, value); updateSummary(); },
    onBooleanAnswerChange: (id, value) => { session.updateQuestionCorrectAnswerBoolean(id, value); updateSummary(); },
    onNumberAnswerChange: (id, value) => { session.updateQuestionCorrectAnswerNumber(id, value); updateSummary(); },
    onAllowSignedChange: (id, value) => { session.updateQuestionNumberRulesAllowSigned(id, value); updateSummary(); },
    onDecimalPlacesChange: (id, value) => { session.updateQuestionNumberRulesDecimalPlacesAllowed(id, value); updateSummary(); },
  });
  session.destroyAnswerSettings = answerSettings.destroy;
  const multipleChoiceControls = createMultipleChoiceControls({
    t, createEditorIcon, setIconButtonContent, getSelectionModeLabel,
    onSelectionModeChange: (id, value) => { session.updateQuestionSelectionMode(id, value); updateSummary(); },
    onShuffleChange: (id, value) => { session.updateQuestionShuffleOptions(id, value); updateSummary(); },
    onOptionsTextChange: (id, value) => { session.updateQuestionOptionsFromText(id, value); updateSummary(); },
    onAddOption: id => { session.addQuestionOption(id); updateSummary(); },
  });
  session.destroyMultipleChoiceControls = multipleChoiceControls.destroy;
  const { questionOptions, questionOptionsList, questionOptionWarning, addOptionBtn } = multipleChoiceControls;
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
  const promptTrackGenerationLanguageByBlockId = new Map();
  const optionTrackGenerationLanguageByKey = new Map();
  let openOptionAudioMenuKey = null;
  let promptAudioHintRef = null;
  let mediaActionInFlight = false;
  const loadStatus = document.createElement('p');
  loadStatus.className = 'muted';
  loadStatus.dataset.editorLoadStatus = '1';
  loadStatus.setAttribute('role', 'status');
  loadStatus.setAttribute('aria-live', 'polite');
  function createVisualLoadStatus() {
    const copy = loadStatus.cloneNode(false);
    // Only the persistent shell region announces stages. Modal copies are visual.
    copy.removeAttribute('role');
    copy.removeAttribute('aria-live');
    copy.setAttribute('aria-hidden', 'true');
    return copy;
  }
  const refreshPackageLoadControls = () => {
    const progress = session.packageLoad.current;
    const label = progress ? t(`editor.packageLoad.${progress.stage === 'downloading' && progress.percent !== null ? 'downloadingPercent' : progress.stage}`, { percent: progress.percent }) : '';
    shell.querySelectorAll('[data-editor-package-load]').forEach(button => {
      const active = progress?.id === button.dataset.editorPackageLoad;
      button.disabled = Boolean(progress);
      button.textContent = active ? label : button.dataset.idleLabel;
      button.setAttribute('aria-busy', active ? 'true' : 'false');
      button.setAttribute('aria-label', active ? t(`editor.packageLoad.${progress.stage}`) : button.dataset.idleLabel);
    });
    importBtn.disabled = Boolean(progress);
    startNewWorksheetBtn.disabled = Boolean(progress);
    openViewerBtn.disabled = Boolean(progress);
    const creating = progress?.id === 'new';
    const newLabel = creating ? label : t('editor.actions.startNewWorksheet');
    if (startNewWorksheetBtn.textContent !== newLabel) {
      setMediaActionButtonContent(startNewWorksheetBtn, creating ? 'loading' : 'worksheetPlus', newLabel);
    }
    startNewWorksheetBtn.setAttribute('aria-busy', creating ? 'true' : 'false');
    importBtn.textContent = progress?.id === 'local' ? label : t('editor.actions.importPackage');
    importBtn.setAttribute('aria-busy', progress?.id === 'local' ? 'true' : 'false');
    const spoken = progress ? t(`editor.packageLoad.${progress.stage}`) : '';
    shell.querySelectorAll('[data-editor-load-status]').forEach(status => {
      if (status.textContent !== spoken) status.textContent = spoken;
      status.hidden = !progress;
    });
  };

  const restoreLegacyPromptInFlightMarker = () => {
    promptT2AInFlightBlockId = promptT2AInFlightBlockIds.values().next().value || null;
  };

  const restoreLegacyOptionInFlightMarker = () => {
    optionT2AInFlightKey = optionT2AInFlightKeys.values().next().value || null;
  };

  const closeOpenOptionAudioMenu = ({ restoreFocus = false } = {}) => {
    const openMenu = Array.from(rightPanel.querySelectorAll('details.option-audio-menu[open]'))
      .find((menu) => menu.dataset.optionAudioMenuKey === openOptionAudioMenuKey)
      || rightPanel.querySelector('details.option-audio-menu[open]');
    const trigger = openMenu?.querySelector('[data-option-audio-menu-trigger="1"]');
    if (openMenu) openMenu.open = false;
    openOptionAudioMenuKey = null;
    shell.classList.remove('editor-shell--option-audio-menu-open');
    if (restoreFocus && trigger instanceof HTMLElement) trigger.focus();
  };

  document.addEventListener('pointerdown', (event) => {
    if (dialogs.isConfirmationOpen() || statusPanel.isOpen()) return;
    rightPanel.querySelectorAll('details.audio-track-more-menu[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
    if (!openOptionAudioMenuKey) return;
    const openMenu = Array.from(rightPanel.querySelectorAll('details.option-audio-menu[open]'))
      .find((menu) => menu.dataset.optionAudioMenuKey === openOptionAudioMenuKey);
    if (openMenu && !openMenu.contains(event.target)) closeOpenOptionAudioMenu();
  }, { signal: dialogEvents.signal });

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

  async function confirmAudioLanguageMismatch(text, language, { replacing = false } = {}) {
    const mismatch = getTextLanguageMismatch(text, language);
    if (!mismatch) return { confirmed: true, replacementConfirmed: false };
    const languageLabel = getAudioTrackLanguageLabel(language);
    let bodyText = mismatch === 'chinese_text_for_english'
      ? t('editor.media.audioTracks.confirm.chineseForEnglish', { language: languageLabel })
      : t('editor.media.audioTracks.confirm.englishForChinese', { language: languageLabel });
    if (replacing) bodyText += t('editor.media.audioTracks.confirm.replaceAlso', { language: languageLabel });
    const confirmed = await showConfirmDialog({
      title: t('editor.media.audioTracks.confirm.mismatchTitle', { language: languageLabel }),
      bodyText,
      removalItems: replacing ? [languageLabel] : [],
      confirmLabel: replacing ? t('editor.media.actions.replaceAudio') : t('editor.media.audioTracks.continueAnyway'),
      cancelLabel: t('common.actions.cancel'),
      variant: replacing ? 'danger' : 'warning',
      warningText: t('editor.media.audioTracks.confirm.mismatchWarning'),
    });
    return { confirmed, replacementConfirmed: replacing && confirmed };
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
    if (button?.disabled || session._publishMenuBusy) return null;
    session._publishMenuBusy = true;
    const generation = session._audioDraftGeneration;
    const revision = manageUploadedDraftsDialogRevision;
    let accountCurrent = session.readAuth.captureIdentity();
    const isCurrent = () => accountCurrent() && generation === session._audioDraftGeneration
      && manageUploadedDraftsDialogOpen && revision === manageUploadedDraftsDialogRevision;
    try { return await action(isCurrent, guard => { accountCurrent = guard; }); }
    finally { session._publishMenuBusy = false; updateSummary(); }
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
        successText: editorNotification('clipboard.copiedField', { label: title }),
        failureText: editorNotification('clipboard.unavailable'),
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
      let settled = false;
      let deleting = false;
      const flow = session._uploadPackageFlow;
      const isCurrent = () => !settled && (!flow || flow.canProgress());
      const finish = deleted => {
        if (settled) return;
        settled = true;
        overlay.remove();
        if (previousActive?.isConnected) previousActive.focus();
        resolve({ deleted });
      };
      const list = document.createElement('div');
      const setDeleting = value => {
        deleting = value;
        list.querySelectorAll('button').forEach(button => { button.disabled = value; });
      };
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
          if (deleting || !isCurrent()) return;
          setDeleting(true);
          try {
            const result = await session.deleteUploadedDraft(item.uploaded_draft_id, { isCurrent, confirm: () => showConfirmDialog({
              title: t('editor.uploadedDraft.deleteDialog.title'),
              entityLabel: item.title || t('common.values.untitled'),
              descriptionText: item.published_package_id
                ? t('editor.uploadedDraft.deleteDialog.publishedDescription')
                : t('editor.uploadedDraft.deleteDialog.draftDescription'),
              removalItems: [t('editor.uploadedDraft.deleteDialog.removeArtifact'), t('editor.uploadedDraft.deleteDialog.removeMetadata')],
              confirmLabel: t('editor.uploadedDraft.deleteDialog.confirm'),
            }) });
            if (isCurrent() && result?.ok) finish(true);
          } finally {
            if (!settled) setDeleting(false);
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
        finish(false);
      });
      actions.appendChild(closeBtn);
      dialog.append(heading, description, list, actions);
      overlay.appendChild(dialog);
      shell.appendChild(overlay);
      closeBtn.focus();
    });
  }

  async function runPublishedSearch(options = {}) {
    const request = ++publishedSearchRequest;
    const revision = browsePublishedDialogRevision;
    const isCurrent = () => browsePublishedDialogOpen && revision === browsePublishedDialogRevision && request === publishedSearchRequest && (options.isCurrent?.() ?? true);
    if (!isCurrent()) {
      if (request === publishedSearchRequest) browsePublishedState = { ...browsePublishedState, loading: false };
      return { ok: false, status: 'superseded' };
    }
    const append = options.append === true;
    // Session checks are part of loading too; never show an empty/stale list meanwhile.
    browsePublishedState = { ...browsePublishedState, loading: true, error: null };
    renderPublishedBrowserModal();
    try {
      const sessionReady = options.prepared || await session.ensureReadSessionReady({ isCurrent, intent: { kind: 'published', filters: { title: browsePublishedState.title, subject: browsePublishedState.subject, owner: browsePublishedState.owner } } });
      if (!isCurrent()) {
        if (request === publishedSearchRequest) browsePublishedState = { ...browsePublishedState, loading: false };
        return { ok: false, status: 'superseded' };
      }
      if (sessionReady.result?.skipped) return sessionReady.result;
      if (!sessionReady.ok) {
        const notReadyMessage = getApiErrorMessage(sessionReady.result, 'list');
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
        return sessionReady.result;
      }
      let result;
      try {
        result = await session.readAuth.read(() => session.apiClient.listPublishedPackages({
          title: browsePublishedState.title,
          subject: browsePublishedState.subject,
          owner: browsePublishedState.owner,
          limit: 20,
          offset: append && Number.isFinite(Number(browsePublishedState.nextOffset))
            ? Number(browsePublishedState.nextOffset)
            : 0,
        }), { preflight: false, prepared: sessionReady, isCurrent, intent: { kind: 'published', filters: { title: browsePublishedState.title, subject: browsePublishedState.subject, owner: browsePublishedState.owner } } });
      } catch (error) {
        result = { ok: false, error: { code: 'NETWORK_ERROR' }, cause: error };
      }
      if (!isCurrent()) {
        if (request === publishedSearchRequest) browsePublishedState = { ...browsePublishedState, loading: false };
        return { ok: false, status: 'superseded' };
      }
      if (result.ok && !result.isCurrent?.()) result = { ok: false, skipped: true, status: 'superseded' };
      if (result.skipped) { browsePublishedState = { ...browsePublishedState, loading: false }; renderPublishedBrowserModal(); return result; }
      if (!result.ok) {
        browsePublishedState = {
          ...browsePublishedState,
          loading: false,
          error: getApiErrorMessage(result, 'list'),
          hasMore: false,
          nextOffset: null,
        };
        emitPublishedBrowseNotification({
          kind: 'error',
          source: 'browse.published.search',
          text: getApiErrorMessage(result, 'list'),
        });
        renderPublishedBrowserModal();
        return result;
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
          ? editorNotification('browsePublished.loadedMoreCount', { count: resultItems.length })
          : editorNotification('browsePublished.foundCount', { count: resultItems.length }),
      });
      renderPublishedBrowserModal();
      return result;
    } finally {
      if (request === publishedSearchRequest && browsePublishedState.loading) {
        browsePublishedState = { ...browsePublishedState, loading: false };
        renderPublishedBrowserModal();
      }
    }
  }

  function renderPublishedBrowserModal() {
    const revision = browsePublishedDialogRevision;
    const generation = session._audioDraftGeneration;
    const isCurrent = () => !shellDisposed && browsePublishedDialogOpen
      && revision === browsePublishedDialogRevision && generation === session._audioDraftGeneration;
    publishedBrowserView.render({
      open: browsePublishedDialogOpen,
      title: browsePublishedState.title, subject: browsePublishedState.subject, owner: browsePublishedState.owner,
      loading: browsePublishedState.loading, error: browsePublishedState.error,
      items: browsePublishedState.items, hasMore: browsePublishedState.hasMore,
      currentUserSub: session.state.serverSession?.user?.sub || '',
      openingIds: [...session.state.openingPublishedPackageIds],
    }, isCurrent);
    refreshPackageLoadControls();
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
  const worksheetActionsRow = document.createElement('div');
  worksheetActionsRow.className = 'sidebar-worksheet-actions';
  const startNewWorksheetBtn = document.createElement('button');
  startNewWorksheetBtn.type = 'button';
  startNewWorksheetBtn.className = 'sidebar-action-btn';
  setMediaActionButtonContent(startNewWorksheetBtn, 'worksheetPlus', t('editor.actions.startNewWorksheet'));
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
  const cancelUploadBtn = document.createElement('button');
  cancelUploadBtn.type = 'button';
  cancelUploadBtn.dataset.uploadCancel = 'editor';
  cancelUploadBtn.textContent = t('common.actions.cancel');
  cancelUploadBtn.addEventListener('click', () => session.uploadController?.abort());

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
  signInBtn.textContent = t('feedback.login');
  const serverSessionStatus = document.createElement('p');
  serverSessionStatus.className = 'muted';
  const notificationPanel = createNotificationPanel({ t, requestRefresh: () => updateSummary(),
    presentation: session.notificationPresentation ||= { dismissedIds: new Set() },
  });
  const statusPanel = createStatusPanel({ t, icon: createEditorIcon, backgroundRoot: shell,
    getState: () => session.state, getGeneration: () => session._audioDraftGeneration,
    onRetrySave: () => session.saveNow(),
    onNavigate: target => {
      if (session.state.draft?.localId !== target.draftId) return;
      if (target.kind === 'feedback') session.state.feedbackSettingsDraftId = target.draftId;
      else {
        if (!session.findBlock(target.blockId)) return;
        session.selectBlock(target.blockId);
      }
      updateSummary();
      const panel = target.kind === 'feedback' ? feedbackEditor.root : rightPanel;
      panel.tabIndex = -1; panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' });
    },
  });
  session.destroyStatusPanel = statusPanel.destroy;
  session.destroyNotificationPanel = notificationPanel.destroy;
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
  let publishedSearchRequest = 0;
  let browsePublishedDialogOpen = false;
  let browsePublishedDialogRevision = 0;
  let manageUploadedDraftsDialogOpen = false;
  let manageUploadedDraftsDialogRevision = 0;
  let pendingManagerEntry = null;
  const publishedBrowserView = createPublishedBrowserView({
    root: browsePublishedModalRoot, t, formatTimestamp: formatUploadedDraftTimestamp, createVisualLoadStatus,
    async onCopyLink(item) {
      const viewerUrl = buildPublishedPackageViewerUrl(item.published_package_id);
      const copied = await copyTextToClipboard(viewerUrl);
      emitServerNotification({
        kind: copied ? 'success' : 'warn',
        source: 'clipboard.publishedId',
        text: copied
          ? editorNotification('clipboard.viewerLinkCopied')
          : editorNotification('clipboard.unavailable'),
      });
    },
    async onOpen(item) {
      if (session.packageLoad.current || session.state.openingPublishedPackageIds.has(item.published_package_id)) return;
      const confirmed = await showConfirmDialog({
        title: t('editor.replaceWorksheet.title'),
        bodyText: t('editor.uploadedDraft.openDialog.description', { title: item.title || item.published_package_id }),
        warningText: t('editor.uploadedDraft.openDialog.warning'),
        confirmLabel: t('editor.replaceWorksheet.confirm'),
        variant: 'warning',
      });
      if (!confirmed || session.packageLoad.current) return;
      const revision = browsePublishedDialogRevision;
      const isCurrent = () => browsePublishedDialogOpen && revision === browsePublishedDialogRevision;
      const reopenPromise = session.reopenPublishedPackageAsLocalCopy(item.published_package_id, { isCurrent });
      renderPublishedBrowserModal();
      const reopenResult = await reopenPromise.catch((error) => ({ ok: false, error }));
      if (!isCurrent() || reopenResult?.skipped) return;
      if (reopenResult?.ok) {
        emitPublishedBrowseNotification({
          kind: 'success',
          source: 'browse.published.open',
          text: editorNotification('browsePublished.openedPublishedPackageInEditor', { id: item.published_package_id }),
        });
        browsePublishedDialogOpen = false;
        browsePublishedDialogRevision++;
      } else if (reopenResult?.canceled) {
        browsePublishedState = {
          ...browsePublishedState,
          error: null,
        };
      } else {
        const openError = getApiErrorMessage(reopenResult, 'open');
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
    },
    async onDelete(item) {
      const generation = session._audioDraftGeneration;
      const revision = browsePublishedDialogRevision;
      const isCurrent = () => browsePublishedDialogOpen && revision === browsePublishedDialogRevision && generation === session._audioDraftGeneration;
      await session.deletePublishedPackage(item.published_package_id, {
        isCurrent, refresh: () => runPublishedSearch({ isCurrent }),
        confirm: () => showConfirmDialog({
          title: 'Delete published package?',
          entityLabel: item.title || 'Untitled',
          descriptionText: 'This deletes the published package. Existing viewer links for this package will stop working.',
          removalItems: ['Published package ZIP artifact', 'Published package metadata'],
          confirmLabel: 'Delete package',
        }),
      });
    },
    async onSearch(filters) {
      browsePublishedState = { ...browsePublishedState, ...filters };
      await runPublishedSearch();
    },
    async onRefresh(filters) {
      browsePublishedState = { ...browsePublishedState, ...filters };
      await runPublishedSearch();
    },
    async onLoadMore() {
      await runPublishedSearch({ append: true });
    },
    onClose() {
      browsePublishedDialogOpen = false;
      browsePublishedDialogRevision++;
      renderPublishedBrowserModal();
    },
  });
  session.destroyPublishedBrowserView = publishedBrowserView.destroy;

  const detailViewStates = new Map();
  const detailViewKey = block => `${session.state.draft?.localId}:${block.blockId}`;
  const detailViewState = block => {
    const key = detailViewKey(block);
    if (!detailViewStates.has(key)) detailViewStates.set(key, {
      mediaOpen: true,
      instructionsOpen: Boolean(worksheetTextToPlain(block.prompt).trim()),
      audioLanguage: 'cantonese',
    });
    return detailViewStates.get(key);
  };
  let detailSignature = null;
  let optionActionSignature = null;
  const syncFormControls = () => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    const draftId = session.state.draft?.localId;
    textEditor.prune(new Set((session.state.draft?.blocks || []).map(block => `${draftId}:${block.blockId}`)));
    blankEditor.prune(new Set((session.state.draft?.blocks || []).filter(b=>isFillInBlanks(b.responseConfig)).map(b=>`${draftId}:${b.blockId}`)));
    if (isFillInBlanks(selectedBlock?.responseConfig)) blankEditor.sync(`${draftId}:${selectedBlock.blockId}`, selectedBlock.responseConfig);
    if (selectedBlock) textEditor.sync(`${draftId}:${selectedBlock.blockId}`, selectedBlock.prompt || selectedBlock.content);
    const activeElement = document.activeElement;

    if (activeElement !== titleInput) {
      titleInput.value = session.state.draft?.title || '';
    }
    if (activeElement !== subjectInput) {
      subjectInput.value = session.state.draft?.metadata?.subject || '';
    }
    if (selectedBlock && activeElement !== blockKind) {
      blockKind.value = selectedBlock.kind;
    }
    if (selectedBlock?.kind === 'question') {
      const responseConfig = normalizeQuestionResponseConfig(selectedBlock.responseConfig);
      if (activeElement !== questionInputType) {
        questionInputType.value = responseConfig.inputType || 'text';
      }
    }
    multipleChoiceControls.sync(selectedBlock?.kind === 'question' ? {
      blockId: selectedBlock.blockId,
      responseConfig: normalizeQuestionResponseConfig(selectedBlock.responseConfig),
    } : {});
    answerSettings.sync(selectedBlock?.kind === 'question' ? {
      blockId: selectedBlock.blockId,
      responseConfig: normalizeQuestionResponseConfig(selectedBlock.responseConfig),
    } : {});
  };

  const blockNavigation = createBlockNavigation({
    blockList,
    dialogHost: shell,
    getState: () => ({
      draftId: session.state.draft?.localId,
      blocks: session.state.draft?.blocks || [],
      selectedBlockId: session.state.selectedBlockId,
      feedbackSelected: session.state.feedbackSettingsDraftId === session.state.draft?.localId,
    }),
    onSelect: blockId => { session.selectBlock(blockId); updateSummary(); },
    onMove: (blockId, targetIndex) => {
      session.reorderBlockToIndex(blockId, targetIndex);
      updateSummary({ preserveDetailEditor: true });
    },
    onDelete: async (blockId, displayIndex) => {
      const outcome = session.deleteBlockWithPolicy(blockId);
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
        session.deleteBlockWithPolicy(blockId, { confirmDelete: true });
      }
      updateSummary();
    },
    requestRefresh: () => updateSummary(),
    t, createEditorIcon, getBlockKindLabel,
  });
  session.destroyBlockNavigation = blockNavigation.destroy;

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
      ]).concat(normalizeAudioTracks(selectedBlock?.prompt?.audioTracks).map((track) => [
        track.language, track.assetId, track.sourceTextHash,
      ])))
      : '[]';
    const normalizedOptionMediaRefs = selectedBlock.kind === 'question'
      ? JSON.stringify((normalizedResponseConfig?.options || []).map((opt) => {
        const normalized = normalizeResponseOption(opt);
        return [
          String(normalized.id ?? ''),
          ...normalizeMediaRefs(normalized.mediaRefs).map((ref) => String(ref?.assetId ?? '')),
          ...normalizeAudioTracks(normalized.audioTracks).map((track) => `${track.language}:${track.assetId}:${track.sourceTextHash}`),
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
      session.state.draft?.localId,
      selectedBlock.blockId,
      selectedBlock.kind,
      normalizedInputType,
      normalizedResponseConfig?.displayMode || '',
      normalizedResponseConfig?.textMode || '',
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
        ...normalizeMediaRefs(normalized.mediaRefs).map((ref) => String(ref?.assetId ?? '')),
        ...normalizeAudioTracks(normalized.audioTracks).map((track) => `${track.language}:${track.assetId}:${track.sourceTextHash}`),
        optionTextState.eligible ? '1' : '0',
        optionTextState.exceedsLimit ? '1' : '0',
        isOptionT2AInFlight ? '1' : '0',
      ];
    }));
  };

  const refreshPromptT2AControlsForSelectedBlock = () => {
    if (!promptAudioHintRef) return;
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    if (!selectedBlock || selectedBlock.kind !== 'question' || selectedBlock.blockId !== promptAudioHintRef.blockId) {
      return;
    }
    const promptTextState = getT2ATextEligibility(worksheetTextToPlain(selectedBlock?.prompt), PROMPT_TEXT_LIMIT);
    const isPromptT2AInFlight = promptT2AInFlightBlockIds.has(selectedBlock.blockId)
      || promptT2AInFlightBlockId === selectedBlock.blockId;
    promptAudioHintRef.hint.textContent = promptTextState.exceedsLimit
      ? getEditorTextTooLongForAudioLabel(PROMPT_TEXT_LIMIT)
      : '';
    promptAudioHintRef.hint.hidden = !promptTextState.exceedsLimit;
    const viewState = detailViewState(selectedBlock);
    rightPanel.querySelectorAll('[data-prompt-audio-language]').forEach(button => {
      const language = button.dataset.promptAudioLanguage;
      const attached = Boolean(getAudioTrack(selectedBlock.prompt?.audioTracks, language));
      button.classList.toggle('editor-audio-language--attached', attached);
      button.setAttribute('aria-pressed', String(language === viewState.audioLanguage));
      const label = t('editorLayout.audioLanguageStatus', {
        language: getAudioTrackLanguageLabel(language),
        status: t(attached ? 'editor.block.attachedBadge' : 'editorLayout.noAudio'),
      });
      button.title = label;
      button.setAttribute('aria-label', label);
      button.querySelector('.editor-audio-language-mark').textContent = attached ? '✓' : '−';
      button.disabled = isPromptT2AInFlight;
    });
    const currentTextHash = getAudioSourceTextHash(worksheetTextToPlain(selectedBlock?.prompt));
    document.querySelectorAll(`[data-prompt-audio-track-block-id="${selectedBlock.blockId}"]`).forEach((trackRow) => {
      const language = trackRow.dataset.promptAudioTrackLanguage;
      trackRow.hidden = language !== viewState.audioLanguage;
      const track = getAudioTrack(selectedBlock.prompt?.audioTracks, language);
      const status = trackRow.querySelector('[data-audio-track-status="1"]');
      const stale = trackRow.querySelector('[data-audio-track-stale="1"]');
      const attachBtn = trackRow.querySelector('[data-audio-track-action="attach"]');
      const generateBtn = trackRow.querySelector('[data-audio-track-action="generate"]');
      const playBtn = trackRow.querySelector('[data-audio-track-action="play"]');
      const removeBtn = trackRow.querySelector('[data-audio-track-action="remove"]');
      const cancelBtn = trackRow.querySelector('[data-audio-track-action="cancel"]');
      if (cancelBtn) cancelBtn.hidden = !(isPromptT2AInFlight && promptTrackGenerationLanguageByBlockId.get(selectedBlock.blockId) === language);
      const moreMenu = trackRow.querySelector('.audio-track-more-menu');
      const overflowGenerateBtn = trackRow.querySelector('[data-audio-track-overflow-action="generate"]');
      trackRow.dataset.audioTrackSourceHash = track?.sourceTextHash || '';
      trackRow.classList.toggle('audio-track-row--attached', Boolean(track));
      trackRow.classList.toggle('audio-track-row--empty', !track);
      if (status instanceof HTMLElement) {
        status.className = track ? 'asset-status-badge' : 'asset-status-badge asset-status-badge--empty';
        status.textContent = track ? t('editor.block.attachedBadge') : t('common.values.none');
      }
      if (stale instanceof HTMLElement) {
        stale.hidden = !track || track.sourceTextHash === currentTextHash;
      }
      if (attachBtn instanceof HTMLButtonElement) {
        attachBtn.disabled = isPromptT2AInFlight;
        setMediaActionButtonContent(attachBtn, 'upload', track ? t('editor.media.actions.replace') : t('editor.media.actions.attach'));
      }
      if (generateBtn instanceof HTMLButtonElement) {
        const isThisLanguageGenerating = isPromptT2AInFlight
          && promptTrackGenerationLanguageByBlockId.get(selectedBlock.blockId) === language;
        setMediaActionButtonContent(
          generateBtn,
          isThisLanguageGenerating ? 'loading' : track ? 'refresh' : 'generate',
          isThisLanguageGenerating
            ? t('editor.media.actions.generating')
            : track ? t('editor.media.actions.regenerate') : t('editor.media.actions.generateAudio')
        );
        generateBtn.disabled = !promptTextState.eligible || isPromptT2AInFlight;
      }
      if (overflowGenerateBtn instanceof HTMLButtonElement) {
        overflowGenerateBtn.disabled = !promptTextState.eligible || isPromptT2AInFlight;
      }
      if (playBtn instanceof HTMLButtonElement) playBtn.disabled = !track || isPromptT2AInFlight;
      if (removeBtn instanceof HTMLButtonElement) removeBtn.disabled = !track || isPromptT2AInFlight;
      setAudioTrackMoreMenuDisabled(moreMenu, isPromptT2AInFlight);
    });
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
    const optionTextState = getT2ATextEligibility(option?.label ?? option?.value ?? '');
    const optionT2AKey = `${selectedBlockId}:${optionId}`;
    const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey || optionT2AInFlightKeys.has(optionT2AKey);

    const optionT2AHint = row.querySelector('[data-option-t2a-hint="1"]');
    const optionAudioMenuTrigger = row.querySelector('[data-option-audio-menu-trigger="1"]');
    const isPersistedOption = row.dataset.persistedOption === '1';

    setOptionAudioMenuTriggerState(optionAudioMenuTrigger, {
      hasAudio: normalizeAudioTracks(option.audioTracks).length > 0,
      isGenerating: isOptionT2AInFlight,
      isPersisted: isPersistedOption,
    });
    if (optionT2AHint instanceof HTMLElement) {
      optionT2AHint.hidden = !isPersistedOption || !optionTextState.exceedsLimit;
      optionT2AHint.textContent = optionTextState.exceedsLimit
        ? getEditorTextTooLongForAudioLabel(T2A_TEXT_MAX_LENGTH)
        : '';
    }
    const currentTextHash = getAudioSourceTextHash(option?.label ?? option?.value ?? '');
    row.querySelectorAll('[data-option-audio-track-language]').forEach((trackSection) => {
      const language = trackSection.dataset.optionAudioTrackLanguage;
      const track = getAudioTrack(option.audioTracks, language);
      const status = trackSection.querySelector('[data-audio-track-status="1"]');
      const stale = trackSection.querySelector('[data-audio-track-stale="1"]');
      const attachBtn = trackSection.querySelector('[data-option-audio-action="attach"]');
      const generateBtn = trackSection.querySelector('[data-option-audio-action="generate"]');
      const playBtn = trackSection.querySelector('[data-option-audio-action="play"]');
      const removeBtn = trackSection.querySelector('[data-option-audio-action="remove"]');
      const cancelBtn = trackSection.querySelector('[data-option-audio-action="cancel"]');
      if (cancelBtn) cancelBtn.hidden = !(isOptionT2AInFlight && optionTrackGenerationLanguageByKey.get(optionT2AKey) === language);
      const moreMenu = trackSection.querySelector('.audio-track-more-menu');
      trackSection.dataset.audioTrackSourceHash = track?.sourceTextHash || '';
      trackSection.classList.toggle('option-audio-track--attached', Boolean(track));
      trackSection.classList.toggle('option-audio-track--empty', !track);
      if (status instanceof HTMLElement) {
        status.className = track
          ? 'asset-status-badge option-audio-track__status'
          : 'option-audio-track__status option-audio-track__status--empty';
        status.textContent = track ? t('editor.block.attachedBadge') : t('common.values.none');
      }
      if (stale instanceof HTMLElement) stale.hidden = !track || track.sourceTextHash === currentTextHash;
      if (attachBtn instanceof HTMLButtonElement) {
        attachBtn.disabled = !isPersistedOption || isOptionT2AInFlight;
        setMediaActionButtonContent(attachBtn, 'upload', track ? t('editor.media.actions.replace') : t('editor.media.actions.attach'));
      }
      if (generateBtn instanceof HTMLButtonElement) {
        const isThisLanguageGenerating = isOptionT2AInFlight
          && optionTrackGenerationLanguageByKey.get(optionT2AKey) === language;
        setMediaActionButtonContent(
          generateBtn,
          isThisLanguageGenerating ? 'loading' : track ? 'refresh' : 'generate',
          isThisLanguageGenerating
            ? t('editor.media.actions.generating')
            : track ? t('editor.media.actions.regenerate') : t('editor.media.actions.generate')
        );
        generateBtn.disabled = !isPersistedOption || !optionTextState.eligible || isOptionT2AInFlight;
      }
      if (playBtn instanceof HTMLButtonElement) playBtn.disabled = !isPersistedOption || !track || isOptionT2AInFlight;
      if (removeBtn instanceof HTMLButtonElement) removeBtn.disabled = !isPersistedOption || !track || isOptionT2AInFlight;
      setAudioTrackMoreMenuDisabled(moreMenu, !isPersistedOption || isOptionT2AInFlight);
    });
  };

  const renderDetailEditor = ({ force = false } = {}) => {
    const selectedBlock = session.state.draft?.blocks?.find((block) => block.blockId === session.state.selectedBlockId);
    if (openOptionAudioMenuKey) {
      const responseConfig = selectedBlock?.kind === 'question'
        ? normalizeQuestionResponseConfig(selectedBlock.responseConfig)
        : null;
      const selectedMenuKeys = new Set((responseConfig?.options || []).map((option, index) => {
        const normalized = normalizeResponseOption(option, `option_${index}`);
        return `${selectedBlock.blockId}:${String(normalized.id || '')}`;
      }));
      if (responseConfig?.inputType !== 'multiple_choice' || !selectedMenuKeys.has(openOptionAudioMenuKey)) {
        openOptionAudioMenuKey = null;
        shell.classList.remove('editor-shell--option-audio-menu-open');
      }
    }
    const activeOptionAudioAction = (
      typeof HTMLButtonElement !== 'undefined' &&
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.dataset.optionAudioAction &&
      questionOptionsList.contains(document.activeElement)
    ) ? {
        menuKey: document.activeElement.dataset.optionAudioMenuKey || '',
        language: document.activeElement.dataset.optionAudioLanguage || '',
        action: document.activeElement.dataset.optionAudioAction || '',
        surface: document.activeElement.dataset.optionAudioActionSurface || '',
      } : null;
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
    const focusedPromptControl = rightPanel.contains(document.activeElement) ? document.activeElement : null;
    const focusedPromptRow = focusedPromptControl?.closest('[data-prompt-audio-track-block-id]');
    const focusedPromptLanguage = focusedPromptControl?.dataset.promptAudioLanguage
      || (focusedPromptRow && focusedPromptRow.dataset.promptAudioTrackBlockId === selectedBlock?.blockId ? focusedPromptRow.dataset.promptAudioTrackLanguage : null);
    const focusedPromptAction = focusedPromptControl?.dataset.audioTrackAction;
    detailSignature = nextSignature;
    optionActionSignature = nextOptionActionSignature;
    multipleChoiceControls.resetRows();
    rightPanel.innerHTML = '';
    const detailHeader = document.createElement('div');
    detailHeader.className = 'block-detail-header';
    const detailTitleGroup = document.createElement('div');
    detailTitleGroup.className = 'block-detail-header__title';
    detailTitleGroup.appendChild(rightHeading);
    const detailActions = document.createElement('div');
    detailActions.className = 'block-detail-header__actions';
    if (!selectedBlock) {
      promptAudioHintRef = null;
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
      promptAudioHintRef = null;
      rightPanel.appendChild(createEditorSectionHeader({ icon: 'pencil', title: t('editor.block.contentSectionTitle') }));
      const contentLabel = document.createElement('label');
      contentLabel.textContent = t('editor.block.contentTextLabel');
      contentLabel.htmlFor = 'editor-block-editor';
      textEditor.mount(rightPanel, contentLabel, `${session.state.draft.localId}:${selectedBlock.blockId}`, selectedBlock.content, false, { draftId: session.state.draft.localId, blockId: selectedBlock.blockId });
      return;
    }

    const activeInputType = selectedBlock.responseConfig?.inputType || 'text';
    const viewState = detailViewState(selectedBlock);
    const inputTypeField = document.createElement('div');
    inputTypeField.className = 'editor-question-type';
    const inputTypeLabel = document.createElement('label');
    inputTypeLabel.textContent = t('editorLayout.questionType');
    inputTypeLabel.htmlFor = 'editor-question-input-type';
    inputTypeField.append(inputTypeLabel, questionInputType);
    rightPanel.append(inputTypeField);
    let promptHost = rightPanel;
    if (activeInputType === 'fill_in_blanks') {
      rightPanel.appendChild(createEditorSectionHeader({ icon: 'pencil', title: t('editorLayout.passageTitle') }));
      blankEditor.mount(rightPanel, `${session.state.draft.localId}:${selectedBlock.blockId}`, selectedBlock.responseConfig, { draftId: session.state.draft.localId, blockId: selectedBlock.blockId });
      const instructions = document.createElement('details');
      instructions.className = 'editor-disclosure editor-instructions';
      instructions.open = viewState.instructionsOpen;
      instructions.addEventListener('toggle', () => { if (instructions.isConnected) viewState.instructionsOpen = instructions.open; });
      const summary = document.createElement('summary');
      summary.textContent = t('editorLayout.instructions');
      promptHost = document.createElement('div');
      promptHost.className = 'editor-disclosure-body';
      instructions.append(summary, promptHost);
      rightPanel.append(instructions);
    } else {
      rightPanel.appendChild(createEditorSectionHeader({ icon: 'pencil', title: t('editor.block.questionSectionTitle') }));
    }
    const promptLabel = document.createElement('label');
    promptLabel.textContent = t(activeInputType === 'fill_in_blanks' ? 'editorLayout.instructionsOptional' : 'editor.block.promptLabel');
    promptLabel.htmlFor = 'editor-block-editor';
    textEditor.mount(promptHost, promptLabel, `${session.state.draft.localId}:${selectedBlock.blockId}`, selectedBlock.prompt, true, { draftId: session.state.draft.localId, blockId: selectedBlock.blockId });

    const promptMediaRefs = normalizeMediaRefs(selectedBlock?.prompt?.mediaRefs);
    const currentQuestionImageRef = getSingleMediaRef(promptMediaRefs, 'question_image');

    const mediaSection = document.createElement('details');
    mediaSection.className = 'editor-disclosure editor-prompt-media media-section';
    mediaSection.open = viewState.mediaOpen;
    mediaSection.addEventListener('toggle', () => { if (mediaSection.isConnected) viewState.mediaOpen = mediaSection.open; });
    const mediaSummary = document.createElement('summary');
    mediaSummary.textContent = t('editorLayout.mediaAudio');
    mediaSection.append(mediaSummary);
    const mediaRows = document.createElement('div');
    mediaRows.className = 'media-row-list media-row-list--flat';
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
    setMediaActionButtonContent(attachImageBtn, 'image', currentQuestionImageRef ? t('editor.media.actions.replace') : t('editor.media.actions.attach'));
    const removeImageBtn = document.createElement('button');
    removeImageBtn.type = 'button';
    removeImageBtn.className = 'media-action-btn media-action-btn--remove';
    setMediaActionButtonContent(removeImageBtn, 'trash', t('editor.media.actions.remove'));
    removeImageBtn.disabled = !currentQuestionImageRef;
    const viewImageBtn = document.createElement('button');
    viewImageBtn.type = 'button';
    viewImageBtn.className = 'media-action-btn';
    setMediaActionButtonContent(viewImageBtn, 'eye', t('editor.media.actions.view'));
    viewImageBtn.disabled = !currentQuestionImageRef;
    attachImageBtn.addEventListener('click', () => {
      questionImageInput.dataset.blockId = selectedBlock.blockId;
      questionImageInput.value = '';
      questionImageInput.click();
    });
    removeImageBtn.addEventListener('click', async () => {
      await runMediaAction(async () => {
        const confirmed = await confirmDangerAction({
          title: t('editor.media.confirm.removeQuestionImageTitle'),
          bodyText: t('editor.media.confirm.removeQuestionImageBody'),
          confirmLabel: t('editor.media.actions.removeImage'),
          removalItems: [t('editor.media.confirm.currentQuestionImageAttachment')],
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

    const promptTextState = getT2ATextEligibility(worksheetTextToPlain(selectedBlock?.prompt), PROMPT_TEXT_LIMIT);
    const promptT2AEligible = promptTextState.eligible;
    const isPromptT2AInFlight = promptT2AInFlightBlockIds.has(selectedBlock.blockId)
      || promptT2AInFlightBlockId === selectedBlock.blockId;
    const questionAudioHint = document.createElement('p');
    questionAudioHint.className = 'muted';
    questionAudioHint.textContent = promptTextState.exceedsLimit
      ? getEditorTextTooLongForAudioLabel(PROMPT_TEXT_LIMIT)
      : '';
    questionAudioHint.hidden = !promptTextState.exceedsLimit;
    promptAudioHintRef = { blockId: selectedBlock.blockId, hint: questionAudioHint };
    const audioHeading = document.createElement('div');
    audioHeading.className = 'editor-prompt-audio-heading';
    const audioTitle = document.createElement('strong');
    audioTitle.textContent = t('editor.block.promptAudioLabel');
    const languages = document.createElement('div');
    languages.className = 'editor-audio-languages';
    languages.setAttribute('role', 'group');
    languages.setAttribute('aria-label', t('editorLayout.audioLanguage'));
    for (const language of AUDIO_TRACK_LANGUAGE_IDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'editor-audio-language';
      button.dataset.promptAudioLanguage = language;
      const label = document.createElement('span');
      label.textContent = { cantonese: '粵', mandarin: '普', english: 'EN' }[language];
      const status = document.createElement('span');
      status.className = 'editor-audio-language-mark';
      status.setAttribute('aria-hidden', 'true');
      button.append(label, status);
      button.addEventListener('click', () => {
        viewState.audioLanguage = language;
        languageTrackRows.querySelectorAll('details[open]').forEach(menu => { menu.open = false; });
        refreshPromptT2AControlsForSelectedBlock();
      });
      languages.append(button);
    }
    audioHeading.append(audioTitle, languages);
    const languageTrackRows = document.createElement('div');
    languageTrackRows.className = 'media-row-list media-row-list--flat audio-track-row-list audio-track-row-list--flat editor-prompt-audio-tracks';
    AUDIO_TRACK_LANGUAGE_IDS.forEach((language) => {
      const track = getAudioTrack(selectedBlock.prompt?.audioTracks, language);
      const isTrackGenerating = isPromptT2AInFlight
        && promptTrackGenerationLanguageByBlockId.get(selectedBlock.blockId) === language;
      const trackRow = document.createElement('div');
      trackRow.className = `media-row audio-track-row ${track ? 'audio-track-row--attached' : 'audio-track-row--empty'}`;
      trackRow.hidden = language !== viewState.audioLanguage;
      trackRow.dataset.promptAudioTrackBlockId = selectedBlock.blockId;
      trackRow.dataset.promptAudioTrackLanguage = language;
      trackRow.dataset.audioTrackSourceHash = track?.sourceTextHash || '';
      const trackMeta = document.createElement('div');
      trackMeta.className = 'media-row__meta';
      const trackTitle = document.createElement('span');
      trackTitle.className = 'media-row__title';
      trackTitle.textContent = getAudioTrackLanguageLabel(language);
      const trackStatus = document.createElement('span');
      trackStatus.dataset.audioTrackStatus = '1';
      trackStatus.className = track ? 'asset-status-badge' : 'asset-status-badge asset-status-badge--empty';
      trackStatus.textContent = track ? t('editor.block.attachedBadge') : t('common.values.none');
      trackMeta.append(trackTitle, trackStatus);
      const stale = document.createElement('span');
      stale.className = 'asset-status-badge asset-status-badge--warn';
      stale.dataset.audioTrackStale = '1';
      stale.textContent = t('editor.media.audioTracks.textChanged');
      stale.hidden = !track || track.sourceTextHash === getAudioSourceTextHash(worksheetTextToPlain(selectedBlock.prompt));
      trackMeta.appendChild(stale);
      const actions = document.createElement('div');
      actions.className = 'media-row__actions';
      const attachBtn = document.createElement('button');
      attachBtn.type = 'button'; attachBtn.className = 'media-action-btn';
      attachBtn.dataset.audioTrackAction = 'attach';
      setMediaActionButtonContent(attachBtn, 'upload', track ? t('editor.media.actions.replace') : t('editor.media.actions.attach'));
      attachBtn.disabled = isPromptT2AInFlight;
      const attachPromptTrack = () => {
        questionAudioInput.dataset.blockId = selectedBlock.blockId;
        questionAudioInput.dataset.language = language;
        questionAudioInput.value = '';
        questionAudioInput.click();
      };
      attachBtn.addEventListener('click', attachPromptTrack);
      const generateBtn = document.createElement('button');
      generateBtn.type = 'button'; generateBtn.className = 'media-action-btn';
      generateBtn.dataset.audioTrackAction = 'generate';
      setMediaActionButtonContent(
        generateBtn,
        isTrackGenerating ? 'loading' : track ? 'refresh' : 'generate',
        isTrackGenerating
          ? t('editor.media.actions.generating')
          : track ? t('editor.media.actions.regenerate') : t('editor.media.actions.generateAudio')
      );
      generateBtn.disabled = !promptT2AEligible || isPromptT2AInFlight;
      const generatePromptTrack = async () => {
        const blockId = selectedBlock.blockId;
        const latestBlock = session.state.draft?.blocks?.find((block) => block.blockId === blockId);
        const latestPromptText = worksheetTextToPlain(latestBlock?.prompt);
        if (!getT2ATextEligibility(latestPromptText, PROMPT_TEXT_LIMIT).eligible || promptT2AInFlightBlockIds.has(blockId)) return;
        session.stopPreviewAudio();
        promptT2AInFlightBlockIds.add(blockId);
        promptTrackGenerationLanguageByBlockId.set(blockId, language);
        restoreLegacyPromptInFlightMarker();
        refreshPromptT2AControlsForSelectedBlock();
        try {
          const latestTrack = getAudioTrack(latestBlock?.prompt?.audioTracks, language);
          const warning = await confirmAudioLanguageMismatch(latestPromptText, language, { replacing: Boolean(latestTrack) });
          if (!warning.confirmed) return;
          if (latestTrack && !warning.replacementConfirmed) {
            const confirmed = await confirmDangerAction({
              title: t('editor.media.audioTracks.confirm.regenerateTitle', { language: getAudioTrackLanguageLabel(language) }),
              bodyText: t('editor.media.audioTracks.confirm.regeneratePromptBody', { language: getAudioTrackLanguageLabel(language) }),
              confirmLabel: t('editor.media.actions.regenerateAudio'),
              removalItems: [getAudioTrackLanguageLabel(language)],
            });
            if (!confirmed) return;
          }
          const result = await session.triggerProtectedAction('editorPromptT2A', {
            blockId,
            target: 'question_prompt',
            language,
          });
          if (!result?.ok && !result?.cancelled && result?.status !== 'executed' && result?.status !== 'redirected') {
            session.setMediaFeedback(result?.reason === 'generation-failed' ? getApiErrorMessage(result, result.source === 'repository-api' ? 'session' : 'audio', result.source || 'bridge') : (result?.error?.message || editorNotification('audioGeneration.failed')));
          }
        } finally {
          promptT2AInFlightBlockIds.delete(blockId);
          promptTrackGenerationLanguageByBlockId.delete(blockId);
          restoreLegacyPromptInFlightMarker();
          refreshPromptT2AControlsForSelectedBlock();
          updateSummary();
        }
      };
      generateBtn.addEventListener('click', generatePromptTrack);
      const playBtn = document.createElement('button');
      playBtn.type = 'button'; playBtn.className = 'media-action-btn';
      playBtn.dataset.audioTrackAction = 'play';
      setMediaActionButtonContent(playBtn, 'play', t('editor.media.actions.play'));
      playBtn.disabled = !track || isPromptT2AInFlight;
      playBtn.addEventListener('click', async () => {
        if (!track) return;
        playBtn.disabled = true;
        const result = await session.playAssetAudio(track.assetId, { onEnded: () => { playBtn.disabled = false; }, onError: () => { playBtn.disabled = false; }, onInterrupted: () => { playBtn.disabled = false; } });
        if (!result.ok) playBtn.disabled = false;
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.className = 'media-action-btn media-action-btn--remove';
      removeBtn.dataset.audioTrackAction = 'remove';
      setMediaActionButtonContent(removeBtn, 'trash', t('editor.media.actions.remove'));
      removeBtn.disabled = !track || isPromptT2AInFlight;
      const removePromptTrack = async () => {
        if (!track) return;
        const confirmed = await confirmDangerAction({
          title: t('editor.media.audioTracks.confirm.removeTitle', { language: getAudioTrackLanguageLabel(language) }),
          bodyText: t('editor.media.audioTracks.confirm.removePromptBody', { language: getAudioTrackLanguageLabel(language) }),
          confirmLabel: t('editor.media.actions.removeAudio'),
          removalItems: [getAudioTrackLanguageLabel(language)],
        });
        if (!confirmed) return;
        session.removeAudioTrack(selectedBlock.blockId, 'prompt', language, { confirmRemove: true });
        updateSummary();
      };
      removeBtn.addEventListener('click', removePromptTrack);
      let moreMenu = null;
      if (track) {
        moreMenu = createAudioTrackMoreMenu({
          languageLabel: getAudioTrackLanguageLabel(language),
          actionButtons: [removeBtn],
          className: 'audio-track-more-menu--prompt',
        });
        setAudioTrackMoreMenuDisabled(moreMenu, isPromptT2AInFlight);
      }
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.className = 'media-action-btn';
      cancelBtn.dataset.audioTrackAction = 'cancel';
      cancelBtn.textContent = t('common.actions.cancel');
      cancelBtn.hidden = !isTrackGenerating;
      cancelBtn.addEventListener('click', () => session.cancelAudioGeneration(selectedBlock.blockId));
      actions.append(attachBtn, generateBtn, cancelBtn, playBtn);
      if (moreMenu) actions.appendChild(moreMenu);
      trackRow.append(trackMeta, actions);
      languageTrackRows.appendChild(trackRow);
    });
    const audioSourceHint = document.createElement('p');
    audioSourceHint.className = 'muted editor-audio-source-hint';
    audioSourceHint.textContent = t(activeInputType === 'fill_in_blanks' ? 'editorLayout.instructionsAudioHint' : 'editorLayout.promptAudioHint');
    mediaRows.append(questionImageRow, audioHeading, languageTrackRows, audioSourceHint);
    // Avoid the rich editor scrolling its selection between pointer-down and click.
    mediaRows.querySelectorAll('button').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
    });
    mediaSection.append(mediaRows, questionAudioHint, mediaFeedback);
    rightPanel.appendChild(mediaSection);
    refreshPromptT2AControlsForSelectedBlock();

    const answerSection = document.createElement('section');
    answerSection.className = 'editor-detail-section answer-section';
    answerSection.appendChild(createEditorSectionHeader({ icon: 'list', title: t('editor.question.answerSectionTitle') }));
    const answerGrid = document.createElement('div');
    answerGrid.className = 'answer-grid';
    const imageCount = imageQuestions(session.state.draft.blocks).length;
    const imageTypeOption = questionInputType.querySelector('[value="image_response"]');
    imageTypeOption.textContent = t('imageResponse.typeCount', { count: imageCount });
    imageTypeOption.disabled = imageCount >= 3 && activeInputType !== 'image_response';
    const imageNotice = document.createElement('p'); imageNotice.className='muted';
    imageNotice.textContent=t(imageCount >= 3 ? 'imageResponse.questionLimit' : 'imageResponse.typeCount', {count:imageCount});
    inputTypeField.append(imageNotice);
    if (activeInputType === 'image_response') {
      const field=document.createElement('div');field.className='editor-field';
      const label=document.createElement('label');label.htmlFor='editor-max-images';label.textContent=t('imageResponse.maxImages');
      const select=document.createElement('select');select.id='editor-max-images';select.className='control';
      for(const n of [1,2,3])select.add(new Option(String(n),String(n),false,n===selectedBlock.responseConfig.maxImages));
      select.onchange=()=>{selectedBlock.responseConfig.maxImages=Number(select.value);session.touchDraft();updateSummary();};
      const hint=document.createElement('p');hint.className='muted';hint.textContent=t('imageResponse.rules');
      field.append(label,select,hint);answerSection.append(field);
    }
    if (imageCount) {
      const budget = document.createElement('p');
      budget.className = 'muted';
      budget.dataset.imageBudget = '';
      inputTypeField.append(budget);
    }

    if (activeInputType === 'multiple_choice') {
      answerGrid.appendChild(multipleChoiceControls.selectionModeField);
    }
    answerSection.appendChild(answerGrid);
    answerSettings.mount(answerSection, selectedBlock, activeInputType);

    if (activeInputType !== 'multiple_choice' && activeInputType !== 'fill_in_blanks') {
      rightPanel.appendChild(answerSection);
    }



    if (activeInputType === 'multiple_choice') {
      answerSection.append(multipleChoiceControls.shuffleRow);

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
      multipleChoiceControls.setWarning(duplicateOptionValues.length > 0
        ? `Option values must be unique. Duplicate values: ${duplicateOptionValues.join(', ')}.`
        : isNonEmptyString(normalizedResponseConfig.correctAnswerMappingWarning)
          ? normalizedResponseConfig.correctAnswerMappingWarning : '');

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
        const isSelected = isMultiSelect
          ? selectedOptionIds.has(optionId)
          : hasSelectedSingleOptionId && selectedSingleOptionId === optionId;
        const { row, optionInput, correctToggle, removeBtn } = multipleChoiceControls.createRow({
          optionId, optionIndex, label: optionDisplayText, isPersistedOption, isSelected, isMultiSelect,
          onToggleCorrect: () => {
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
          },
          onTextChange: value => {
            const persistedOptionId = session.updateQuestionOptionAtIndex(
              selectedBlock.blockId,
              optionIndex,
              value,
              { optionId }
            );
            if (persistedOptionId === optionId) row.dataset.persistedOption = '1';
            refreshOptionRowT2AControls(selectedBlock.blockId, optionId, row);
            updateSummary({ preserveDetailEditor: true });
          },
          onPaste: async event => {
            const pastedText = event.clipboardData?.getData('text') || '';
            if (mapOptionsTextToLines(pastedText).length <= 1) return;
            event.preventDefault();
            const outcome = session.applyQuestionOptionMultilinePaste(
              selectedBlock.blockId,
              optionIndex,
              pastedText
            );
            if (outcome?.reason === 'confirm-audio-removal-required') {
              const audioOptionCount = Number.isInteger(outcome.audioOptionCount)
                ? outcome.audioOptionCount
                : 0;
              const confirmed = await confirmDangerAction({
                title: t('editor.question.multilinePasteConfirm.title'),
                bodyText: t('editor.question.multilinePasteConfirm.description', { count: audioOptionCount }),
                confirmLabel: t('editor.question.multilinePasteConfirm.confirmLabel'),
                removalItems: [t('editor.question.multilinePasteConfirm.audioRemoval')],
              });
              if (!confirmed) return;
              session.applyQuestionOptionMultilinePaste(
                selectedBlock.blockId,
                optionIndex,
                pastedText,
                { confirmRemoveAudio: true }
              );
            }
            updateSummary({ preserveDetailEditor: true });
          },
          onRemove: async () => {
            const outcome = session.removeQuestionOptionWithPolicy(selectedBlock.blockId, optionIndex);
            if (!outcome.ok && outcome.reason === 'confirm-delete-required') {
              const removalItems = [];
              if (outcome.policy.hasTypedContent) {
                removalItems.push('Option value/text used in answers.');
              }
              if (outcome.policy.hasAssets) {
                removalItems.push('Option image/audio files and attachment metadata.');
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
          },
        });
        const optionActionsMenu = document.createElement('details');
        optionActionsMenu.className = 'option-actions-menu option-audio-menu';
        optionActionsMenu.dataset.optionAudioMenuKey = optionT2AKey;
        if (openOptionAudioMenuKey === optionT2AKey) {
          optionActionsMenu.open = true;
          shell.classList.add('editor-shell--option-audio-menu-open');
        }
        const optionAudioMenuTrigger = document.createElement('summary');
        optionAudioMenuTrigger.className = 'icon-btn option-actions-menu__toggle option-audio-menu__toggle';
        optionAudioMenuTrigger.dataset.optionAudioMenuTrigger = '1';
        optionAudioMenuTrigger.setAttribute('role', 'button');
        setOptionAudioMenuTriggerState(optionAudioMenuTrigger, {
          hasAudio: normalizeAudioTracks(option.audioTracks).length > 0,
          isGenerating: isOptionT2AInFlight,
          isPersisted: isPersistedOption,
        });
        optionAudioMenuTrigger.addEventListener('click', (event) => {
          event.preventDefault();
          if (optionActionsMenu.open) {
            closeOpenOptionAudioMenu();
            return;
          }
          rightPanel.querySelectorAll('details.option-audio-menu[open]').forEach((otherMenu) => {
            if (otherMenu !== optionActionsMenu) otherMenu.open = false;
          });
          openOptionAudioMenuKey = optionT2AKey;
          optionActionsMenu.open = true;
          shell.classList.add('editor-shell--option-audio-menu-open');
        });
        optionActionsMenu.addEventListener('pointerdown', (event) => {
          if (event.target === optionAudioMenuTrigger || !optionActionsMenu.open) return;
          openOptionAudioMenuKey = optionT2AKey;
          shell.classList.add('editor-shell--option-audio-menu-open');
        });
        optionActionsMenu.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape' || !optionActionsMenu.open) return;
          event.preventDefault();
          closeOpenOptionAudioMenu({ restoreFocus: true });
        });
        const optionActionsRow = document.createElement('div');
        optionActionsRow.className = 'option-actions-menu__list option-audio-menu__list';
        const optionMenuHeader = document.createElement('div');
        optionMenuHeader.className = 'option-audio-menu__header';
        const optionMenuTitle = document.createElement('strong');
        optionMenuTitle.textContent = t('editor.media.optionAudioMenuTitle');
        const optionMenuCloseBtn = document.createElement('button');
        optionMenuCloseBtn.type = 'button';
        optionMenuCloseBtn.className = 'icon-btn option-audio-menu__close';
        optionMenuCloseBtn.title = t('common.actions.close');
        optionMenuCloseBtn.setAttribute('aria-label', t('common.actions.close'));
        setIconButtonContent(optionMenuCloseBtn, 'close');
        optionMenuCloseBtn.addEventListener('click', () => closeOpenOptionAudioMenu({ restoreFocus: true }));
        optionMenuHeader.append(optionMenuTitle, optionMenuCloseBtn);
        optionActionsRow.appendChild(optionMenuHeader);
        const optionTrackList = document.createElement('div');
        optionTrackList.className = 'option-audio-track-list';
        AUDIO_TRACK_LANGUAGE_IDS.forEach((language) => {
          const track = getAudioTrack(option.audioTracks, language);
          const isTrackGenerating = isOptionT2AInFlight
            && optionTrackGenerationLanguageByKey.get(optionT2AKey) === language;
          const languageLabel = getAudioTrackLanguageLabel(language);
          const trackSection = document.createElement('section');
          trackSection.className = `option-audio-track ${track ? 'option-audio-track--attached' : 'option-audio-track--empty'}`;
          trackSection.dataset.optionAudioTrackLanguage = language;
          trackSection.dataset.audioTrackSourceHash = track?.sourceTextHash || '';
          const trackHeading = document.createElement('div');
          trackHeading.className = 'option-audio-track__heading';
          const trackName = document.createElement('strong');
          trackName.textContent = languageLabel;
          const trackStatus = document.createElement('span');
          trackStatus.dataset.audioTrackStatus = '1';
          trackStatus.className = track
            ? 'asset-status-badge option-audio-track__status'
            : 'option-audio-track__status option-audio-track__status--empty';
          trackStatus.textContent = track ? t('editor.block.attachedBadge') : t('common.values.none');
          trackHeading.append(trackName, trackStatus);
          const stale = document.createElement('span');
          stale.className = 'option-audio-track__warning';
          stale.dataset.audioTrackStale = '1';
          stale.textContent = t('editor.media.audioTracks.textChanged');
          stale.hidden = !track || track.sourceTextHash === getAudioSourceTextHash(optionDisplayText);
          trackSection.append(trackHeading, stale);
          const trackActions = document.createElement('div');
          trackActions.className = 'option-audio-track__actions';
          const attachTrackBtn = document.createElement('button');
          attachTrackBtn.type = 'button';
          attachTrackBtn.className = 'media-action-btn';
          attachTrackBtn.dataset.optionAudioAction = 'attach';
          attachTrackBtn.dataset.optionAudioLanguage = language;
          attachTrackBtn.dataset.optionAudioMenuKey = optionT2AKey;
          attachTrackBtn.dataset.optionAudioActionSurface = track ? 'overflow' : 'direct';
          setMediaActionButtonContent(attachTrackBtn, 'upload', track ? t('editor.media.actions.replace') : t('editor.media.actions.attach'));
          attachTrackBtn.disabled = !isPersistedOption || isOptionT2AInFlight;
          attachTrackBtn.addEventListener('click', () => {
            pendingOptionAudioTarget = { blockId: selectedBlock.blockId, optionId, language };
            optionAudioInput.value = '';
            optionAudioInput.click();
          });
          const generateTrackBtn = document.createElement('button');
          generateTrackBtn.type = 'button';
          generateTrackBtn.className = 'media-action-btn';
          generateTrackBtn.dataset.optionAudioAction = 'generate';
          generateTrackBtn.dataset.optionAudioLanguage = language;
          generateTrackBtn.dataset.optionAudioMenuKey = optionT2AKey;
          generateTrackBtn.dataset.optionAudioActionSurface = track ? 'overflow' : 'direct';
          setMediaActionButtonContent(
            generateTrackBtn,
            isTrackGenerating ? 'loading' : track ? 'refresh' : 'generate',
            isTrackGenerating
              ? t('editor.media.actions.generating')
              : track ? t('editor.media.actions.regenerate') : t('editor.media.actions.generate')
          );
          generateTrackBtn.disabled = !isPersistedOption || !optionTextEligibleForT2A || isOptionT2AInFlight;
          generateTrackBtn.addEventListener('click', async () => {
            const latestBlock = session.state.draft?.blocks?.find((block) => block.blockId === selectedBlock.blockId);
            const latestResponseConfig = normalizeQuestionResponseConfig(latestBlock?.responseConfig);
            const latestOptions = (latestResponseConfig.options || []).map((item, index) =>
              normalizeResponseOption(item, `option_${index}`));
            const latestOption = latestOptions.find((item) => String(item?.id || '') === optionId) || null;
            const latestOptionText = latestOption?.label ?? latestOption?.value ?? '';
            if (!getT2ATextEligibility(latestOptionText).eligible || optionT2AInFlightKeys.has(optionT2AKey)) return;
            session.stopPreviewAudio();
            optionT2AInFlightKeys.add(optionT2AKey);
            optionTrackGenerationLanguageByKey.set(optionT2AKey, language);
            restoreLegacyOptionInFlightMarker();
            refreshOptionRowT2AControls(selectedBlock.blockId, optionId, row);
            try {
              const latestTrack = getAudioTrack(latestOption?.audioTracks, language);
              const warning = await confirmAudioLanguageMismatch(latestOptionText, language, { replacing: Boolean(latestTrack) });
              if (!warning.confirmed) return;
              if (latestTrack && !warning.replacementConfirmed) {
                const confirmed = await confirmDangerAction({
                  title: t('editor.media.audioTracks.confirm.regenerateTitle', { language: languageLabel }),
                  bodyText: t('editor.media.audioTracks.confirm.regenerateOptionBody', { language: languageLabel, index: optionIndex + 1 }),
                  confirmLabel: t('editor.media.actions.regenerateAudio'),
                  removalItems: [languageLabel],
                });
                if (!confirmed) return;
              }
              const result = await session.triggerProtectedAction('editorOptionT2A', {
                blockId: selectedBlock.blockId,
                optionId,
                target: 'option',
                language,
              });
              if (!result?.ok && !result?.cancelled && result?.status !== 'executed' && result?.status !== 'redirected') {
                session.setMediaFeedback(result?.reason === 'generation-failed' ? getApiErrorMessage(result, result.source === 'repository-api' ? 'session' : 'audio', result.source || 'bridge') : (result?.error?.message || editorNotification('audioGeneration.failed')));
              }
            } finally {
              optionT2AInFlightKeys.delete(optionT2AKey);
              optionTrackGenerationLanguageByKey.delete(optionT2AKey);
              restoreLegacyOptionInFlightMarker();
              refreshOptionRowT2AControls(selectedBlock.blockId, optionId, row);
              updateSummary();
            }
          });
          const playTrackBtn = document.createElement('button');
          playTrackBtn.type = 'button';
          playTrackBtn.className = 'media-action-btn';
          playTrackBtn.dataset.optionAudioAction = 'play';
          playTrackBtn.dataset.optionAudioLanguage = language;
          playTrackBtn.dataset.optionAudioMenuKey = optionT2AKey;
          playTrackBtn.dataset.optionAudioActionSurface = 'direct';
          setMediaActionButtonContent(playTrackBtn, 'play', t('editor.media.actions.play'));
          playTrackBtn.disabled = !track || isOptionT2AInFlight;
          playTrackBtn.addEventListener('click', async () => {
            if (!track) return;
            playTrackBtn.disabled = true;
            const result = await session.playAssetAudio(track.assetId, { onEnded: () => { playTrackBtn.disabled = false; }, onError: () => { playTrackBtn.disabled = false; }, onInterrupted: () => { playTrackBtn.disabled = false; } });
            if (!result.ok) playTrackBtn.disabled = false;
          });
          const removeTrackBtn = document.createElement('button');
          removeTrackBtn.type = 'button';
          removeTrackBtn.className = 'media-action-btn media-action-btn--remove';
          removeTrackBtn.dataset.optionAudioAction = 'remove';
          removeTrackBtn.dataset.optionAudioLanguage = language;
          removeTrackBtn.dataset.optionAudioMenuKey = optionT2AKey;
          removeTrackBtn.dataset.optionAudioActionSurface = 'overflow';
          setMediaActionButtonContent(removeTrackBtn, 'trash', t('editor.media.actions.remove'));
          removeTrackBtn.disabled = !track || isOptionT2AInFlight;
          removeTrackBtn.addEventListener('click', async () => {
            if (!track) return;
            const confirmed = await confirmDangerAction({
              title: t('editor.media.audioTracks.confirm.removeTitle', { language: languageLabel }),
              bodyText: t('editor.media.audioTracks.confirm.removeOptionBody', { language: languageLabel, index: optionIndex + 1 }),
              confirmLabel: t('editor.media.actions.removeAudio'),
              removalItems: [languageLabel],
            });
            if (!confirmed) return;
            session.removeAudioTrack(selectedBlock.blockId, 'option', language, { optionId, confirmRemove: true });
            updateSummary();
          });
          if (track) {
            const moreMenu = createAudioTrackMoreMenu({
              languageLabel,
              actionButtons: [attachTrackBtn, generateTrackBtn, removeTrackBtn],
              className: 'audio-track-more-menu--option',
            });
            setAudioTrackMoreMenuDisabled(moreMenu, !isPersistedOption || isOptionT2AInFlight);
            trackActions.append(playTrackBtn, moreMenu);
          } else {
            trackActions.append(attachTrackBtn, generateTrackBtn);
          }
          const cancelTrackBtn = document.createElement('button');
          cancelTrackBtn.type = 'button'; cancelTrackBtn.className = 'media-action-btn';
          cancelTrackBtn.dataset.optionAudioAction = 'cancel';
          cancelTrackBtn.textContent = t('common.actions.cancel');
          cancelTrackBtn.hidden = !isTrackGenerating;
          cancelTrackBtn.addEventListener('click', () => session.cancelAudioGeneration(selectedBlock.blockId, optionId));
          trackActions.appendChild(cancelTrackBtn);
          trackSection.appendChild(trackActions);
          optionTrackList.appendChild(trackSection);
        });
        optionActionsRow.appendChild(optionTrackList);

        optionActionsMenu.append(optionAudioMenuTrigger, optionActionsRow);
        row.append(correctToggle, optionInput, optionActionsMenu, removeBtn);
        mountOptionImageEditor({ row, option, blockId: selectedBlock.blockId, session, icon: createEditorIcon,
          confirm: bodyText => confirmDangerAction({ title: t('optionImages.manage'), bodyText, confirmLabel: t('common.actions.apply'), removalItems: [] }),
          refresh: () => updateSummary(), run: runMediaAction });
        const optionT2AHint = document.createElement('span');
        optionT2AHint.className = 'muted option-row__meta';
        optionT2AHint.dataset.optionT2aHint = '1';
        optionT2AHint.textContent = optionTextExceedsT2ALimit
          ? getEditorTextTooLongForAudioLabel(T2A_TEXT_MAX_LENGTH)
          : '';
        optionT2AHint.hidden = !isPersistedOption || !optionTextExceedsT2ALimit;
        row.appendChild(optionT2AHint);
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
      } else if (activeOptionAudioAction) {
        const replacementAudioAction = Array.from(questionOptionsList.querySelectorAll('[data-option-audio-action]'))
          .find((button) => button.dataset.optionAudioMenuKey === activeOptionAudioAction.menuKey
            && button.dataset.optionAudioLanguage === activeOptionAudioAction.language
            && button.dataset.optionAudioAction === activeOptionAudioAction.action
            && (button.dataset.optionAudioActionSurface || '') === activeOptionAudioAction.surface);
        if (replacementAudioAction instanceof HTMLButtonElement) {
          queueMicrotask(() => replacementAudioAction.focus());
        }
      }
    }
    if (focusedPromptLanguage) {
      const row = Array.from(rightPanel.querySelectorAll('[data-prompt-audio-track-language]'))
        .find(element => element.dataset.promptAudioTrackLanguage === focusedPromptLanguage);
      const action = focusedPromptAction && row?.querySelector(`[data-audio-track-action="${focusedPromptAction}"]`);
      const replacement = action && !action.disabled && action.getClientRects().length ? action
        : Array.from(rightPanel.querySelectorAll('[data-prompt-audio-language]'))
          .find(button => button.dataset.promptAudioLanguage === focusedPromptLanguage);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  };

  const uploadedDraftsView = createUploadedDraftsView({
    root: manageUploadedDraftsModalRoot, t, createVisualLoadStatus,
    async onOpen(item, display) {
      if (session.packageLoad.current) return;
      const confirmed = await showConfirmDialog({
        title: t('editor.uploadedDraft.openDialog.title'),
        bodyText: t('editor.uploadedDraft.openDialog.description', { title: display.title }),
        warningText: t('editor.uploadedDraft.openDialog.warning'),
        confirmLabel: t('editor.uploadedDraft.openDialog.confirm'),
        variant: 'warning',
      });
      if (!confirmed || session.packageLoad.current) return;
      let result;
      try {
        const revision = manageUploadedDraftsDialogRevision;
        result = await session.reopenUploadedDraftAsLocalCopy(item.uploaded_draft_id, { isCurrent: () => manageUploadedDraftsDialogOpen && revision === manageUploadedDraftsDialogRevision });
      } catch (error) {
        session.pushNotification({
          kind: 'error',
          category: 'server',
          source: 'uploadedDraft.open',
          text: error?.message || editorNotification('save.manualSaveFailed'),
        });
        session.notifyStateChange();
        updateSummary();
        return;
      }
      if (result?.ok) {
        manageUploadedDraftsDialogOpen = false;
        manageUploadedDraftsDialogRevision++;
        renderManageUploadedDraftsModal();
      }
      updateSummary();
    },
    async onCopyLink(publishedPackageId) {
      const copied = await copyTextToClipboard(buildPublishedPackageViewerUrl(publishedPackageId));
      emitServerNotification({
        kind: copied ? 'success' : 'warn',
        source: 'clipboard.publishedViewerLink',
        text: copied ? editorNotification('clipboard.viewerLinkCopied') : editorNotification('clipboard.unavailable'),
      });
    },
    async onPublish(item, publishBtn) {
      if (session.state.publishingDraftIds.has(item.uploaded_draft_id)) return;
      await guardServerMenuAction(publishBtn, async (isCurrent, setAccountGuard) => {
        const restored = session._returnedMutation?.operation === 'publish' && session._returnedMutation.id === item.uploaded_draft_id ? session._returnedMutation.filters : null;
        if (restored) session._returnedMutation = null;
        return runPublicationFlow({
          initialMetadata: { title: String(restored?.title ?? item?.title ?? ''), subject: String(restored?.subject ?? item?.subject ?? '') },
          isCurrent,
          collectMetadata: async metadata => {
            const modal = await showPublishModal({ uploadedDraft: item, initialTitle: metadata.title, initialSubject: metadata.subject });
            return modal.confirmed ? { title: String(modal.title ?? ''), subject: String(modal.subject ?? '') } : null;
          },
          publish: metadata => session.publishUploadedDraftToServer(item.uploaded_draft_id, metadata, { isCurrent, onPrepared: setAccountGuard }),
          isConflict: result => result?.error?.code === 'PUBLISHED_PACKAGE_CONFLICT',
          chooseConflict: async () => (await showPublishedPackageConflictModal())?.action,
        });
      });
      updateSummary();
    },
    async onDelete(item, publishedPackageId) {
      const generation = session._audioDraftGeneration;
      const revision = manageUploadedDraftsDialogRevision;
      const isCurrent = () => manageUploadedDraftsDialogOpen && revision === manageUploadedDraftsDialogRevision && generation === session._audioDraftGeneration;
      await session.deleteUploadedDraft(item.uploaded_draft_id, { isCurrent, confirm: () => showConfirmDialog({
        title: t('editor.uploadedDraft.deleteDialog.title'),
        entityLabel: isNonEmptyString(item.title) ? item.title.trim() : t('common.values.untitled'),
        descriptionText: publishedPackageId
          ? t('editor.uploadedDraft.deleteDialog.publishedDescription')
          : t('editor.uploadedDraft.deleteDialog.draftDescription'),
        removalItems: [t('editor.uploadedDraft.deleteDialog.removeArtifact'), t('editor.uploadedDraft.deleteDialog.removeMetadata')],
        confirmLabel: t('editor.uploadedDraft.deleteDialog.confirm'),
      }) });
      updateSummary();
    },
    async onRefresh() {
      const revision = manageUploadedDraftsDialogRevision;
      await session.loadUploadedDrafts({ isCurrent: () => manageUploadedDraftsDialogOpen && revision === manageUploadedDraftsDialogRevision });
      renderManageUploadedDraftsModal();
    },
    async onClose() {
      manageUploadedDraftsDialogOpen = false;
      manageUploadedDraftsDialogRevision++;
      renderManageUploadedDraftsModal();
    },
  });
  session.destroyUploadedDraftsView = uploadedDraftsView.destroy;

  function renderManageUploadedDraftsModal() {
    const revision = manageUploadedDraftsDialogRevision;
    const generation = session._audioDraftGeneration;
    const isCurrent = () => !shellDisposed && manageUploadedDraftsDialogOpen
      && revision === manageUploadedDraftsDialogRevision && generation === session._audioDraftGeneration;
    uploadedDraftsView.render({
      open: manageUploadedDraftsDialogOpen,
      loading: session.state.isLoadingUploadedDrafts, error: session.state.uploadedDraftsError,
      items: session.state.uploadedDrafts, slotLimit: session.state.uploadedDraftSlotLimit,
      serverReady: session.state.serverSession?.status === 'ready',
      publishBusy: session._publishMenuBusy, publishingIds: [...session.state.publishingDraftIds],
    }, isCurrent);
    refreshPackageLoadControls();
  }

  const refreshImageBudget = () => {
    const budget = rightPanel.querySelector('[data-image-budget]');
    const draft = session.state.draft;
    if (!budget || !draft) return;
    const blocks = structuredClone(draft.blocks);
    const key = JSON.stringify([blocks, draft.assets]);
    if (budget.dataset.budgetKey === key) return;
    budget.dataset.budgetKey = key;
    budget.textContent = t('imageResponse.budgetCalculating');
    session.imageBudgetSizes ??= new Map();
    const sizes = (draft.assets || []).map(a => {
      if (!session.imageBudgetSizes.has(a.assetId)) {
        session.imageBudgetSizes.set(a.assetId, Promise.resolve(session.storage.localAssets.get(a.assetId)).then(r => {
          if (!r?.binary) throw new Error('Missing media');
          return r.binary.byteLength;
        }).catch(error => { session.imageBudgetSizes.delete(a.assetId); throw error; }));
      }
      return session.imageBudgetSizes.get(a.assetId);
    });
    Promise.all(sizes).then(values => {
      if (!budget.isConnected || budget.dataset.budgetKey !== key) return;
      const b = imageBudget(blocks, values.reduce((n, v) => n + v, 0), new TextEncoder().encode(JSON.stringify(blocks)).length * 4);
      budget.className = b.ok ? 'muted' : 'control-error';
      budget.textContent = t('imageResponse.budget', { size: (b.total / 1048576).toFixed(1) })
        + (b.ok ? '' : ' ' + t('imageResponse.budgetExceeded'));
    }).catch(() => {
      if (budget.isConnected && budget.dataset.budgetKey === key) {
        budget.className = 'control-error'; budget.textContent = t('imageResponse.unavailable');
      }
    });
  };

  const updateSummary = ({ preserveDetailEditor = false } = {}) => {
    if (shellDisposed) return;
    session.pruneExpiredNotifications();
    session.validateCurrentDraft();
    syncFormControls();
    blockNavigation.update();
    const feedbackSelected =
      session.state.feedbackSettingsDraftId === session.state.draft?.localId;
    rightPanel.hidden = feedbackSelected;
    feedbackEditor.root.hidden = !feedbackSelected;
    feedbackButton.setAttribute(
      'aria-current',
      feedbackSelected ? 'page' : 'false',
    );
    feedbackBadge.textContent = t(
      feedbackEnabled(session.state.draft?.feedback)
        ? 'feedback.enabled'
        : 'feedback.disabled',
    );
    feedbackBadge.classList.toggle(
      'is-disabled',
      !feedbackEnabled(session.state.draft?.feedback),
    );
    if (feedbackSelected) {
      feedbackEditor.update(session.state.draft);
    }

    if (!preserveDetailEditor) {
      renderDetailEditor();
    }
    refreshPromptT2AControlsForSelectedBlock();
    refreshImageBudget();

    statusPanel.update();
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
    const userLabel = session.state.serverSession?.user?.email || session.state.serverSession?.user?.sub || t('common.values.unknown');
    if (sessionStatus === 'ready') {
      serverSessionStatus.textContent = t('editor.serverSession.ready', { user: userLabel });
    } else if (sessionStatus === 'checking') {
      serverSessionStatus.textContent = t('editor.serverSession.checking');
    } else {
      serverSessionStatus.textContent = t('editor.serverSession.notReady', {
        reason: session.state.serverSession?.error || t('editor.serverSession.signInForFeatures'),
      });
    }
    const isUploadingDraft = session.state.isUploadingDraft;
    const isUploadDraftFlowActive = session.state.isUploadDraftFlowActive;
    const isRefreshingUploadedDrafts = session.state.isLoadingUploadedDrafts;

    notificationPanel.update({ activityLog: session.state.activityLog, notifications: session.state.notifications });

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
    cancelUploadBtn.hidden = !isUploadingDraft;
    syncDraftBtn.disabled = isUploadingDraft || isUploadDraftFlowActive;
    browsePublishedBtn.disabled = Boolean(pendingManagerEntry);
    browsePublishedBtn.textContent = pendingManagerEntry?.kind === 'published' ? t('common.actions.loading') : t('editor.published.browse');
    browsePublishedBtn.setAttribute('aria-busy', String(pendingManagerEntry?.kind === 'published'));
    manageUploadedDraftsBtn.textContent = pendingManagerEntry?.kind === 'drafts' ? t('common.actions.loading')
      : isRefreshingUploadedDrafts ? t('common.actions.refreshing') : t('editor.uploadedDraft.manage');
    manageUploadedDraftsBtn.disabled = Boolean(pendingManagerEntry) || isRefreshingUploadedDrafts;
    manageUploadedDraftsBtn.setAttribute('aria-busy', String(pendingManagerEntry?.kind === 'drafts'));
    signInBtn.hidden = serverReady;
    if (manageUploadedDraftsDialogOpen) renderManageUploadedDraftsModal();
    refreshPackageLoadControls();
  };

  session.resumeReadIntent = async intent => {
    if (intent.kind === 'mutation') {
      if (intent.operation === 'generateAudio') {
        session.setRecoveryMessage(t('apiErrors.audioRetryRequired'));
        session.notifyStateChange();
        return;
      }
      session._returnedMutation = intent;
      session.pushNotification({ kind: 'info', category: 'server', source: 'session.mutation', text: t('mutationAuth.returned') });
      session.notifyStateChange();
      if (intent.operation === 'delete-publication') browsePublishedBtn.click();
      else if (intent.operation !== 'upload') manageUploadedDraftsBtn.click();
      return;
    }
    if (intent.kind === 'drafts') { manageUploadedDraftsBtn.click(); return; }
    if (intent.kind === 'published') { browsePublishedState = { ...browsePublishedState, ...intent.filters }; browsePublishedBtn.click(); return; }
    if (!await showConfirmDialog({ title: t('editor.replaceWorksheet.title'),
      bodyText: t('editor.uploadedDraft.openDialog.description', { title: intent.id }),
      warningText: t('editor.uploadedDraft.openDialog.warning'), confirmLabel: t('editor.replaceWorksheet.confirm'), variant: 'warning' })) return;
    if (intent.kind === 'draft') await session.reopenUploadedDraftAsLocalCopy(intent.id);
    if (intent.kind === 'publication') await session.reopenPublishedPackageAsLocalCopy(intent.id);
  };
  session._onReadAuthInvalidated = reason => {
    browsePublishedState = { ...browsePublishedState, items: [], hasMore: false, nextOffset: null, error: t(reason === 'account_changed' ? 'readAuth.accountChanged' : 'apiErrors.authRequired') };
  };

  session.setOnStateChange(() => {
    updateSummary();
    if (browsePublishedDialogOpen) {
      renderPublishedBrowserModal();
    }
    if (manageUploadedDraftsDialogOpen) {
      renderManageUploadedDraftsModal();
    }
    refreshPackageLoadControls();
  });

  titleInput.addEventListener('input', () => {
    session.updateTitle(titleInput.value);
    updateSummary();
  });
  subjectInput.addEventListener('input', () => {
    session.updateSubject(subjectInput.value);
    updateSummary();
  });
  function confirmBlankTextConversion(block, { asContent = false } = {}) {
    const converted = passageToPrompt(block);
    const preview = document.createElement('div');
    preview.className = 'editor-type-preview';
    const heading = document.createElement('strong');
    heading.textContent = t('editorLayout.resultingPrompt');
    const text = document.createElement('div');
    text.className = 'editor-type-preview-text';
    text.textContent = worksheetTextToPlain(converted);
    preview.append(heading, text);
    if (!asContent && promptTextState(converted).exceedsLimit) {
      const limit = document.createElement('p'); limit.className = 'input-error';
      limit.textContent = t('editorLayout.convertedTooLong', { max: PROMPT_TEXT_LIMIT });
      preview.append(limit);
    }
    return showConfirmDialog({
      title: t(asContent ? 'editorLayout.toContentTitle' : 'editorLayout.fromBlanksTitle'),
      descriptionText: t(asContent ? 'editorLayout.toContentDescription' : 'editorLayout.fromBlanksDescription'),
      content: preview, removalItems: [t('fillBlanks.removeType')],
      confirmLabel: t('editorLayout.convertAndRemove'), variant: 'warning',
      warningText: t('editorLayout.visibleAnswersWarning'),
    });
  }

  blockKind.addEventListener('change', async () => {
    const block = session.findBlock(session.state.selectedBlockId);
    const kind = blockKind.value;
    if (kind === 'content' && isFillInBlanks(block?.responseConfig)) {
      blockKind.value = 'question';
      const draftId = session.state.draft.localId, generation = session._audioDraftGeneration;
      const snapshot = JSON.stringify(block);
      const confirmed = await confirmBlankTextConversion(block, { asContent: true });
      if (!confirmed || session.state.draft?.localId !== draftId || session._audioDraftGeneration !== generation
        || session.state.selectedBlockId !== block.blockId || JSON.stringify(session.findBlock(block.blockId)) !== snapshot) {
        updateSummary(); return;
      }
    }
    session.setSelectedBlockKind(kind);
    updateSummary();
  });
  saveBtn.addEventListener('click', async () => {
    try { await session.saveNow(); }
    catch { /* Save state and notifications already explain the failure. */ }
    updateSummary();
  });
  startNewWorksheetBtn.addEventListener('click', async () => {
    if (session.packageLoad.current) return;
    const confirmed = await showConfirmDialog({
      title: t('editor.newWorksheet.confirmTitle'),
      bodyText: t('editor.newWorksheet.confirmDescription'),
      removalItems: [
        t('editor.newWorksheet.removeCurrentDraft'),
        t('editor.newWorksheet.removeBlocks'),
        t('editor.newWorksheet.removeLocalMedia'),
      ],
      confirmLabel: t('editor.newWorksheet.confirmLabel'),
    });
    if (!confirmed || session.packageLoad.current) return;
    let nextDraft;
    try {
      nextDraft = await session.startNewWorksheet();
    } catch (error) {
      session.pushNotification({ kind: 'error', category: 'editor', source: 'worksheet.new', text: error?.message || editorNotification('save.manualSaveFailed') });
      updateSummary();
      return;
    }
    if (nextDraft?.localId) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('localDraftId', nextDraft.localId);
      nextUrl.searchParams.delete('draftUpdatedAt');
      window.history.replaceState(null, '', nextUrl.toString());
    }
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
    try {
      session.requireReadyWorksheet();
    } catch (error) {
      session.pushNotification({
        kind: 'error',
        text: error.message,
      });
      updateSummary();
      return;
    }

    const localDraftId = session.state.draft?.localId;
    if (!localDraftId) return;
    const returnState = {
      selectedBlockId: session.state.selectedBlockId,
      scrollY: window.scrollY,
      listScroll: blockList.scrollTop,
    };
    if (collectLegacyAudioTargets(session.state.draft?.blocks).length > 0) {
      session.setMediaFeedback('Legacy audio must be migrated before preview.');
      updateSummary();
      return;
    }
    try { await session.saveNow(); }
    catch { updateSummary(); return; }
    if (session.state.draft?.localId !== localDraftId) return;
    try { session.requireReadyWorksheet(); }
    catch (error) {
      session.pushNotification({ kind: 'error', category: 'editor', text: error.message });
      updateSummary();
      return;
    }
    updateSummary();
    const draftUpdatedAt = session.state.draft?.metadata?.updatedAt || null;
    try {
      sessionStorage.setItem(`worksheet-editor-preview:${localDraftId}`, JSON.stringify(returnState));
    } catch { /* Navigation still works when browser session storage is unavailable. */ }
    const viewerUrl = buildViewerUrlFromCurrentLocation(window.location.href, localDraftId, draftUpdatedAt);
    window.location.assign(viewerUrl);
  });
  questionInputType.addEventListener('change', async () => {
    const draft = session.state.draft;
    const selectedBlockId = session.state.selectedBlockId;
    const selectedBlock = draft?.blocks?.find(block => block.blockId === selectedBlockId);
    if (!selectedBlock || selectedBlock.kind !== 'question') return;
    const nextType = questionInputType.value;
    const currentInputType = normalizeQuestionResponseConfig(selectedBlock.responseConfig).inputType || 'text';
    questionInputType.value = currentInputType;
    if (nextType === currentInputType) return;
    const generation = session._audioDraftGeneration;
    const snapshot = JSON.stringify(selectedBlock);
    const stillCurrent = () => session.state.draft?.localId === draft.localId
      && session._audioDraftGeneration === generation
      && session.state.selectedBlockId === selectedBlockId
      && JSON.stringify(session.findBlock(selectedBlockId)) === snapshot;
    const impact = session.getQuestionInputTypeSwitchImpact(selectedBlockId, nextType);
    const removals = [];
    if (impact.optionCountToRemove) removals.push(t('editor.question.switchTypeConfirm.optionRemoval', { count: impact.optionCountToRemove }));
    if (impact.optionAttachmentCountToRemove) removals.push(t('editor.question.switchTypeConfirm.attachmentRemoval', { count: impact.optionAttachmentCountToRemove }));
    if (impact.hasOptionTextLoss) removals.push(t('editor.question.switchTypeConfirm.optionTextRemoval'));
    let promptPlacement = 'instructions';
    try {
      if (nextType === 'fill_in_blanks' && worksheetTextToPlain(selectedBlock.prompt).trim()) {
        const choices = document.createElement('div');
        choices.className = 'editor-type-choices';
        for (const value of ['passage', 'instructions']) {
          const label = document.createElement('label');
          label.className = 'editor-type-choice';
          const radio = document.createElement('input');
          radio.type = 'radio'; radio.name = 'prompt-placement'; radio.value = value;
          radio.checked = value === 'passage';
          const text = document.createElement('span');
          const title = document.createElement('strong');
          title.textContent = t(`editorLayout.${value}Choice`);
          const hint = document.createElement('small');
          hint.textContent = t(`editorLayout.${value}ChoiceHint`);
          text.append(title, hint); label.append(radio, text); choices.append(label);
        }
        const confirmed = await showConfirmDialog({
          title: t('editorLayout.toBlanksTitle'), descriptionText: t('editorLayout.toBlanksDescription'),
          content: choices, removalItems: removals,
          confirmLabel: t('editorLayout.switchType'), variant: 'warning',
          warningText: normalizeAudioTracks(selectedBlock.prompt?.audioTracks).length
            ? t('editorLayout.audioSourceWarning') : '',
        });
        if (!confirmed || !stillCurrent()) { updateSummary(); return; }
        promptPlacement = choices.querySelector('input:checked').value;
      } else if (currentInputType === 'fill_in_blanks') {
        const confirmed = await confirmBlankTextConversion(selectedBlock);
        if (!confirmed || !stillCurrent()) { updateSummary(); return; }
      } else if (impact.hasMeaningfulDataLoss) {
        const confirmed = await showConfirmDialog({
          title: t('editor.question.switchTypeConfirm.title'),
          descriptionText: t('editor.question.switchTypeConfirm.description', {
            fromType: getAnswerInputTypeLabel(currentInputType), toType: getAnswerInputTypeLabel(nextType),
          }),
          removalItems: removals, confirmLabel: t('editor.question.switchTypeConfirm.confirmLabel'),
        });
        if (!confirmed || !stillCurrent()) { updateSummary(); return; }
      }
      session.switchQuestionInputTypeWithImpactPolicy(selectedBlockId, nextType, { confirmSwitch: true, promptPlacement });
      // An existing prompt remains discoverable when it is retained as instructions.
      detailViewState(session.findBlock(selectedBlockId)).instructionsOpen = Boolean(worksheetTextToPlain(session.findBlock(selectedBlockId).prompt).trim());
    } catch (error) {
      session.pushNotification({ kind: 'error', category: 'editor', source: 'question.type', text: t('editorLayout.conversionFailed') });
    }
    updateSummary();
    if (session.state.selectedBlockId === selectedBlockId) questionInputType.focus();
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
          title: t('editor.media.confirm.replaceQuestionImageTitle'),
          bodyText: t('editor.media.confirm.replaceQuestionImageBody'),
          confirmLabel: t('editor.media.actions.replaceImage'),
          removalItems: [t('editor.media.confirm.currentQuestionImageAttachment')],
        });
        if (!confirmed) {
          session.setMediaFeedback(t('editor.media.feedback.imageReplacementCanceled'));
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
      const language = questionAudioInput.dataset.language;
      if (isAudioTrackLanguage(language)) {
        const current = session.getAudioTrackTarget(blockId, 'prompt');
        const existingTrack = getAudioTrack(current?.audioTracks, language);
        const warning = await confirmAudioLanguageMismatch(current?.text || '', language, { replacing: Boolean(existingTrack) });
        if (!warning.confirmed) return;
        if (existingTrack && !warning.replacementConfirmed) {
          const confirmed = await confirmDangerAction({
            title: t('editor.media.audioTracks.confirm.replaceTitle', { language: getAudioTrackLanguageLabel(language) }),
            bodyText: t('editor.media.audioTracks.confirm.replacePromptBody', { language: getAudioTrackLanguageLabel(language) }),
            confirmLabel: t('editor.media.actions.replaceAudio'),
            removalItems: [getAudioTrackLanguageLabel(language)],
          });
          if (!confirmed) return;
        }
        await session.attachAudioTrack(blockId, 'prompt', language, file, { confirmReplace: true });
        delete questionAudioInput.dataset.language;
        questionAudioInput.value = '';
        updateSummary();
        return;
      }
      const currentBlock = session.findBlock(blockId);
      const hasExisting = Boolean(getSingleMediaRef(currentBlock?.prompt?.mediaRefs, 'question_audio'));
      if (hasExisting) {
        const confirmed = await confirmDangerAction({
          title: t('editor.media.confirm.replaceQuestionAudioTitle'),
          bodyText: t('editor.media.confirm.replaceQuestionAudioBody'),
          confirmLabel: t('editor.media.actions.replaceAudio'),
          removalItems: [t('editor.media.confirm.currentQuestionAudioAttachment')],
        });
        if (!confirmed) {
          session.setMediaFeedback(t('editor.media.feedback.audioReplacementCanceled'));
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
      const { blockId, optionId, language } = pendingOptionAudioTarget;
      pendingOptionAudioTarget = null;
      const block = session.findBlock(blockId);
      const config = normalizeQuestionResponseConfig(block?.responseConfig);
      const option = (config.options || []).map((item) => normalizeResponseOption(item)).find((item) => item.id === optionId);
      if (isAudioTrackLanguage(language)) {
        const existingTrack = getAudioTrack(option?.audioTracks, language);
        const warning = await confirmAudioLanguageMismatch(option?.label ?? option?.value ?? '', language, { replacing: Boolean(existingTrack) });
        if (!warning.confirmed) return;
        if (existingTrack && !warning.replacementConfirmed) {
          const languageLabel = getAudioTrackLanguageLabel(language);
          const confirmed = await confirmDangerAction({
            title: t('editor.media.audioTracks.confirm.replaceTitle', { language: languageLabel }),
            bodyText: t('editor.media.audioTracks.confirm.replaceOptionBody', { language: languageLabel }),
            confirmLabel: t('editor.media.actions.replaceAudio'),
            removalItems: [languageLabel],
          });
          if (!confirmed) return;
        }
        await session.attachAudioTrack(blockId, 'option', language, file, { optionId, confirmReplace: true });
        optionAudioInput.value = '';
        updateSummary();
        return;
      }
      const hasExisting = Boolean(getSingleMediaRef(option?.mediaRefs, 'option_audio'));
      if (hasExisting) {
        const confirmed = await confirmDangerAction({
          title: t('editor.media.confirm.replaceOptionAudioTitle'),
          bodyText: t('editor.media.confirm.replaceOptionAudioBody'),
          confirmLabel: t('editor.media.actions.replaceAudio'),
          removalItems: [t('editor.media.confirm.currentOptionAudioAttachment')],
        });
        if (!confirmed) {
          session.setMediaFeedback(t('editor.media.feedback.optionAudioReplacementCanceled'));
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
    if (session.packageLoad.current) { importFileInput.value = ''; return; }
    const [file] = importFileInput.files || [];
    if (!file) return;
    const isZipFile = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
    if (!isZipFile) {
      session.pushNotification({
        kind: 'error',
        category: 'editor',
        source: 'import.package_zip',
        text: editorNotification('import.zipRequired'),
      });
      session.notifyStateChange();
      importFileInput.value = '';
      updateSummary();
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t('editor.replaceWorksheet.title'),
      bodyText: t('editor.uploadedDraft.openDialog.description', { title: file.name }),
      warningText: t('editor.uploadedDraft.openDialog.warning'),
      confirmLabel: t('editor.replaceWorksheet.confirm'),
      variant: 'warning',
    });
    if (!confirmed || session.packageLoad.current) {
      importFileInput.value = '';
      return;
    }
    let importResult;
    try {
      importResult = await session.importWorksheetPackageFile(file, { convertToEditableDraft: true });
    } catch {
      // The importer reports validation/storage failures; retain the current draft.
      importFileInput.value = '';
      updateSummary();
      return;
    }
    if (importResult?.canceled) {
      importFileInput.value = '';
      updateSummary();
      return;
    }
    const importedLocalDraftId = importResult?.draftRecord?.localId || session.state.draft?.localId;
    if (importedLocalDraftId) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('localDraftId', importedLocalDraftId);
      nextUrl.searchParams.delete('draftUpdatedAt');
      window.history.replaceState(null, '', nextUrl.toString());
    }
    importFileInput.value = '';
    updateSummary();
  });
  exportBtn.addEventListener('click', async () => {
    try { await session.exportCurrentDraftToPackageFile(); }
    catch { /* The export method reports the validation or package error. */ }
    updateSummary();
  });
  syncDraftBtn.addEventListener('click', async () => {
    if (session.state.isUploadDraftFlowActive || session.state.isUploadingDraft) return;
    if (syncDraftBtn.disabled) return;
    try { session.requireReadyWorksheet(); }
    catch (error) {
      session.pushNotification({ kind: 'error', category: 'editor', text: error.message });
      updateSummary();
      return;
    }
    const draftId = session.state.draft?.localId;
    const generation = session._audioDraftGeneration;
    session.uploadFlows ??= new UploadOperationSlot();
    let accountCurrent = () => true;
    const flow = session.uploadFlows.begin(() => accountCurrent() && session.state.draft?.localId === draftId && session._audioDraftGeneration === generation);
    if (!flow) return;
    session._uploadPackageFlow = flow;
    session.state.isUploadDraftFlowActive = true;
    updateSummary();
    try {
      const ready = await session.ensureMutationSessionReady({ isCurrent: () => flow.canPublish(), signal: flow.signal, intent: { kind: 'mutation', operation: 'upload' } });
      if (ready.ok) accountCurrent = ready.isCurrent;
      if (!ready.ok || !flow.canPublish()) return;
      await runUploadRecoveryFlow({
        resource: 'worksheet-draft',
        isCurrent: () => flow.canPublish(),
        signal: flow.signal,
        submit: conflictAction => session.uploadCurrentDraftToServer({ preflight: false, conflictAction }),
        chooseConflict: async result => {
          const choice = await showUploadConflictModal({ existingDraft: result.error?.details?.existingDraft });
          return choice.action;
        },
        recoverSlots: result => showSlotFullModal({ uploadedDrafts: result.error?.details?.uploadedDrafts }),
      });
    } finally {
      flow.preparedPackage = null;
      if (session._uploadPackageFlow === flow) session._uploadPackageFlow = null;
      if (flow.finish()) {
        session.state.isUploadDraftFlowActive = false;
      }
      updateSummary();
    }
  });
  async function openServerManager(kind) {
    if (pendingManagerEntry || browsePublishedDialogOpen || manageUploadedDraftsDialogOpen) return;
    const entry = { kind };
    let cancelled = false;
    const draftId = session.state.draft?.localId;
    const generation = session._audioDraftGeneration;
    const contextCurrent = () => !shellDisposed && session.state.draft?.localId === draftId
      && session._audioDraftGeneration === generation;
    let isCurrent = () => contextCurrent() && pendingManagerEntry === entry;
    pendingManagerEntry = entry;
    updateSummary();
    try {
      const intent = kind === 'published'
        ? { kind, filters: { title: browsePublishedState.title, subject: browsePublishedState.subject, owner: browsePublishedState.owner } }
        : { kind };
      const ready = await session.ensureReadSessionReady({ isCurrent, intent });
      cancelled = ready.result?.cancelled === true;
      if (!isCurrent() || !ready.ok || !ready.isCurrent?.()) return;
      // The entry owns only authentication. Once mounted, the modal revision
      // owns the list so Close/reopen can supersede a pending request immediately.
      pendingManagerEntry = null;
      updateSummary();
      if (kind === 'published') {
        browsePublishedDialogOpen = true;
        const revision = ++browsePublishedDialogRevision;
        isCurrent = () => contextCurrent() && browsePublishedDialogOpen && revision === browsePublishedDialogRevision;
        await runPublishedSearch({ prepared: ready, isCurrent });
      } else {
        manageUploadedDraftsDialogOpen = true;
        const revision = ++manageUploadedDraftsDialogRevision;
        isCurrent = () => contextCurrent() && manageUploadedDraftsDialogOpen && revision === manageUploadedDraftsDialogRevision;
        await session.loadUploadedDrafts({ preflight: false, prepared: ready, isCurrent });
        if (isCurrent()) renderManageUploadedDraftsModal();
      }
    } catch (error) {
      if (isCurrent()) emitServerNotification({ kind: 'error', source: 'browse.open', text: getApiErrorMessage({ error }, 'list') });
    } finally {
      if (pendingManagerEntry === entry) pendingManagerEntry = null;
      updateSummary();
      // The shared prompt cannot restore focus while its entry is disabled.
      if (cancelled && contextCurrent() && document.activeElement === document.body) {
        (kind === 'published' ? browsePublishedBtn : manageUploadedDraftsBtn).focus();
      }
    }
  }
  browsePublishedBtn.addEventListener('click', () => openServerManager('published'));
  signInBtn.addEventListener('click', () => {
    session.beginServerSignIn();
    updateSummary();
  });
  manageUploadedDraftsBtn.addEventListener('click', () => openServerManager('drafts'));

  worksheetActionsRow.appendChild(startNewWorksheetBtn);
  controlsRow.append(addContentBtn, addQuestionBtn);
  for(const button of [saveBtn,exportBtn,importBtn,openViewerBtn])button.classList.add('sidebar-action-btn');
  metaRow.append(saveBtn, exportBtn, importBtn, openViewerBtn);
  protectedActionsColumn.append(
    serverSessionStatus,
    signInBtn,
    syncDraftBtn,
    cancelUploadBtn,
    manageUploadedDraftsBtn,
    browsePublishedBtn
  );
  moreActions.append(protectedActionsColumn);
  leftPanel.append(
    leftHeading,
    metadataSection,
    worksheetActionsRow,
    loadStatus,
    controlsRow,
    blockList,
    feedbackButton,
    metaRow,
    moreActions,
    notificationPanel.activityRoot,
    importFileInput,
    questionImageInput,
    questionAudioInput,
    optionAudioInput
  );
  rightPanel.append(rightHeading, statusRow);
  layout.append(leftPanel, rightPanel, feedbackEditor.root);
  const languageSelector = createLanguageSelector({
    onChange: () => {
      renderEditorShell(session);
    },
  });
  const languageSelect = languageSelector.querySelector('select');
  languageSelect?.setAttribute('aria-label', t('editorStatus.language'));
  languageSelector.querySelector('.editor-label')?.classList.add('editor-status-sr');
  for (const option of languageSelect?.options || []) option.textContent = option.value === 'zh-Hant' ? '繁中' : 'EN';
  topBar.append(statusPanel.badge, notificationPanel.headerRoot, statusPanel.infoButton, languageSelector);
  shell.append(topBar, layout);
  shell.appendChild(browsePublishedModalRoot);
  shell.appendChild(manageUploadedDraftsModalRoot);
  session.unsubscribeEditorPackageLoad?.();
  session.unsubscribeEditorPackageLoad = session.packageLoad.subscribe(refreshPackageLoadControls);
  app.innerHTML = '';
  app.append(shell);
  updateSummary();
}

async function bootstrapEditor() {
  const readReturn = takeReadAuthReturn('editor');
  const session = new EditorDraftSession(editorStorage);
  const params = new URLSearchParams(window.location.search);
  let initialRestore = session.getRouteUiRestoreMetadata();
  let previewReturn = null;
  try {
    const draftId = params.get('localDraftId');
    const saved = JSON.parse(sessionStorage.getItem(`worksheet-editor-preview:${draftId}`) || 'null');
    if (draftId && saved && typeof saved.selectedBlockId === 'string') {
      previewReturn = saved;
      initialRestore = { ...initialRestore, localId: draftId, selectedBlockId: saved.selectedBlockId };
    }
  } catch { /* Ignore unavailable or malformed session state. */ }
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
      const allowed = new Set(['localDraftId', 'blockId', 'target', 'language']);
      if (!hasOnlyAllowedKeys(payload, allowed)) return false;
      if (typeof payload.localDraftId !== 'string' || typeof payload.blockId !== 'string') return false;
      if (payload.target !== 'question_prompt') return false;
      return session.validateEditorPromptT2AIntentPayload(payload).ok;
    }

    if (actionId === 'editorOptionT2A') {
      const allowed = new Set(['localDraftId', 'blockId', 'target', 'optionId', 'language']);
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
    replayIntent: (intent) => session.restoreProtectedAction(intent),
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
    await session.loadUploadedDrafts({ preflight: false, recoverAuth: false });
  }

  session.persistRestoreMetadata();

  renderEditorShell(session);

  if (previewReturn) {
    const position = value => Number.isFinite(value) && value >= 0 ? value : 0;
    requestAnimationFrame(() => {
      window.scrollTo(0, position(previewReturn.scrollY));
      const list = document.querySelector('.block-list');
      if (list) list.scrollTop = position(previewReturn.listScroll);
    });
    try { sessionStorage.removeItem(`worksheet-editor-preview:${localDraftId}`); } catch { /* Optional state. */ }
  }

  window.editorSession = session;
  if (readReturn && (!readReturn.localId || readReturn.localId === session.state.draft?.localId)
      && (!readReturn.subject || readReturn.subject === session.state.serverSession.user?.sub)
      && session.state.serverSession.status === 'ready') await session.resumeReadIntent(readReturn.readIntent);
  else if (readReturn && session.state.serverSession.status === 'ready') {
    session.pushNotification({ kind: 'warn', category: 'server', source: 'session.readReturn', text: t('readAuth.accountChanged') });
    session.notifyStateChange();
  }
}

installPageRecovery('localDrafts', () => globalThis.window?.editorSession);

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
  getNotificationToastRemainingMs,
  getAudioSourceTextHash,
  getTextLanguageMismatch,
  migrateLegacyAudioBlocks,
};
function normalizeQuestionResponseConfig(responseConfig, options = {}) {
  const forContract = options.forContract === true;
  const source = isRecord(responseConfig) ? { ...responseConfig } : {};
  const inputType = source.inputType == null ? 'text' : source.inputType;

  const normalized = {
    ...source,
    inputType,
  };

  if (inputType === 'fill_in_blanks') return source.passage ? structuredClone(source) : emptyBlankConfig();
  for (const key of ['passage','mode','reuseWords','distractors']) delete normalized[key];
  if (inputType === 'image_response') return { inputType, maxImages: source.maxImages ?? 3 };
  delete normalized.maxImages;
  if (inputType !== 'text') delete normalized.textMode;
  if (inputType === 'text') {
    normalized.maxLength = Number.isFinite(source.maxLength) ? Number(source.maxLength) : isLongText(source) ? LONG_TEXT_LIMIT : 200;
    normalized.displayMode = !isLongText(source) && source.displayMode === 'single_line' ? 'single_line' : 'multi_line';
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
      const optionValue = getOptionValueForAnswerKey(optionImageRef(option) ? option : sourceOptions[index]);
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
      ? normalizedOptions.map((option) => ({ value: option.value, label: option.label, ...(optionImageRef(option) ? { id: option.id, mediaRefs: [optionImageRef(option)], imageDescription: option.imageDescription || '' } : {}) }))
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
