import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareProjectImport, createProjectArchive, ImportErrorCode } from '../scripts/storage.js';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function loadUploadedRolePlaySceneDrafts('), source.indexOf('async function uploadCurrentProjectToServer('));
test('draft loader ignores stale success, failure and rejection without releasing a newer lock', async () => {
  for (const outcome of ['success', 'failure', 'reject', 'modal']) {
    const requests = [], events = [];
    const c = vm.createContext({
      openingUploadedDraft: null, uploadedDraftsRequestId: 0, serverModalRevision: 0,
      uploadedDrafts: [], uploadedDraftSlotLimit: 3, isLoadingUploadedDrafts: false,
      updateServerSessionUi() {}, renderUploadedDraftManager: () => events.push('render'),
      showMessage: () => events.push('error'), getServerErrorMessage: () => 'error',
      apiClient: { listRolePlaySceneDrafts: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) },
    });
    vm.runInContext(code, c);
    const old = c.loadUploadedRolePlaySceneDrafts({ preflight: false, showManager: true });
    if (outcome === 'modal') c.serverModalRevision++;
    const fresh = outcome === 'modal' ? null : c.loadUploadedRolePlaySceneDrafts({ preflight: false });
    if (outcome === 'reject') requests[0].reject(new Error('offline'));
    else requests[0].resolve({ ok: outcome !== 'failure', data: { items: ['old'] } });
    assert.equal((await old).status, 'stale_response');
    assert.deepEqual(events, []);
    assert.equal(c.uploadedDrafts.length, 0);
    assert.equal(c.isLoadingUploadedDrafts, Boolean(fresh));
    if (fresh) {
      requests[1].resolve({ ok: true, data: { items: ['new'] } });
      await fresh;
      assert.equal(c.uploadedDrafts[0], 'new');
      assert.equal(c.isLoadingUploadedDrafts, false);
    }
  }
});

test('JSON and ZIP imports reject non-string dialogue text before hydration', async () => {
  for (const text of [42, true, {}, []]) {
    const project = { meta: { title: 'Fixture' }, scenes: [{ id: 'start', type: 'start', dialogue: [{ text }] }] };
    const json = new File([JSON.stringify(project)], 'fixture.json', { type: 'application/json' });
    const { archiveData } = await createProjectArchive(project);
    const zip = new File([archiveData], 'fixture.zip', { type: 'application/zip' });
    for (const file of [json, zip]) {
      await assert.rejects(prepareProjectImport(file), error => error.code === ImportErrorCode.INVALID_PROJECT
        && error.errors.some(message => message.includes('string text')));
    }
  }
  for (const text of ['粵語 dialogue', '', null, undefined]) {
    const result = await prepareProjectImport(new File([JSON.stringify({ scenes: [{ id: 'a', dialogue: [{ text }] }] })], 'legacy.json'));
    assert.equal(result.project.scenes[0].dialogue[0].text, text ?? '');
  }
});
