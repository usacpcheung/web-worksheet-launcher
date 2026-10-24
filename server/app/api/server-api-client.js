import { DEFAULT_PUBLISHED_PACKAGE_LIMIT } from './published-packages-service.js';
import { hashUploadRequest } from './upload-operation-contract.js';

const DEFAULT_PUBLIC_API_BASE = '/api/worksheet-launcher/v1';
const BRIDGE_API_BASE = '/api/rewrite-bridge';
const DEFAULT_SIGN_IN_POPUP_PATH = '/worksheet_launcher/app/login/popup.html';

function createAuthMessage() {
  return 'Sign in for server features, then retry this action.';
}

async function parseErrorBody(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text);
      return { kind: 'json', parsed, text };
    } catch {
      return { kind: 'invalid_json', text };
    }
  }
  return { kind: 'text', text };
}

function authLikeStatus(status) {
  return status === 401 || status === 403;
}

function canceledBridgeRequest() {
  return toStructuredError({ code: 'ABORTED', message: 'Bridge request was canceled.' });
}

function normalizePublishedPackagesQuery(query = {}) {
  const source = query && typeof query === 'object' ? query : {};
  const normalizedLimit = Number(source.limit);
  const normalizedOffset = Number(source.offset);
  return {
    title: String(source.title ?? ''),
    subject: String(source.subject ?? ''),
    owner: String(source.owner ?? ''),
    limit: Number.isFinite(normalizedLimit) ? normalizedLimit : DEFAULT_PUBLISHED_PACKAGE_LIMIT,
    offset: Number.isFinite(normalizedOffset) ? normalizedOffset : 0,
  };
}

function toStructuredError({ code, message, status = null, requiresSignIn = false, details = null }) {
  return {
    ok: false,
    error: {
      code,
      message,
      status,
      requiresSignIn,
      ...(details ? { details } : {}),
    },
  };
}

function toTransportError(error, { signal = null, duringRead = false, status = null } = {}) {
  const aborted = signal?.aborted || error?.name === 'AbortError';
  return toStructuredError({
    code: aborted ? 'ABORTED' : 'NETWORK_ERROR',
    status,
    requiresSignIn: !aborted && authLikeStatus(status),
    message: aborted
      ? 'Server API request was cancelled.'
      : duringRead
        ? `Connection was interrupted while reading server data. ${error?.message || String(error)}`
        : `Unable to reach server API. ${error?.message || String(error)}`,
  });
}

function isUncertainRequestFailure(result) {
  const status = result.error?.status;
  // An explicit rejection/auth failure must not be replaced by an old receipt.
  return !result.ok && !result.error?.requiresSignIn && !(status >= 400 && status < 500)
    && (['NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'REQUEST_TIMEOUT', 'INVALID_JSON_RESPONSE', 'UNEXPECTED_NON_JSON_RESPONSE'].includes(result.error?.code)
      || status >= 500);
}

function waitForRecoveryPoll(delayMs, signal) {
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, delayMs);
  });
}

async function parseJsonResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const bodyText = await response.text();
    if (authLikeStatus(response.status) || (response.ok && contentType.includes('text/html'))) {
      return toStructuredError({
        code: 'AUTH_REQUIRED',
        message: createAuthMessage(),
        status: response.status,
        requiresSignIn: true,
      });
    }
    return toStructuredError({
      code: 'UNEXPECTED_NON_JSON_RESPONSE',
      message: 'Server returned an unexpected non-JSON response.',
      status: response.status,
      details: { contentType, bodyPreview: bodyText.slice(0, 120) },
    });
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    if (error?.name !== 'SyntaxError') throw error;
    return toStructuredError({
      code: authLikeStatus(response.status) ? 'AUTH_REQUIRED' : 'INVALID_JSON_RESPONSE',
      message: authLikeStatus(response.status) ? createAuthMessage() : 'Server returned malformed JSON.',
      status: response.status,
      requiresSignIn: authLikeStatus(response.status),
    });
  }

  if (response.ok && parsed?.ok === true) {
    return { ok: true, data: parsed.data, status: response.status };
  }

  const errorCode = parsed?.error?.code || (authLikeStatus(response.status) ? 'AUTH_REQUIRED' : 'API_ERROR');
  return toStructuredError({
    code: errorCode,
    message: parsed?.error?.message || (authLikeStatus(response.status) ? createAuthMessage() : 'API request failed.'),
    status: response.status,
    requiresSignIn: authLikeStatus(response.status),
    details: parsed?.error?.details || null,
  });
}

