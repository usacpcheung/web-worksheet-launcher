import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rewriteModuleSourceForTests } from '../test-utils/module-source-test-helpers.mjs';

async function loadEditorModule() {
  const filePath = path.resolve('server/editor/main.js');
  const source = await fs.readFile(filePath, 'utf8');

  const rewrittenSource = rewriteModuleSourceForTests(source, [
    {
      name: 'replace editor dependency imports with test doubles',
      pattern: /import\s*\{\s*editorStorage\s*\}\s*from\s*['"]\.\/storage\/index\.js['"];\s*import\s*\{\s*SharedAuthGate\s*\}\s*from\s*['"]\.\.\/app\/auth\/shared-auth-gate\.js['"];\s*import\s*\{\s*createServerApiClient\s*\}\s*from\s*['"]\.\.\/app\/api\/server-api-client\.js['"];\s*import\s*\{\s*createWorksheetPackageFromDraft,\s*mapLegacyJsonToPackageModel,\s*parseWorksheetPackage,\s*\}\s*from\s*['"]\.\/worksheet-package\.js['"];\s*/,
      replacement: `const editorStorage = {
  drafts: { get: async () => null, put: async (value) => value, delete: async () => {} },
  importedWorksheets: { put: async () => {} },
  resumeFlags: { get: () => null, set: () => {}, clear: () => {} },
  resumeMetadata: { get: () => null, set: () => {}, clear: () => {} },
};
const SharedAuthGate = class {
  constructor() {}
  async restoreAfterAuthReturn() {}
};
const createServerApiClient = () => ({
  getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
  getSession: async () => ({ ok: false, error: { message: 'auth required' } }),
  listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
  uploadDraftPackage: async () => ({ ok: false, error: { message: 'not configured' } }),
  fetchUploadedDraftArtifact: async () => ({ ok: false, error: { message: 'not configured' } }),
  deleteUploadedDraft: async () => ({ ok: false, error: { message: 'not configured' } }),
  publishFromUploadedDraft: async () => ({ ok: false, error: { message: 'not configured' } }),
});
const createWorksheetPackageFromDraft = (draft, assets) => {
  globalThis.__lastCreateWorksheetPackageCall = { draft, assets };
  return { bytes: new Uint8Array([1, 2, 3]) };
};
const mapLegacyJsonToPackageModel = (input) => {
  if (!input || typeof input !== 'object' || !Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw new Error('Imported worksheet must have a non-empty blocks array.');
  }
  return {
    worksheet: {
      title: String(input.title || 'Imported worksheet'),
      blocks: input.blocks,
      metadata: input.metadata || {},
    },
    manifest: { format: 'worksheet-package', packageVersion: 1, assets: [] },
    assets: [],
  };
};
const parseWorksheetPackage = () => ({ manifest: {}, worksheet: { title: 'Pkg', blocks: [] }, assets: [] });
`,
    },
    {
      name: 'replace media config import with deterministic constants',
      pattern: /import\s*\{\s*MEDIA_LIMITS,\s*IMAGE_MIME_TYPES,\s*IMAGE_EXTENSIONS,\s*AUDIO_MIME_TYPES,\s*AUDIO_EXTENSIONS\s*\}\s*from\s*['"]\.\/media-config\.js['"];\s*/,
      replacement: `const MEDIA_LIMITS = { imageMaxBytes: 8 * 1024 * 1024, audioMaxBytes: 5 * 1024 * 1024 };
const IMAGE_MIME_TYPES = ['image/png','image/jpeg','image/jpg','image/webp'];
const IMAGE_EXTENSIONS = ['png','jpg','jpeg','webp'];
const AUDIO_MIME_TYPES = ['audio/mpeg','audio/mp3'];
const AUDIO_EXTENSIONS = ['mp3'];
`,
    },
    {
      name: 'replace shared auth utility imports with local test doubles',
      pattern: /import\s*\{\s*probeSession\s*\}\s*from\s*['"]\.\.\/app\/auth\/session-readiness\.js['"];\s*import\s*\{\s*startAuthPopupFlow,\s*AUTH_POPUP_FLOW_DEFAULTS\s*\}\s*from\s*['"]\.\.\/app\/auth\/auth-popup-flow\.js['"];\s*/,
      replacement: `const AUTH_POPUP_FLOW_DEFAULTS = { pollIntervalMs: 20, pollTimeoutMs: 80 };
const probeSession = async ({ apiClient }) => {
  const result = await apiClient.getSession();
  if (result?.ok) return { ok: true, status: 'ready', user: result.data?.user || null, error: null };
  return { ok: false, status: 'not_ready', user: null, error: result?.error || { message: 'auth required' } };
};
const startAuthPopupFlow = (options = {}) => {
  const popupWindow = window.open(
    options.apiClient.getSessionSignInUrl({ source: options.source, authFlowId: options.authFlowId }),
    'worksheet_launcher_auth_popup_editor',
    'width=520,height=720,left=160,top=120,resizable=yes,scrollbars=yes'
  );
  if (!popupWindow) {
    options.onPopupBlocked?.();
    options.onSessionNotReady?.({ ok: false, status: 'not_ready', error: { message: 'blocked' } });
    return { popupWindow: null, cancel: () => true, promise: Promise.resolve({ ok: false }) };
  }
  options.onStatusMessage?.('Complete sign-in in the popup. Session will refresh automatically.');
  const timer = setTimeout(async () => {
    const result = await probeSession({ apiClient: options.apiClient, force: true });
    if (result.ok) {
      await options.onSessionReady?.(result);
    } else {
      options.onSessionNotReady?.(result);
    }
  }, 0);
  return { popupWindow, cancel: () => { clearTimeout(timer); return true; }, promise: Promise.resolve({ ok: true }) };
};
`,
    },
    {
      name: 'replace dynamic contracts loader with deterministic test stub',
      pattern: /async function loadContracts\(\)\s*\{[\s\S]*?\n\}\s*\nfunction createEmptyQuestionBlock/,
      replacement: `async function loadContracts() {
  return {
    validateDraftSchema(draft) {
      const errors = [];
      if (!draft || typeof draft !== 'object') {
        return { valid: false, errors: ['draft must be object'] };
      }
      if (!Array.isArray(draft.blocks) || draft.blocks.length === 0) {
        errors.push('draft.blocks must be a non-empty array');
      } else {
        draft.blocks.forEach((block, index) => {
          if (block.kind === 'question' && !String(block?.prompt?.text || '').trim()) {
            errors.push(\`draft.blocks[\${index}].prompt.text is required for question blocks\`);
          }
          if (block.kind === 'content' && !String(block?.content?.text || '').trim()) {
            errors.push(\`draft.blocks[\${index}].content.text is required for content blocks\`);
          }
        });
      }
      return { valid: errors.length === 0, errors };
    },
  };
}

function createEmptyQuestionBlock`,
    },

    {
      name: 'replace editor shell rendering call with test probe',
      pattern: /\n\s*renderEditorShell\(session\);/,
      replacement: '\n  globalThis.__renderedSession = session;',
    },
    {
      name: 'replace bootstrap invocation with explicit test exports',
      pattern: /bootstrapEditor\(\)\.catch\([\s\S]*?\);\s*export\s*\{[^}]+\};/,
      replacement: 'export { EditorDraftSession, bootstrapEditor, createDraftRecord, normalizeBlocks, mapOptionsTextToResponseOptions, buildViewerUrlFromCurrentLocation, getNumberQuestionValidationErrors, formatUploadedDraftTimestamp, toUploadedDraftDisplay };',
    },
  ]);

  globalThis.document = {
    getElementById: () => null,
    activeElement: null,
  };
  globalThis.window = {
    location: { hash: '#fallback', origin: 'https://example.test', search: '', href: 'https://example.test/editor.html#fallback' },
    scrollY: 150,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  const dataUrl = `data:text/javascript,${encodeURIComponent(rewrittenSource)}`;
  return import(dataUrl);
}

function stripOptionIds(options = []) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    value: option.value,
    label: option.label,
  }));
}

function getOptionIdByValue(options = [], value) {
  return (Array.isArray(options) ? options : []).find((option) => option.value === value)?.id || null;
}

function createSessionForTests() {
  return {
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  };
}

function toBlockFieldsWithoutPosition(block) {
  const snapshot = {
    blockId: block.blockId,
    kind: block.kind,
    prompt: block.prompt,
    content: block.content,
    responseConfig: block.responseConfig,
  };
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return {
    blockId: snapshot.blockId,
    kind: snapshot.kind,
    prompt: snapshot.prompt ? JSON.parse(JSON.stringify(snapshot.prompt)) : snapshot.prompt,
    content: snapshot.content ? JSON.parse(JSON.stringify(snapshot.content)) : snapshot.content,
    responseConfig: snapshot.responseConfig ? JSON.parse(JSON.stringify(snapshot.responseConfig)) : snapshot.responseConfig,
  };
}


test('bootstrapEditor completes without requiring a registerAuthPopupMessageListener method', async () => {
  const mod = await loadEditorModule();
  globalThis.window = {
    location: {
      hash: '#fallback',
      origin: 'https://example.test',
      search: '',
      href: 'https://example.test/editor.html#fallback',
    },
    history: { replaceState: () => {} },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  await assert.doesNotReject(async () => {
    await mod.bootstrapEditor();
  });

  assert.ok(globalThis.window.editorSession);
  assert.equal(typeof globalThis.window.editorSession.beginServerSignIn, 'function');
});

test('beginServerSignIn completes via shared popup flow and refreshes uploads on ready session', async () => {
  const mod = await loadEditorModule();
  let messageHandler = null;
  globalThis.window = {
    location: { origin: 'https://example.test' },
    open: () => ({ closed: false }),
    addEventListener: (type, handler) => {
      if (type === 'message') messageHandler = handler;
    },
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: ({ source, authFlowId } = {}) => {
        const params = new URLSearchParams();
        if (source) params.set('source', source);
        if (authFlowId) params.set('authFlowId', authFlowId);
        const query = params.toString();
        return query ? `/worksheet_launcher/app/login/popup.html?${query}` : '/worksheet_launcher/app/login/popup.html';
      },
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });
  session.beginServerSignIn();
  const authFlowId = session._activeAuthFlowId;
  await messageHandler?.({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete', source: 'editor', authFlowId },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.state.serverSession.status, 'ready');
  assert.deepEqual(session.state.uploadedDrafts, []);
});

test('beginServerSignIn shows popup blocked message when popup cannot open', async () => {
  const mod = await loadEditorModule();
  globalThis.window = {
    location: { origin: 'https://example.test' },
    open: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  session.beginServerSignIn();

  assert.equal(
    session.state.serverActionMessage,
    'Sign-in popup was blocked. Allow popups for this site, then try again.'
  );
});

test('beginServerSignIn clears stale popup-blocked notification before a new auth flow', async () => {
  const mod = await loadEditorModule();
  globalThis.window = {
    location: { origin: 'https://example.test' },
    open: () => ({ closed: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });
  session.pushNotification({
    kind: 'error',
    category: 'server',
    source: 'auth.popup',
    text: 'Sign-in popup was blocked. Allow popups for this site, then try again.',
  });
  assert.equal(session.state.notifications.some((item) => item.source === 'auth.popup'), true);

  session.beginServerSignIn();

  assert.equal(session.state.notifications.some((item) => item.source === 'auth.popup'), false);
});

test('beginServerSignIn stores popup handle and fallback polling can recover missed callback', async () => {
  const authPopup = { closed: false };
  const mod = await loadEditorModule();
  let openedPopupUrl = null;
  globalThis.window = {
    location: { hash: '#fallback', origin: 'https://example.test', search: '', href: 'https://example.test/editor.html#fallback' },
    open: (url) => {
      openedPopupUrl = url;
      return authPopup;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: ({ source, authFlowId } = {}) => {
        const params = new URLSearchParams();
        if (source) params.set('source', source);
        if (authFlowId) params.set('authFlowId', authFlowId);
        const query = params.toString();
        return query ? `/worksheet_launcher/app/login/popup.html?${query}` : '/worksheet_launcher/app/login/popup.html';
      },
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  session.beginServerSignIn();
  assert.equal(session._authPopupWindow, authPopup);
  assert.equal(typeof session._activeAuthFlowId, 'string');
  assert.equal(session._activeAuthFlowId.startsWith('auth_flow_'), true);
  assert.equal(openedPopupUrl.includes('authFlowId='), true);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(session.state.serverSession.status, 'ready');
  assert.equal(session.state.serverActionMessage, null);
  assert.equal(session._activeAuthFlowId, null);
});

test('editor silent session probe updates readiness without forcing visible checking state', async () => {
  const statuses = [];
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: false, error: { message: 'auth required', requiresSignIn: true } }),
    },
  });
  session.state.serverSession = { status: 'ready', user: { email: 'teacher@example.test' }, error: null };
  session.setOnStateChange((state) => {
    statuses.push(state.serverSession.status);
  });

  await session.probeServerSessionSilently();

  assert.equal(statuses.includes('checking'), false);
  assert.equal(session.state.serverSession.status, 'not_ready');
});

test('editor popup fallback polling uses shared wait flow and still reaches ready state', async () => {
  const mod = await loadEditorModule();
  const authPopup = { closed: true };
  globalThis.window = {
    location: { hash: '#fallback', origin: 'https://example.test', search: '', href: 'https://example.test/editor.html#fallback' },
    open: () => authPopup,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  let silentProbeCalls = 0;
  session.probeServerSessionSilently = async () => {
    silentProbeCalls += 1;
    session.state.serverSession = { status: 'ready', user: { email: 'teacher@example.test' }, error: null };
    return { ok: true, data: { user: { email: 'teacher@example.test' } } };
  };

  session.beginServerSignIn();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(silentProbeCalls > 0, true);
});

test('editor upload action runs silent session preflight and blocks when session is not ready', async () => {
  const calls = [];
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => {
        calls.push('getSession');
        return { ok: false, error: { message: 'auth required', requiresSignIn: true } };
      },
      uploadDraftPackage: async () => {
        calls.push('uploadDraftPackage');
        return { ok: true, data: { uploaded_draft_id: 'ud_1' } };
      },
    },
  });
  session.state.draft = { localId: 'd1', title: 'Draft', metadata: { subject: '' }, blocks: [] };
  session.buildCurrentDraftPackageZipBytes = async () => new Uint8Array([1, 2, 3]);

  const result = await session.uploadCurrentDraftToServer();

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['getSession']);
  assert.equal(session.state.serverActionMessage, 'Sign-in session expired. Please sign in again.');
});

test('editor upload preflight surfaces transient server/non-auth errors without expired-session copy', async () => {
  const calls = [];
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => {
        calls.push('getSession');
        return {
          ok: false,
          error: {
            code: 'UNEXPECTED_NON_JSON_RESPONSE',
            message: 'Server returned an unexpected non-JSON response.',
            requiresSignIn: true,
            status: 502,
          },
        };
      },
      uploadDraftPackage: async () => {
        calls.push('uploadDraftPackage');
        return { ok: true, data: { uploaded_draft_id: 'ud_1' } };
      },
    },
  });
  session.state.draft = { localId: 'd1', title: 'Draft', metadata: { subject: '' }, blocks: [] };
  session.buildCurrentDraftPackageZipBytes = async () => new Uint8Array([1, 2, 3]);

  const result = await session.uploadCurrentDraftToServer();

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['getSession']);
  assert.equal(session.state.serverActionMessage, 'Server returned an unexpected non-JSON response.');
});

