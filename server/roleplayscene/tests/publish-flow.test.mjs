import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function publishUploadedRolePlaySceneDraft(draft) {');
const end = source.indexOf('\nasync function openUploadedRolePlaySceneDraft', start);
const draft = { id: 'A', title: 'Clinic', description: 'Original' };
const metadata = { title: 'Clinic', description: 'Edited' };
const success = { ok: true, data: { roleplayscene_published_scene_id: 'p1' } };
const conflict = { ok: false, error: { code: 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT' } };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const state = { dialogs: [], requests: [], managers: 0, conflicts: 0 };
  const context = vm.createContext({
    openingUploadedDraft: null, isPublishingDraftFlow: false,
    publishingDraftIds: new Set(), activeServerModal: null,
    getRolePlaySceneDraftId: draft => draft.id,
    translate: key => key, showMessage() {}, getServerErrorMessage: () => 'error',
    syncUploadedDraftActionAvailability() {},
    renderUploadedDraftManager() { state.managers++; context.activeServerModal = {}; },
    async showPublishDraftModal(draft, title, description) {
      state.dialogs.push({ title, description });
      return metadata;
    },
    async showPublishConflictModal() { state.conflicts++; return null; },
    async ensureServerSessionReady() { return { ok: true }; },
    async loadUploadedRolePlaySceneDrafts(options) { assert.equal(options.showManager, undefined); },
    apiClient: { async publishRolePlaySceneFromUploadedDraft(id, data) {
      state.requests.push({ id, ...data }); return success;
    } },
    ...overrides,
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, state, run: value => context.publishUploadedRolePlaySceneDraft(value || draft) };
}

test('publish flow reserves before the first dialog and releases on cancel', async () => {
  const dialog = deferred(); let calls = 0;
  const h = harness({ showPublishDraftModal() { calls++; return dialog.promise; } });
  const first = h.run();
  await h.run({ ...draft, id: 'B' });
  assert.equal(calls, 1);
  assert.equal(h.context.isPublishingDraftFlow, true);
  dialog.resolve(null); await first;
  assert.equal(h.context.isPublishingDraftFlow, false);
  assert.equal(h.state.requests.length, 0);
  await h.run(); assert.equal(calls, 2);
});

test('closing or replacing the manager does not unlock pending publishing or steal another modal', async () => {
  for (const replacement of [null, { name: 'other dialog' }]) {
    for (const response of [success, conflict]) {
      const request = deferred();
      const h = harness({ apiClient: { publishRolePlaySceneFromUploadedDraft: () => request.promise } });
      const first = h.run(); await tick();
      h.context.activeServerModal = replacement;
      await h.run({ ...draft, id: 'B' });
      assert.equal(h.state.dialogs.length, 1);
      assert.equal(h.context.isPublishingDraftFlow, true);
      request.resolve(response); await first;
      assert.equal(h.context.activeServerModal, replacement);
      assert.equal(h.state.managers, 1);
      assert.equal(h.state.conflicts, 0);
      assert.equal(h.context.isPublishingDraftFlow, false);
    }
  }
});

test('conflict rename retains metadata and keeps guard through conflict and retry dialogs', async () => {
  const choice = deferred(); const retryDialog = deferred(); let dialogs = 0;
  const h = harness({
    async showPublishDraftModal(draft, title, description) {
      dialogs++;
      if (dialogs === 1) return { title: 'Taken', description: '' };
      assert.equal(title, 'Taken'); assert.equal(description, '');
      return retryDialog.promise;
    },
    showPublishConflictModal: () => choice.promise,
    apiClient: { async publishRolePlaySceneFromUploadedDraft(id, data) {
      h.state.requests.push({ id, ...data }); return h.state.requests.length === 1 ? conflict : success;
    } },
  });
  const first = h.run(); await tick();
  await h.run({ ...draft, id: 'B' }); assert.equal(dialogs, 1);
  choice.resolve('edit'); await tick();
  await h.run({ ...draft, id: 'B' }); assert.equal(dialogs, 2);
  retryDialog.resolve({ title: 'Renamed', description: 'Retained' }); await first;
  assert.deepEqual(h.state.requests[1], { id: 'A', title: 'Renamed', description: 'Retained' });
  assert.equal(h.context.isPublishingDraftFlow, false);
});

test('canceling conflict or rename releases the guard without publishing again', async () => {
  for (const choice of [null, 'edit']) {
    let dialogs = 0;
    const h = harness({
      async showPublishDraftModal() { return ++dialogs === 1 ? metadata : null; },
      async showPublishConflictModal() { return choice; },
      apiClient: { async publishRolePlaySceneFromUploadedDraft() { return conflict; } },
    });
    await h.run();
    assert.equal(h.context.isPublishingDraftFlow, false);
    assert.equal(h.context.publishingDraftIds.size, 0);
    assert.equal(dialogs, choice === 'edit' ? 2 : 1);
  }
});

test('manager ownership is checked again after the success refresh finishes', async () => {
  const refresh = deferred();
  const h = harness({ loadUploadedRolePlaySceneDrafts: () => refresh.promise });
  const first = h.run(); await tick();
  const other = {}; h.context.activeServerModal = other;
  assert.equal(h.context.isPublishingDraftFlow, true);
  refresh.resolve(); await first;
  assert.equal(h.context.activeServerModal, other);
  assert.equal(h.state.managers, 1);
});

test('session failure, request failure, and refresh failure all release the guard', async () => {
  for (const overrides of [
    { async ensureServerSessionReady() { return { ok: false }; } },
    { apiClient: { async publishRolePlaySceneFromUploadedDraft() { throw Error('offline'); } } },
    { apiClient: { async publishRolePlaySceneFromUploadedDraft() { return { ok: false }; } } },
    { async loadUploadedRolePlaySceneDrafts() { throw Error('refresh failed'); } },
  ]) {
    const h = harness(overrides);
    if (overrides.loadUploadedRolePlaySceneDrafts) await assert.rejects(h.run(), /refresh failed/);
    else await h.run();
    assert.equal(h.context.isPublishingDraftFlow, false);
    assert.equal(h.context.publishingDraftIds.size, 0);
  }
});
