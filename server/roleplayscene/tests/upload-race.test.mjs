import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { serializeProject } from '../scripts/storage.js';
import { createProject } from '../scripts/model.js';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function uploadCurrentProjectToServer('), source.indexOf('async function publishUploadedRolePlaySceneDraft('));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness() {
  const calls = [], preflight = deferred(), archive = deferred();
  let project = createProject({ meta: { title: 'A' } });
  const context = vm.createContext({
    console, serializeProject, isUploadingDraft: false, openingUploadedDraft: null,
    store: { get: () => ({ project }) },
    ensureServerSessionReady: () => preflight.promise,
    createProjectArchive: async snapshot => { await archive.promise; return { archiveData: snapshot, payload: { manifest: { project: { title: snapshot.meta.title } } } }; },
    apiClient: { uploadRolePlaySceneDraftPackage: async (bytes, metadata) => { calls.push({ bytes, metadata }); return { ok: true, data: {} }; } },
    updateServerSessionUi() {}, showMessage() {}, getUploadWarnings: () => [],
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
      if (count === 1) return { ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT' } };
      if (count === 2) return { ok: false, error: { code: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED', details: { uploadedDrafts: ['existing'], slotLimit: 3 } } };
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
    assert.deepEqual(h.calls.map(c => c.metadata.conflictAction), ['', choice, choice]);
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