async function parseJsonResponseFromText({ status, contentType = '', text = '' }) {
  const normalizedContentType = String(contentType || '').toLowerCase();
  if (!normalizedContentType.includes('application/json')) {
    if (authLikeStatus(status) || (status >= 200 && status < 300 && normalizedContentType.includes('text/html'))) {
      return toStructuredError({
        code: 'AUTH_REQUIRED',
        message: createAuthMessage(),
        status,
        requiresSignIn: true,
      });
    }
    return toStructuredError({
      code: 'UNEXPECTED_NON_JSON_RESPONSE',
      message: 'Server returned an unexpected non-JSON response.',
      status,
      details: { contentType: normalizedContentType, bodyPreview: String(text || '').slice(0, 120) },
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return toStructuredError({
      code: authLikeStatus(status) ? 'AUTH_REQUIRED' : 'INVALID_JSON_RESPONSE',
      message: authLikeStatus(status) ? createAuthMessage() : 'Server returned malformed JSON.',
      status,
      requiresSignIn: authLikeStatus(status),
    });
  }

  if (status >= 200 && status < 300 && parsed?.ok === true) {
    return { ok: true, data: parsed.data, status };
  }

  const errorCode = parsed?.error?.code || (authLikeStatus(status) ? 'AUTH_REQUIRED' : 'API_ERROR');
  return toStructuredError({
    code: errorCode,
    message: parsed?.error?.message || (authLikeStatus(status) ? createAuthMessage() : 'API request failed.'),
    status,
    requiresSignIn: authLikeStatus(status),
    details: parsed?.error?.details || null,
  });
}

function createServerApiClient({ uploadTimeoutMs = 120000, listTimeoutMs = 15000, operationLookupTimeoutMs = 5000 } = {}) {
  const publicApiBase = DEFAULT_PUBLIC_API_BASE;
  const operationLookupDeadlineMs = Number.isFinite(operationLookupTimeoutMs) && operationLookupTimeoutMs > 0
    ? operationLookupTimeoutMs : 5000;

  function buildUrl(path, query = null) {
    const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
    const base = `${publicApiBase}${normalizedPath}`;
    if (!query || Object.keys(query).length === 0) return base;
    const url = new URL(base, window.location.origin);
    Object.entries(query).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return `${url.pathname}${url.search}`;
  }

  function buildAppUrl(path, query = null) {
    const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
    const base = normalizedPath;
    if (!query || Object.keys(query).length === 0) return base;
    const url = new URL(base, window.location.origin);
    Object.entries(query).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return `${url.pathname}${url.search}`;
  }

  function requestWithDeadline(path, { signal = null, deadlineMs = listTimeoutMs, label = 'List refresh', cache } = {}) {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 15000;
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => {
        finish(toStructuredError({ code: 'ABORTED', message: `${label} was canceled. Any completed upload remains saved.` }));
        controller.abort();
      };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        finish(toStructuredError({ code: 'REQUEST_TIMEOUT', message: `${label} timed out. Refresh again to see uploaded items.` }));
        controller.abort();
      }, timeoutMs);
      requestJson(path, { signal: controller.signal, cache }).then(finish);
    });
  }

  async function requestJson(path, request = {}) {
    const { method = 'GET', query = null, body = null, headers = {}, signal = null, cache } = request;
    let response;
    try {
      response = await fetch(buildUrl(path, query), {
        method,
        credentials: 'include',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(signal ? { signal } : {}),
        ...(cache ? { cache } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      return toTransportError(error, { signal });
    }
    try {
      return await parseJsonResponse(response);
    } catch (error) {
      return toTransportError(error, { signal, duringRead: true, status: response.status });
    }
  }

  async function requestZip(path, request = {}) {
    const { method = 'GET', query = null, body = null, headers = {}, onProgress = null, signal = null, requireIdentityEncoding = false } = request;
    let response;
    try {
      response = await fetch(buildUrl(path, query), {
        method,
        credentials: 'include',
        headers,
        ...(signal ? { signal } : {}),
        ...(body ? { body } : {}),
      });
    } catch (error) {
      return toTransportError(error, { signal });
    }

    if (!response.ok) {
      let parsedError;
      try {
        parsedError = await parseErrorBody(response);
      } catch (error) {
        return toTransportError(error, { signal, duringRead: true, status: response.status });
      }
      // Explicit resource permission denial must survive the legacy 403 auth
      // fallback. Gateway HTML/malformed responses retain their existing policy.
      const permissionCode = parsedError.kind === 'json'
        ? String(parsedError.parsed?.error?.code || '').toUpperCase() : '';
      if (response.status === 403 && ['FORBIDDEN', 'PERMISSION_DENIED'].includes(permissionCode)) {
        return toStructuredError({
          code: permissionCode,
          message: parsedError.parsed.error.message || 'Permission denied.',
          status: response.status,
          details: parsedError.parsed.error.details || null,
        });
      }
      if (authLikeStatus(response.status)) {
        return toStructuredError({
          code: 'AUTH_REQUIRED',
          message: createAuthMessage(),
          status: response.status,
          requiresSignIn: true,
        });
      }
      if (parsedError.kind === 'json') {
        return toStructuredError({
          code: parsedError.parsed?.error?.code || 'API_ERROR',
          message: parsedError.parsed?.error?.message || 'API request failed.',
          status: response.status,
        });
      }
      return toStructuredError({
        code: 'API_ERROR',
        message: 'API request failed.',
        status: response.status,
      });
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return toStructuredError({ code: 'AUTH_REQUIRED', message: createAuthMessage(), status: response.status, requiresSignIn: true });
    }
    if (!contentType.includes('application/zip')) {
      return toStructuredError({
        code: 'UNEXPECTED_CONTENT_TYPE',
        message: `Expected ZIP artifact but got ${contentType || 'unknown'}.`,
        status: response.status,
      });
    }

    try {
      if (typeof onProgress !== 'function' || !response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: true, data: bytes, status: response.status };
      }

      const total = Number(response.headers.get('content-length') || 0);
      const encoding = response.headers.get('content-encoding');
      const lengthComputable = Number.isFinite(total) && total > 0
        && (!requireIdentityEncoding || !encoding || encoding.toLowerCase() === 'identity');
      const reader = response.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ loaded, total: lengthComputable ? total : 0, lengthComputable });
      }

      const bytes = new Uint8Array(loaded);
      let offset = 0;
      chunks.forEach((chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      });
      return { ok: true, data: bytes, status: response.status };
    } catch (error) {
      return toTransportError(error, { signal, duringRead: true, status: response.status });
    }
  }

  async function requestBinary(path, expectedMime, request = {}) {
    const { method = 'GET', body = null, headers = {}, signal = null } = request;
    let response;
    try {
      if (signal?.aborted) return canceledBridgeRequest();
      response = await fetch(`${BRIDGE_API_BASE}${path}`, {
        method,
        credentials: 'include',
        headers,
        ...(body ? { body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return canceledBridgeRequest();
      return toStructuredError({
        code: 'NETWORK_ERROR',
        message: `Unable to reach bridge API. ${error?.message || String(error)}`,
      });
    }

    try {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();

      if (!response.ok) {
        const parsedError = await parseErrorBody(response);
        const explicitCode = parsedError.parsed?.error?.code || parsedError.parsed?.code;
        const forbidden = response.status === 403 && ['FORBIDDEN', 'PERMISSION_DENIED'].includes(explicitCode);
        if (forbidden) return toStructuredError({ code: 'FORBIDDEN', status: 403, message: 'Permission denied.' });
        if (authLikeStatus(response.status)) {
          return toStructuredError({
            code: 'AUTH_REQUIRED',
            message: createAuthMessage(),
            status: response.status,
            requiresSignIn: true,
          });
        }
        if (parsedError.kind === 'json') {
          return toStructuredError({
            code: parsedError.parsed?.error?.code || 'API_ERROR',
            message: parsedError.parsed?.error?.message || 'API request failed.',
            status: response.status,
          });
        }
        return toStructuredError({
          code: 'API_ERROR',
          message: 'API request failed.',
          status: response.status,
        });
      }

      if (contentType.includes('text/html')) {
        return toStructuredError({
          code: 'AUTH_REQUIRED',
          message: createAuthMessage(),
          status: response.status,
          requiresSignIn: true,
        });
      }

      if (!contentType.includes(String(expectedMime || '').toLowerCase())) {
        return toStructuredError({
          code: 'UNEXPECTED_CONTENT_TYPE',
          message: `Expected ${expectedMime} response but got ${contentType || 'unknown'}.`,
          status: response.status,
        });
      }

      const bytes = await response.arrayBuffer();
      if (signal?.aborted) return canceledBridgeRequest();
      if (!bytes || bytes.byteLength <= 0) {
        return toStructuredError({
          code: 'BRIDGE_EMPTY_RESPONSE',
          message: 'Bridge returned an empty binary response.',
          status: response.status,
        });
      }
      return { ok: true, data: new Uint8Array(bytes), status: response.status };
    } catch (error) {
      return toTransportError(error, { signal, duringRead: true });
    }
  }

  function getUploadOperation(operationId, { signal = null } = {}, deadlineMs = operationLookupDeadlineMs) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId || '')) {
      return Promise.resolve(toStructuredError({ code: 'INVALID_UPLOAD_OPERATION_ID', message: 'Upload operation ID must be a UUID.' }));
    }
    return requestWithDeadline(`/upload-operations/${operationId.toLowerCase()}`, {
      signal, deadlineMs, label: 'Upload status lookup', cache: 'no-store',
    });
  }

  async function recoverUploadOperation(id, kind, requestHash, signal) {
    const deadline = performance.now() + operationLookupDeadlineMs;
    let interval = 250;
    while (!signal?.aborted) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      const status = await getUploadOperation(id, { signal }, remaining);
      if (signal?.aborted || performance.now() >= deadline) return null;
      const receipt = status.data;
      if (status.ok) {
        if (receipt?.operationId !== id) return null;
        if (receipt.state === 'completed') {
          return receipt.kind === kind && receipt.requestSha256 === requestHash && receipt.result?.ok === true
            ? receipt.result : null;
        }
        if (receipt.state !== 'unknown') return null;
      } else if (!isUncertainRequestFailure(status)) {
        return null; // Auth, unsupported endpoint and other permanent failures.
      }
      // A receipt remains invisible until COMMIT; polling never resends the ZIP.
      await waitForRecoveryPoll(Math.min(interval, Math.max(0, deadline - performance.now())), signal);
      interval = Math.min(interval * 2, 1000);
    }
    return null;
  }

  async function uploadZip(path, zipBytes, request = {}) {
    const operationId = request.operationId ?? globalThis.crypto?.randomUUID?.();
    if (operationId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      return toStructuredError({ code: 'INVALID_UPLOAD_OPERATION_ID', message: 'Upload operation ID must be a UUID.' });
    }
    const id = operationId?.toLowerCase();
    const expectedKind = {
      '/drafts/upload': 'worksheet-draft', '/attempts/upload': 'worksheet-attempt',
      '/roleplayscene/drafts/upload': 'roleplayscene-draft',
    }[path];
    // Hash precisely what URLSearchParams sends (including UTF-16 repair), and
    // freeze query values before awaiting hashing just as we snapshot ZIP bytes.
    const query = Object.fromEntries(new URL(buildUrl(path, request.query), window.location.origin).searchParams);
    // Snapshot before hashing so caller mutations cannot change the sent bytes.
    const body = ArrayBuffer.isView(zipBytes)
      ? new Uint8Array(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength).slice()
      : zipBytes instanceof ArrayBuffer ? zipBytes.slice(0) : zipBytes;
    let requestHash = null;
    if (id) {
      requestHash = await hashUploadRequest(expectedKind, [query.title, query.subject ?? query.description, query.conflictAction], body).catch(() => null);
    }
    const result = await uploadZipOnce(path, body, { ...request, query, operationId: id });
    if (!id) return result; // Older/non-secure browser contexts keep the legacy transport.
    if (isUncertainRequestFailure(result) && requestHash && !request.signal?.aborted) {
      const recovered = await recoverUploadOperation(id, expectedKind, requestHash, request.signal);
      if (request.signal?.aborted) {
        return { ...toStructuredError({ code: 'ABORTED', message: 'Upload status lookup was canceled. The server may already have saved the upload.' }), operationId: id };
      }
      if (recovered) {
        return { ok: true, data: recovered.data, status: recovered.statusCode, operationId: id, recovered: true };
      }
    }
    // Never resend automatically: older servers may ignore Idempotency-Key.
    return { ...result, operationId: id };
  }

  async function uploadZipOnce(path, zipBytes, request = {}) {
    const { query = null, onProgress = null, signal = null, operationId = null } = request;
    const targetUrl = buildUrl(path, query);
    const timeoutMs = Number.isFinite(uploadTimeoutMs) && uploadTimeoutMs > 0 ? uploadTimeoutMs : 120000;
    return new Promise((resolve) => {
      let settled = false;
      let abortTransport = () => {};
      let timer;
      let responseStatus = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      const canceled = () => toStructuredError({ code: 'ABORTED', message: 'Upload was canceled. Refresh uploaded items before retrying; the server may already have received it.' });
      const timedOut = () => toStructuredError({ code: 'UPLOAD_TIMEOUT', status: responseStatus, requiresSignIn: authLikeStatus(responseStatus), message: 'Upload timed out. Refresh uploaded items before retrying; the server may already have received it.' });
      const cancel = () => { finish(canceled()); abortTransport(); };
      if (signal?.aborted) { finish(canceled()); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        finish(timedOut());
        abortTransport();
      }, timeoutMs);

      if (typeof XMLHttpRequest !== 'function') {
        const controller = new AbortController();
        abortTransport = () => controller.abort();
        // The deadline covers response body consumption as well as headers.
        (async () => {
          try {
            const response = await fetch(targetUrl, {
              method: 'POST', credentials: 'include',
              headers: { 'content-type': 'application/zip', ...(operationId ? { 'idempotency-key': operationId } : {}) }, body: zipBytes, signal: controller.signal,
            });
            responseStatus = response.status;
            finish(await parseJsonResponse(response));
          } catch (error) {
            finish(toTransportError(error, { signal: controller.signal, duringRead: true, status: responseStatus }));
          }
        })();
        return;
      }

      try {
        const xhr = new XMLHttpRequest();
        abortTransport = () => { try { xhr.abort(); } catch {} };
        xhr.open('POST', targetUrl, true);
        xhr.withCredentials = true;
        xhr.responseType = 'text';
        xhr.timeout = timeoutMs;
        xhr.setRequestHeader('content-type', 'application/zip');
        if (operationId) xhr.setRequestHeader('idempotency-key', operationId);
        xhr.onreadystatechange = () => {
          // XHR resets status to 0 on timeout/network error. Retain headers
          // already received so an explicit 4xx cannot become recoverable.
          if (!settled && xhr.readyState >= 2 && xhr.status > 0) responseStatus = Number(xhr.status);
        };
        if (typeof onProgress === 'function' && xhr.upload) {
          xhr.upload.onprogress = event => {
            if (!settled) onProgress({ loaded: Number(event?.loaded || 0), total: Number(event?.total || 0), lengthComputable: Boolean(event?.lengthComputable) });
          };
        }
        xhr.onerror = () => finish(toStructuredError({ code: 'NETWORK_ERROR', status: responseStatus, requiresSignIn: authLikeStatus(responseStatus), message: 'Unable to reach server API. Network request failed.' }));
        xhr.onabort = () => finish(canceled());
        xhr.ontimeout = () => finish(timedOut());
        xhr.onload = async () => {
          try {
            finish(await parseJsonResponseFromText({ status: Number(xhr.status || 0), contentType: xhr.getResponseHeader('content-type') || '', text: xhr.responseText || '' }));
          } catch (error) { finish(toTransportError(error, { duringRead: true, status: responseStatus })); }
        };
        xhr.send(zipBytes);
      } catch (error) { finish(toTransportError(error, { signal, status: responseStatus })); }
    });
  }

  return {
    publicApiBase,
    getSessionSignInUrl(context = {}) {
      const source = typeof context.source === 'string' && context.source.trim()
        ? context.source.trim()
        : null;
      const authFlowId = typeof context.authFlowId === 'string' && context.authFlowId.trim()
        ? context.authFlowId.trim()
        : null;
      const query = {};
      if (source) query.source = source;
      if (authFlowId) query.authFlowId = authFlowId;
      return buildAppUrl(DEFAULT_SIGN_IN_POPUP_PATH, Object.keys(query).length > 0 ? query : null);
    },
    getSession(options = {}) {
      return requestJson('/session', { signal: options.signal });
    },
    listUploadedDrafts(options = {}) {
      return requestWithDeadline('/drafts', options);
    },
    getUploadOperation(operationId, options = {}) {
      return getUploadOperation(operationId, options);
    },
    uploadDraftPackage(zipBytes, metadata = {}, options = {}) {
      return uploadZip('/drafts/upload', zipBytes, {
        operationId: options.operationId,
        query: {
          title: metadata.title || '',
          subject: metadata.subject || '',
          conflictAction: metadata.conflictAction || '',
        },
        onProgress: options.onProgress,
        signal: options.signal,
      });
    },
    fetchUploadedDraftArtifact(uploadedDraftId, options = {}) {
      return requestZip(`/drafts/${uploadedDraftId}/artifact`, { ...options, requireIdentityEncoding: true });
    },
    deleteUploadedDraft(uploadedDraftId) {
      return requestJson(`/drafts/${uploadedDraftId}`, { method: 'DELETE' });
    },
    listRolePlaySceneDrafts(options = {}) {
      return requestWithDeadline('/roleplayscene/drafts', options);
    },
    uploadRolePlaySceneDraftPackage(zipBytes, metadata = {}, options = {}) {
      return uploadZip('/roleplayscene/drafts/upload', zipBytes, {
        operationId: options.operationId,
        query: {
          title: metadata.title || '',
          description: metadata.description || '',
          conflictAction: metadata.conflictAction || '',
        },
        onProgress: options.onProgress,
        signal: options.signal,
      });
    },
    fetchRolePlaySceneDraftArtifact(uploadedDraftId, options = {}) {
      return requestZip(`/roleplayscene/drafts/${uploadedDraftId}/artifact`, options);
    },
    deleteRolePlaySceneDraft(uploadedDraftId) {
      return requestJson(`/roleplayscene/drafts/${uploadedDraftId}`, { method: 'DELETE' });
    },
    publishRolePlaySceneFromUploadedDraft(uploadedDraftId, metadata = {}) {
      return requestJson('/roleplayscene/published', {
        method: 'POST',
        body: {
          uploadedDraftId,
          title: metadata.title || '',
          ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
        },
      });
    },
    listRolePlayScenePublishedScenes(filters = {}) {
      return requestJson('/roleplayscene/published', {
        query: {
          q: filters.q || '',
          title: filters.title || '',
          description: filters.description || '',
          owner: filters.owner || '',
          limit: filters.limit ?? '',
          offset: filters.offset ?? '',
        },
      });
    },
    fetchRolePlayScenePublishedScene(publishedSceneId, options = {}) {
      return requestJson(`/roleplayscene/published/${publishedSceneId}`, options);
    },
    fetchRolePlayScenePublishedSceneArtifact(publishedSceneId, options = {}) {
      return requestZip(`/roleplayscene/published/${publishedSceneId}/artifact`, options);
    },
    deleteRolePlayScenePublishedScene(publishedSceneId) {
      return requestJson(`/roleplayscene/published/${publishedSceneId}`, { method: 'DELETE' });
    },
    listUploadedAttempts(options = {}) {
      return requestWithDeadline('/attempts', options);
    },
    uploadAttemptPackage(zipBytes, metadata = {}, options = {}) {
      return uploadZip('/attempts/upload', zipBytes, {
        operationId: options.operationId,
        query: {
          title: metadata.title || '',
          subject: metadata.subject || '',
          conflictAction: metadata.conflictAction || '',
        },
        onProgress: options.onProgress,
        signal: options.signal,
      });
    },
    fetchUploadedAttemptArtifact(uploadedAttemptId) {
      return requestZip(`/attempts/${uploadedAttemptId}/artifact`);
    },
    deleteUploadedAttempt(uploadedAttemptId) {
      return requestJson(`/attempts/${uploadedAttemptId}`, { method: 'DELETE' });
    },
    publishFromUploadedDraft(uploadedDraftId, metadata = {}) {
      return requestJson('/published', {
        method: 'POST',
        body: {
          uploadedDraftId,
          title: metadata.title || '',
          subject: metadata.subject || '',
        },
      });
    },
    listPublishedPackages(query = {}) {
      return requestJson('/published', { query: normalizePublishedPackagesQuery(query) });
    },
    fetchPublishedPackageArtifact(publishedPackageId, options = {}) {
      return requestZip(`/published/${publishedPackageId}/artifact`, { ...options, requireIdentityEncoding: true });
    },
    deletePublishedPackage(publishedPackageId) {
      return requestJson(`/published/${publishedPackageId}`, { method: 'DELETE' });
    },
    // Cancellation stops local waiting; admitted backend work may still complete.
    async transcribeAudio(audioBlob, { signal } = {}) {
      if (signal?.aborted) return canceledBridgeRequest();
      try {
        const form = new FormData();
        form.append('audio', audioBlob);
        const response = await fetch(`${BRIDGE_API_BASE}/transcriptions`, {
          method: 'POST', credentials: 'include', body: form,
          ...(signal ? { signal } : {}),
        });
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const text = await response.text();
        if (signal?.aborted) return canceledBridgeRequest();
        if (!contentType.includes('application/json')) {
          const auth = authLikeStatus(response.status) || (contentType.includes('text/html')
            && /sign[\s-]?in|log[\s-]?in|auth|unauthori[sz]ed/i.test(text));
          return toStructuredError({
            code: auth ? 'AUTH_REQUIRED' : 'UNEXPECTED_NON_JSON_RESPONSE',
            message: auth ? createAuthMessage() : 'Server returned an unexpected non-JSON response.',
            status: response.status, requiresSignIn: auth,
          });
        }
        let body;
        try { body = JSON.parse(text); } catch {
          return toStructuredError({ code: 'INVALID_JSON_RESPONSE',
            message: 'Server returned malformed JSON.', status: response.status });
        }
        if (!response.ok || body?.ok !== true) {
          return toStructuredError({
            code: body?.error?.code || body?.code || (authLikeStatus(response.status) ? 'AUTH_REQUIRED' : 'API_ERROR'),
            message: body?.error?.message || body?.message || (authLikeStatus(response.status) ? createAuthMessage() : 'API request failed.'),
            status: response.status, requiresSignIn: authLikeStatus(response.status),
          });
        }
        if (typeof body.result !== 'string' || !body.result.trim()) {
          return toStructuredError({ code: 'BRIDGE_EMPTY_RESPONSE',
            message: 'Bridge returned an empty transcription response.', status: response.status });
        }
        return { ok: true, data: { text: body.result,
          durationSeconds: body.durationSeconds ?? null, requestId: body.requestId ?? null,
          timings: body.timings ?? null }, status: response.status };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return canceledBridgeRequest();
        // Never include response bodies, audio, or thrown exception text in diagnostics.
        return toStructuredError({ code: 'NETWORK_ERROR', message: 'Unable to reach bridge API.' });
      }
    },
    async rewriteText(text, { signal } = {}) {
      // Cancellation is opt-in; existing callers retain their legacy error contract.
      if (signal?.aborted) return canceledBridgeRequest();
      try {
        let response;
        try {
          response = await fetch(`${BRIDGE_API_BASE}/rewrite`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: String(text),
              stream: false,
            }),
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          if (signal && (signal.aborted || error?.name === 'AbortError')) return canceledBridgeRequest();
          return toStructuredError({
            code: 'NETWORK_ERROR',
            message: `Unable to reach bridge API. ${error?.message || String(error)}`,
          });
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const authBodyPreviewLimit = 1200;
        if (contentType.includes('text/html')) {
          const bodyText = await response.text();
          if (signal?.aborted) return canceledBridgeRequest();
          const loweredBody = bodyText.toLowerCase();
          const authHintedHtml = /sign[\s-]?in|log[\s-]?in|auth|unauthori[sz]ed/.test(loweredBody);
          const shouldTreatAsAuth = authLikeStatus(response.status) || authHintedHtml;
          if (shouldTreatAsAuth) {
            return toStructuredError({
              code: 'AUTH_REQUIRED',
              message: createAuthMessage(),
              status: response.status,
              requiresSignIn: true,
              details: {
                contentType,
                bodyPreview: bodyText.slice(0, authBodyPreviewLimit),
                bodyLength: bodyText.length,
                bodyTruncated: bodyText.length > authBodyPreviewLimit,
              },
            });
          }
          return toStructuredError({
            code: 'UNEXPECTED_NON_JSON_RESPONSE',
            message: 'Server returned an unexpected non-JSON response.',
            status: response.status,
            details: {
              contentType,
              bodyPreview: bodyText.slice(0, authBodyPreviewLimit),
              bodyLength: bodyText.length,
              bodyTruncated: bodyText.length > authBodyPreviewLimit,
            },
          });
        }
        if (!contentType.includes('application/json')) {
          const bodyText = await response.text();
          if (signal?.aborted) return canceledBridgeRequest();
          if (authLikeStatus(response.status)) {
            return toStructuredError({
              code: 'AUTH_REQUIRED',
              message: createAuthMessage(),
              status: response.status,
              requiresSignIn: true,
              details: {
                contentType,
                bodyPreview: bodyText.slice(0, authBodyPreviewLimit),
                bodyLength: bodyText.length,
                bodyTruncated: bodyText.length > authBodyPreviewLimit,
              },
            });
          }
          return toStructuredError({
            code: 'UNEXPECTED_NON_JSON_RESPONSE',
            message: 'Server returned an unexpected non-JSON response.',
            status: response.status,
            details: { contentType, bodyPreview: bodyText.slice(0, 120) },
          });
        }
        let body;
        try {
          body = await response.json();
          if (signal?.aborted) return canceledBridgeRequest();
        } catch (error) {
          if (signal && (signal.aborted || error?.name === 'AbortError')) return canceledBridgeRequest();
          return toStructuredError({
            code: 'INVALID_JSON_RESPONSE',
            message: 'Server returned malformed JSON.',
            status: response.status,
          });
        }
        if (!response.ok || body?.ok !== true) {
          const errorCode = body?.error?.code || (authLikeStatus(response.status) ? 'AUTH_REQUIRED' : 'API_ERROR');
          return toStructuredError({
            code: errorCode,
            message: body?.error?.message || (authLikeStatus(response.status) ? createAuthMessage() : 'API request failed.'),
            status: response.status,
            requiresSignIn: authLikeStatus(response.status),
            details: body?.error?.details || null,
          });
        }
        // Bridge returns { ok: true, result: "..." } — not data.text
        const rewrittenText = typeof body.result === 'string' ? body.result.trim() : '';
        if (!rewrittenText) {
          return toStructuredError({
            code: 'BRIDGE_EMPTY_RESPONSE',
            message: 'Bridge returned an empty rewrite response.',
            status: response.status,
          });
        }
        return { ok: true, data: { text: rewrittenText }, status: response.status };
      } catch (error) {
        if (!signal) throw error;
        if (signal && (signal.aborted || error?.name === 'AbortError')) return canceledBridgeRequest();
        return toStructuredError({ code: 'NETWORK_ERROR', message: 'Unable to reach bridge API.' });
      }
    },
    async generateAudioFromText(text, options = {}, request = {}) {
      const payload = {
        text: String(text),
        format: 'mp3',
        response_mode: 'binary',
      };
      const voiceControls = ['voice_id', 'language_boost', 'speed', 'volume', 'pitch'];
      if (Object.hasOwn(options || {}, 'voice_choice')) {
        if (typeof options.voice_choice !== 'string' || !options.voice_choice.trim()) {
          return toStructuredError({ code: 'INVALID_INPUT', message: 'voice_choice must be a non-empty string.', status: 400 });
        }
        // A named choice owns all voice tuning. Reject even empty overrides.
        const conflictingField = voiceControls.find((key) => Object.hasOwn(options, key));
        if (conflictingField) {
          return toStructuredError({ code: 'INVALID_INPUT', message: `voice_choice cannot be combined with ${conflictingField}.`, status: 400 });
        }
        payload.voice_choice = options.voice_choice.trim();
      } else {
        voiceControls.forEach((key) => {
          if (options?.[key] !== undefined && options?.[key] !== null && options?.[key] !== '') {
            payload[key] = options[key];
          }
        });
      }
      return requestBinary('/t2a', 'audio/mpeg', {
        method: 'POST',
        signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
  };
}

export { DEFAULT_PUBLIC_API_BASE, createServerApiClient };