test('uploadCurrentDraftToServer emits ordered notifications for progress, success, and refresh result', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      uploadDraftPackage: async () => ({ ok: true, data: { uploaded_draft_id: 'draft_upload_1' } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });
  session.state.draft = { localId: 'draft_local_1', title: 'Draft 1', metadata: { subject: '' }, blocks: [] };
  session.buildCurrentDraftPackageZipBytes = async () => new Uint8Array([1, 2, 3]);

  const result = await session.uploadCurrentDraftToServer();
  assert.equal(result.ok, true);
  const uploadNotifications = session.state.notifications
    .filter((item) => ['upload.status', 'upload.refresh'].includes(item.source))
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(uploadNotifications, [
    {
      source: 'upload.status',
      kind: 'info',
      category: 'server',
      text: 'Uploading…',
    },
    {
      source: 'upload.status',
      kind: 'success',
      category: 'server',
      text: 'Uploaded draft draft_upload_1.',
    },
    {
      source: 'upload.refresh',
      kind: 'success',
      category: 'server',
      text: 'Uploaded drafts refreshed.',
    },
  ]);
  const uploadActivityTexts = session.state.activityLog
    .filter((item) => item.source === 'upload.status' || item.source === 'upload.refresh')
    .map((item) => item.text);
  assert.equal(uploadActivityTexts.includes('Uploading…'), false);
  assert.equal(uploadActivityTexts.includes('Uploaded draft draft_upload_1.'), true);
  assert.equal(uploadActivityTexts.includes('Uploaded drafts refreshed.'), true);
});

test('uploadCurrentDraftToServer keeps in-progress notification visible while request is in flight', async () => {
  const mod = await loadEditorModule();
  let resolveUpload;
  const uploadPromise = new Promise((resolve) => { resolveUpload = resolve; });
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      uploadDraftPackage: async () => uploadPromise,
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });
  session.state.draft = { localId: 'draft_local_inflight', title: 'Draft inflight', metadata: { subject: '' }, blocks: [] };
  session.buildCurrentDraftPackageZipBytes = async () => new Uint8Array([1, 2, 3]);

  const pendingUpload = session.uploadCurrentDraftToServer();
  const inflightNotification = session.state.notifications.find((item) => (
    item.source === 'upload.status' && item.kind === 'info' && item.text === 'Uploading…'
  ));
  assert.equal(Boolean(inflightNotification), true);
  assert.equal(session.state.activityLog.some((item) => item.text === 'Uploading…'), false);

  resolveUpload({ ok: true, data: { uploaded_draft_id: 'draft_upload_inflight' } });
  const result = await pendingUpload;
  assert.equal(result.ok, true);
});

test('uploadCurrentDraftToServer emits refresh warning when uploaded drafts refresh fails', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      uploadDraftPackage: async () => ({ ok: true, data: { uploaded_draft_id: 'draft_upload_2' } }),
      listUploadedDrafts: async () => ({ ok: false, error: { message: 'Unable to refresh uploaded drafts.' } }),
    },
  });
  session.state.draft = { localId: 'draft_local_2', title: 'Draft 2', metadata: { subject: '' }, blocks: [] };
  session.buildCurrentDraftPackageZipBytes = async () => new Uint8Array([1, 2, 3]);

  const result = await session.uploadCurrentDraftToServer();
  assert.equal(result.ok, true);

  const refreshNotifications = session.state.notifications
    .filter((item) => item.source === 'upload.refresh')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(refreshNotifications, [
    {
      source: 'upload.refresh',
      kind: 'warn',
      category: 'server',
      text: 'Unable to refresh uploaded drafts.',
    },
  ]);
});


test('editor shell removes Retry session button from normal server controls', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("retrySessionBtn.textContent = 'Retry session';"), false);
});

test('normalizeBlocks preserves canonical question responseConfig and extra fields', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Question?', format: 'markdown' },
      responseConfig: { inputType: 'text', maxLength: 42, displayMode: 'single_line' },
      extraField: 'keep-me',
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'question');
  assert.deepEqual(blocks[0].responseConfig, { inputType: 'text', maxLength: 42, displayMode: 'single_line' });
  assert.equal(blocks[0].extraField, 'keep-me');
});

test('normalizeBlocks preserves non-prompt extra fields while normalizing content', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'c1',
      kind: 'content',
      position: 2,
      content: { text: 99, format: '' },
      customMeta: { foo: 'bar' },
    },
  ]);

  assert.equal(blocks[0].kind, 'content');
  assert.equal(blocks[0].content.text, '99');
  assert.equal(blocks[0].content.format, 'plain_text');
  assert.deepEqual(blocks[0].customMeta, { foo: 'bar' });
});

test('validateCurrentDraft flags non-canonical responseConfig.inputType values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  session.state.draft = {
    draftWorksheetId: 'draft_legacy_input_type',
    localId: 'draft_legacy_input_type',
    title: 'Legacy draft',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Legacy?' },
        responseConfig: { inputType: 'plain_text' },
      },
    ],
  };

  const validation = session.validateCurrentDraft();
  assert.equal(validation.valid, false);
  assert.equal(
    validation.errors.includes(
      'draft.blocks[0].responseConfig.inputType must be one of: text, number, boolean, multiple_choice'
    ),
    true
  );
});

test('validateCurrentDraft flags non-string responseConfig.inputType values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  for (const badInputType of [123, {}, [], true]) {
    session.state.draft = {
      draftWorksheetId: 'draft_non_string_input_type',
      localId: 'draft_non_string_input_type',
      title: 'Non-string inputType draft',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Bad inputType?' },
          responseConfig: { inputType: badInputType },
        },
      ],
    };

    const validation = session.validateCurrentDraft();
    assert.equal(
      validation.valid,
      false,
      `expected invalid for inputType: ${JSON.stringify(badInputType)}`
    );
    assert.equal(
      validation.errors.includes(
        'draft.blocks[0].responseConfig.inputType must be one of: text, number, boolean, multiple_choice'
      ),
      true,
      `expected canonical inputType error for inputType: ${JSON.stringify(badInputType)}`
    );
  }
});

test('persistRestoreMetadata preserves explicit empty hash and zero-like scroll token', async () => {
  const mod = await loadEditorModule();
  let saved = null;

  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: {
      get: () => null,
      set: (_key, value) => {
        saved = value;
      },
    },
  });

  session.state.draft = { localId: 'draft_1', blocks: [] };
  session.state.hash = '';
  session.state.scrollToken = 0;

  session.persistRestoreMetadata();

  assert.equal(saved.hash, '');
  assert.equal(saved.scrollToken, 0);
});

test('importWorksheetJson throws clear parse error for invalid JSON text', async () => {
  const mod = await loadEditorModule();

  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.importWorksheetJson('{not-valid-json', {}),
    /Imported worksheet JSON could not be parsed/
  );
  const importError = session.state.notifications.find((item) => item.source === 'import.legacy_json');
  assert.equal(importError?.kind, 'error');
  assert.equal(importError?.text.includes('could not be parsed'), true);
});

test('importWorksheetJson rejects legacy JSON without blocks array', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await assert.rejects(
    () => session.importWorksheetJson({ title: 'bad legacy' }, {}),
    /non-empty blocks array/
  );
  const importError = session.state.notifications.find((item) => item.source === 'import.legacy_json');
  assert.equal(importError?.kind, 'error');
});

test('import/save/export operations emit notification records for success and error outcomes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
    localAssets: { get: async () => null, put: async () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_notifications');
  clearTimeout(session.autosaveTimer);

  await session.importWorksheetJson({ title: 'Legacy', blocks: [{ kind: 'content', content: { text: 'Intro' } }] });
  const importJsonSuccess = session.state.notifications.find((item) => item.source === 'import.legacy_json' && item.kind === 'success');
  assert.equal(Boolean(importJsonSuccess), true);
  assert.equal(importJsonSuccess.text.includes('importedId:'), true);

  await session.importWorksheetPackageFile({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, {});
  const importPackageSuccess = session.state.notifications.find((item) => item.source === 'import.package_zip' && item.kind === 'success');
  assert.equal(Boolean(importPackageSuccess), true);

  await session.saveNow();
  const manualSaveSuccess = session.state.notifications.find((item) => item.source === 'save.manual' && item.kind === 'success');
  assert.equal(Boolean(manualSaveSuccess), true);

  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const originalBlob = globalThis.Blob;
  globalThis.URL = { createObjectURL: () => 'blob:test-export', revokeObjectURL: () => {} };
  globalThis.document = {
    ...originalDocument,
    body: { appendChild: () => {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  globalThis.Blob = originalBlob;
  try {
    await session.exportCurrentDraftToPackageFile();
  } finally {
    globalThis.document = originalDocument;
    globalThis.URL = originalUrl;
    globalThis.Blob = originalBlob;
  }
  const exportSuccess = session.state.notifications.find((item) => item.source === 'export.package_zip' && item.kind === 'success');
  assert.equal(Boolean(exportSuccess), true);

  await assert.rejects(
    () => session.importWorksheetPackageFile(null, {}),
    /required/
  );
  const importPackageError = session.state.notifications.find((item) => item.source === 'import.package_zip' && item.kind === 'error');
  assert.equal(Boolean(importPackageError), true);
});

test('pushNotification appends activity log entries and caps at 200 records', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  for (let index = 0; index < 210; index += 1) {
    session.pushNotification({
      kind: 'info',
      category: 'editor',
      source: `activity.test.${index}`,
      text: `event ${index}`,
    });
  }
  assert.equal(session.state.activityLog.length, 200);
  assert.equal(session.state.activityLog[0].text, 'event 10');
  assert.equal(session.state.activityLog[199].text, 'event 209');
  assert.equal(session.state.notifications.length, 200);
  assert.equal(session.state.notifications[0].text, 'event 10');
  assert.equal(session.state.notifications[199].text, 'event 209');
});

test('pushNotification prunes expired ttl notifications before appending', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  const createdAt = new Date(Date.now() - 5000).toISOString();
  session.state.notifications.push({
    id: 'notif_expired',
    kind: 'info',
    category: 'server',
    source: 'ttl.expired',
    text: 'old',
    createdAt,
    ttlMs: 1000,
  });

  session.pushNotification({
    kind: 'info',
    category: 'editor',
    source: 'activity.test.current',
    text: 'current',
  });

  assert.equal(session.state.notifications.some((item) => item.source === 'ttl.expired'), false);
  assert.equal(session.state.notifications.some((item) => item.source === 'activity.test.current'), true);
});

test('notification dedupe/removal does not erase historical activity log entries', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.setNotificationForSource({
    source: 'dedupe.source',
    category: 'editor',
    kind: 'warn',
    text: 'first',
  });
  session.setNotificationForSource({
    source: 'dedupe.source',
    category: 'editor',
    kind: 'warn',
    text: 'second',
  });
  session.clearNotificationsBySource('dedupe.source');

  assert.equal(session.state.notifications.some((item) => item.source === 'dedupe.source'), false);
  const activityMessages = session.state.activityLog
    .filter((item) => item.source === 'dedupe.source')
    .map((item) => item.text);
  assert.deepEqual(activityMessages, ['first', 'second']);
});

test('activity panel source uses activity log pagination with load-older control', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const ACTIVITY_VISIBLE_INITIAL = 30;'), true);
  assert.equal(source.includes('const ACTIVITY_MAX_STORED = 200;'), true);
  assert.equal(source.includes("loadOlderActivityBtn.textContent = 'Load older activity';"), true);
  assert.equal(source.includes('const feedNotifications = (Array.isArray(session.state.activityLog) ? session.state.activityLog : [])'), true);
  assert.equal(source.includes('visibleActivityCount = Math.min(totalActivity, visibleActivityCount + ACTIVITY_VISIBLE_INITIAL);'), true);
  assert.equal(source.includes('Showing ${Math.min(visibleActivityCount, totalActivity)} of ${totalActivity} recent activities.'), true);
  assert.equal(source.includes("renderNotificationCard(notification, 'notification-feed-item', { announce: false })"), true);
  assert.equal(source.includes("item.setAttribute('aria-live', 'off');"), true);
});

test('editor shell no longer relies on 500ms summary interval loop', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('setInterval(updateSummary, 500)'), false);
});

test('detail signature excludes per-keystroke numeric fields to avoid focus loss during typing', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('selectedBlock.responseConfig?.min ?? \'\''), false);
  assert.equal(source.includes('selectedBlock.responseConfig?.max ?? \'\''), false);
  assert.equal(source.includes('selectedBlock.responseConfig?.correctAnswer ?? null'), false);
});

test('detail signature includes normalized multiple_choice correctAnswer to prevent stale clear button state', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const normalizedCorrectAnswer = (() => {'), true);
  assert.equal(source.includes("normalizedInputType !== 'multiple_choice'"), true);
  assert.equal(source.includes("normalizedSelectionMode === 'single'"), true);
  assert.equal(source.includes("normalizedSelectionMode === 'multi'"), true);
  assert.equal(source.includes('normalizedCorrectAnswer,'), true);
});

test('editor uses live server upload/publish integration instead of protected-intent wrappers', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("session.triggerProtectedAction('resumeDraftUploadAfterLogin')"), false);
  assert.equal(source.includes("session.triggerProtectedAction('resumePublishAfterLogin')"), false);
  assert.equal(source.includes('await session.uploadCurrentDraftToServer();'), true);
  assert.equal(source.includes('await session.publishUploadedDraftToServer('), true);
  assert.equal(source.includes('await session.refreshServerSession();'), true);
});

test('draft metadata subject is editable and stored in local draft metadata', async () => {
  const mod = await loadEditorModule();
  const draft = mod.createDraftRecord({ title: 'Worksheet' });
  assert.equal(draft.metadata.subject, '');

  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = draft;
  session.updateSubject('Physics');
  assert.equal(session.state.draft.metadata.subject, 'Physics');
});

test('publishUploadedDraftToServer forwards modal title/subject overrides and refreshes drafts', async () => {
  const calls = [];
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      publishFromUploadedDraft: async (uploadedDraftId, metadata) => {
        calls.push({ uploadedDraftId, metadata });
        return { ok: true, data: { published_package_id: 'p1' } };
      },
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  const result = await session.publishUploadedDraftToServer('u1', {
    title: 'Release title',
    subject: 'Release subject',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    uploadedDraftId: 'u1',
    metadata: { title: 'Release title', subject: 'Release subject' },
  });
});

test('publishUploadedDraftToServer emits ordered notifications and keeps terminal messages for concurrent publishes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      publishFromUploadedDraft: async (uploadedDraftId) => ({
        ok: true,
        data: { published_package_id: `pkg_${uploadedDraftId}` },
      }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  const [first, second] = await Promise.all([
    session.publishUploadedDraftToServer('u1', { title: 'T1', subject: 'S1' }),
    session.publishUploadedDraftToServer('u2', { title: 'T2', subject: 'S2' }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const terminalPublishes = session.state.notifications
    .filter((item) => item.source === 'publish.status' && item.kind === 'success')
    .map((item) => item.text)
    .sort();
  assert.deepEqual(terminalPublishes, [
    'Published package pkg_u1.',
    'Published package pkg_u2.',
  ]);
  const publishActivityTexts = session.state.activityLog
    .filter((item) => item.source === 'publish.status')
    .map((item) => item.text);
  assert.equal(publishActivityTexts.includes('Publishing…'), false);
  assert.equal(publishActivityTexts.includes('Published package pkg_u1.'), true);
  assert.equal(publishActivityTexts.includes('Published package pkg_u2.'), true);
  const refreshFollowups = session.state.notifications
    .filter((item) => item.source === 'publish.refresh')
    .map((item) => ({ source: item.source, kind: item.kind, category: item.category, text: item.text }));
  assert.equal(refreshFollowups.length >= 1, true);
  assert.equal(refreshFollowups.every((item) => item.kind === 'success' && item.category === 'server'), true);
});

test('publishUploadedDraftToServer emits refresh warning when uploaded drafts refresh fails', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      publishFromUploadedDraft: async () => ({ ok: true, data: { published_package_id: 'pkg_warn_1' } }),
      listUploadedDrafts: async () => ({ ok: false, error: { message: 'Unable to refresh uploaded drafts.' } }),
    },
  });

  const result = await session.publishUploadedDraftToServer('u_warn_1', {
    title: 'Warn title',
    subject: 'Warn subject',
  });

  assert.equal(result.ok, true);
  const refreshFollowups = session.state.notifications
    .filter((item) => item.source === 'publish.refresh')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(refreshFollowups, [
    {
      source: 'publish.refresh',
      kind: 'warn',
      category: 'server',
      text: 'Unable to refresh uploaded drafts.',
    },
  ]);
});

