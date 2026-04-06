const DEFAULT_PUBLIC_API_BASE = '/api/worksheet-launcher';

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
    getSessionSignInUrl() {
      return buildUrl('/api/v1/session');
    },
    getSession() {
      return requestJson('/api/v1/session');
    },
    listUploadedDrafts() {
      return requestJson('/api/v1/drafts');
    },
    uploadDraftPackage(zipBytes, metadata = {}) {
      return uploadZip('/api/v1/drafts/upload', zipBytes, {
        query: {
          title: metadata.title || '',
          subject: metadata.subject || '',
        },
      });
    },
    fetchUploadedDraftArtifact(uploadedDraftId) {
      return requestZip(`/api/v1/drafts/${uploadedDraftId}/artifact`);
    },
    publishFromUploadedDraft(uploadedDraftId) {
      return requestJson('/api/v1/published', {
        method: 'POST',
        body: { uploadedDraftId },
      });
    },
    listPublishedPackages(query = {}) {
      return requestJson('/api/v1/published', { query });
    },
    fetchPublishedPackageArtifact(publishedPackageId) {
      return requestZip(`/api/v1/published/${publishedPackageId}/artifact`);
    },
  };
}

export { DEFAULT_PUBLIC_API_BASE, createServerApiClient };
