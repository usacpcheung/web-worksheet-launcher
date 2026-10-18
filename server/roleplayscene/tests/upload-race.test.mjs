import { runDeletionFlow } from '../../app/api/deletion-flow.js';
import { runUploadRecoveryFlow } from '../../app/api/upload-recovery-flow.js';
import { getApiErrorMessage } from '../../app/api/error-presentation.js';
import { UploadOperationSlot, staleUploadResult, canceledUploadResult } from '../../app/api/upload-operation-lifecycle.js';
import { classifyUploadResult } from '../../app/api/upload-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { serializeProject } from '../scripts/storage.js';
import { createProject } from '../scripts/model.js';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function uploadCurrentProjectToServer('), source.indexOf('async function publishUploadedRolePlaySceneDraft('));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('manager refresh cannot reopen closed recovery or replace a newer modal', async () => {
  for (const state of ['closed', 'replaced', 'current']) {
    const response = deferred();
    const c = vm.createContext({ runDeletionFlow, deletingDraftIds: new Set(), deletingPublishedSceneIds: new Set(), store: { projectGeneration: 0 }, t: key => key, serverModalRevision: 0,
      uploadedDrafts: [], uploadedDraftSlotLimit: 3, openingUploadedDraft: null,
      activeServerModal: null, translate: key => key,
      loadUploadedRolePlaySceneDrafts: () => response.promise,
    });
    c.closeServerModal = reason => {
      const previous = c.activeServerModal;
      c.activeServerModal = null;
      previous?.onClose?.(reason);
    };
    c.openServerModal = options => {
      c.closeServerModal(options.replacementReason || 'replace');
      c.activeServerModal = options;
    };
    vm.runInContext(extract('function renderUploadedDraftManager(', 'function getRolePlayScenePublishedSceneId(')
      + extract('function showSlotLimitRecoveryModal(', 'async function loadUploadedRolePlaySceneDrafts('), c);
    const recovery = c.showSlotLimitRecoveryModal();
    const original = c.activeServerModal;
    const refresh = original.actions[0].onClick();
    if (state === 'closed') c.closeServerModal('close');
    if (state === 'replaced') c.openServerModal({ title: 'New dialog' });
    const expected = c.activeServerModal;
    response.resolve({ ok: true });
    await refresh;
    if (state === 'current') {
      assert.notEqual(c.activeServerModal, original);
      assert.equal(c.activeServerModal.title, 'server.slotRecoveryTitle');
      c.closeServerModal('close');
    } else assert.equal(c.activeServerModal, expected, state);
    assert.equal((await recovery).deleted, false);
  }
});

test('real slot recovery settles cancellation/failure and retries only after successful deletion', async () => {
  for (const outcome of ['cancel', 'session', 'server', 'network', 'success', 'replace', 'close']) {
    const h = harness(); let modal, uploads = 0;
    vm.runInContext(extract('function showSlotLimitRecoveryModal(', 'async function loadUploadedRolePlaySceneDrafts(')
      + extract('async function deleteUploadedRolePlaySceneDraft(', 'if (importConfirmAccept)'), h.context);
    h.context.renderUploadedDraftManager = options => { modal = options; };
    h.context.closeServerModal = reason => modal.onClose(reason);
    h.context.getRolePlaySceneDraftId = () => 'draft';
    h.context.showDeleteDraftConfirmation = async (_draft, options) => {
      modal.onClose(options.replacementReason);
      return outcome === 'cancel' ? null : 'delete';
    };
    h.context.apiClient.uploadRolePlaySceneDraftPackage = async () => ++uploads === 1
      ? { ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED' } }
      : { ok: true, data: {} };
    h.context.apiClient.deleteRolePlaySceneDraft = async () => {
      if (outcome === 'network') throw new Error('offline');
      return { ok: outcome !== 'server' };
    };
    h.preflight.resolve({ ok: true }); h.archive.resolve();
    const pending = h.context.uploadCurrentProjectToServer();
    await new Promise(resolve => setTimeout(resolve, 0));
    // A legitimate manager refresh must not cancel recovery.
    modal.onClose('slot-recovery-refresh');
    assert.equal(h.context.isUploadingDraft, true);
    if (outcome === 'replace' || outcome === 'close') modal.onClose(outcome);
    else {
      if (outcome === 'session') h.context.ensureServerSessionReady = async () => ({ ok: false });
      await h.context.deleteUploadedRolePlaySceneDraft({}, modal);
    }
    await pending;
    assert.equal(h.context.isUploadingDraft, false, outcome);
    assert.equal(uploads, outcome === 'success' ? 2 : 1, outcome);
  }
});
function harness() {
  const calls = [], preflight = deferred(), archive = deferred();
  let project = createProject({ meta: { title: 'A' } });
  const context = vm.createContext({ runDeletionFlow, deletingDraftIds: new Set(), deletingPublishedSceneIds: new Set(), t: key => key, runUploadRecoveryFlow, getApiErrorMessage, classifyUploadResult, staleUploadResult, canceledUploadResult, uploadOperations: new UploadOperationSlot(), AbortController, uploadController: null, serverModalRevision: 0,
    console, serializeProject, isUploadingDraft: false, openingUploadedDraft: null,
    store: { get: () => ({ project }) },
    ensureServerSessionReady: () => preflight.promise,
    createProjectArchive: async snapshot => { await archive.promise; return { archiveData: snapshot, payload: { manifest: { project: { title: snapshot.meta.title } } } }; },
    apiClient: { uploadRolePlaySceneDraftPackage: async (bytes, metadata) => { calls.push({ bytes, metadata }); return { ok: true, data: {} }; } },
    updateServerSessionUi() {}, syncServerSessionFromApiResult() {}, showMessage() {}, getUploadWarnings: () => [],
    loadUploadedRolePlaySceneDrafts: async () => {}, getServerErrorMessage: () => 'failed',
    uploadedDrafts: [], uploadedDraftSlotLimit: 5,
  });
  vm.runInContext(code, context);
  return { context, calls, preflight, archive, change: () => { project.meta.title = 'B'; } };
}

test('save reserves preflight and snapshots metadata before any await', async () => {
  const h = harness(), first = h.context.uploadCurrentProjectToServer();
  assert.equal((await h.context.uploadCurrentProjectToServer()).skipped, true);
  h.change(); h.preflight.resolve({ ok: true }); h.archive.resolve();
  await first;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bytes.meta.title, 'A');
  assert.equal(h.calls[0].metadata.title, 'A');
  assert.equal(h.context.isUploadingDraft, false);
});

