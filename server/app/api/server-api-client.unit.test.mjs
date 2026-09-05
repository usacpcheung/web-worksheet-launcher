import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';

function mockJsonResponse(status, payload, headers = { 'content-type': 'application/json; charset=utf-8' }) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function setTestWindow(search = '') {
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search,
    },
  };
}

test('createServerApiClient uses production public base path by default', async () => {
  setTestWindow();
  globalThis.fetch = async () => mockJsonResponse(200, { ok: true, data: { ready: true } });

  const client = createServerApiClient();
  assert.equal(client.publicApiBase, '/api/worksheet-launcher/v1');
  await client.getSession();
});

test('getSession builds canonical public API URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { ready: true } });
  };

  const client = createServerApiClient();
  await client.getSession();
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/session');
});

test('public API requests ignore query-controlled or option-controlled API bases', async () => {
  const hostileInputs = [
    '?apiBase=https%3A%2F%2Fattacker.example%2Fapi',
    '?apiBase=%2F%2Fattacker.example%2Fapi',
  ];

  for (const search of hostileInputs) {
    setTestWindow(search);
    let requestedUrl = null;
    globalThis.fetch = async (url) => {
      requestedUrl = url;
      return mockJsonResponse(200, { ok: true, data: { ready: true } });
    };

    const client = createServerApiClient({ apiBase: 'https://attacker.example/api' });
    await client.getSession();

    assert.equal(client.publicApiBase, '/api/worksheet-launcher/v1');
    assert.equal(requestedUrl, '/api/worksheet-launcher/v1/session');
  }
});

test('getSessionSignInUrl builds popup login path under app/login', async () => {
  setTestWindow();

  const client = createServerApiClient();
  assert.equal(client.getSessionSignInUrl(), '/worksheet_launcher/app/login/popup.html');
  assert.equal(
    client.getSessionSignInUrl({ source: 'editor' }),
    '/worksheet_launcher/app/login/popup.html?source=editor'
  );
  assert.equal(
    client.getSessionSignInUrl({ source: 'editor', authFlowId: 'auth_flow_123' }),
    '/worksheet_launcher/app/login/popup.html?source=editor&authFlowId=auth_flow_123'
  );
});

test('listUploadedDrafts builds canonical public API URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: [] });
  };

  const client = createServerApiClient();
  await client.listUploadedDrafts();
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/drafts');
});

test('getSession returns structured AUTH_REQUIRED for html auth redirect-like responses', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response('<html>login</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  const client = createServerApiClient();
  const result = await client.getSession();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  assert.equal(result.error.requiresSignIn, true);
});

test('fetchPublishedPackageArtifact parses zip payload', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });

  const client = createServerApiClient();
  const result = await client.fetchPublishedPackageArtifact('abc');
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.data), [0x50, 0x4b, 0x03, 0x04]);
});

test('deleteUploadedDraft sends DELETE to canonical drafts path', async () => {
  setTestWindow();
  let requestedUrl = null;
  let requestedMethod = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    requestedMethod = request.method;
    return mockJsonResponse(200, { ok: true, data: { deleted: true } });
  };

  const client = createServerApiClient();
  const result = await client.deleteUploadedDraft('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/drafts/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(requestedMethod, 'DELETE');
});

test('uploadDraftPackage sends metadata and conflict action as query params', async () => {
  setTestWindow();
  const previousXhr = globalThis.XMLHttpRequest;
  let requestedUrl = null;
  let contentType = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    contentType = request.headers?.['content-type'];
    return mockJsonResponse(201, { ok: true, data: { uploaded_draft_id: 'u1' } });
  };

  const client = createServerApiClient();
  const result = await client.uploadDraftPackage(new Uint8Array([0x50, 0x4b]), {
    title: 'Title',
    subject: 'Math',
    conflictAction: 'replace',
  });
  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    '/api/worksheet-launcher/v1/drafts/upload?title=Title&subject=Math&conflictAction=replace'
  );
  assert.equal(contentType, 'application/zip');
  globalThis.XMLHttpRequest = previousXhr;
});

test('listRolePlaySceneDrafts builds canonical public API URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { items: [] } });
  };

  const client = createServerApiClient();
  const result = await client.listRolePlaySceneDrafts();
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/drafts');
});

