import { runDeletionFlow } from '../../app/api/deletion-flow.js';
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
    const c = vm.createContext({ runDeletionFlow, deletingDraftIds: new Set(), deletingPublishedSceneIds: new Set(), store: { projectGeneration: 0 }, t: key => key,
      openingUploadedDraft: null, serverModalRevision: 0, uploadedDraftsRequestId: 0,
      publishedScenesRequestId: 0, isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false,
      uploadedDrafts: [], uploadedDraftSlotLimit: 3, publishedScenes: [], publishedScenesFilters: {},
      publishedScenesNextOffset: null, publishedScenesHasMore: false, serverModalOverlay: { hidden: true },
      getRolePlaySceneDraftId: () => 'draft', getRolePlayScenePublishedSceneId: () => 'publication',
      showDeleteDraftConfirmation: async () => 'delete', showDeletePublishedSceneConfirmation: async () => 'delete',
      ensureServerSessionReady: async () => ({ ok: true }), syncUploadedDraftActionAvailability() {}, updateServerSessionUi() {}, showMessage() {},
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
    if (changedAt !== 'delete') finishList({ ok: true, data: { items: [] } });
    await pending;
    assert.equal(renders, changedAt === 'none' ? 1 : 0, `${published}/${changedAt}`);
  }
});

test('late slot-recovery deletion settles without closing a newer dialog or retrying upload', async () => {
  let finishDelete;
  const events = [];
  const c = vm.createContext({ runDeletionFlow, deletingDraftIds: new Set(), deletingPublishedSceneIds: new Set(), store: { projectGeneration: 0 }, t: key => key,
    openingUploadedDraft: null, serverModalRevision: 0,
    getRolePlaySceneDraftId: () => 'draft', showDeleteDraftConfirmation: async () => 'delete',
    ensureServerSessionReady: async () => ({ ok: true }), showMessage() {},
    apiClient: { deleteRolePlaySceneDraft: () => new Promise(r => { finishDelete = r; }) },
  });
  vm.runInContext(extract('async function deleteUploadedRolePlaySceneDraft(', 'if (importConfirmAccept)'), c);
  const pending = c.deleteUploadedRolePlaySceneDraft({}, {
    onDraftDeleted: () => events.push('retry'), onDeleteCanceled: () => events.push('cancel'),
  });
  await new Promise(r => setImmediate(r));
  c.serverModalRevision++;
  finishDelete({ ok: true });
  await pending;
  assert.deepEqual(events, ['cancel']);
});

for (const published of [false,true]) for (const outcome of ['preflight-stale','uncertain','refresh-failure']) {
  test(`scene ${published?'publication':'draft'} deletion: ${outcome}`,async()=>{
    let requests=0,ready;const messages=[];
    const c=vm.createContext({runDeletionFlow,store:{projectGeneration:0},deletingDraftIds:new Set(),deletingPublishedSceneIds:new Set(),
      openingUploadedDraft:null,serverModalRevision:0,t:key=>key,
      getRolePlaySceneDraftId:()=> 'one',getRolePlayScenePublishedSceneId:()=> 'one',
      showDeleteDraftConfirmation:async()=> 'delete',showDeletePublishedSceneConfirmation:async()=> 'delete',
      ensureServerSessionReady:()=>new Promise(resolve=>{ready=resolve;}),
      showMessage:m=>messages.push(m),getServerErrorMessage:result=>result.error.code,
      renderUploadedDraftManager(){},renderPublishedBrowserModal(){},
      loadUploadedRolePlaySceneDrafts:async()=>{throw Error('refresh');},loadPublishedRolePlaySceneScenes:async()=>{throw Error('refresh');},
      apiClient:{deleteRolePlaySceneDraft:async()=>{requests++;return outcome==='uncertain'?{ok:false,error:{code:'NETWORK_ERROR'}}:{ok:true};},
        deleteRolePlayScenePublishedScene:async()=>{requests++;return outcome==='uncertain'?{ok:false,error:{code:'NETWORK_ERROR'}}:{ok:true};}},
    });
    vm.runInContext(extract('async function deleteUploadedRolePlaySceneDraft(', 'if (importConfirmAccept)')
      +extract('async function deletePublishedRolePlayScene(', 'function showSlotLimitRecoveryModal('),c);
    const method=published?'deletePublishedRolePlayScene':'deleteUploadedRolePlaySceneDraft';
    const pending=c[method]({});await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await c[method]({})).deletionStatus,'busy');
    if(outcome==='preflight-stale')c.serverModalRevision++;
    ready({ok:true});const result=await pending;
    assert.equal(result.deletionStatus,outcome==='preflight-stale'?'stale':outcome==='uncertain'?'uncertain':'confirmed');
    assert.equal(requests,outcome==='preflight-stale'?0:1);
    if(outcome==='preflight-stale')assert.equal(messages.length,0);
    if(outcome==='refresh-failure')assert.ok(messages.some(m=>m.text==='apiErrors.deleteRefreshFailed'));
  });
}