test('copy/replace and slot recovery keep one snapshot and lock through retries', async () => {
  for (const choice of ['copy', 'replace']) {
    const h = harness(); let count = 0;
    h.context.apiClient.uploadRolePlaySceneDraftPackage = async (bytes, metadata) => {
      h.calls.push({ bytes, metadata }); count++;
      if (count === 1 || count === 4) return { ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT' } };
      if (count === 2 || count === 3) return { ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED', details: { uploadedDrafts: ['existing'], slotLimit: 3 } } };
      return { ok: true, data: {} };
    };
    h.context.showUploadConflictModal = async () => {
      h.change(); assert.equal((await h.context.uploadCurrentProjectToServer()).skipped, true); return choice;
    };
    h.context.showSlotLimitRecoveryModal = async () => {
      assert.equal((await h.context.uploadCurrentProjectToServer()).skipped, true); return { deleted: true };
    };
    h.preflight.resolve({ ok: true }); h.archive.resolve();
    await h.context.uploadCurrentProjectToServer();
    assert.deepEqual(h.calls.map(c => c.metadata.conflictAction), ['', choice, choice, choice, choice]);
    assert.ok(h.calls.every(c => c.bytes === h.calls[0].bytes && c.metadata.title === 'A'));
    assert.equal(h.context.isUploadingDraft, false);
  }
});

test('preflight failure, network rejection and conflict cancellation release the save lock', async () => {
  for (const failure of ['session', 'network', 'cancel']) {
    const h = harness();
    h.preflight.resolve({ ok: failure !== 'session', result: { ok: false } }); h.archive.resolve();
    if (failure === 'network') h.context.apiClient.uploadRolePlaySceneDraftPackage = async () => { throw new Error('offline'); };
    if (failure === 'cancel') {
      h.context.apiClient.uploadRolePlaySceneDraftPackage = async () => ({ ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT' } });
      h.context.showUploadConflictModal = async () => null;
    }
    await h.context.uploadCurrentProjectToServer();
    assert.equal(h.context.isUploadingDraft, false);
  }
});

test('cancel also reaches the post-upload list refresh and preserves the saved result', async () => {
  const h = harness(); let entered;
  const refreshing = new Promise(resolve => { entered = resolve; });
  h.context.loadUploadedRolePlaySceneDrafts = ({ signal }) => new Promise(resolve => {
    entered(); signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'ABORTED' } }), { once: true });
  });
  h.preflight.resolve({ ok: true }); h.archive.resolve();
  const upload = h.context.uploadCurrentProjectToServer();
  await refreshing; h.context.uploadController.abort();
  assert.equal((await upload).ok, true);
  assert.equal(h.context.isUploadingDraft, false);
  assert.equal(h.context.uploadController, null);
});

for (const code of ['AUTH_REQUIRED', 'NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'ABORTED', 'UNKNOWN']) {
  test(`shared classification preserves RolePlayScene ${code} without retrying`, async () => {
    const h = harness();
    let posts = 0, observed;
    const result = { ok: false, operationId: 'keep-operation', error: { code, message: 'Original server feedback' } };
    h.context.apiClient.uploadRolePlaySceneDraftPackage = async () => { posts++; return result; };
    h.context.getServerErrorMessage = value => { observed = value; return value.error.message; };
    h.preflight.resolve({ ok: true }); h.archive.resolve();
    assert.equal(await h.context.uploadCurrentProjectToServer(), result);
    assert.equal(observed, result);
    assert.equal(posts, 1);
    assert.equal(h.context.isUploadingDraft, false);
    assert.equal(h.context.uploadController, null);
  });
}

for (const action of ['cancel', 'switch']) test(`scene ${action} during archive creation never sends the old upload`, async () => {
  const h = harness(); h.preflight.resolve({ ok: true });
  const upload = h.context.uploadCurrentProjectToServer();
  await new Promise(resolve => setTimeout(resolve, 0));
  if (action === 'cancel') h.context.uploadController.abort();
  else h.context.store.projectGeneration = 1;
  h.archive.resolve();
  const result = await upload;
  assert.equal(h.calls.length, 0);
  assert.equal(action === 'cancel' ? result.error.code : result.status, action === 'cancel' ? 'ABORTED' : 'stale_upload');
  assert.equal(h.context.isUploadingDraft, false);
});

test('closing an old conflict dialog cannot publish cancellation on a replacement project', async () => {
  const h = harness();
  const messages = [];
  h.context.showMessage = message => messages.push(message.textId);
  h.context.apiClient.uploadRolePlaySceneDraftPackage = async () => ({ ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT' } });
  h.context.showUploadConflictModal = async () => {
    h.context.store.projectGeneration = 1;
    messages.length = 0;
    return null;
  };
  h.preflight.resolve({ ok: true }); h.archive.resolve();
  assert.equal((await h.context.uploadCurrentProjectToServer()).status, 'stale_upload');
  assert.deepEqual(messages, []);
  assert.equal(h.context.isUploadingDraft, false);
});
