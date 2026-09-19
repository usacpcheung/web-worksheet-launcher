import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadPublishedRolePlaySceneScenes(');
const end = source.indexOf('\nasync function exitPublishedPlay', start);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const response = deferred();
  const events = [];
  const context = vm.createContext({
    openingUploadedDraft: null, isLoadingPublishedScenes: false, publishedScenesRequestId: 0,
    publishedScenes: [], publishedScenesFilters: {}, publishedScenesNextOffset: 0, publishedScenesHasMore: false,
    serverModalOverlay: { hidden: false }, updateServerSessionUi() { events.push('ui'); },
    renderPublishedBrowserModal() { events.push('render'); },
    ensureServerSessionReady: async () => ({ ok: true }),
    apiClient: { listRolePlayScenePublishedScenes() { events.push('fetch'); return response.promise; } },
    showMessage() { events.push('error'); }, getServerErrorMessage: () => 'error',
  });
  vm.runInContext(source.slice(start, end), context);
  // Execute the production open-flow prefix up to its first UI update.
  const openStart = source.indexOf('async function openUploadedRolePlaySceneDraft(');
  const prefixEnd = source.indexOf('  syncUploadedDraftActionAvailability();', openStart);
  context.getRolePlayScenePublishedSceneId = () => 'publication';
  context.getRolePlaySceneDraftId = () => 'draft';
  vm.runInContext(source.slice(openStart, prefixEnd) + '\n}', context);
  return { context, response, events, load: options => context.loadPublishedRolePlaySceneScenes({ preflight: false, showBrowser: true, ...options }) };
}
test('late list success/failure cannot render or overwrite messages after copy starts or finishes', async () => {
  for (const finished of [false, true]) for (const ok of [false, true]) {
    const h = harness();
    const pending = h.load();
    await h.context.openUploadedRolePlaySceneDraft({}, { published: true });
    if (finished) h.context.openingUploadedDraft = null;
    h.context.serverModalOverlay.hidden = true;
    h.events.length = 0;
    h.response.resolve({ ok, data: { items: ['stale'] } });
    const result = await pending;
    assert.equal(result.status, 'stale_response');
    assert.deepEqual(h.events, []);
    assert.equal(h.context.publishedScenes.length, 0);
    assert.equal(h.context.isLoadingPublishedScenes, false);
  }
});
test('copy lock blocks new requests and releases for a normal refresh', async () => {
  const h = harness();
  await h.context.openUploadedRolePlaySceneDraft({}, { published: true });
  assert.equal((await h.load()).skipped, true);
  assert.deepEqual(h.events, []);
  h.context.openingUploadedDraft = null;
  const pending = h.load();
  h.response.resolve({ ok: true, data: { items: ['fresh'] } });
  await pending;
  assert.equal(h.context.publishedScenes[0], 'fresh');
  assert.equal(h.context.isLoadingPublishedScenes, false);
});
test('stale completion cannot release a newer list request lock', async () => {
  const h = harness();
  const old = h.load();
  await h.context.openUploadedRolePlaySceneDraft({}, { published: true });
  h.context.openingUploadedDraft = null;
  const fresh = deferred();
  h.context.apiClient.listRolePlayScenePublishedScenes = () => fresh.promise;
  const latest = h.load();
  h.response.resolve({ ok: true, data: { items: ['old'] } });
  await old;
  assert.equal(h.context.isLoadingPublishedScenes, true);
  assert.equal(h.context.publishedScenes.length, 0);
  fresh.resolve({ ok: true, data: { items: ['new'] } });
  await latest;
  assert.equal(h.context.publishedScenes[0], 'new');
  assert.equal(h.context.isLoadingPublishedScenes, false);
});