test('uploadRolePlaySceneDraftPackage sends title description and conflict action', async () => {
  setTestWindow();
  const previousXhr = globalThis.XMLHttpRequest;
  let requestedUrl = null;
  let contentType = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    contentType = request.headers?.['content-type'];
    return mockJsonResponse(201, { ok: true, data: { roleplayscene_uploaded_draft_id: 'r1' } });
  };

  const client = createServerApiClient();
  const result = await client.uploadRolePlaySceneDraftPackage(new Uint8Array([0x50, 0x4b]), {
    title: 'Clinic',
    description: 'Practice draft',
    conflictAction: 'copy',
  });
  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    '/api/worksheet-launcher/v1/roleplayscene/drafts/upload?title=Clinic&description=Practice+draft&conflictAction=copy'
  );
  assert.equal(contentType, 'application/zip');
  globalThis.XMLHttpRequest = previousXhr;
});

test('fetchRolePlaySceneDraftArtifact parses zip payload', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });
  };

  const client = createServerApiClient();
  const result = await client.fetchRolePlaySceneDraftArtifact('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/drafts/550e8400-e29b-41d4-a716-446655440000/artifact');
  assert.deepEqual(Array.from(result.data), [0x50, 0x4b, 0x03, 0x04]);
});

test('fetchRolePlaySceneDraftArtifact reports streamed download progress', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': '4',
    },
  });

  const progressEvents = [];
  const client = createServerApiClient();
  const result = await client.fetchRolePlaySceneDraftArtifact(
    '550e8400-e29b-41d4-a716-446655440000',
    { onProgress: (progress) => progressEvents.push(progress) },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.data), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(progressEvents.at(-1), {
    loaded: 4,
    total: 4,
    lengthComputable: true,
  });
});

test('fetchRolePlaySceneDraftArtifact reports indeterminate progress without content length', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([0x50, 0x4b]), {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });

  const progressEvents = [];
  const client = createServerApiClient();
  const result = await client.fetchRolePlaySceneDraftArtifact('draft-id', {
    onProgress: (progress) => progressEvents.push(progress),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(progressEvents.at(-1), {
    loaded: 2,
    total: 0,
    lengthComputable: false,
  });
});

test('deleteRolePlaySceneDraft sends DELETE to canonical roleplayscene drafts path', async () => {
  setTestWindow();
  let requestedUrl = null;
  let requestedMethod = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    requestedMethod = request.method;
    return mockJsonResponse(200, { ok: true, data: { deleted: true } });
  };

  const client = createServerApiClient();
  const result = await client.deleteRolePlaySceneDraft('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/drafts/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(requestedMethod, 'DELETE');
});

for (const [name, metadata] of [
  ['omitted', {}],
  ['provided', { description: 'Practice ordering food.' }],
  ['cleared', { description: '' }],
]) {
  test(`RolePlayScene publish forwards ${name} description`, async () => {
    setTestWindow();
    let requestedUrl = null;
    let requestBody = null;
    globalThis.fetch = async (url, request = {}) => {
      requestedUrl = url;
      requestBody = request.body;
      return mockJsonResponse(201, { ok: true, data: { roleplayscene_published_scene_id: 'p1' } });
    };

    const client = createServerApiClient();
    const result = await client.publishRolePlaySceneFromUploadedDraft('550e8400-e29b-41d4-a716-446655440000', {
      title: 'Published clinic',
      ...metadata,
    });
    assert.equal(result.ok, true);
    assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/published');
    assert.deepEqual(JSON.parse(requestBody), {
      uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Published clinic',
      ...metadata,
    });
  });

}

test('listRolePlayScenePublishedScenes builds query URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { items: [] } });
  };

  const client = createServerApiClient();
  const result = await client.listRolePlayScenePublishedScenes({
    q: 'clinic',
    title: 'Greeting',
    description: 'Practice',
    owner: 'teacher@example.test',
    limit: 20,
    offset: 40,
  });
  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    '/api/worksheet-launcher/v1/roleplayscene/published?q=clinic&title=Greeting&description=Practice&owner=teacher%40example.test&limit=20&offset=40'
  );
});