test('editor source removes global Publish button and adds labeled metadata and browse controls', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('await session.publishCurrentDraftToServer();'), false);
  assert.equal(source.includes('protectedActionsColumn.append(\n    serverSessionStatus,\n    signInBtn,\n    syncDraftBtn,\n    publishBtn,'), false);
  assert.equal(source.includes("rewriteBtn.textContent = 'Rewrite (Sign-in required)'"), false);
  assert.equal(source.includes("t2aBtn.textContent = 'T2A (Sign-in required)'"), false);
  assert.equal(source.includes("metadataHeading.textContent = 'Draft Metadata';"), true);
  assert.equal(source.includes("titleLabel.textContent = 'Worksheet Title';"), true);
  assert.equal(source.includes("subjectLabel.textContent = 'Subject';"), true);
  assert.equal(source.includes("signInBtn.textContent = 'Sign in for server features';"), true);
  assert.equal(source.includes("syncDraftBtn.textContent = 'Upload Draft';"), true);
  assert.equal(source.includes("loadUploadedDraftsBtn.textContent = 'Refresh Uploaded Drafts';"), true);
  assert.equal(source.includes("browsePublishedBtn.textContent = 'Browse Published Packages';"), true);
  assert.equal(source.includes("loadMoreBtn.textContent = browsePublishedState.loading ? 'Loading…' : 'Load more';"), true);
  assert.equal(source.includes("ownerFilter.placeholder = 'Filter by owner email';"), true);
  assert.equal(source.includes("copyBtn.textContent = 'Copy Published ID';"), true);
  assert.equal(source.includes("openInEditorBtn.textContent = isOpening ? 'Opening…' : 'Open in Editor';"), true);
  assert.equal(source.includes('if (session.state.openingPublishedPackageIds.has(item.published_package_id)) return;'), true);
  assert.equal(source.includes('const reopenPromise = session.reopenPublishedPackageAsLocalCopy(item.published_package_id);'), true);
  assert.equal(source.includes('const reopenResult = await reopenPromise;'), true);
  assert.equal(source.includes('if (browsePublishedDialogOpen) {\n      renderPublishedBrowserModal();\n    }'), true);
  assert.equal(source.includes('if (reopenResult?.ok) {'), true);
  assert.equal(source.includes('browsePublishedDialogOpen = false;'), true);
  assert.equal(source.includes("const openError = session.state.serverActionMessage || reopenResult?.error?.message || 'Failed to open published package.';"), true);
  assert.equal(source.includes('emitPublishedBrowseNotification({'), true);
  assert.equal(source.includes("await runPublishedSearch({ append: true });"), true);
  assert.equal(source.includes("summary.textContent = 'Published details';"), true);
  assert.equal(
    source.includes("publishedOwnerLine.textContent = `Owner: ${item.published_owner_email || item.published_owner_name || session.state.serverSession?.user?.email || 'Unknown'}`;"),
    true
  );
  assert.equal(
    source.includes("subjectOwner.textContent = `Subject: ${item.subject || '—'} • Owner: ${item.owner_email || item.owner_name || item.owner_sub || '—'}`;"),
    true
  );
});

test('stage3: protected actions column no longer includes legacy rewrite/t2a stub buttons', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("rewriteBtn.textContent = 'Rewrite (Sign-in required)'"), false);
  assert.equal(source.includes("t2aBtn.textContent = 'T2A (Sign-in required)'"), false);
  assert.equal(source.includes('protectedActionsColumn.append(\n    serverSessionStatus,\n    signInBtn,\n    syncDraftBtn,\n    browsePublishedBtn,\n    loadUploadedDraftsBtn,\n    uploadedDraftList\n  );'), true);
});

test('detail signature includes media refs so media attach/remove rerenders immediately', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const normalizedPromptMediaRefs = selectedBlock.kind === \'question\''), true);
  assert.equal(source.includes('const normalizedOptionMediaRefs = selectedBlock.kind === \'question\''), true);
  assert.equal(source.includes('normalizedPromptMediaRefs,'), true);
  assert.equal(source.includes('normalizedOptionMediaRefs,'), true);
});

test('multiple-choice option audio controls gate placeholder options with helper feedback', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const persistedOptionIds = new Set(normalizedOptions.map((option) => String(option?.id || \'\')));'), true);
  assert.equal(source.includes('const isPersistedOption = persistedOptionIds.has(optionId);'), true);
  assert.equal(source.includes("optionAudioBtn.disabled = !isPersistedOption || isOptionT2AInFlight;"), true);
  assert.equal(source.includes("Enter option text or click Add option before attaching audio."), true);
});

test('question audio row adds contextual generate/regenerate control with prompt eligibility checks', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("const promptTextState = getT2ATextEligibility(selectedBlock?.prompt?.text || '');"), true);
  assert.equal(source.includes("generateQuestionAudioBtn.textContent = isPromptT2AInFlight"), true);
  assert.equal(source.includes("? 'Generating…'"), true);
  assert.equal(source.includes(": currentQuestionAudioRef ? 'Regenerate audio' : 'Generate audio';"), true);
  assert.equal(source.includes("generateQuestionAudioBtn.disabled = !promptT2AEligible || isPromptT2AInFlight;"), true);
  assert.equal(source.includes("Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters)."), true);
  assert.equal(source.includes("attachQuestionAudioBtn.disabled = true;"), true);
  assert.equal(source.includes("playQuestionAudioBtn.disabled = true;"), true);
  assert.equal(source.includes("removeQuestionAudioBtn.disabled = true;"), true);
  assert.equal(source.includes("questionAudioRow.append(attachQuestionAudioBtn, generateQuestionAudioBtn, playQuestionAudioBtn, removeQuestionAudioBtn);"), true);
});

test('stage3: prompt row triggers replace confirmation before prompt bridge generation when audio exists', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  const hasAudioConfirmIdx = source.indexOf("title: 'Regenerate question audio?'");
  const promptBridgeCallIdx = source.indexOf("await session.triggerProtectedAction('editorPromptT2A', {");
  const sessionReadyIdx = source.indexOf("const sessionReady = await session.ensureServerSessionReady();");
  assert.equal(hasAudioConfirmIdx >= 0, true);
  assert.equal(sessionReadyIdx >= 0, true);
  assert.equal(promptBridgeCallIdx >= 0, true);
  assert.equal(sessionReadyIdx < promptBridgeCallIdx, true);
  assert.equal(hasAudioConfirmIdx < promptBridgeCallIdx, true);
});

test('multiple-choice option row renders audio status menu and shows attached asset id', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("const optionActionsMenu = document.createElement('details');"), true);
  assert.equal(source.includes("optionActionsMenu.className = 'option-actions-menu option-audio-menu';"), true);
  assert.equal(source.includes("const optionAudioMenuTrigger = document.createElement('summary');"), true);
  assert.equal(source.includes("optionAudioMenuTrigger.dataset.optionAudioMenuTrigger = '1';"), true);
  assert.equal(source.includes("const optionActionsRow = document.createElement('div');"), true);
  assert.equal(source.includes("optionActionsRow.className = 'option-actions-menu__list option-audio-menu__list';"), true);
  assert.equal(source.includes('optionActionsMenu.append(optionAudioMenuTrigger, optionActionsRow);'), true);
  assert.equal(source.includes('row.append(correctToggle, optionInput, optionActionsMenu, removeBtn);'), true);
  assert.equal(source.includes('Option audio attached ('), true);
});

test('multiple-choice option actions include contextual generate/regenerate audio with text eligibility and row lock', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("const optionDisplayText = String(option?.label ?? option?.value ?? '');"), true);
  assert.equal(source.includes("const optionTextState = getT2ATextEligibility(optionDisplayText);"), true);
  assert.equal(source.includes("const optionT2AKey = `${selectedBlock.blockId}:${optionId}`;"), true);
  assert.equal(source.includes("const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey || optionT2AInFlightKeys.has(optionT2AKey);"), true);
  assert.equal(source.includes("const optionT2ALabel = isOptionT2AInFlight"), true);
  assert.equal(source.includes(": optionAudioRef ? 'Regenerate audio' : 'Generate audio';"), true);
  assert.equal(source.includes("setMediaActionButtonContent("), true);
  assert.equal(source.includes("optionT2ABtn.disabled = !isPersistedOption || !optionTextEligibleForT2A || isOptionT2AInFlight;"), true);
  assert.equal(source.includes("optionT2AInFlightKey = optionT2AKey;"), true);
  assert.equal(source.includes("optionT2AInFlightKey = null;"), true);
  assert.equal(source.includes("actionId: 'editorOptionT2A'"), false);
  assert.equal(source.includes("await session.triggerProtectedAction('editorOptionT2A', {"), true);
  assert.equal(source.includes("text: getProtectedActionErrorMessage(result, 'Unable to start audio generation. Please try again.'),"), true);
  assert.equal(source.includes('Text is too long to generate audio (max ${T2A_TEXT_MAX_LENGTH} characters).'), true);
  assert.equal(source.includes("optionActionsRow.append(optionAudioBtn, optionT2ABtn, playOptionAudioBtn, removeOptionAudioBtn);"), true);
  assert.equal(source.includes("setOptionAudioMenuTriggerState(optionAudioMenuTrigger"), true);
});

test('stage3: option row triggers replace confirmation before option bridge generation when audio exists', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  const hasAudioConfirmIdx = source.indexOf("title: `Regenerate option ${optionIndex + 1} audio?`");
  const optionBridgeCallIdx = source.indexOf("await session.triggerProtectedAction('editorOptionT2A', {");
  const optionSessionReadyIdx = source.indexOf("const sessionReady = await session.ensureServerSessionReady();");
  assert.equal(hasAudioConfirmIdx >= 0, true);
  assert.equal(optionSessionReadyIdx >= 0, true);
  assert.equal(optionBridgeCallIdx >= 0, true);
  assert.equal(optionSessionReadyIdx < optionBridgeCallIdx, true);
  assert.equal(hasAudioConfirmIdx < optionBridgeCallIdx, true);
});

test('stage3: in-flight lock is row-scoped by block/option key and leaves unrelated rows interactive', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("const optionT2AKey = `${selectedBlock.blockId}:${optionId}`;"), true);
  assert.equal(source.includes("const isOptionT2AInFlight = optionT2AInFlightKey === optionT2AKey || optionT2AInFlightKeys.has(optionT2AKey);"), true);
  assert.equal(source.includes("optionAudioBtn.disabled = !isPersistedOption || isOptionT2AInFlight;"), true);
  assert.equal(source.includes("playOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;"), true);
  assert.equal(source.includes("removeOptionAudioBtn.disabled = !optionAudioRef || !isPersistedOption || isOptionT2AInFlight;"), true);
  assert.equal(source.includes("await runMediaAction(async () => {\n            if (optionAudioRef)"), false);
  assert.equal(source.includes("await runMediaAction(async () => {\n        if (currentQuestionAudioRef)"), false);
  assert.equal(source.includes("status !== 'executed' && status !== 'redirected'"), true);
});

test('multiple-choice option action state rerenders while typing when option ids/media refs change and restores caret', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const computeOptionActionSignature = (selectedBlock) => {'), true);
  assert.equal(source.includes('nextOptionActionSignature === optionActionSignature'), true);
  assert.equal(source.includes("optionInput.dataset.optionIndex = String(optionIndex);"), true);
  assert.equal(source.includes('queueMicrotask(() => {'), true);
  assert.equal(source.includes('replacementOptionInput.setSelectionRange(activeOptionSelectionStart, activeOptionSelectionEnd);'), true);
});

test('prompt typing updates T2A state without forcing detail-panel rerender on each keystroke', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('const updateSummary = ({ preserveDetailEditor = false } = {}) => {'), true);
  assert.equal(source.includes('if (!preserveDetailEditor) {\n      renderDetailEditor();\n    }'), true);
  assert.equal(source.includes('refreshPromptT2AControlsForSelectedBlock();'), true);
  assert.equal(source.includes('updateSummary({ preserveDetailEditor: true });'), true);
  assert.equal(source.includes('promptTextSignature'), false);
});

test('localDraftId render path avoids innerHTML interpolation for untrusted ids', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('localDraftIdEl.innerHTML'), false);
  assert.equal(source.includes("localDraftIdLabel.textContent = 'localDraftId:';"), true);
  assert.equal(source.includes("localDraftIdValue.textContent = session.state.draft?.localId || 'n/a';"), true);
});

test('autosave completion emits state updates and clears pending state without extra UI events', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  let emissions = 0;
  session.setOnStateChange(() => {
    emissions += 1;
  });

  await session.createOrOpenByLocalDraftId('draft_status');
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  assert.equal(session.state.autosavePending, false);
  assert.ok(emissions >= 2, 'expected state emissions for pending + completion transitions');
});

test('autosave mirrors persistence and validation warnings into deduped notification sources', async () => {
  const mod = await loadEditorModule();
  let shouldFailPut = false;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (v) => {
        if (shouldFailPut) throw new Error('disk full');
        return v;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_autosave_notifs');
  clearTimeout(session.autosaveTimer);
  const question = session.createBlock('question');
  clearTimeout(session.autosaveTimer);
  session.updateBlockContent(question.blockId, 'Temporary prompt');
  clearTimeout(session.autosaveTimer);
  session.updateBlockContent(question.blockId, '');
  clearTimeout(session.autosaveTimer);
  session.state.isPristineDraft = false;

  await session.autosave();
  await session.autosave();
  const validationWarnings = session.state.notifications.filter((item) => item.source === 'autosave.validation');
  assert.equal(validationWarnings.length, 1);
  assert.equal(validationWarnings[0].text, session.state.lastValidationWarning);

  session.updateTitle('changed before failed autosave');
  clearTimeout(session.autosaveTimer);
  shouldFailPut = true;
  await assert.rejects(() => session.autosave(), /disk full/);
  session.updateTitle('changed before failed autosave again');
  clearTimeout(session.autosaveTimer);
  await assert.rejects(() => session.autosave(), /disk full/);
  const persistenceErrors = session.state.notifications.filter((item) => item.source === 'autosave.persistence');
  assert.equal(persistenceErrors.length, 1);
  assert.equal(persistenceErrors[0].text, session.state.lastPersistenceError);

  shouldFailPut = false;
  session.updateBlockContent(question.blockId, 'Prompt entered');
  clearTimeout(session.autosaveTimer);
  await session.autosave();
  const hasValidationNotification = session.state.notifications.some((item) => item.source === 'autosave.validation');
  assert.equal(hasValidationNotification, Boolean(session.state.lastValidationWarning));
  assert.equal(session.state.notifications.some((item) => item.source === 'autosave.persistence'), false);
});

test('saveNow and export failures emit error notifications', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async () => { throw new Error('save failed'); },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_save_error_notif');
  clearTimeout(session.autosaveTimer);

  await assert.rejects(() => session.saveNow(), /save failed/);
  const saveError = session.state.notifications.find((item) => item.source === 'save.manual' && item.kind === 'error');
  assert.equal(Boolean(saveError), true);

  session.state.draft = null;
  await assert.rejects(() => session.exportCurrentDraftToPackageFile(), /No active draft to export/);
  const exportError = session.state.notifications.find((item) => item.source === 'export.package_zip' && item.kind === 'error');
  assert.equal(Boolean(exportError), true);
});

