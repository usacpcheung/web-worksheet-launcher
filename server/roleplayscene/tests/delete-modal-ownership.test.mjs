import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('deletion refresh preserves newer dialogs before and during refresh, but restores an owned manager', async () => {
  for (const published of [false, true]) for (const changedAt of ['none', 'delete', 'refresh']) {
    let finishDelete, finishList;
    let renders = 0;
    const c = vm.createContext({
      openingUploadedDraft: null, serverModalRevision: 0, uploadedDraftsRequestId: 0,
      publishedScenesRequestId: 0, isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false,
      uploadedDrafts: [], uploadedDraftSlotLimit: 3, publishedScenes: [], publishedScenesFilters: {},
      publishedScenesNextOffset: null, publishedScenesHasMore: false, serverModalOverlay: { hidden: true },
      getRolePlaySceneDraftId: () => 'draft', getRolePlayScenePublishedSceneId: () => 'publication',
      showDeleteDraftConfirmation: async () => 'delete', showDeletePublishedSceneConfirmation: async () => 'delete',
      ensureServerSessionReady: async () => ({ ok: true }), updateServerSessionUi() {}, showMessage() {},
      renderUploadedDraftManager() { renders++; }, renderPublishedBrowserModal() { renders++; },
      apiClient: {
        deleteRolePlaySceneDraft: () => new Promise(r => { finishDelete = r; }),
        deleteRolePlayScenePublishedScene: () => new Promise(r => { finishDelete = r; }),
        listRolePlaySceneDrafts: () => new Promise(r => { finishList = r; }),
        listRolePlayScenePublishedScenes: () => new Promise(r => { finishList = r; }),
      },
    });
    vm.runInContext(
      extract('async function loadUploadedRolePlaySceneDrafts(', 'async function uploadCurrentProjectToServer(')
      + extract('async function loadPublishedRolePlaySceneScenes(', 'async function exitPublishedPlay(')
      + extract('async function deleteUploadedRolePlaySceneDraft(', 'if (importConfirmAccept)')
      + extract('async function deletePublishedRolePlayScene(', 'function showSlotLimitRecoveryModal('), c);
    const pending = published ? c.deletePublishedRolePlayScene({}) : c.deleteUploadedRolePlaySceneDraft({});
    await new Promise(r => setImmediate(r));
    if (changedAt === 'delete') c.serverModalRevision++;
    finishDelete({ ok: true });
    await new Promise(r => setImmediate(r));
    if (changedAt === 'refresh') c.serverModalRevision++;
    finishList({ ok: true, data: { items: [] } });
    await pending;
    assert.equal(renders, changedAt === 'none' ? 1 : 0, `${published}/${changedAt}`);
  }
});
