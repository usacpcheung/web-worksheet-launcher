import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openUploadedRolePlaySceneDraft(');
const end = source.indexOf('\nasync function downloadUploadedRolePlaySceneDraft', start);
function harness({ confirm = true, failure = false } = {}) {
  const events = [], original = { meta: { title: 'Existing' } };
  let current = original, progress;
  const candidate = { meta: { title: 'Published' }, scenes: [{ id: 'scene-021' }] };
  const context = vm.createContext({
    openingUploadedDraft: null, teardown: null, publishedPlay: {}, editorPreview: null, editorSession: {},
    getRolePlayScenePublishedSceneId: () => 'pub', getRolePlaySceneDraftId: () => 'draft',
    getDirectPublishedSceneIdFromLocation: () => '',
    syncUploadedDraftActionAvailability() { events.push(['state', context.openingUploadedDraft && { ...context.openingUploadedDraft }]); },
    ensureDiscussionCanBeDiscarded: async () => true, ensureServerSessionReady: async () => ({ ok: true }),
    apiClient: {
      async fetchRolePlayScenePublishedSceneArtifact(id, options) {
        events.push(['fetch', id]); progress = options.onProgress;
        progress({ loaded: 25, total: 100, lengthComputable: true });
        return failure ? { ok: false } : { ok: true, data: new Uint8Array() };
      },
      fetchRolePlaySceneDraftArtifact() { throw new Error('wrong endpoint'); },
    },
    createZipFileFromBytes: value => value, sanitizeFilename: value => value,
    prepareProjectImport: async () => ({ project: candidate, missingMediaPaths: [], validation: { warnings: [] } }),
    closeServerModal() {}, confirmProjectImport: async () => { assert.equal(current, original); return confirm; },
    discardDiscussion() {}, store: { get: () => ({ project: current }) },
    applyPreparedProjectImport: async (store, prepared) => { current = prepared.project; },
    translate: (key, args) => key === 'published.copyTitle' ? `${args.title} (copy)` : key,
    showMessage() {}, getServerErrorMessage: () => 'error', showImportError: e => { throw e; },
    revokeProjectObjectUrls: project => events.push(['revoke', project]),
    setMode: mode => events.push(['mode', mode]), updatePublishedPlayUi() {}, console,
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, events, original, candidate, current: () => current, late: () => progress({ loaded: 99, total: 100, lengthComputable: true }), run: () => context.openUploadedRolePlaySceneDraft({ title: 'Published' }, { published: true }) };
}
test('published edit copy uses read-only endpoint, progress, confirmation and independent title', async () => {
  const h = harness(); await h.run();
  assert.equal(h.current(), h.candidate);
  assert.equal(h.current().meta.title, 'Published (copy)');
  assert.equal(h.current().scenes[0].id, 'scene-021');
  assert.ok(h.events.some(([kind, value]) => kind === 'state' && value?.percent === 25));
  assert.ok(h.events.some(([kind, value]) => kind === 'state' && value?.phase === 'preparing'));
  assert.equal(h.context.openingUploadedDraft, null);
  const count = h.events.length; h.late(); assert.equal(h.events.length, count);
});
test('cancel and failed download leave the original project intact and release the lock', async () => {
  for (const options of [{ confirm: false }, { failure: true }]) {
    const h = harness(options); await h.run();
    assert.equal(h.current(), h.original);
    assert.equal(h.context.openingUploadedDraft, null);
    if (!options.failure) assert.ok(h.events.some(([kind, project]) => kind === 'revoke' && project === h.candidate));
    await h.run();
    assert.equal(h.events.filter(([kind]) => kind === 'fetch').length, 2, 'retry is unlocked');
  }
});
