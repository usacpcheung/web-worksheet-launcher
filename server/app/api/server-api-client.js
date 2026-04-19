import { DEFAULT_PUBLISHED_PACKAGE_LIMIT } from './published-packages-service.js';

const DEFAULT_PUBLIC_API_BASE = '/api/worksheet-launcher/v1';
const BRIDGE_API_BASE = '/api/rewrite-bridge';
const DEFAULT_SIGN_IN_POPUP_PATH = '/worksheet_launcher/app/login/popup.html';

function buildPublicApiBase(options = {}) {
  const fromOverride = options.apiBase || null;
  if (fromOverride) return String(fromOverride).replace(/\/+$/, '');
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('apiBase');
  if (fromQuery) return String(fromQuery).replace(/\/+$/, '');
  return DEFAULT_PUBLIC_API_BASE;
}

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

async function parseJsonResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const bodyText = await response.text();
    if (authLikeStatus(response.status) || contentType.includes('text/html')) {
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
  } catch {
    return toStructuredError({
      code: 'INVALID_JSON_RESPONSE',
      message: 'Server returned malformed JSON.',
      status: response.status,
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

function createServerApiClient(options = {}) {
  const publicApiBase = buildPublicApiBase(options);

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

  async function requestJson(path, request = {}) {
    const { method = 'GET', query = null, body = null, headers = {} } = request;
    let response;
    try {
      response = await fetch(buildUrl(path, query), {
        method,
        credentials: 'include',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      return toStructuredError({
        code: 'NETWORK_ERROR',
        message: `Unable to reach server API. ${error?.message || String(error)}`,
      });
    }
    return parseJsonResponse(response);
  }

  async function requestZip(path, request = {}) {
    const { method = 'GET', query = null, body = null, headers = {} } = request;
    let response;
    try {
      response = await fetch(buildUrl(path, query), {
        method,
        credentials: 'include',
        headers,
        ...(body ? { body } : {}),
      });
    } catch (error) {
      return toStructuredError({
        code: 'NETWORK_ERROR',
        message: `Unable to reach server API. ${error?.message || String(error)}`,
      });
    }

    if (!response.ok) {
      const parsedError = await parseErrorBody(response);
      if (authLikeStatus(response.status) || response.headers.get('content-type')?.includes('text/html')) {
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
    if (!contentType.includes('application/zip')) {
      return toStructuredError({
        code: 'UNEXPECTED_CONTENT_TYPE',
        message: `Expected ZIP artifact but got ${contentType || 'unknown'}.`,
        status: response.status,
      });
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, data: bytes, status: response.status };
  }

  async function requestBinary(path, expectedMime, request = {}) {
    const { method = 'GET', body = null, headers = {} } = request;
    let response;
    try {
      response = await fetch(`${BRIDGE_API_BASE}${path}`, {
        method,
        credentials: 'include',
        headers,
        ...(body ? { body } : {}),
      });
    } catch (error) {
      return toStructuredError({
        code: 'NETWORK_ERROR',
        message: `Unable to reach bridge API. ${error?.message || String(error)}`,
      });
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();

    if (!response.ok) {
      if (authLikeStatus(response.status) || contentType.includes('text/html')) {
        return toStructuredError({
          code: 'AUTH_REQUIRED',
          message: createAuthMessage(),
          status: response.status,
          requiresSignIn: true,
        });
      }
      const parsedError = await parseErrorBody(response);
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
    if (!bytes || bytes.byteLength <= 0) {
      return toStructuredError({
        code: 'BRIDGE_EMPTY_RESPONSE',
        message: 'Bridge returned an empty binary response.',
        status: response.status,
      });
    }
    return { ok: true, data: new Uint8Array(bytes), status: response.status };
  }

  async function uploadZip(path, zipBytes, request = {}) {
    const { query = null } = request;
    let response;
    try {
      response = await fetch(buildUrl(path, query), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/zip' },
        body: zipBytes,
      });
    } catch (error) {
      return toStructuredError({
        code: 'NETWORK_ERROR',
        message: `Unable to reach server API. ${error?.message || String(error)}`,
      });
    }
    return parseJsonResponse(response);
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
    getSession() {
      return requestJson('/session');
    },
    listUploadedDrafts() {
      return requestJson('/drafts');
    },
    uploadDraftPackage(zipBytes, metadata = {}) {
      return uploadZip('/drafts/upload', zipBytes, {
        query: {
          title: metadata.title || '',
          subject: metadata.subject || '',
        },
      });
    },
    fetchUploadedDraftArtifact(uploadedDraftId) {
      return requestZip(`/drafts/${uploadedDraftId}/artifact`);
    },
    deleteUploadedDraft(uploadedDraftId) {
      return requestJson(`/drafts/${uploadedDraftId}`, { method: 'DELETE' });
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
    fetchPublishedPackageArtifact(publishedPackageId) {
      return requestZip(`/published/${publishedPackageId}/artifact`);
    },
    async rewriteText(text) {
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
        });
      } catch (error) {
        return toStructuredError({
          code: 'NETWORK_ERROR',
          message: `Unable to reach bridge API. ${error?.message || String(error)}`,
        });
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (authLikeStatus(response.status) || contentType.includes('text/html')) {
        return toStructuredError({
          code: 'AUTH_REQUIRED',
          message: createAuthMessage(),
          status: response.status,
          requiresSignIn: true,
        });
      }
      if (!contentType.includes('application/json')) {
        const bodyText = await response.text();
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
      } catch {
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
    },
    generateAudioFromText(text) {
      return requestBinary('/t2a', 'audio/mpeg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: String(text),
          format: 'mp3',
          response_mode: 'binary',
        }),
      });
    },
  };
}

export { DEFAULT_PUBLIC_API_BASE, createServerApiClient };
