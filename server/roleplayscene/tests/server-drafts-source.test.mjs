import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.ok(
  mainSource.includes('apiClient.listRolePlaySceneDrafts()'),
  'RolePlayScene should list uploaded drafts through the PR5 API client method',
);
assert.ok(
  mainSource.includes('apiClient.uploadRolePlaySceneDraftPackage(archiveData'),
  'RolePlayScene should upload the current package through the PR5 API client method',
);
assert.ok(
  mainSource.includes('apiClient.fetchRolePlaySceneDraftArtifact(uploadedDraftId)'),
  'RolePlayScene should fetch exact uploaded draft artifacts for open/download',
);
assert.ok(
  mainSource.includes('apiClient.deleteRolePlaySceneDraft(uploadedDraftId)'),
  'RolePlayScene should delete uploaded drafts through the PR5 API client method',
);

const openFunctionIndex = mainSource.indexOf('async function openUploadedRolePlaySceneDraft');
const fetchIndex = mainSource.indexOf('apiClient.fetchRolePlaySceneDraftArtifact(uploadedDraftId)', openFunctionIndex);
const prepareIndex = mainSource.indexOf('preparedImport = await prepareProjectImport', openFunctionIndex);
const confirmIndex = mainSource.indexOf('const shouldImport = await confirmProjectImport()', openFunctionIndex);
const applyIndex = mainSource.indexOf('await applyPreparedProjectImport(store, preparedImport)', openFunctionIndex);
const revokeIndex = mainSource.indexOf('revokeProjectObjectUrls(preparedImport.project)', openFunctionIndex);

assert.ok(openFunctionIndex > -1, 'uploaded draft open flow should exist');
assert.ok(fetchIndex > openFunctionIndex, 'uploaded draft open flow should fetch the ZIP before import preparation');
assert.ok(prepareIndex > fetchIndex, 'uploaded draft open flow should prepare the ZIP before confirmation');
assert.ok(confirmIndex > prepareIndex, 'uploaded draft open flow should confirm before replacing the local project');
assert.ok(applyIndex > confirmIndex, 'uploaded draft open flow should apply only after confirmation');
assert.ok(revokeIndex > confirmIndex, 'cancelled uploaded draft opens should revoke candidate object URLs');

assert.ok(
  mainSource.includes("code === 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT'")
    && mainSource.includes("conflictAction: choice"),
  'upload conflict flow should expose replace/copy and retry with conflictAction',
);
assert.ok(
  mainSource.includes("code === 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED'")
    && mainSource.includes('result.error?.details?.uploadedDrafts'),
  'slot-limit flow should use the server-provided uploaded draft list',
);
assert.ok(
  mainSource.includes('missing_media_count')
    && mainSource.includes('validation_warning_count')
    && mainSource.includes('publish_state')
    && mainSource.includes('artifact_size_bytes'),
  'uploaded draft manager should surface server metadata and warnings',
);
assert.ok(
  indexSource.includes('id="server-status"')
    && indexSource.includes('id="server-save-btn"')
    && indexSource.includes('id="server-manage-btn"')
    && indexSource.includes('id="server-modal-overlay"'),
  'server status/actions and manager modal should be present in the static markup',
);

console.log('server draft source tests passed');
