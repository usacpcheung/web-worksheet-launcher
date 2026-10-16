import { t } from '../i18n/index.js';

// Presentation only. Never infer behavior from prose, mutate responses, retry,
// or change auth state. Raw diagnostics remain in the caller's original result.
const registry = Object.create(null);
function register(key, codes) {
  for (const code of codes.split(' ')) registry[code] = key;
}

register('authRequired', 'AUTH_REQUIRED');
register('sessionExpired', 'SESSION_EXPIRED');
register('downloadTimeout', 'DOWNLOAD_TIMEOUT');
register('forbidden', 'FORBIDDEN PERMISSION_DENIED');
register('conflict', 'DRAFT_NAME_CONFLICT ATTEMPT_NAME_CONFLICT ROLEPLAYSCENE_DRAFT_NAME_CONFLICT PUBLISHED_PACKAGE_CONFLICT ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT');
register('slots', 'DRAFT_SLOT_LIMIT_REACHED ATTEMPT_SLOT_LIMIT_REACHED ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED');
register('notFound', 'UPLOADED_DRAFT_NOT_FOUND UPLOADED_ATTEMPT_NOT_FOUND PUBLISHED_PACKAGE_NOT_FOUND PUBLISHED_ARTIFACT_NOT_FOUND ROLEPLAYSCENE_DRAFT_NOT_FOUND ROLEPLAYSCENE_PUBLISHED_SCENE_NOT_FOUND DRAFT_REPLACE_TARGET_MISSING ATTEMPT_REPLACE_TARGET_MISSING ROLEPLAYSCENE_DRAFT_REPLACE_TARGET_MISSING');
register('invalidPackage', 'INVALID_ATTEMPT_PACKAGE INVALID_WORKSHEET_PACKAGE INVALID_ROLEPLAYSCENE_PACKAGE INVALID_ROLEPLAYSCENE_PACKAGE_ZIP INVALID_ROLEPLAYSCENE_MANIFEST INVALID_ROLEPLAYSCENE_MANIFEST_JSON INVALID_ROLEPLAYSCENE_PROJECT_JSON INVALID_ROLEPLAYSCENE_PROJECT INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_FORMAT UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_VERSION ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT');
register('packageLimits', 'ROLEPLAYSCENE_PACKAGE_RESOURCE_LIMIT_EXCEEDED');
register('invalidRequest', 'INVALID_UPLOAD_OPERATION_ID INVALID_UPLOADED_DRAFT_ID INVALID_UPLOADED_ATTEMPT_ID INVALID_PUBLISHED_PACKAGE_ID INVALID_ROLEPLAYSCENE_UPLOADED_DRAFT_ID INVALID_ROLEPLAYSCENE_PUBLISHED_SCENE_ID');
register('alreadyPublished', 'DRAFT_ARTIFACT_ALREADY_PUBLISHED ROLEPLAYSCENE_DRAFT_ARTIFACT_ALREADY_PUBLISHED');
register('missingMedia', 'ROLEPLAYSCENE_MEDIA_MISSING');
register('invalidScene', 'ROLEPLAYSCENE_SPEECH_BUBBLE_INVALID');
register('operationMismatch', 'UPLOAD_OPERATION_MISMATCH');
register('rateLimited', 'RATE_LIMITED RATE_LIMIT_EXCEEDED');
register('uploadTooLarge', 'UPLOAD_TOO_LARGE PAYLOAD_TOO_LARGE');
register('busy', 'BUSY SERVICE_BUSY');
register('voiceUnsupported', 'VOICE_CHOICE_UNSUPPORTED');
register('invalidResponse', 'INVALID_JSON_RESPONSE UNEXPECTED_NON_JSON_RESPONSE UNEXPECTED_CONTENT_TYPE BRIDGE_EMPTY_RESPONSE');
register('sessionFailed', 'SESSION_PROBE_ERROR SESSION_PROBE_FAILED AUTH_POPUP_FLOW_ERROR');
register('sessionTimeout', 'SESSION_PROBE_TIMEOUT SESSION_TIMEOUT SESSION_WAIT_TIMEOUT');
register('popupBlockedHelp', 'AUTH_POPUP_BLOCKED');
register('popupDeadline', 'AUTH_POPUP_FLOW_HARD_DEADLINE');
register('authRequired', 'SESSION_NOT_READY');
register('canceled', 'SESSION_PROBE_CANCELLED SESSION_WAIT_CANCELLED AUTH_POPUP_FLOW_CANCELLED');
register('noRecord', 'NO_ACTIVE_RECORD');
register('restoreMissing', 'RESTORE_RECORD_MISSING');
register('restoreFailed', 'RESTORE_FAILED');
register('staleIntent', 'STALE_CONTEXT INTENT_INVALID');

