import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./main.js',import.meta.url),'utf8');
const start=source.indexOf('  async function runPublishedSearch(');
const code=source.slice(start,source.indexOf('\n  function renderPublishedBrowserModal',start));
function harness() {
  const pending=[],messages=[];
  const c=vm.createContext({browsePublishedDialogOpen:true,browsePublishedDialogRevision:0,publishedSearchRequest:0,browsePublishedState:{items:[],title:'',subject:'',owner:'',loading:false},
    session:{state:{},readAuth:{read:async request=>({...await request(),isCurrent:()=>true})},ensureReadSessionReady:async()=>({ok:true}),apiClient:{listPublishedPackages:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}},
    t:key=>key,getApiErrorMessage:()=> 'list failure',editorNotification:key=>key,
    emitPublishedBrowseNotification:value=>messages.push(value),renderPublishedBrowserModal(){},
  });
  vm.runInContext(code,c);return {c,pending,messages};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
for(const outcome of ['success','failure','throw']) {
  test(`publication refresh ignores older ${outcome} after newer search`,async()=>{
    const {c,pending,messages}=harness();
    const old=c.runPublishedSearch();await tick();
    const newer=c.runPublishedSearch();await tick();
    pending[1].resolve({ok:true,data:{items:[{published_package_id:'new'}]}});await newer;
    const count=messages.length;
    if(outcome==='throw')pending[0].reject(Error('offline'));
    else pending[0].resolve({ok:outcome==='success',data:{items:[{published_package_id:'old'}]}});
    assert.equal((await old).status,'superseded');
    assert.equal(c.browsePublishedState.items[0].published_package_id,'new');
    assert.equal(messages.length,count);assert.equal(c.browsePublishedState.loading,false);
  });
}
test('publication refresh reports transport exceptions and clears the loading state',async()=>{
  const {c,pending}=harness();const run=c.runPublishedSearch();await tick();
  assert.equal(c.browsePublishedState.loading,true);pending[0].reject(Error('offline'));
  assert.equal((await run).ok,false);assert.equal(c.browsePublishedState.loading,false);
});
test('closed deletion context receives a superseded refresh without late notifications',async()=>{
  const {c,pending,messages}=harness();let current=true;
  const run=c.runPublishedSearch({isCurrent:()=>current});await tick();current=false;
  pending[0].resolve({ok:true,data:{items:[{}]}});
  assert.equal((await run).status,'superseded');assert.equal(messages.length,0);
  assert.equal(c.browsePublishedState.items.length,0);assert.equal(c.browsePublishedState.loading,false);
});
