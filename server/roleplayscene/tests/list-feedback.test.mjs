import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const loader = source.slice(source.indexOf('async function loadPublishedRolePlaySceneScenes('), source.indexOf('async function exitPublishedPlay('));
function harness({ open = false, ready = true, result = { ok: true, data: { items: [] } }, throws = false } = {}) {
  return new Function('ready', 'result', 'open', 'throws', `
    let isLoadingPublishedScenes=false, openingUploadedDraft=null, publishedScenesRequestId=0, serverModalRevision=0;
    let publishedScenes=['cached'], publishedScenesFilters={}, publishedScenesNextOffset=20, publishedScenesHasMore=true;
    const serverModalOverlay={hidden:!open}; const renders=[]; let reads=0;
    const syncUploadedDraftActionAvailability=()=>{}, updateServerSessionUi=()=>{}, showMessage=()=>{}, getServerErrorMessage=()=>'';
    const renderPublishedBrowserModal=()=>renders.push('list');
    const renderServerListFailure=()=>renders.push('error');
    const ensureServerSessionReady=async()=>({ok:ready,result:{ok:false,error:{code:'AUTH_REQUIRED'}}});
    const apiClient={listRolePlayScenePublishedScenes:async()=>{ reads++; if(throws)throw Error('network');return await result; }};
    ${loader}
    return {load:()=>loadPublishedRolePlaySceneScenes({showBrowser:true}), close:()=>serverModalRevision++, renders, pagination:()=>({items:publishedScenes,more:publishedScenesHasMore,next:publishedScenesNextOffset}), reads:()=>reads};
  `)(ready, result, open, throws);
}
test('initial failed checks/reads never open an empty browser; existing browsers show errors', async () => {
  for (const open of [false,true]) for (const failure of ['auth','http','throw']) {
    const h=harness({open,ready:failure!=='auth',throws:failure==='throw',result:{ok:false,error:{code:'SERVICE_BUSY'}}});
    assert.equal((await h.load()).ok,false);
    assert.deepEqual(h.renders,open?['error']:[]);
    if(failure==='auth')assert.equal(h.reads(),0);
    if(open)assert.deepEqual(h.pagination(),{items:[],more:false,next:null});
  }
});
test('only successful reads render empty results', async () => {
  const h=harness();assert.equal((await h.load()).ok,true);assert.deepEqual(h.renders,['list']);
});
test('late success and failure cannot reopen or overwrite a closed dialog', async () => {
  for(const ok of [true,false]) {
    let finish;const result=new Promise(resolve=>finish=resolve);const h=harness({open:true,result});
    const pending=h.load();await Promise.resolve();h.close();finish({ok,data:{items:[]}});
    await pending;assert.deepEqual(h.renders,[]);
  }
});