test('saveNow dedupes active save.manual notifications across repeated saves', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (value) => value },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_save_dedupe');
  clearTimeout(session.autosaveTimer);

  await session.saveNow();
  await session.saveNow();
  await session.saveNow();

  const activeManualSaveNotifications = session.state.notifications
    .filter((item) => item?.source === 'save.manual');
  assert.equal(activeManualSaveNotifications.length, 1);
  assert.equal(activeManualSaveNotifications[0].kind, 'success');
});

test('exportCurrentDraftToPackageFile revokes object URL when click throws', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (value) => value },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
    localAssets: { get: async () => null, put: async () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_export_revoke_on_throw');
  clearTimeout(session.autosaveTimer);

  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const originalBlob = globalThis.Blob;
  const revokedUrls = [];
  globalThis.URL = {
    createObjectURL: () => 'blob:test-export-throw',
    revokeObjectURL: (value) => revokedUrls.push(value),
  };
  globalThis.document = {
    ...originalDocument,
    body: { appendChild: () => {} },
    createElement: () => ({ click() { throw new Error('click failed'); }, remove() {} }),
  };
  globalThis.Blob = originalBlob;
  try {
    await assert.rejects(() => session.exportCurrentDraftToPackageFile(), /click failed/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.URL = originalUrl;
    globalThis.Blob = originalBlob;
  }

  assert.deepEqual(revokedUrls, ['blob:test-export-throw']);
});

test('new question transient prompt validation is suppressed during first autosave', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_transient');
  clearTimeout(session.autosaveTimer);
  const firstBlock = session.state.draft.blocks[0];
  session.updateBlockContent(firstBlock.blockId, 'intro text');
  clearTimeout(session.autosaveTimer);

  const question = session.createBlock('question');
  clearTimeout(session.autosaveTimer);
  session.state.isPristineDraft = false;
  await session.autosave();

  assert.equal(session.state.lastSavedLocalValidationIssueCount > 0, true);
  assert.equal(session.state.lastContractValidationIssueCount > 0, true);
  assert.equal(session.state.lastValidationWarning, null, 'transient empty prompt warning should be suppressed');

  session.updateBlockContent(question.blockId, 'typed prompt');
  clearTimeout(session.autosaveTimer);
  await session.autosave();
  assert.equal(session.state.lastValidationWarning, null);
});

test('older autosave completion cannot override newer save status', async () => {
  const mod = await loadEditorModule();
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const first = deferred();
  const second = deferred();
  let putCall = 0;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        putCall += 1;
        if (putCall === 1) {
          await first.promise;
          return value;
        }
        await second.promise;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_race');
  clearTimeout(session.autosaveTimer);
  session.updateBlockContent(session.state.draft.blocks[0].blockId, 'intro text');
  clearTimeout(session.autosaveTimer);
  const q = session.createBlock('question');
  clearTimeout(session.autosaveTimer);
  session.state.isPristineDraft = false;

  const save1 = session.autosave(); // invalid (empty question)
  session.updateBlockContent(q.blockId, 'now valid');
  clearTimeout(session.autosaveTimer);
  const newerRevision = session.state.draftRevision;
  const save2 = session.autosave(); // valid

  second.resolve();
  await save2;
  first.resolve();
  await save1;

  assert.equal(session.state.lastSavedRevision, newerRevision);
  assert.equal(session.state.lastValidationWarning, null);
  assert.equal(session.state.lastSavedLocalValidationIssueCount, 0);
  assert.equal(session.state.lastContractValidationIssueCount, 0);
});

test('viewer navigation no longer uses hardcoded /viewer absolute assign path', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("window.location.assign(`/viewer/?localDraftId=${encodeURIComponent(localDraftId)}`);"), false);
  assert.equal(source.includes('buildViewerUrlFromCurrentLocation(window.location.href, localDraftId, draftUpdatedAt)'), true);
  assert.equal(source.includes("new URL('../viewer/', currentHref)"), true);
});

test('buildViewerUrlFromCurrentLocation resolves sibling viewer route from current page', async () => {
  const mod = await loadEditorModule();
  const rootResolved = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/editor/',
    'draft_root',
    '2026-03-31T00:00:00.000Z'
  );
  assert.equal(
    rootResolved.toString(),
    'https://example.test/viewer/?localDraftId=draft_root&preview=1&draftUpdatedAt=2026-03-31T00%3A00%3A00.000Z'
  );

  const nestedResolved = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/server/editor/index.html?mode=edit#section',
    'draft_nested'
  );
  assert.equal(nestedResolved.toString(), 'https://example.test/server/viewer/?localDraftId=draft_nested&preview=1');
});

test('mapOptionsTextToResponseOptions maps trimmed non-empty lines', async () => {
  const mod = await loadEditorModule();
  const mapped = mod.mapOptionsTextToResponseOptions('  Alpha\n\nBeta  \n Gamma ');
  assert.deepEqual(stripOptionIds(mapped), [
    { value: 'Alpha', label: 'Alpha' },
    { value: 'Beta', label: 'Beta' },
    { value: 'Gamma', label: 'Gamma' },
  ]);
  assert.equal(mapped.every((option) => typeof option.id === 'string' && option.id.length > 0), true);
});

test('question field updates map inputType, maxLength, and options through draft blocks', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_q');
  const block = session.createBlock('question');
  session.selectBlock(block.blockId);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionOptionsFromText(block.blockId, 'One\nTwo');
  session.updateQuestionInputType(block.blockId, 'text');
  session.updateQuestionMaxLength(block.blockId, '25');

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.inputType, 'text');
  assert.equal(updated.responseConfig.maxLength, 25);
  assert.equal(updated.responseConfig.options, undefined);
});

test('question input type change flow routes destructive switches through in-app confirm modal', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("questionInputType.addEventListener('change', async () => {"), true);
  assert.equal(source.includes("reason === 'confirm-switch-required'"), true);
  assert.equal(source.includes("title: 'Switching answer type will remove data'"), true);
  assert.equal(source.includes("confirmLabel: 'Switch and Remove'"), true);
  assert.equal(source.includes('descriptionText: `You are switching from ${outcome.impact.fromType} to ${outcome.impact.toType}.`'), true);
  assert.equal(source.includes('await showConfirmDialog({'), true);
});

test('confirm modal uses configurable description copy and defaults initial focus to cancel', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.match(source, /function showConfirmDialog\(\{\s*title,\s*bodyText,\s*entityLabel,\s*descriptionText,/m);
  assert.match(source, /cancelLabel\s*=\s*'Cancel'/);
  assert.match(source, /variant\s*=\s*'danger'/);
  assert.match(source, /resolvedBodyText\s*=\s*isNonEmptyString\(bodyText\)\s*\?\s*bodyText\s*:\s*descriptionText/);
  assert.match(source, /fallbackDescription\s*=\s*isNonEmptyString\(entityLabel\)/);
  assert.match(source, /'Are you sure you want to continue\?'/);
  assert.equal(source.includes('cancelBtn.focus();'), true);
});

test('replace/delete image flows use shared confirm modal and avoid native confirm', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.match(source, /title:\s*'Replace question image\?'/);
  assert.match(source, /confirmLabel:\s*'Replace image'/);
  assert.match(source, /title:\s*'Remove question image\?'/);
  assert.match(source, /confirmLabel:\s*'Remove image'/);
  assert.match(source, /await\s+confirmDangerAction\(\{/);
  assert.equal(source.includes('window.confirm('), false);
});

test('delete block baseline confirm parity uses shared danger modal labels', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("title: `Delete block ${displayIndex}?`"), true);
  assert.equal(source.includes("confirmLabel: 'Delete block'"), true);
  assert.equal(source.includes('await showConfirmDialog({'), true);
});

test('media confirmation actions gate duplicate submissions while busy', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.match(source, /let mediaActionInFlight\s*=\s*false/);
  assert.match(source, /if\s*\(mediaActionInFlight\)\s*return false/);
  assert.match(source, /mediaActionInFlight\s*=\s*true/);
  assert.match(source, /mediaActionInFlight\s*=\s*false/);
});

test('browse modal filters are decoupled from generic button-row card styling and search button has one naming source', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.match(source, /filterRow\.className\s*=\s*'browse-modal__filters'/);
  assert.equal(source.includes("filterRow.className = 'button-row browse-modal__filters'"), false);
  assert.match(source, /searchBtn\.setAttribute\('aria-label', 'Search published packages'\)/);
  assert.equal(source.includes('<span class="sr-only">Search</span>'), false);
});

test('confirmDangerAction safely no-ops when body text is missing', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.match(source, /if\s*\(!isNonEmptyString\(bodyText\)\)\s*\{\s*return false;\s*\}/m);
});

test('non-destructive type switch does not require confirmation', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = {
    localId: 'draft_type_switch_non_destructive',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: '', label: '' }],
        },
      },
    ],
    assets: [],
  };

  const impact = session.getQuestionInputTypeSwitchImpact('q1', 'text');
  assert.equal(impact.optionCountToRemove, 1);
  assert.equal(impact.optionAttachmentCountToRemove, 0);
  assert.equal(impact.hasOptionTextLoss, false);
  assert.equal(impact.hasMeaningfulDataLoss, false);

  const result = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(result.ok, true);
  const updated = session.state.draft.blocks[0];
  assert.equal(updated.responseConfig.inputType, 'text');
  assert.equal(updated.responseConfig.options, undefined);
});

test('destructive type switch requires confirm and cancel path preserves data', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = {
    localId: 'draft_type_switch_cancel',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'Alpha', label: 'Alpha' }],
        },
      },
    ],
    assets: [],
  };

  const result = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'confirm-switch-required');
  assert.equal(result.impact.optionCountToRemove, 1);
  assert.equal(result.impact.hasOptionTextLoss, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.inputType, 'multiple_choice');
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 1);
});

test('confirming destructive type switch removes targeted option data and attachments only', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_type_switch_confirm',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_remove' }] },
          ],
        },
      },
      {
        blockId: 'q2',
        kind: 'question',
        position: 1,
        prompt: { text: 'Q2' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o2', value: 'B', label: 'B', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_keep_shared' }] },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_remove' }, { assetId: 'asset_keep_shared' }, { assetId: 'asset_keep_unused' }],
  };

  const blocked = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'confirm-switch-required');

  const confirmed = session.switchQuestionInputTypeWithImpactPolicy('q1', 'text', { confirmSwitch: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.inputType, 'text');
  assert.equal(session.state.draft.blocks[0].responseConfig.options, undefined);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_remove'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep_shared'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep_unused'), true);
  assert.deepEqual(removed, ['asset_remove']);
});

test('reorderBlockByDelta moves middle block up/down and normalizes positions to 0..n-1', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_middle');
  clearTimeout(session.autosaveTimer);

  const blockA = {
    blockId: 'blk_a',
    kind: 'content',
    position: 0,
    content: { text: 'Intro', format: 'plain_text' },
  };
  const blockB = {
    blockId: 'blk_b',
    kind: 'question',
    position: 1,
    prompt: { text: 'Question B?', format: 'plain_text', mediaRefs: [{ assetId: 'asset_q', usage: 'question_audio' }] },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'single',
      options: [
        { id: 'opt_1', value: 'One', label: 'One', mediaRefs: [{ assetId: 'asset_opt', usage: 'option_audio' }] },
        { id: 'opt_2', value: 'Two', label: 'Two', mediaRefs: [] },
      ],
      correctAnswer: 'opt_1',
    },
  };
  const blockC = {
    blockId: 'blk_c',
    kind: 'content',
    position: 2,
    content: { text: 'Outro', format: 'markdown' },
  };

  session.state.draft.blocks = [blockA, blockB, blockC];
  session.state.selectedBlockId = 'blk_b';
  const beforeById = new Map(session.state.draft.blocks.map((block) => [block.blockId, toBlockFieldsWithoutPosition(block)]));

  session.reorderBlockByDelta('blk_b', -1);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['blk_b', 'blk_a', 'blk_c']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.equal(session.state.selectedBlockId, 'blk_b');
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  session.state.draft.blocks.forEach((block) => {
    assert.deepEqual(toBlockFieldsWithoutPosition(block), beforeById.get(block.blockId));
  });

  session.reorderBlockByDelta('blk_b', 1);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['blk_a', 'blk_b', 'blk_c']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.equal(session.state.selectedBlockId, 'blk_b');
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  session.state.draft.blocks.forEach((block) => {
    assert.deepEqual(toBlockFieldsWithoutPosition(block), beforeById.get(block.blockId));
  });
});

test('reorderBlockByDelta no-ops for out-of-bounds moves and preserves fields/selection', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_bounds');
  clearTimeout(session.autosaveTimer);

  session.state.draft.blocks = [
    { blockId: 'first', kind: 'content', position: 0, content: { text: 'First', format: 'plain_text' } },
    {
      blockId: 'middle',
      kind: 'question',
      position: 1,
      prompt: { text: 'Middle?', format: 'plain_text', mediaRefs: [{ assetId: 'asset_m', usage: 'question_image' }] },
      responseConfig: { inputType: 'text', maxLength: 120, displayMode: 'multi_line' },
    },
    { blockId: 'last', kind: 'content', position: 2, content: { text: 'Last', format: 'plain_text' } },
  ];
  session.state.selectedBlockId = 'middle';
  const snapshot = session.state.draft.blocks.map((block) => structuredClone(block));
  const revisionBefore = session.state.draftRevision;

  session.reorderBlockByDelta('first', -1);
  session.reorderBlockByDelta('last', 1);

  assert.deepEqual(session.state.draft.blocks, snapshot);
  assert.equal(session.state.selectedBlockId, 'middle');
  assert.equal(session.state.draftRevision, revisionBefore);
  session.state.draft.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
});

test('reorderBlockByDelta follows position order when array order diverges', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  await session.createOrOpenByLocalDraftId('draft_reorder_position_canonical');
  clearTimeout(session.autosaveTimer);

  // Intentionally divergent array order vs. position order:
  // array: [b(1), c(2), a(0)] but visible/render order should be [a, b, c].
  session.state.draft.blocks = [
    { blockId: 'b', kind: 'content', position: 1, content: { text: 'B', format: 'plain_text' } },
    { blockId: 'c', kind: 'content', position: 2, content: { text: 'C', format: 'plain_text' } },
    { blockId: 'a', kind: 'content', position: 0, content: { text: 'A', format: 'plain_text' } },
  ];

  session.reorderBlockByDelta('b', 1);

  // Moving "b" down in visible order [a, b, c] should become [a, c, b].
  assert.deepEqual(session.state.draft.blocks.map((block) => block.blockId), ['a', 'c', 'b']);
  assert.deepEqual(session.state.draft.blocks.map((block) => block.position), [0, 1, 2]);
});

