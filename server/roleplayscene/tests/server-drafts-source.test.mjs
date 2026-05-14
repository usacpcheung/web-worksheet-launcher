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
assert.ok(
  mainSource.includes('apiClient.publishRolePlaySceneFromUploadedDraft(uploadedDraftId')
    && mainSource.includes('function showPublishDraftModal')
    && mainSource.includes("code === 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT'")
    && mainSource.includes('showPublishConflictModal(result)')
    && mainSource.includes('await loadUploadedRolePlaySceneDrafts({ preflight: false, showManager: true })'),
  'RolePlayScene should publish uploaded drafts, expose edit-title conflict recovery, and refresh draft markers',
);

const openFunctionIndex = mainSource.indexOf('async function openUploadedRolePlaySceneDraft');
const fetchIndex = mainSource.indexOf('apiClient.fetchRolePlaySceneDraftArtifact(uploadedDraftId)', openFunctionIndex);
const prepareIndex = mainSource.indexOf('preparedImport = await prepareProjectImport', openFunctionIndex);
const confirmIndex = mainSource.indexOf('const shouldImport = await confirmProjectImport()', openFunctionIndex);
const closeModalBeforeConfirmIndex = mainSource.indexOf("closeServerModal('import-confirm')", openFunctionIndex);
const applyIndex = mainSource.indexOf('await applyPreparedProjectImport(store, preparedImport)', openFunctionIndex);
const revokeIndex = mainSource.indexOf('revokeProjectObjectUrls(preparedImport.project)', openFunctionIndex);

assert.ok(openFunctionIndex > -1, 'uploaded draft open flow should exist');
assert.ok(fetchIndex > openFunctionIndex, 'uploaded draft open flow should fetch the ZIP before import preparation');
assert.ok(prepareIndex > fetchIndex, 'uploaded draft open flow should prepare the ZIP before confirmation');
assert.ok(closeModalBeforeConfirmIndex > prepareIndex && closeModalBeforeConfirmIndex < confirmIndex, 'uploaded draft open flow should close the server modal before import confirmation');
assert.ok(confirmIndex > prepareIndex, 'uploaded draft open flow should confirm before replacing the local project');
assert.ok(applyIndex > confirmIndex, 'uploaded draft open flow should apply only after confirmation');
assert.ok(revokeIndex > confirmIndex, 'cancelled uploaded draft opens should revoke candidate object URLs');

assert.ok(
  mainSource.includes("code === 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT'")
    && mainSource.includes("conflictAction: choice")
    && mainSource.includes('return await uploadCurrentProjectToServer({ conflictAction: choice, preflight: false });'),
  'upload conflict flow should expose replace/copy and retry with conflictAction',
);
assert.ok(
  mainSource.includes("code === 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED'")
    && mainSource.includes('result.error?.details?.uploadedDrafts')
    && mainSource.includes('showSlotLimitRecoveryModal({ drafts: uploadedDrafts, slotLimit: uploadedDraftSlotLimit })')
    && mainSource.includes('return await uploadCurrentProjectToServer({ conflictAction, preflight: false });'),
  'slot-limit flow should use the server-provided draft list and retry with the preserved conflict action after deletion',
);
assert.ok(
  mainSource.includes('function showSlotLimitRecoveryModal')
    && mainSource.includes('onDraftDeleted: () =>')
    && mainSource.includes("closeServerModal('slot-recovery-delete')")
    && mainSource.includes('settle({ deleted: true })')
    && mainSource.includes('recoveryMode: true'),
  'slot-limit recovery should resolve when the user deletes a draft and render recovery-specific UI',
);
assert.ok(
  mainSource.includes("translate('server.slotRecoveryTitle')")
    && mainSource.includes("translate('server.slotRecoveryDescription')")
    && mainSource.includes("translate(recoveryMode ? 'server.cancelUpload' : 'server.close')"),
  'slot-limit recovery modal should clearly explain that deleting a draft frees a slot and continues upload',
);
assert.ok(
  mainSource.includes('missing_media_count')
    && mainSource.includes('validation_warning_count')
    && mainSource.includes('publish_state')
    && mainSource.includes('artifact_size_bytes')
    && mainSource.includes("translate('server.meta.missingMedia')")
    && mainSource.includes("translate('server.meta.validationWarnings')"),
  'uploaded draft manager should surface server metadata and warnings',
);
assert.ok(
  mainSource.includes("publishState !== 'current_version_published'")
    && mainSource.includes("translate('server.publishDraft')")
    && mainSource.includes("translate('server.publishNewVersion')")
    && mainSource.includes('publishUploadedRolePlaySceneDraft(draft)'),
  'uploaded draft manager should show publish actions only for draft-only and unpublished-changes rows',
);
assert.ok(
  mainSource.includes('function handleServerModalKeydown(event)')
    && mainSource.includes("event.key === 'Escape'")
    && mainSource.includes("event.key !== 'Tab'")
    && mainSource.includes('current?.previousFocus?.isConnected'),
  'server modal should support Escape, focus trapping, and focus restoration',
);
assert.ok(
  indexSource.includes('id="server-status" class="server-status" aria-live="polite"')
    && !indexSource.includes('class="toolbar__server" aria-live=')
    && indexSource.includes('id="server-save-btn"')
    && indexSource.includes('id="server-manage-btn"')
    && indexSource.includes('id="server-modal-overlay"')
    && indexSource.includes('tabindex="-1"'),
  'server status/actions and manager modal should be present in the static markup',
);

console.log('server draft source tests passed');