test('fetchRolePlayScenePublishedScene builds detail URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { roleplayscene_published_scene_id: 'p1' } });
  };

  const client = createServerApiClient();
  const result = await client.fetchRolePlayScenePublishedScene('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/published/550e8400-e29b-41d4-a716-446655440000');
});

test('fetchRolePlayScenePublishedSceneArtifact parses zip payload', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });
  };

  const client = createServerApiClient();
  const result = await client.fetchRolePlayScenePublishedSceneArtifact('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/published/550e8400-e29b-41d4-a716-446655440000/artifact');
  assert.deepEqual(Array.from(result.data), [0x50, 0x4b, 0x03, 0x04]);
});

test('published scene requests forward cancellation and artifact download progress', async () => {
  setTestWindow();
  const controller = new AbortController();
  const progressEvents = [];
  const seenSignals = [];
  globalThis.fetch = async (url, request = {}) => {
    seenSignals.push(request.signal);
    if (!String(url).endsWith('/artifact')) {
      return mockJsonResponse(200, { ok: true, data: { title: 'Clinic' } });
    }
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': '4',
      },
    });
  };

  const client = createServerApiClient();
  await client.fetchRolePlayScenePublishedScene('550e8400-e29b-41d4-a716-446655440000', {
    signal: controller.signal,
  });
  const artifact = await client.fetchRolePlayScenePublishedSceneArtifact('550e8400-e29b-41d4-a716-446655440000', {
    signal: controller.signal,
    onProgress: progress => progressEvents.push(progress),
  });

  assert.equal(artifact.ok, true);
  assert.deepEqual(seenSignals, [controller.signal, controller.signal]);
  assert.deepEqual(progressEvents.at(-1), {
    loaded: 4,
    total: 4,
    lengthComputable: true,
  });
});

test('deleteRolePlayScenePublishedScene sends DELETE to published scene path', async () => {
  setTestWindow();
  let requestedUrl = null;
  let requestedMethod = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    requestedMethod = request.method;
    return mockJsonResponse(200, { ok: true, data: { deleted: true } });
  };

  const client = createServerApiClient();
  const result = await client.deleteRolePlayScenePublishedScene('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/roleplayscene/published/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(requestedMethod, 'DELETE');
});

test('uploadDraftPackage emits upload progress when XHR progress events exist', async () => {
  setTestWindow();
  const previousXhr = globalThis.XMLHttpRequest;
  const progressEvents = [];

  class FakeXhr {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.responseText = JSON.stringify({ ok: true, data: { uploaded_draft_id: 'u2' } });
      this.status = 201;
      this.withCredentials = false;
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    getResponseHeader(name) {
      if (String(name).toLowerCase() === 'content-type') return 'application/json; charset=utf-8';
      return null;
    }
    send() {
      this.upload.onprogress?.({ loaded: 1024, total: 4096, lengthComputable: true });
      this.upload.onprogress?.({ loaded: 4096, total: 4096, lengthComputable: true });
      this.onload?.();
    }
    abort() {}
  }

  globalThis.XMLHttpRequest = FakeXhr;
  const client = createServerApiClient();
  const result = await client.uploadDraftPackage(
    new Uint8Array([0x50, 0x4b]),
    { title: 'Title', subject: 'Math' },
    { onProgress: (event) => progressEvents.push(event) }
  );

  assert.equal(result.ok, true);
  assert.equal(progressEvents.length, 2);
  assert.deepEqual(progressEvents[0], { loaded: 1024, total: 4096, lengthComputable: true });
  assert.deepEqual(progressEvents[1], { loaded: 4096, total: 4096, lengthComputable: true });
  globalThis.XMLHttpRequest = previousXhr;
});