test('autosave/export/preview reorder paths remain position-driven without brittle source checks', async () => {
  const mod = await loadEditorModule();
  let persistedSnapshot = null;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        persistedSnapshot = value;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.createOrOpenByLocalDraftId('draft_reorder_autosave');
  clearTimeout(session.autosaveTimer);
  session.state.draft.blocks = [
    { blockId: 'a', kind: 'content', position: 0, content: { text: 'A', format: 'plain_text' } },
    { blockId: 'b', kind: 'content', position: 1, content: { text: 'B', format: 'plain_text' } },
    { blockId: 'c', kind: 'content', position: 2, content: { text: 'C', format: 'plain_text' } },
  ];

  session.reorderBlockByDelta('b', -1);
  await session.autosave();

  assert.ok(persistedSnapshot, 'autosave should persist a snapshot');
  assert.deepEqual(persistedSnapshot.blocks.map((block) => block.blockId), ['b', 'a', 'c']);
  assert.deepEqual(persistedSnapshot.blocks.map((block) => block.position), [0, 1, 2]);
  persistedSnapshot.blocks.forEach((block, index) => {
    assert.equal(block.position, index);
  });
  assert.deepEqual(persistedSnapshot.contractDraft.blocks.map((block) => block.position), [0, 1, 2]);
  assert.deepEqual(persistedSnapshot.contractDraft.blocks.map((block) => block.blockId), ['b', 'a', 'c']);

  const url = mod.buildViewerUrlFromCurrentLocation(
    'https://example.test/server/editor/index.html',
    'draft_reorder_autosave',
    '2026-04-05T00:00:00.000Z'
  );
  assert.equal(
    url.toString(),
    'https://example.test/server/viewer/?localDraftId=draft_reorder_autosave&preview=1&draftUpdatedAt=2026-04-05T00%3A00%3A00.000Z'
  );

  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const originalBlob = globalThis.Blob;
  const anchor = { clickCalled: false, removeCalled: false, click() { this.clickCalled = true; }, remove() { this.removeCalled = true; } };
  globalThis.URL = {
    createObjectURL: () => 'blob:test-export',
    revokeObjectURL: () => {},
  };
  globalThis.document = {
    ...originalDocument,
    body: { appendChild: () => {} },
    createElement: () => anchor,
  };
  globalThis.Blob = originalBlob;

  try {
    const filename = await session.exportCurrentDraftToPackageFile();
    assert.equal(filename.includes('worksheet-package-draft_reorder_autosave-'), true);
    assert.equal(anchor.clickCalled, true);
    assert.equal(anchor.removeCalled, true);
    assert.deepEqual(
      globalThis.__lastCreateWorksheetPackageCall?.draft?.blocks?.map((block) => block.blockId),
      ['b', 'a', 'c']
    );
    assert.deepEqual(
      globalThis.__lastCreateWorksheetPackageCall?.draft?.blocks?.map((block) => block.position),
      [0, 1, 2]
    );
  } finally {
    globalThis.document = originalDocument;
    globalThis.URL = originalUrl;
    globalThis.Blob = originalBlob;
    delete globalThis.__lastCreateWorksheetPackageCall;
  }
});

test('text response normalization removes stale numeric constraints', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Explain' },
      responseConfig: {
        inputType: 'text',
        maxLength: 120,
        displayMode: 'single_line',
        min: 1,
        max: 10,
      },
    },
  ]);

  assert.deepEqual(blocks[0].responseConfig, {
    inputType: 'text',
    maxLength: 120,
    displayMode: 'single_line',
  });
});

test('normalizeBlocks preserves non-canonical single_choice inputType without migration', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Choose?' },
      responseConfig: {
        inputType: 'single_choice',
        options: [{ value: 'a', label: 'A' }],
      },
    },
  ]);
  assert.equal(blocks[0].responseConfig.inputType, 'single_choice');
  assert.equal(Object.hasOwn(blocks[0].responseConfig, 'selectionMode'), false);
  assert.equal(Object.hasOwn(blocks[0].responseConfig, 'options'), false);
});

test('normalizeBlocks keeps only type-compatible correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const blocks = mod.normalizeBlocks([
    {
      blockId: 'q_bool',
      kind: 'question',
      position: 0,
      prompt: { text: 'True?' },
      responseConfig: { inputType: 'boolean', correctAnswer: true },
    },
    {
      blockId: 'q_number',
      kind: 'question',
      position: 1,
      prompt: { text: 'How many?' },
      responseConfig: { inputType: 'number', correctAnswer: Number.NaN },
    },
    {
      blockId: 'q_multi',
      kind: 'question',
      position: 2,
      prompt: { text: 'Pick many' },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'multi',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        correctAnswer: ['a', 'b', 'a', 'x', 5],
      },
    },
    {
      blockId: 'q_malformed',
      kind: 'question',
      position: 3,
      prompt: { text: 'Broken options' },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'single',
        options: [null],
        correctAnswer: 'option_0',
      },
    },
  ]);

  assert.equal(blocks[0].responseConfig.correctAnswer, true);
  assert.equal(Object.hasOwn(blocks[1].responseConfig, 'correctAnswer'), false);
  assert.deepEqual(blocks[2].responseConfig.correctAnswer, ['a', 'b']);
  assert.equal(Object.hasOwn(blocks[3].responseConfig, 'correctAnswer'), false);
});

test('changing inputType or selectionMode re-normalizes/coerces correctAnswer', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_answer_key');
  const block = session.createBlock('question');

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'single',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: 'a',
        },
      }
      : entry
  ));

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['a']);

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: ['a', 'b'],
        },
      }
      : entry
  ));

  session.updateQuestionInputType(block.blockId, 'text');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('selectionMode coercion keeps first valid value when switching multi to single', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_selection_coerce');
  const block = session.createBlock('question');

  session.state.draft.blocks = session.state.draft.blocks.map((entry) => (
    entry.blockId === block.blockId
      ? {
        ...entry,
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          correctAnswer: ['x', 'b', 'a'],
        },
      }
      : entry
  ));

  session.updateQuestionSelectionMode(block.blockId, 'single');
  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'b');
});

test('option mutations prune correctAnswer values not present in options', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_option_prune');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB\nC');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  let optionIdA = getOptionIdByValue(updated.responseConfig.options, 'A');
  let optionIdC = getOptionIdByValue(updated.responseConfig.options, 'C');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [optionIdA, optionIdC]);
  session.updateQuestionOptionAtIndex(block.blockId, 2, 'D');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'D']);

  optionIdA = getOptionIdByValue(updated.responseConfig.options, 'A');
  const optionIdB = getOptionIdByValue(updated.responseConfig.options, 'B');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [optionIdA, optionIdB]);
  session.removeQuestionOption(block.blockId, 0);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B']);

  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(updated.responseConfig.options, 'B'));
  session.updateQuestionOptionsFromText(block.blockId, 'X\nY');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('duplicate multiple-choice option values are flagged during draft validation', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_duplicate_option_validation');
  const block = session.createBlock('question');

  session.updateBlockContent(block.blockId, 'Choose one');
  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nA\nB');

  const validation = session.validateCurrentDraft();
  assert.equal(
    validation.errors.some((message) => message.includes('contains duplicate values: A')),
    true
  );
});

test('duplicate selection values normalize deterministically in multi mode', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_duplicate_value_normalize');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nA\nB');
  const updatedBeforeSelect = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  const firstA = getOptionIdByValue(updatedBeforeSelect.responseConfig.options, 'A');
  const secondA = updatedBeforeSelect.responseConfig.options.find((opt) => opt.value === 'A' && opt.id !== firstA)?.id;
  const optionB = getOptionIdByValue(updatedBeforeSelect.responseConfig.options, 'B');
  session.updateQuestionCorrectAnswerChoices(block.blockId, [firstA, secondA, optionB]);

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'A', 'B']);
});

test('input type transitions clear incompatible correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_type_transition');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'boolean');
  session.updateQuestionCorrectAnswerBoolean(block.blockId, 'true');
  session.updateQuestionInputType(block.blockId, 'number');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);

  session.updateQuestionCorrectAnswerNumber(block.blockId, '2');
  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('question number config and multiple choice settings update through helpers', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_number_config');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionNumberConfig(block.blockId, 'min', '1');
  session.updateQuestionNumberConfig(block.blockId, 'max', '10');
  session.updateQuestionNumberConfig(block.blockId, 'step', '0.5');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(
    { min: updated.responseConfig.min, max: updated.responseConfig.max },
    { min: 1, max: 10 }
  );
  assert.equal(Object.hasOwn(updated.responseConfig, 'step'), false);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionShuffleOptions(block.blockId, true);
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.inputType, 'multiple_choice');
  assert.equal(updated.responseConfig.selectionMode, 'multi');
  assert.equal(updated.responseConfig.shuffleOptions, true);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
});

test('number rules authoring persists and prunes conflicting correctAnswer', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_number_rules');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionCorrectAnswerNumber(block.blockId, '-1.25');
  session.updateQuestionNumberConfig(block.blockId, 'min', '-10');
  session.updateQuestionNumberConfig(block.blockId, 'max', '10');
  session.updateQuestionNumberRulesAllowSigned(block.blockId, false);
  session.updateQuestionNumberRulesDecimalPlacesAllowed(block.blockId, '1');

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.numberRules.allowSigned, false);
  assert.equal(updated.responseConfig.numberRules.decimalPlacesAllowed, 1);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false);
});

test('question correctAnswer helpers update typed answer keys', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_correct_answer_controls');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'boolean');
  session.updateQuestionCorrectAnswerBoolean(block.blockId, 'true');
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, true);

  session.updateQuestionInputType(block.blockId, 'number');
  session.updateQuestionCorrectAnswerNumber(block.blockId, '4.5');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 4.5);

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  let optionId = getOptionIdByValue(
    session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options,
    'B'
  );
  session.updateQuestionCorrectAnswerChoice(block.blockId, optionId);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'B');
  assert.equal(updated.responseConfig.correctAnswerOptionId, optionId);

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  const optionIds = session.state.draft.blocks
    .find((entry) => entry.blockId === block.blockId)
    .responseConfig.options
    .map((option) => option.id);
  session.updateQuestionCorrectAnswerChoices(block.blockId, optionIds);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['A', 'B']);
});

test('multiple choice toggle semantics match single and multi selection behavior', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_choice_toggle_semantics');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'single');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB\nC');

  let currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(currentOptions, 'A'));
  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'A', 'single mode first click should set value');

  session.updateQuestionCorrectAnswerChoice(block.blockId, '');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(Object.hasOwn(updated.responseConfig, 'correctAnswer'), false, 'single mode second click should clear');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoice(block.blockId, getOptionIdByValue(currentOptions, 'B'));
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'B', 'single mode selecting another option should replace');

  session.updateQuestionSelectionMode(block.blockId, 'multi');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B'], 'mode switch should coerce single string to array');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [
    getOptionIdByValue(currentOptions, 'B'),
    getOptionIdByValue(currentOptions, 'C'),
  ]);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['B', 'C'], 'multi mode toggle-on should add value');

  currentOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [getOptionIdByValue(currentOptions, 'C')]);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(updated.responseConfig.correctAnswer, ['C'], 'multi mode toggle-off should remove value');

  session.updateQuestionSelectionMode(block.blockId, 'single');
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.equal(updated.responseConfig.correctAnswer, 'C', 'switching back to single should return string value');
});

test('multiple choice option helpers add, update, and remove options', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_option_helpers');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.addQuestionOption(block.blockId);
  session.addQuestionOption(block.blockId);
  session.updateQuestionOptionAtIndex(block.blockId, 0, 'First');
  session.updateQuestionOptionAtIndex(block.blockId, 1, 'Second');
  session.removeQuestionOption(block.blockId, 0);

  const updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'Second', label: 'Second' }]);
});

test('typing first visible option persists when options array starts empty', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_first_option');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionOptionAtIndex(block.blockId, 0, 'First typed option');

  let updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [{ value: 'First typed option', label: 'First typed option' }]);

  session.addQuestionOption(block.blockId);
  updated = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(stripOptionIds(updated.responseConfig.options), [
    { value: 'First typed option', label: 'First typed option' },
    { value: '', label: '' },
  ]);
});

test('updateQuestionMaxLength preserves existing maxLength on empty or non-numeric input', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_ml');
  const block = session.createBlock('question');
  session.selectBlock(block.blockId);

  session.updateQuestionMaxLength(block.blockId, '200');
  const afterValid = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterValid.responseConfig.maxLength, 200);

  session.updateQuestionMaxLength(block.blockId, '');
  const afterEmpty = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterEmpty.responseConfig.maxLength, 200, 'maxLength should be preserved on empty input');

  session.updateQuestionMaxLength(block.blockId, 'abc');
  const afterNan = session.state.draft.blocks.find((b) => b.blockId === block.blockId);
  assert.equal(afterNan.responseConfig.maxLength, 200, 'maxLength should be preserved on non-numeric input');
});

test('autosave persists normalized contractDraft with typed correctAnswer', async () => {
  const mod = await loadEditorModule();
  let lastPersisted = null;
  const session = new mod.EditorDraftSession({
    drafts: {
      get: async () => null,
      put: async (value) => {
        lastPersisted = value;
        return value;
      },
    },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  await session.createOrOpenByLocalDraftId('draft_autosave_answer_key');
  const block = session.createBlock('question');

  session.updateQuestionInputType(block.blockId, 'multiple_choice');
  session.updateQuestionSelectionMode(block.blockId, 'multi');
  session.updateQuestionOptionsFromText(block.blockId, 'A\nB');
  const autosaveOptions = session.state.draft.blocks.find((entry) => entry.blockId === block.blockId).responseConfig.options;
  session.updateQuestionCorrectAnswerChoices(block.blockId, [
    getOptionIdByValue(autosaveOptions, 'A'),
    getOptionIdByValue(autosaveOptions, 'B'),
    'missing-option-id',
  ]);
  clearTimeout(session.autosaveTimer);
  await session.autosave();

  const savedQuestion = lastPersisted.contractDraft.blocks.find((entry) => entry.blockId === block.blockId);
  assert.deepEqual(savedQuestion.responseConfig.correctAnswer, ['A', 'B']);
});

test('importWorksheetJson convert flow preserves normalized correctAnswer values', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });

  await session.importWorksheetJson({
    title: 'Imported',
    blocks: [
      {
        blockId: 'q_import',
        kind: 'question',
        position: 0,
        prompt: { text: 'Pick', format: 'plain_text' },
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'single',
          options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
          correctAnswer: 'A',
        },
      },
    ],
  }, { convertToEditableDraft: true });

  const importedQuestion = session.state.draft.blocks.find((entry) => entry.blockId === 'q_import');
  assert.equal(importedQuestion.responseConfig.correctAnswer, 'A');
  assert.equal(typeof importedQuestion.responseConfig.correctAnswerOptionId, 'string');
});

test('number validation helper reports min > max error', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors({
    inputType: 'number',
    min: 10,
    max: 5,
    numberRules: { allowSigned: true, decimalPlacesAllowed: null },
  });

  assert.equal(errors.min, 'Max must be greater than or equal to Min');
  assert.equal(errors.max, 'Max must be greater than or equal to Min');
});

test('number validation helper reports decimal-place violation', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      numberRules: { allowSigned: true, decimalPlacesAllowed: 1 },
    },
    { correctAnswer: '1.23', decimalPlacesAllowed: '1' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer has more decimal places than allowed');
});