// Domain codes belong to this repository. The bridge only shares transport,
// authentication and voice error meanings.
const bridgeKeys = new Set(['authRequired', 'sessionExpired', 'forbidden', 'rateLimited', 'uploadTooLarge', 'busy', 'voiceUnsupported', 'invalidResponse']);
const fallbacks = {
  upload: 'uploadFailed',
  publish: 'publishFailed',
  list: 'listFailed',
  open: 'openFailed',
  download: 'downloadFailed',
  delete: 'deleteFailed',
  session: 'sessionFailed',
  audio: 'audioFailed',
  rewrite: 'rewriteFailed',
};
const isPositiveInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function resolveErrorPresentation(result, { operation = 'action', source = 'repository-api' } = {}) {
  const value = result?.result?.error ? result.result : result;
  const error = value?.error || value || {};
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const rawStatus = error.status ?? value?.status ?? value?.statusCode;
  const status = typeof rawStatus === 'number' ? rawStatus
    : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : NaN;
  const params = {};
  let key = Object.hasOwn(fallbacks, operation) ? fallbacks[operation] : 'unknown';
  const known = Object.hasOwn(registry, code) && (source !== 'bridge' || bridgeKeys.has(registry[code]));
  if (known) key = registry[code];
  if (status === 413) key = 'uploadTooLarge';
  if (status === 429) key = 'rateLimited';
  const authWithoutStatus = !known && (!Number.isFinite(status) || status === 0)
    && (error.requiresSignIn || value?.requiresSignIn);
  if (status === 401 || (status === 403 && key !== 'forbidden') || authWithoutStatus) key = 'authRequired';
  const rejected = status >= 400 && status < 500;
  if (!rejected && ['ABORTED', 'CANCELED'].includes(code)) key = operation === 'upload' ? 'uploadCanceled' : 'canceled';
  else if (!rejected && ['NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'REQUEST_TIMEOUT'].includes(code)) key = operation === 'upload' ? 'uploadUncertain' : 'network';
  if (operation === 'upload' && !error.requiresSignIn && !(status >= 400 && status < 500)
      && (status >= 500 || ['INVALID_JSON_RESPONSE', 'UNEXPECTED_NON_JSON_RESPONSE'].includes(code))
      && !['ABORTED', 'CANCELED'].includes(code)) key = 'uploadUncertain';
  if (code === 'PROMPT_TOO_LONG' && source !== 'bridge') {
    key = 'promptTooLong';
    if (isPositiveInteger(error.details?.max)) {
      key = 'promptLimit';
      params.max = error.details.max;
    }
  }
  if (key === 'slots' && isPositiveInteger(error.details?.slotLimit)) {
    key = 'slotsWithLimit';
    params.limit = error.details.slotLimit;
  }
  // Only bounded protocol identifiers/status are suitable for a public details
  // disclosure. Never include arbitrary messages, URLs, headers or request bodies.
  const diagnostic = { source: source === 'bridge' ? 'bridge' : 'repository-api' };
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) diagnostic.code = code;
  if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.status = status;
  return { key: `apiErrors.${key}`, params, diagnostic };
}

export function getApiErrorMessage(result, operation = 'action', source = 'repository-api') {
  const presentation = resolveErrorPresentation(result, { operation, source });
  return t(presentation.key, presentation.params);
}

export function getApiErrorDiagnostic(result, options = {}) {
  const { diagnostic } = resolveErrorPresentation(result, options);
  return Object.entries(diagnostic).map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function createErrorDetails(result, options = {}, doc = document) {
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = t('apiErrors.details');
  const body = doc.createElement('pre');
  body.textContent = getApiErrorDiagnostic(result, options);
  details.append(summary, body);
  return details;
}