test('uploadDraftPackage returns structured network error on XHR transport failure', async () => {
  setTestWindow();
  const previousXhr = globalThis.XMLHttpRequest;

  class FailingXhr {
    constructor() {
      this.upload = {};
    }
    open() {}
    setRequestHeader() {}
    send() {
      this.onerror?.();
    }
    abort() {}
  }

  globalThis.XMLHttpRequest = FailingXhr;
  const client = createServerApiClient();
  const result = await client.uploadDraftPackage(new Uint8Array([0x50, 0x4b]), { title: 'Title', subject: 'Math' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
  assert.equal(result.error.message.includes('Unable to reach server API'), true);
  globalThis.XMLHttpRequest = previousXhr;
});

test('uploadDraftPackage does not send when AbortSignal is already aborted', async () => {
  setTestWindow();
  const previousXhr = globalThis.XMLHttpRequest;
  let sendCalled = false;

  class AbortAwareXhr {
    constructor() {
      this.upload = {};
    }
    open() {}
    setRequestHeader() {}
    send() {
      sendCalled = true;
    }
    abort() {}
  }

  globalThis.XMLHttpRequest = AbortAwareXhr;
  const controller = new AbortController();
  controller.abort();

  const client = createServerApiClient();
  const result = await client.uploadDraftPackage(
    new Uint8Array([0x50, 0x4b]),
    { title: 'Title', subject: 'Math' },
    { signal: controller.signal }
  );

  assert.equal(sendCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
  assert.equal(result.error.message, 'Unable to reach server API. Upload was canceled before completion.');

  globalThis.XMLHttpRequest = previousXhr;
});


test('deletePublishedPackage sends DELETE to canonical published path', async () => {
  setTestWindow();
  let requestedUrl = null;
  let requestedMethod = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    requestedMethod = request.method;
    return mockJsonResponse(200, { ok: true, data: { deleted: true } });
  };

  const client = createServerApiClient();
  const result = await client.deletePublishedPackage('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/published/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(requestedMethod, 'DELETE');
});

test('publishFromUploadedDraft sends uploadedDraftId with title and subject overrides', async () => {
  setTestWindow();
  let requestBody = null;
  globalThis.fetch = async (_url, request = {}) => {
    requestBody = request.body;
    return mockJsonResponse(201, { ok: true, data: { published_package_id: 'p1' } });
  };

  const client = createServerApiClient();
  const result = await client.publishFromUploadedDraft('550e8400-e29b-41d4-a716-446655440000', {
    title: 'Published title',
    subject: 'Algebra',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(requestBody), {
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Published title',
    subject: 'Algebra',
  });
});

test('listPublishedPackages sends canonical query shape with title, subject, owner, limit, and offset', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { items: [] } });
  };

  const client = createServerApiClient();
  const result = await client.listPublishedPackages({ title: 'math', subject: 'algebra', owner: 'owner@example.test' });
  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    '/api/worksheet-launcher/v1/published?title=math&subject=algebra&owner=owner%40example.test&limit=20&offset=0'
  );
});

test('rewriteText returns success payload for non-empty result', async () => {
  setTestWindow();
  globalThis.fetch = async (url, request = {}) => {
    assert.equal(url, '/api/rewrite-bridge/rewrite');
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { text: 'hello', stream: false });
    return mockJsonResponse(200, { ok: true, result: ' rewritten ' });
  };

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'rewritten');
});

test('rewriteText returns BRIDGE_EMPTY_RESPONSE for empty/missing/whitespace result', async () => {
  setTestWindow();
  const payloads = [
    { ok: true, result: '' },
    { ok: true, result: '   ' },
    { ok: true },
  ];
  let index = 0;
  globalThis.fetch = async () => mockJsonResponse(200, payloads[index++]);

  const client = createServerApiClient();
  for (let i = 0; i < payloads.length; i += 1) {
    const result = await client.rewriteText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BRIDGE_EMPTY_RESPONSE');
  }
});

test('rewriteText maps auth statuses and auth-like html responses to AUTH_REQUIRED', async () => {
  setTestWindow();
  const responses = [
    mockJsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } }),
    mockJsonResponse(403, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } }),
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  let index = 0;
  globalThis.fetch = async () => responses[index++];

  const client = createServerApiClient();
  for (let i = 0; i < responses.length; i += 1) {
    const result = await client.rewriteText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTH_REQUIRED');
    assert.equal(result.error.requiresSignIn, true);
    if (i === 2) {
      assert.equal(result.error.details?.contentType, 'text/html');
      assert.equal(typeof result.error.details?.bodyPreview, 'string');
      assert.equal(result.error.details.bodyPreview.includes('login'), true);
      assert.equal(result.error.details?.bodyLength > 0, true);
      assert.equal(typeof result.error.details?.bodyTruncated, 'boolean');
    }
  }
});