test('number validation helper reports out-of-range correct answer', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      min: 2,
      max: 8,
      numberRules: { allowSigned: true, decimalPlacesAllowed: null },
    },
    { correctAnswer: '9' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer must be less than or equal to Max');
});

test('number validation helper reports signed-rule violation', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      numberRules: { allowSigned: false, decimalPlacesAllowed: null },
    },
    { correctAnswer: '-3' }
  );

  assert.equal(errors.correctAnswer, 'Correct answer must be positive when signed values are disabled');
});

test('number validation helper returns no errors for valid constraints', async () => {
  const mod = await loadEditorModule();
  const errors = mod.getNumberQuestionValidationErrors(
    {
      inputType: 'number',
      min: -5,
      max: 5,
      correctAnswer: 2.5,
      numberRules: { allowSigned: true, decimalPlacesAllowed: 1 },
    },
    { decimalPlacesAllowed: '1', correctAnswer: '2.5' }
  );

  assert.deepEqual(errors, {
    min: null,
    max: null,
    decimalPlacesAllowed: null,
    correctAnswer: null,
  });
});

function createFakeFile({ name, type, size = 4, bytes = [1, 2, 3, 4] }) {
  const data = new Uint8Array(bytes);
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return data.buffer.slice(0);
    },
  };
}

function createSessionWithQuestion(mod, responseConfig = { inputType: 'text' }) {
  const assetStore = new Map();
  const removedIds = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: {
      get: async (id) => assetStore.get(id) || null,
      put: async (record) => {
        assetStore.set(record.localId, record);
        return record;
      },
      remove: async (id) => {
        removedIds.push(id);
        assetStore.delete(id);
      },
    },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_media',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      position: 0,
      prompt: { text: 'Prompt', format: 'plain_text' },
      responseConfig,
    }],
  });
  return { session, assetStore, removedIds };
}

test('attach/replace/remove question image with confirmation behavior', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore, removedIds } = createSessionWithQuestion(mod);

  const first = await session.attachQuestionMedia('q1', 'question_image', createFakeFile({ name: 'pic.png', type: 'image/png' }));
  assert.equal(first.ok, true);
  assert.equal(assetStore.has(first.assetId), true);

  const replaceNeedsConfirm = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'next.png', type: 'image/png' }),
    { confirmReplace: false }
  );
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');

  const replaced = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'next.png', type: 'image/png' }),
    { confirmReplace: true }
  );
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(first.assetId), true, 'replaced binary should be deleted from localAssets');
  assert.equal(assetStore.has(first.assetId), false, 'replaced binary should be gone from store');
  assert.equal(assetStore.has(replaced.assetId), true, 'new binary should be in store');

  const removeNeedsConfirm = await session.removeQuestionMedia('q1', 'question_image', { confirmRemove: false });
  assert.equal(removeNeedsConfirm.reason, 'confirm-remove-required');
  const removed = await session.removeQuestionMedia('q1', 'question_image', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed binary should be deleted from localAssets');
  assert.equal(assetStore.has(replaced.assetId), false, 'removed binary should be gone from store');
});

test('rejects invalid and oversized question image files', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);

  const badType = await session.attachQuestionMedia('q1', 'question_image', createFakeFile({ name: 'pic.gif', type: 'image/gif' }));
  assert.equal(badType.reason, 'validation');

  const tooBig = await session.attachQuestionMedia(
    'q1',
    'question_image',
    createFakeFile({ name: 'pic.png', type: 'image/png', size: 9 * 1024 * 1024 })
  );
  assert.equal(tooBig.reason, 'validation');
});

test('attach/replace/remove question mp3 and validate type/size', async () => {
  const mod = await loadEditorModule();
  const { session, removedIds } = createSessionWithQuestion(mod);

  const attached = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.mp3', type: 'audio/mpeg' }));
  assert.equal(attached.ok, true);

  const replaceNeedsConfirm = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q2.mp3', type: 'audio/mpeg' }), { confirmReplace: false });
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');
  const replaced = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q2.mp3', type: 'audio/mpeg' }), { confirmReplace: true });
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(attached.assetId), true, 'replaced binary should be deleted from localAssets');

  const removed = await session.removeQuestionMedia('q1', 'question_audio', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed binary should be deleted from localAssets');

  const badType = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.wav', type: 'audio/wav' }));
  assert.equal(badType.reason, 'validation');
  const tooBig = await session.attachQuestionMedia('q1', 'question_audio', createFakeFile({ name: 'q.mp3', type: 'audio/mpeg', size: 6 * 1024 * 1024 }));
  assert.equal(tooBig.reason, 'validation');
});

test('attach/replace/remove option mp3', async () => {
  const mod = await loadEditorModule();
  const { session, removedIds } = createSessionWithQuestion(mod, {
    inputType: 'multiple_choice',
    options: [{ id: 'o1', value: 'A', label: 'A' }],
  });

  const attached = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt.mp3', type: 'audio/mpeg' }));
  assert.equal(attached.ok, true);

  const replaceNeedsConfirm = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt2.mp3', type: 'audio/mpeg' }), { confirmReplace: false });
  assert.equal(replaceNeedsConfirm.reason, 'confirm-replace-required');
  const replaced = await session.attachOptionAudio('q1', 'o1', createFakeFile({ name: 'opt2.mp3', type: 'audio/mpeg' }), { confirmReplace: true });
  assert.equal(replaced.ok, true);
  assert.equal(removedIds.includes(attached.assetId), true, 'replaced option binary should be deleted from localAssets');

  const removed = await session.removeOptionAudio('q1', 'o1', { confirmRemove: true });
  assert.equal(removed.ok, true);
  assert.equal(removedIds.includes(replaced.assetId), true, 'removed option binary should be deleted from localAssets');
});

test('attach option audio on non-persisted option returns missing-option with helper feedback', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod, {
    inputType: 'multiple_choice',
    options: [],
  });

  const result = await session.attachOptionAudio('q1', 'placeholder_opt', createFakeFile({ name: 'opt.mp3', type: 'audio/mpeg' }));
  assert.equal(result.reason, 'missing-option');
  assert.equal(session.state.mediaFeedback, 'Enter option text or click Add option before attaching audio.');
});

// ─── preview helper tests ────────────────────────────────────────────────────

test('getLocalAssetRecord returns record from storage', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2]), metadata: { mimeType: 'audio/mpeg' } });
  const record = await session.getLocalAssetRecord('asset_1');
  assert.ok(record);
  assert.equal(record.localId, 'asset_1');
});

test('getLocalAssetRecord returns null for missing asset', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const record = await session.getLocalAssetRecord('no_such_id');
  assert.equal(record, null);
});

test('getLocalAssetRecord returns null for falsy assetId', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  assert.equal(await session.getLocalAssetRecord(null), null);
  assert.equal(await session.getLocalAssetRecord(''), null);
});

test('createObjectUrlForAsset returns null when binary is missing', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    assert.equal(session.createObjectUrlForAsset(null), null);
    assert.equal(session.createObjectUrlForAsset({ metadata: {} }), null);
    assert.equal(objectUrls.length, 0);
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('createObjectUrlForAsset creates an object URL for a record with binary', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    const url = session.createObjectUrlForAsset({ binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
    assert.equal(typeof url, 'string');
    assert.ok(url.startsWith('blob:'));
    assert.equal(objectUrls.length, 1);
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('playAssetAudio returns missing-asset when record not in storage', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const result = await session.playAssetAudio('no_such_id');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-asset');
  assert.equal(session.state.mediaFeedback, 'Unable to load attached audio for preview.');
});

test('playAssetAudio returns missing-binary when record has no binary', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', metadata: { mimeType: 'audio/mpeg' } });
  const objectUrls = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = () => { const u = `blob:test/${objectUrls.length}`; objectUrls.push(u); return u; };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-binary');
  } finally {
    URL.createObjectURL = origCreate;
  }
});

test('playAssetAudio returns playback-failed and revokes URL when play() rejects', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });

  const revokedUrls = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/audio1';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);

  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.reject(new Error('NotAllowedError')); }
    pause() {}
    addEventListener() {}
  };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'playback-failed');
    assert.ok(revokedUrls.includes('blob:test/audio1'), 'URL should be revoked on playback failure');
    assert.equal(session.previewAudio, null);
    assert.equal(session.previewAudioUrl, null);
    assert.equal(session.state.mediaFeedback, 'Audio playback was blocked. Try again.');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio succeeds and clears media feedback', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
  session.state.mediaFeedback = 'old message';

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:test/audio2';
  const origAudio = globalThis.Audio;
  const listeners = {};
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  try {
    const result = await session.playAssetAudio('asset_1');
    assert.equal(result.ok, true);
    assert.equal(session.state.mediaFeedback, null);
    assert.equal(session.previewAudioUrl, 'blob:test/audio2');
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio ignores stale error events from interrupted audio when switching clips', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });
  assetStore.set('asset_2', { localId: 'asset_2', binary: new Uint8Array([4, 5, 6]), metadata: { mimeType: 'audio/mpeg' } });
  session.state.mediaFeedback = null;

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (() => {
    let i = 0;
    return () => `blob:test/audio-switch-${++i}`;
  })();

  const origAudio = globalThis.Audio;
  const audioInstances = [];
  globalThis.Audio = class {
    constructor(src) {
      this.src = src;
      this.listeners = {};
      this.playCallCount = 0;
      audioInstances.push(this);
    }
    play() {
      this.playCallCount += 1;
      return Promise.resolve();
    }
    pause() {
      this.listeners.error?.();
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  };

  try {
    const first = await session.playAssetAudio('asset_1');
    assert.equal(first.ok, true);

    const second = await session.playAssetAudio('asset_2');
    assert.equal(second.ok, true, 'new audio should start on first click after interrupting previous playback');
    assert.equal(session.state.mediaFeedback, null, 'stale interrupted-audio errors should not persist');
    assert.equal(audioInstances.length, 2);
    assert.equal(audioInstances[1].playCallCount, 1);
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('playAssetAudio treats out-of-order asset loads as superseded instead of cancelling newer playback', async () => {
  const mod = await loadEditorModule();

  let resolveFirstGet;
  const firstGetPromise = new Promise((resolve) => {
    resolveFirstGet = resolve;
  });
  const localAssets = {
    get: async (id) => {
      if (id === 'asset_slow') {
        return firstGetPromise;
      }
      if (id === 'asset_fast') {
        return { localId: id, binary: new Uint8Array([7, 8, 9]), metadata: { mimeType: 'audio/mpeg' } };
      }
      return null;
    },
  };
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets,
    resumeFlags: { get: () => null, set: () => {} },
  });

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (() => {
    let i = 0;
    return () => `blob:test/audio-race-${++i}`;
  })();
  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor(src) { this.src = src; }
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
  };

  try {
    const slowPromise = session.playAssetAudio('asset_slow');
    const fastResult = await session.playAssetAudio('asset_fast');
    assert.equal(fastResult.ok, true);

    resolveFirstGet({ localId: 'asset_slow', binary: new Uint8Array([1, 1, 1]), metadata: { mimeType: 'audio/mpeg' } });
    const slowResult = await slowPromise;
    assert.equal(slowResult.ok, false);
    assert.equal(slowResult.reason, 'superseded');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    globalThis.Audio = origAudio;
  }
});

test('stopPreviewAudio revokes object URL for current preview', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_1', { localId: 'asset_1', binary: new Uint8Array([1, 2, 3]), metadata: { mimeType: 'audio/mpeg' } });

  const revokedUrls = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/audio3';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);
  const origAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() {}
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
  };
  try {
    await session.playAssetAudio('asset_1');
    assert.ok(session.previewAudio, 'audio should be set after play');
    assert.equal(session.previewAudioUrl, 'blob:test/audio3');
    session.stopPreviewAudio();
    assert.equal(session.previewAudio, null);
    assert.equal(session.previewAudioUrl, null);
    assert.ok(revokedUrls.includes('blob:test/audio3'), 'URL should be revoked by stopPreviewAudio');
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.Audio = origAudio;
  }
});

test('openAssetImage returns blocked when window.open returns null', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  const origOpen = globalThis.window.open;
  globalThis.window.open = () => null;
  try {
    const result = await session.openAssetImage('asset_1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blocked');
    assert.equal(session.state.mediaFeedback, 'Image preview was blocked. Allow pop-ups and try again.');
  } finally {
    globalThis.window.open = origOpen;
  }
});

test('openAssetImage omits noopener/noreferrer features so browsers return window handle', async () => {
  // Per spec (and Chrome 88+), window.open returns null when noopener or
  // noreferrer is in the features string, even though a tab still opens.
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image2';
  URL.revokeObjectURL = () => {};
  const origOpen = globalThis.window.open;
  const origSetTimeout = globalThis.window.setTimeout;
  let receivedFeatures = null;
  let navigatedTo = null;
  globalThis.window.open = (_url, _target, features) => {
    receivedFeatures = features ?? null;
    // Simulate spec behaviour: return null when noopener or noreferrer present.
    if (features?.includes('noreferrer') || features?.includes('noopener')) return null;
    return {
      set opener(_) {},
      document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
      location: { replace(url) { navigatedTo = url; } },
    };
  };
  try {
    globalThis.window.setTimeout = () => 0;
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true, 'should succeed without noopener/noreferrer features');
    assert.ok(
      !receivedFeatures?.includes('noreferrer') && !receivedFeatures?.includes('noopener'),
      `features must not contain noopener or noreferrer, got: ${receivedFeatures}`
    );
    assert.equal(navigatedTo, 'blob:test/image2');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    globalThis.window.open = origOpen;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('openAssetImage returns missing-asset when asset not in storage', async () => {
  const mod = await loadEditorModule();
  const { session } = createSessionWithQuestion(mod);
  let closed = false;
  globalThis.window.open = () => ({
    close() { closed = true; },
    set opener(_) {},
    document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
    location: { replace() {} },
  });
  try {
    const result = await session.openAssetImage('no_such_id');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-asset');
    assert.equal(closed, true);
  } finally {
    delete globalThis.window.open;
  }
});

test('openAssetImage navigates new window to object URL on success', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const revokedUrls = [];
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image1';
  URL.revokeObjectURL = (u) => revokedUrls.push(u);

  let navigatedTo = null;
  globalThis.window.open = () => ({
    set opener(_) {},
    document: { get title() { return ''; }, set title(_) {}, body: { set textContent(_) {} } },
    location: { replace(url) { navigatedTo = url; } },
  });
  const origSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (fn) => fn();
  try {
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true);
    assert.equal(navigatedTo, 'blob:test/image1');
    assert.ok(revokedUrls.includes('blob:test/image1'), 'URL should be revoked via setTimeout');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    delete globalThis.window.open;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('openAssetImage falls back to in-window img render when location.replace throws', async () => {
  const mod = await loadEditorModule();
  const { session, assetStore } = createSessionWithQuestion(mod);
  assetStore.set('asset_img', { localId: 'asset_img', binary: new Uint8Array([255, 0]), metadata: { mimeType: 'image/png' } });

  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test/image-fallback';
  URL.revokeObjectURL = () => {};

  let appendedSrc = null;
  globalThis.window.open = () => {
    const body = {
      innerHTML: '',
      style: {},
      appendChild(node) {
        appendedSrc = node?.src || null;
      },
    };
    return {
      set opener(_) {},
      document: {
        title: '',
        body,
        createElement() {
          return { src: '', alt: '', style: {} };
        },
      },
      location: {
        replace() {
          throw new Error('navigation blocked');
        },
      },
      close() {},
    };
  };
  const origSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (fn) => fn();
  try {
    const result = await session.openAssetImage('asset_img');
    assert.equal(result.ok, true);
    assert.equal(appendedSrc, 'blob:test/image-fallback');
    assert.equal(session.state.mediaFeedback, null);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    delete globalThis.window.open;
    globalThis.window.setTimeout = origSetTimeout;
  }
});

test('deleteBlock prunes linked question and option media assets', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_q_audio' }] },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] }],
        },
      },
    ],
    assets: [{ assetId: 'asset_q_audio' }, { assetId: 'asset_opt_audio' }, { assetId: 'asset_keep' }],
  };
  session.state.selectedBlockId = 'q1';

  session.deleteBlock('q1');
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_q_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_opt_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed.sort(), ['asset_opt_audio', 'asset_q_audio']);
});