test('rewriteText treats non-auth html responses as UNEXPECTED_NON_JSON_RESPONSE', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response('<html><body>upstream failed</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNEXPECTED_NON_JSON_RESPONSE');
  assert.equal(result.error.requiresSignIn, false);
  assert.equal(result.error.status, 502);
  assert.equal(result.error.details?.contentType, 'text/html');
  assert.equal(result.error.details?.bodyPreview.includes('upstream failed'), true);
});

test('rewriteText preserves backend auth error payload for JSON 401 responses', async () => {
  setTestWindow();
  globalThis.fetch = async () => mockJsonResponse(401, {
    ok: false,
    error: {
      code: 'BRIDGE_AUTH_HEADER_MISSING',
      message: 'Missing X-Bridge-Auth header.',
      details: { expectedHeader: 'X-Bridge-Auth' },
    },
  });

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BRIDGE_AUTH_HEADER_MISSING');
  assert.equal(result.error.message, 'Missing X-Bridge-Auth header.');
  assert.equal(result.error.status, 401);
  assert.equal(result.error.requiresSignIn, true);
  assert.deepEqual(result.error.details, { expectedHeader: 'X-Bridge-Auth' });
});

test('rewriteText returns NETWORK_ERROR on fetch failure', async () => {
  setTestWindow();
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});

test('generateAudioFromText omits optional voice and language controls when absent', async () => {
  setTestWindow();
  globalThis.fetch = async (url, request = {}) => {
    assert.equal(url, '/api/rewrite-bridge/t2a');
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      text: 'hello',
      format: 'mp3',
      response_mode: 'binary',
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, true);
  assert.equal(result.data instanceof Uint8Array, true);
  assert.deepEqual(Array.from(result.data), [1, 2, 3]);
});

test('generateAudioFromText includes optional voice and language controls only when provided', async () => {
  setTestWindow();
  globalThis.fetch = async (url, request = {}) => {
    assert.equal(url, '/api/rewrite-bridge/t2a');
    assert.deepEqual(JSON.parse(request.body), {
      text: 'hello',
      format: 'mp3',
      response_mode: 'binary',
      voice_id: 'Cantonese_PlayfulMan',
      language_boost: 'Chinese,Yue',
      speed: 1,
      volume: 1,
      pitch: 2,
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello', {
    voice_id: 'Cantonese_PlayfulMan',
    language_boost: 'Chinese,Yue',
    speed: 1,
    volume: 1,
    pitch: 2,
  });
  assert.equal(result.ok, true);
});

test('generateAudioFromText returns BRIDGE_EMPTY_RESPONSE for zero-byte payload', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BRIDGE_EMPTY_RESPONSE');
});

test('generateAudioFromText returns UNEXPECTED_CONTENT_TYPE when mime does not match', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNEXPECTED_CONTENT_TYPE');
});

test('generateAudioFromText maps auth statuses and auth-like html responses to AUTH_REQUIRED', async () => {
  setTestWindow();
  const responses = [
    new Response('', { status: 401, headers: { 'content-type': 'audio/mpeg' } }),
    new Response('', { status: 403, headers: { 'content-type': 'audio/mpeg' } }),
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  let index = 0;
  globalThis.fetch = async () => responses[index++];

  const client = createServerApiClient();
  for (let i = 0; i < responses.length; i += 1) {
    const result = await client.generateAudioFromText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTH_REQUIRED');
    assert.equal(result.error.requiresSignIn, true);
  }
});

test('generateAudioFromText returns NETWORK_ERROR on fetch failure', async () => {
  setTestWindow();
  globalThis.fetch = async () => {
    throw new Error('bridge unreachable');
  };

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});

test('bridge methods always use /api/rewrite-bridge urls regardless of API base query params', async () => {
  setTestWindow('?apiBase=%2Fapi%2Foverride-from-query');
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith('/rewrite')) {
      return mockJsonResponse(200, { ok: true, data: { text: 'rewritten' } });
    }
    return new Response(new Uint8Array([7]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const client = createServerApiClient();
  await client.rewriteText('hello');
  await client.generateAudioFromText('hello');

  assert.deepEqual(requestedUrls, [
    '/api/rewrite-bridge/rewrite',
    '/api/rewrite-bridge/t2a',
  ]);
  assert.equal(client.publicApiBase, '/api/worksheet-launcher/v1');
});