test('deleteBlockWithPolicy directly deletes empty block', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_empty_block_delete',
    blocks: [
      {
        blockId: 'c1',
        kind: 'content',
        position: 0,
        content: { text: '   ', format: 'plain_text' },
      },
      {
        blockId: 'c2',
        kind: 'content',
        position: 1,
        content: { text: 'keep', format: 'plain_text' },
      },
    ],
    assets: [],
  };
  session.state.selectedBlockId = 'c1';

  const result = session.deleteBlockWithPolicy('c1');
  assert.equal(result.ok, true);
  assert.equal(result.policy.mode, 'safe_direct_delete');
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'c1'), false);
});

test('deleteBlockWithPolicy requires confirm when block has content/assets and confirm deletes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_risky_block_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Prompt text', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_q_audio' }] },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A' }],
        },
      },
      {
        blockId: 'c2',
        kind: 'content',
        position: 1,
        content: { text: 'keep', format: 'plain_text' },
      },
    ],
    assets: [{ assetId: 'asset_q_audio' }],
  };
  session.state.selectedBlockId = 'q1';

  const gated = session.deleteBlockWithPolicy('q1');
  assert.equal(gated.ok, false);
  assert.equal(gated.reason, 'confirm-delete-required');
  assert.equal(gated.policy.mode, 'confirm_delete');
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'q1'), true, 'cancel/no-confirm should leave block untouched');

  const confirmed = session.deleteBlockWithPolicy('q1', { confirmDelete: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks.some((block) => block.blockId === 'q1'), false, 'confirm should delete block');
});

test('deleteBlock preserves assets still referenced by remaining questions', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_shared',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_shared_audio' }] },
        responseConfig: { inputType: 'text' },
      },
      {
        blockId: 'q2',
        kind: 'question',
        position: 1,
        prompt: { text: 'Q2', mediaRefs: [{ usage: 'question_audio', assetId: 'asset_shared_audio' }] },
        responseConfig: { inputType: 'text' },
      },
    ],
    assets: [{ assetId: 'asset_shared_audio' }, { assetId: 'asset_keep' }],
  };
  session.state.selectedBlockId = 'q1';

  session.deleteBlock('q1');
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_shared_audio'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, []);
});

test('removeQuestionOption prunes option audio asset link', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_opt',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] }],
        },
      },
    ],
    assets: [{ assetId: 'asset_opt_audio' }, { assetId: 'asset_keep' }],
  };

  session.removeQuestionOption('q1', 0);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_opt_audio'), false);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, ['asset_opt_audio']);
});

test('removeQuestionOption preserves shared option audio used by another option', async () => {
  const mod = await loadEditorModule();
  const removed = [];
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    localAssets: { remove: async (id) => { removed.push(id); } },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_cleanup_opt_shared',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_shared_opt_audio' }] },
            { id: 'o2', value: 'B', label: 'B', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_shared_opt_audio' }] },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_shared_opt_audio' }, { assetId: 'asset_keep' }],
  };

  session.removeQuestionOption('q1', 0);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_shared_opt_audio'), true);
  assert.equal(session.state.draft.assets.some((asset) => asset.assetId === 'asset_keep'), true);
  assert.deepEqual(removed, []);
});

test('removeQuestionOptionWithPolicy directly deletes empty option', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_empty_option_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [{ id: 'o1', value: '', label: '' }, { id: 'o2', value: 'B', label: 'B' }],
        },
      },
    ],
    assets: [],
  };

  const result = session.removeQuestionOptionWithPolicy('q1', 0);
  assert.equal(result.ok, true);
  assert.equal(result.policy.mode, 'safe_direct_delete');
  const options = session.state.draft.blocks[0].responseConfig.options;
  assert.equal(options.length, 1);
  assert.equal(options[0].id, 'o2');
});

test('removeQuestionOptionWithPolicy requires confirm; cancel leaves option and confirm deletes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession({
    drafts: { get: async () => null, put: async (v) => v },
    importedWorksheets: { put: async () => {} },
    resumeFlags: { get: () => null, set: () => {} },
  });
  session.state.draft = {
    localId: 'draft_risky_option_delete',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q' },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'o1', value: 'A', label: 'A', mediaRefs: [{ usage: 'option_audio', assetId: 'asset_opt_audio' }] },
            { id: 'o2', value: 'B', label: 'B' },
          ],
        },
      },
    ],
    assets: [{ assetId: 'asset_opt_audio' }],
  };

  const gated = session.removeQuestionOptionWithPolicy('q1', 0);
  assert.equal(gated.ok, false);
  assert.equal(gated.reason, 'confirm-delete-required');
  assert.equal(gated.policy.mode, 'confirm_delete');
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 2, 'cancel/no-confirm should leave option untouched');

  const confirmed = session.removeQuestionOptionWithPolicy('q1', 0, { confirmDelete: true });
  assert.equal(confirmed.ok, true);
  assert.equal(session.state.draft.blocks[0].responseConfig.options.length, 1, 'confirm should delete option');
  assert.equal(session.state.draft.blocks[0].responseConfig.options[0].id, 'o2');
});

test('formatUploadedDraftTimestamp uses local browser formatting and handles invalid timestamps', async () => {
  const mod = await loadEditorModule();
  const originalFormatter = Intl.DateTimeFormat;
  const calls = [];

  Intl.DateTimeFormat = function fakeDateTimeFormat(locale, options) {
    calls.push({ locale, options });
    return {
      format(value) {
        const iso = value instanceof Date ? value.toISOString() : String(value);
        return `LOCAL(${iso})`;
      },
    };
  };

  try {
    const formatted = mod.formatUploadedDraftTimestamp('2026-04-07T15:42:00.000Z');
    assert.equal(formatted.startsWith('LOCAL('), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    assert.equal(mod.formatUploadedDraftTimestamp('not-a-date'), 'Unknown upload time');
    assert.equal(mod.formatUploadedDraftTimestamp(''), 'Unknown upload time');
  } finally {
    Intl.DateTimeFormat = originalFormatter;
  }
});

test('deleteUploadedDraft refreshes uploaded drafts list and leaves local draft intact', async () => {
  const mod = await loadEditorModule();
  const listCalls = [];
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => {
        listCalls.push('list');
        return {
          ok: true,
          data: {
            items: [
              {
                uploaded_draft_id: 'new-draft-id',
                title: 'Replacement draft',
                created_at: '2026-04-07T15:42:00.000Z',
              },
            ],
          },
        };
      },
      deleteUploadedDraft: async (uploadedDraftId) => {
        assert.equal(uploadedDraftId, 'old-draft-id');
        return { ok: true, data: { uploaded_draft_id: uploadedDraftId, deleted: true } };
      },
    },
  });

  session.state.draft = { localId: 'local_draft_1', title: 'Keep local', blocks: [] };
  session.state.uploadedDrafts = [
    { uploaded_draft_id: 'old-draft-id', title: 'Old draft', created_at: '2026-04-06T10:00:00.000Z' },
  ];

  const result = await session.deleteUploadedDraft('old-draft-id');

  assert.equal(result.ok, true);
  assert.equal(result.refreshResult.ok, true);
  assert.equal(listCalls.length, 1);
  assert.equal(session.state.uploadedDrafts.length, 1);
  assert.equal(session.state.uploadedDrafts[0].uploaded_draft_id, 'new-draft-id');
  assert.equal(session.state.draft.localId, 'local_draft_1');
  assert.equal(session.state.serverActionMessage, 'Uploaded drafts refreshed.');
  assert.equal(
    session.state.notifications.some((item) => item.text === 'Uploaded draft deleted.'),
    true
  );
  const deleteNotifications = session.state.notifications
    .filter((item) => item.source === 'uploadedDraft.delete' || item.source === 'uploadedDraft.delete.refresh')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(deleteNotifications, [
    {
      source: 'uploadedDraft.delete',
      kind: 'success',
      category: 'server',
      text: 'Uploaded draft deleted.',
    },
    {
      source: 'uploadedDraft.delete.refresh',
      kind: 'success',
      category: 'server',
      text: 'Uploaded drafts refreshed.',
    },
  ]);
});

test('loadUploadedDrafts deduplicates concurrent preflight calls before loading flag is set', async () => {
  const mod = await loadEditorModule();
  let ensureCalls = 0;
  let listCalls = 0;
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => {
        listCalls += 1;
        return { ok: true, data: { items: [] } };
      },
    },
  });

  session.ensureServerSessionReady = async () => {
    ensureCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, result: { ok: true } };
  };

  const [first, second] = await Promise.all([
    session.loadUploadedDrafts(),
    session.loadUploadedDrafts(),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(ensureCalls, 1);
  assert.equal(listCalls, 1);
});

test('loadUploadedDrafts preflight:false does not reuse an in-flight preflight:true request', async () => {
  const mod = await loadEditorModule();
  let listCalls = 0;
  let resolveEnsure;
  const ensureGate = new Promise((resolve) => {
    resolveEnsure = resolve;
  });
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => {
        listCalls += 1;
        return { ok: true, data: { items: [{ uploaded_draft_id: `draft-${listCalls}` }] } };
      },
    },
  });

  session.ensureServerSessionReady = async () => {
    await ensureGate;
    return { ok: false, result: { ok: false, error: { message: 'session not ready' } } };
  };

  const preflightPromise = session.loadUploadedDrafts();
  const refreshWithoutPreflight = await session.loadUploadedDrafts({ preflight: false });
  resolveEnsure();
  const preflightResult = await preflightPromise;

  assert.equal(refreshWithoutPreflight.ok, true);
  assert.equal(preflightResult.ok, false);
  assert.equal(listCalls, 1);
  assert.equal(session.state.uploadedDrafts.length, 1);
  assert.equal(session.state.uploadedDrafts[0].uploaded_draft_id, 'draft-1');
});

test('loadUploadedDrafts keeps loading state true until overlapping preflight and non-preflight refreshes finish', async () => {
  const mod = await loadEditorModule();
  let resolveEnsure;
  let resolveList;
  const ensureGate = new Promise((resolve) => {
    resolveEnsure = resolve;
  });
  const listGate = new Promise((resolve) => {
    resolveList = resolve;
  });
  const loadingStates = [];
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => {
        await listGate;
        return { ok: true, data: { items: [] } };
      },
    },
  });
  session.setOnStateChange((state) => {
    loadingStates.push(state.isLoadingUploadedDrafts);
  });
  session.ensureServerSessionReady = async () => {
    await ensureGate;
    return { ok: true, result: { ok: true } };
  };

  const withPreflight = session.loadUploadedDrafts();
  const withoutPreflight = session.loadUploadedDrafts({ preflight: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveEnsure();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.state.isLoadingUploadedDrafts, true);

  resolveList();
  await Promise.all([withPreflight, withoutPreflight]);

  assert.equal(session.state.isLoadingUploadedDrafts, false);
  assert.equal(loadingStates.includes(true), true);
  assert.equal(loadingStates[loadingStates.length - 1], false);
});

test('loadUploadedDrafts keeps prior notification-derived server action message after successful refresh', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: true, data: { items: [] } }),
    },
  });

  session.pushNotification({
    kind: 'success',
    source: 'test.seed',
    text: 'Uploaded draft draft_123.',
  });
  const withExistingMessage = await session.loadUploadedDrafts({ preflight: false });
  assert.equal(withExistingMessage.ok, true);
  assert.equal(session.state.serverActionMessage, 'Uploaded draft draft_123.');

  session.clearNotificationsBySource('test.seed');
  const withoutExistingMessage = await session.loadUploadedDrafts({ preflight: false });
  assert.equal(withoutExistingMessage.ok, true);
  assert.equal(session.state.serverActionMessage, null);
});

test('loadUploadedDrafts preserves terminal refresh warnings after request completes', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: false, error: { message: 'Unable to refresh uploaded drafts.' } }),
    },
  });

  const result = await session.loadUploadedDrafts({ preflight: false });
  assert.equal(result.ok, false);
  assert.equal(session.state.serverActionMessage, 'Unable to refresh uploaded drafts.');

  const refreshNotifications = session.state.notifications
    .filter((item) => item.source === 'uploadedDrafts.refresh')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(refreshNotifications, [
    {
      source: 'uploadedDrafts.refresh',
      kind: 'warn',
      category: 'server',
      text: 'Unable to refresh uploaded drafts.',
    },
  ]);
  const refreshActivityTexts = session.state.activityLog
    .filter((item) => item.source === 'uploadedDrafts.refresh')
    .map((item) => item.text);
  assert.equal(refreshActivityTexts.includes('Refreshing…'), false);
  assert.equal(refreshActivityTexts.includes('Unable to refresh uploaded drafts.'), true);
});

test('deleteUploadedDraft preserves success message when refresh fails', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html',
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      listUploadedDrafts: async () => ({ ok: false, error: { message: 'Unable to refresh uploaded drafts.' } }),
      deleteUploadedDraft: async () => ({ ok: true, data: { uploaded_draft_id: 'old-draft-id', deleted: true } }),
    },
  });

  const result = await session.deleteUploadedDraft('old-draft-id');

  assert.equal(result.ok, true);
  assert.equal(result.refreshResult.ok, false);
  assert.equal(session.state.serverActionMessage, 'Unable to refresh uploaded drafts.');
  assert.equal(
    session.state.notifications.some((item) => item.text === 'Uploaded draft deleted.'),
    true
  );
  const deleteNotifications = session.state.notifications
    .filter((item) => item.source === 'uploadedDraft.delete' || item.source === 'uploadedDraft.delete.refresh')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(deleteNotifications, [
    {
      source: 'uploadedDraft.delete',
      kind: 'success',
      category: 'server',
      text: 'Uploaded draft deleted.',
    },
    {
      source: 'uploadedDraft.delete.refresh',
      kind: 'warn',
      category: 'server',
      text: 'Unable to refresh uploaded drafts.',
    },
  ]);
});

test('reopenPublishedPackageAsLocalCopy emits modal-open notification sequence', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      getSession: async () => ({ ok: true, data: { user: { email: 'teacher@example.test' } } }),
      fetchPublishedPackageArtifact: async () => ({ ok: true, data: new Uint8Array([1, 2, 3]) }),
    },
  });
  session.importWorksheetPackageFile = async () => ({ importedRecord: { localId: 'draft_imported' } });

  const result = await session.reopenPublishedPackageAsLocalCopy('pkg_42');
  assert.equal(result.ok, true);
  const openNotifications = session.state.notifications
    .filter((item) => item.source === 'publishedPackage.open')
    .map(({ source, kind, category, text }) => ({ source, kind, category, text }));
  assert.deepEqual(openNotifications, [
    {
      source: 'publishedPackage.open',
      kind: 'info',
      category: 'server',
      text: 'Opening published package…',
    },
    {
      source: 'publishedPackage.open',
      kind: 'success',
      category: 'server',
      text: 'Opened published package pkg_42 as a new local draft copy.',
    },
  ]);
  const openActivityTexts = session.state.activityLog
    .filter((item) => item.source === 'publishedPackage.open')
    .map((item) => item.text);
  assert.equal(openActivityTexts.includes('Opening published package…'), false);
  assert.equal(openActivityTexts.includes('Opened published package pkg_42 as a new local draft copy.'), true);
});

test('setRecoveryMessage emits visible recovery notification objects', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());

  session.setRecoveryMessage('Resumed your previous action after sign-in.');
  const recoveryNotification = session.getLatestNotification({ categories: ['recovery'] });
  assert.deepEqual(
    {
      source: recoveryNotification.source,
      kind: recoveryNotification.kind,
      category: recoveryNotification.category,
      text: recoveryNotification.text,
    },
    {
      source: 'auth.recovery',
      kind: 'info',
      category: 'recovery',
      text: 'Resumed your previous action after sign-in.',
    }
  );
});

test('toUploadedDraftDisplay includes fallback title and uploaded label', async () => {
  const mod = await loadEditorModule();
  const originalFormatter = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function fakeDateTimeFormat() {
    return {
      format() {
        return 'Apr 7, 2026, 3:42 PM';
      },
    };
  };
  try {
    const withTitle = mod.toUploadedDraftDisplay({
      title: '  Algebra worksheet  ',
      created_at: '2026-04-07T15:42:00.000Z',
    });
    assert.equal(withTitle.title, 'Algebra worksheet');
    assert.equal(withTitle.uploadedLabel, 'Uploaded: Apr 7, 2026, 3:42 PM');

    const untitled = mod.toUploadedDraftDisplay({
      title: '',
      created_at: '',
    });
    assert.equal(untitled.title, 'Untitled');
    assert.equal(untitled.uploadedLabel, 'Uploaded: Unknown upload time');
  } finally {
    Intl.DateTimeFormat = originalFormatter;
  }
});

test('editor intent payload validators reject stale or malformed prompt/option t2a payloads', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Question 1' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: 'A', label: 'A' }],
      },
    }],
  });

  assert.equal(
    session.validateEditorPromptT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'q1',
      target: 'question_prompt',
    }).ok,
    true
  );
  assert.equal(
    session.validateEditorPromptT2AIntentPayload({
      localDraftId: 'draft_stale',
      blockId: 'q1',
      target: 'question_prompt',
    }).ok,
    false
  );
  assert.equal(
    session.validateEditorPromptT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'missing',
      target: 'question_prompt',
    }).ok,
    false
  );
  assert.equal(
    session.validateEditorPromptT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'q1',
      target: 'option',
    }).ok,
    false
  );

  assert.equal(
    session.validateEditorOptionT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'q1',
      target: 'option',
      optionId: 'opt_1',
    }).ok,
    true
  );
  assert.equal(
    session.validateEditorOptionT2AIntentPayload({
      localDraftId: 'draft_stale',
      blockId: 'q1',
      target: 'option',
      optionId: 'opt_1',
    }).ok,
    false
  );
  assert.equal(
    session.validateEditorOptionT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'q1',
      target: 'option',
      optionId: 'missing_opt',
    }).ok,
    false
  );
  assert.equal(
    session.validateEditorOptionT2AIntentPayload({
      localDraftId: 'draft_active',
      blockId: 'q1',
      target: 'question_prompt',
      optionId: 'opt_1',
    }).ok,
    false
  );
});

test('bootstrapEditor validateIntent uses action-aware payload validation', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes("actionId === 'editorPromptT2A' || actionId === 'resumeT2AAfterLogin'"), true);
  assert.equal(source.includes("actionId === 'editorOptionT2A'"), true);
  assert.equal(source.includes("actionId === 'resumeRewriteAfterLogin'"), true);
  assert.equal(source.includes('hasOnlyAllowedKeys(payload, allowed)'), true);
  assert.equal(source.includes('session.validateEditorPromptT2AIntentPayload(payload).ok'), true);
  assert.equal(source.includes('session.validateEditorOptionT2AIntentPayload(payload).ok'), true);
});

test('bootstrapEditor configures SharedAuthGate with live session probe check', async () => {
  const source = await fs.readFile(path.resolve('server/editor/main.js'), 'utf8');
  assert.equal(source.includes('checkSessionReady: async () => session.ensureServerSessionReady(),'), true);
  assert.equal(source.includes("isAuthenticated: () => new URL(window.location.href).searchParams.get('auth') === '1'"), false);
});

test('editor triggerProtectedAction forwards payload and remains functional without intentPayload', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = mod.createDraftRecord({ localId: 'draft_1' });
  const calls = [];
  session.authGate = {
    runProtectedAction: async (intent) => {
      calls.push(intent);
      return { status: 'executed' };
    },
  };

  const noPayloadResult = await session.triggerProtectedAction('resumeRewriteAfterLogin');
  const withPayloadResult = await session.triggerProtectedAction('editorPromptT2A', {
    localDraftId: 'draft_stale',
    blockId: 'q1',
    target: 'question_prompt',
  });

  assert.equal(noPayloadResult.status, 'executed');
  assert.equal(withPayloadResult.status, 'executed');
  assert.deepEqual(calls[0], {
    actionId: 'resumeRewriteAfterLogin',
    recordStore: 'localDrafts',
    payload: { localDraftId: 'draft_1' },
  });
  assert.deepEqual(calls[1], {
    actionId: 'editorPromptT2A',
    recordStore: 'localDrafts',
    payload: { localDraftId: 'draft_1', blockId: 'q1', target: 'question_prompt' },
  });
});

test('editor replayProtectedAction receives payload and avoids mutation on stale context', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests());
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Question 1' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: 'A', label: 'A' }],
      },
    }],
  });
  const beforeDraft = JSON.stringify(session.state.draft);

  const result = await session.replayProtectedAction({
    actionId: 'editorOptionT2A',
    payload: {
      localDraftId: 'draft_stale',
      blockId: 'q1',
      target: 'option',
      optionId: 'opt_1',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_context');
  assert.equal(JSON.stringify(session.state.draft), beforeDraft);
});

test('editor replayEditorPromptT2AIntent generates audio and attaches via canonical question media path', async () => {
  const mod = await loadEditorModule();
  const attachCalls = [];
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async (text) => ({
        ok: true,
        data: new Uint8Array([1, 2, 3]),
      }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{ blockId: 'q1', kind: 'question', prompt: { text: 'Prompt audio text' } }],
  });
  session.attachQuestionMedia = async (...args) => {
    attachCalls.push(args);
    return { ok: true };
  };

  const result = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'generated_editor_prompt_t2a');
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0][0], 'q1');
  assert.equal(attachCalls[0][1], 'question_audio');
  assert.equal(typeof attachCalls[0][2]?.arrayBuffer, 'function');
  assert.equal(attachCalls[0][3]?.confirmReplace, false);
});

test('editor replayEditorPromptT2AIntent returns plain-language errors for invalid prompt generation states', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async () => ({ ok: false, error: { message: '' } }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{ blockId: 'q1', kind: 'question', prompt: { text: '' } }],
  });

  const missingPrompt = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  assert.equal(missingPrompt.ok, false);
  assert.equal(missingPrompt.error.message, 'Enter a prompt before generating audio.');

  session.state.draft.blocks[0].prompt.text = 'a'.repeat(201);
  const tooLong = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.message, 'Prompt must be 200 characters or fewer to generate audio.');

  session.state.draft.blocks[0].prompt.text = 'short prompt';
  const generationFailure = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  assert.equal(generationFailure.ok, false);
  assert.equal(generationFailure.error.message, 'Audio generation failed. Existing audio is unchanged.');
  const promptRecoveryNotification = session.state.notifications
    .find((item) => item.source === 'prompt.t2a' && item.kind === 'error');
  assert.equal(Boolean(promptRecoveryNotification), true);
});

test('editor replayEditorOptionT2AIntent generates audio and attaches via canonical option media path', async () => {
  const mod = await loadEditorModule();
  const attachCalls = [];
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async (text) => ({
        ok: true,
        data: new Uint8Array([4, 5, 6]),
      }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Q1' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: 'Option one', label: 'Option one' }],
      },
    }],
  });
  session.attachOptionAudio = async (...args) => {
    attachCalls.push(args);
    return { ok: true };
  };

  const result = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'generated_editor_option_t2a');
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0][0], 'q1');
  assert.equal(attachCalls[0][1], 'opt_1');
  assert.equal(typeof attachCalls[0][2]?.arrayBuffer, 'function');
  assert.equal(attachCalls[0][3]?.confirmReplace, false);
});

test('editor replayEditorOptionT2AIntent returns plain-language errors for invalid option generation states', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async () => ({ ok: false, error: { message: '' } }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Q1' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: '', label: '' }],
      },
    }],
  });

  const missingText = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });
  assert.equal(missingText.ok, false);
  assert.equal(missingText.error.message, 'Enter option text before generating audio.');

  session.state.draft.blocks[0].responseConfig.options[0].label = 'a'.repeat(201);
  const tooLong = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.message, 'Option text must be 200 characters or fewer to generate audio.');

  session.state.draft.blocks[0].responseConfig.options[0].label = 'short option';
  const generationFailure = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });
  assert.equal(generationFailure.ok, false);
  assert.equal(generationFailure.error.message, 'Audio generation failed. Existing audio is unchanged.');
  const optionRecoveryNotification = session.state.notifications
    .find((item) => item.source === 'option.t2a' && item.kind === 'error');
  assert.equal(Boolean(optionRecoveryNotification), true);
});

test('stage3: replay T2A rejects invalid binary payload shape without replacing existing audio', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async () => ({ ok: true, data: { bytes: new Uint8Array([1, 2, 3]) } }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: {
        text: 'Prompt for audio',
        mediaRefs: [{ usage: 'question_audio', assetId: 'asset_prompt_existing' }],
      },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{
          id: 'opt_1',
          value: 'Option one',
          label: 'Option one',
          mediaRefs: [{ usage: 'option_audio', assetId: 'asset_option_existing' }],
        }],
      },
    }],
  });

  const promptResult = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  const optionResult = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });

  assert.equal(promptResult.ok, false);
  assert.equal(optionResult.ok, false);
  assert.equal(promptResult.error.message.includes('Bridge returned invalid audio data.'), true);
  assert.equal(optionResult.error.message.includes('Bridge returned invalid audio data.'), true);
  assert.equal(session.findBlock('q1').prompt.mediaRefs[0].assetId, 'asset_prompt_existing');
  assert.equal(
    mod.normalizeBlocks(session.state.draft.blocks)[0].responseConfig.options[0].mediaRefs[0].assetId,
    'asset_option_existing'
  );
});

test('prompt/option replay T2A guards duplicate in-flight requests per target', async () => {
  const mod = await loadEditorModule();
  let resolvePrompt;
  let resolveOption;
  const promptPending = new Promise((resolve) => { resolvePrompt = resolve; });
  const optionPending = new Promise((resolve) => { resolveOption = resolve; });
  const apiCalls = [];
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async (text) => {
        apiCalls.push(text);
        if (text === 'Prompt text') return promptPending;
        return optionPending;
      },
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Prompt text' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: 'Option text', label: 'Option text' }],
      },
    }],
  });
  session.attachQuestionMedia = async () => ({ ok: true });
  session.attachOptionAudio = async () => ({ ok: true });

  const firstPrompt = session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  const duplicatePrompt = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  assert.equal(duplicatePrompt.ok, false);
  assert.equal(duplicatePrompt.status, 'already_in_flight');
  resolvePrompt({ ok: true, data: new Uint8Array([1]) });
  await firstPrompt;

  const firstOption = session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });
  const duplicateOption = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });
  assert.equal(duplicateOption.ok, false);
  assert.equal(duplicateOption.status, 'already_in_flight');
  resolveOption({ ok: true, data: new Uint8Array([2]) });
  await firstOption;
  assert.equal(apiCalls.length, 2);
});

test('stage3: api failure keeps existing prompt/option audio refs unchanged and emits plain-language notifications', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async () => ({ ok: false, error: { message: '' } }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: {
        text: 'Prompt for audio',
        mediaRefs: [{ usage: 'question_audio', assetId: 'asset_prompt_existing' }],
      },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{
          id: 'opt_1',
          value: 'Option one',
          label: 'Option one',
          mediaRefs: [{ usage: 'option_audio', assetId: 'asset_option_existing' }],
        }],
      },
    }],
  });
  const before = JSON.stringify(session.state.draft);

  const promptResult = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  const optionResult = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });

  assert.equal(promptResult.ok, false);
  assert.equal(optionResult.ok, false);
  assert.equal(session.findBlock('q1').prompt.mediaRefs[0].assetId, 'asset_prompt_existing');
  assert.equal(
    mod.normalizeBlocks(session.state.draft.blocks)[0].responseConfig.options[0].mediaRefs[0].assetId,
    'asset_option_existing'
  );
  assert.equal(JSON.parse(before).blocks[0].prompt.mediaRefs[0].assetId, 'asset_prompt_existing');
  assert.equal(
    session.state.notifications.some((item) => item.text === 'Audio generation failed. Existing audio is unchanged.'),
    true
  );
  assert.equal(
    session.state.notifications.filter((item) => item.text === 'Audio generation failed. Existing audio is unchanged.').length >= 2,
    true
  );
});

test('stage3: successful replay T2A attaches mp3 bytes through canonical media helpers and updates refs', async () => {
  const mod = await loadEditorModule();
  const session = new mod.EditorDraftSession(createSessionForTests(), {
    apiClient: {
      generateAudioFromText: async (text) => ({
        ok: true,
        data: new Uint8Array([7, 8, 9]),
      }),
    },
  });
  session.state.draft = mod.createDraftRecord({
    localId: 'draft_active',
    blocks: [{
      blockId: 'q1',
      kind: 'question',
      prompt: { text: 'Prompt success path' },
      responseConfig: {
        inputType: 'multiple_choice',
        options: [{ id: 'opt_1', value: 'Option success', label: 'Option success' }],
      },
    }],
  });

  const promptResult = await session.replayEditorPromptT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    target: 'question_prompt',
  });
  const optionResult = await session.replayEditorOptionT2AIntent({
    localDraftId: 'draft_active',
    blockId: 'q1',
    optionId: 'opt_1',
    target: 'option',
  });

  const block = session.findBlock('q1');
  const promptAudioRef = block.prompt.mediaRefs.find((ref) => ref.usage === 'question_audio');
  const optionAudioRef = mod.normalizeBlocks([block])[0].responseConfig.options[0].mediaRefs.find((ref) => ref.usage === 'option_audio');
  const promptAsset = session.state.draft.assets.find((asset) => asset.assetId === promptAudioRef.assetId);
  const optionAsset = session.state.draft.assets.find((asset) => asset.assetId === optionAudioRef.assetId);

  assert.equal(promptResult.ok, true);
  assert.equal(optionResult.ok, true);
  assert.equal(Boolean(promptAudioRef?.assetId), true);
  assert.equal(Boolean(optionAudioRef?.assetId), true);
  assert.equal(promptAsset.kind, 'audio');
  assert.equal(optionAsset.kind, 'audio');
  assert.equal(promptAsset.mimeType, 'audio/mpeg');
  assert.equal(optionAsset.mimeType, 'audio/mpeg');
});
