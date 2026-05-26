import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../styles/app.css', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../scripts/editor/editor.js', import.meta.url), 'utf8');
const inspectorSource = await readFile(new URL('../scripts/editor/inspector.js', import.meta.url), 'utf8');
const scenePreviewSource = await readFile(new URL('../scripts/editor/scene-preview.js', import.meta.url), 'utf8');
const speechBubbleInspectorSource = await readFile(new URL('../scripts/editor/speech-bubble-inspector.js', import.meta.url), 'utf8');
const playerSource = await readFile(new URL('../scripts/player/player.js', import.meta.url), 'utf8');
const publishedOpenFunctionIndex = mainSource.indexOf('async function openPublishedRolePlaySceneById');
const publishedOpenFunctionEndIndex = mainSource.indexOf('async function downloadPublishedRolePlayScene', publishedOpenFunctionIndex);
const publishedOpenSource = mainSource.slice(publishedOpenFunctionIndex, publishedOpenFunctionEndIndex);
const dialogueT2AFunctionIndex = editorSource.indexOf('async function generateDialogueAudio');
const dialogueT2AFunctionEndIndex = editorSource.indexOf('function addChoice', dialogueT2AFunctionIndex);
const dialogueT2ASource = editorSource.slice(dialogueT2AFunctionIndex, dialogueT2AFunctionEndIndex);
const refreshLocaleFunctionIndex = mainSource.indexOf('function refreshLocaleUI');
const refreshLocaleFunctionEndIndex = mainSource.indexOf('function getActiveStore', refreshLocaleFunctionIndex);
const refreshLocaleSource = mainSource.slice(refreshLocaleFunctionIndex, refreshLocaleFunctionEndIndex);

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
assert.ok(
  mainSource.includes('apiClient.listRolePlayScenePublishedScenes')
    && mainSource.includes('apiClient.fetchRolePlayScenePublishedScene(publishedSceneId)')
    && mainSource.includes('apiClient.fetchRolePlayScenePublishedSceneArtifact(publishedSceneId)')
    && mainSource.includes('apiClient.deleteRolePlayScenePublishedScene(sceneId)')
    && mainSource.includes('function renderPublishedBrowserModal')
    && mainSource.includes('function openPublishedRolePlaySceneById'),
  'RolePlayScene should browse/open/download/delete published scenes through PR8 API client methods',
);
assert.ok(
  mainSource.includes("const currentUserSub = serverSession.user?.sub || ''")
    && mainSource.includes("if (currentUserSub && scene?.owner_sub === currentUserSub)")
    && mainSource.includes('function showDeletePublishedSceneConfirmation')
    && mainSource.includes('function deletePublishedRolePlayScene')
    && mainSource.includes("await loadPublishedRolePlaySceneScenes({ preflight: false, showBrowser: true })"),
  'published browser should show owner-only delete with confirmation and refresh after deletion',
);
assert.ok(
  mainSource.includes('let publishedPlay = { active: false, store: null, preparedImport: null, scene: null }')
    && mainSource.includes('const playStore = new Store()')
    && mainSource.includes('playStore.set({ project: preparedImport.project })')
    && !publishedOpenSource.includes('applyPreparedProjectImport'),
  'published scene open should use an isolated in-memory store rather than replacing the local autosaved project',
);
assert.ok(
  mainSource.includes('publishedPlay.preparedImport?.project')
    && mainSource.includes('revokeProjectObjectUrls(publishedPlay.preparedImport.project)')
    && mainSource.includes('function exitPublishedPlay')
    && indexSource.includes('id="published-exit-btn"'),
  'published play mode should revoke object URLs and provide an explicit exit action',
);
assert.ok(
  mainSource.includes("params.get('publishedSceneId')")
    && mainSource.includes("openPublishedRolePlaySceneById(directPublishedSceneId, { source: 'direct' })")
    && mainSource.includes('pendingDirectPublishedSceneId'),
  'direct publishedSceneId URLs should open published scenes and support sign-in recovery',
);
assert.ok(
  mainSource.includes('let publishedScenesRequestId = 0')
    && mainSource.includes("return { ok: false, skipped: true, status: 'already_loading' }")
    && mainSource.includes('const requestId = ++publishedScenesRequestId')
    && mainSource.includes('if (requestId !== publishedScenesRequestId)')
    && mainSource.includes('if (requestId === publishedScenesRequestId)'),
  'published browser loads should guard against duplicate in-flight requests and ignore stale responses',
);
assert.ok(
  mainSource.includes('searchButton.disabled = isLoadingPublishedScenes')
    && mainSource.includes("label: isLoadingPublishedScenes ? translate('published.refreshing') : translate('published.refresh')")
    && mainSource.includes('disabled: isLoadingPublishedScenes || !publishedScenesHasMore'),
  'published browser refresh/search/load-more controls should be disabled while loading',
);
assert.ok(
  mainSource.includes('function buildPublishedScenePlayUrl(sceneId)')
    && mainSource.includes("url.searchParams.set('publishedSceneId', sceneId)")
    && mainSource.includes("url.searchParams.delete('authReturn')")
    && mainSource.includes("const playLink = createActionLink(translate('published.playLink'), playUrl, 'confirm-actions__primary')")
    && mainSource.includes("copyTextToClipboard(playUrl)")
    && !mainSource.includes("openButton.addEventListener('click', () => openPublishedRolePlayScene(scene))"),
  'published browser should expose copyable direct play links instead of an in-modal open button',
);
assert.ok(
  mainSource.includes('publishedPlay.store.setLocale(nextLocale)')
    && mainSource.includes('return openPublishedRolePlaySceneById(sceneId, { scene })')
    && mainSource.includes('store.set({ audioGate: false })')
    && !mainSource.includes('unlockAudio')
    && !mainSource.includes('ensureAudioGate(playStore)'),
  'published play should sync locale without unlocking audio before the Begin Story gesture',
);
assert.ok(
  refreshLocaleFunctionIndex > -1
    && !refreshLocaleSource.includes('setMode(mode)')
    && /if \(!currentSceneId\) \{\s*renderIntro\(\);\s*return;\s*\}/.test(playerSource),
  'locale refresh should update labels without rebuilding the active mode, and player subscriptions should redraw intro text without resetting an active run',
);
assert.ok(
  mainSource.includes('teardown = renderEditor(getActiveStore(), elLeft, elRight, showMessage, {')
    && mainSource.includes('apiClient,')
    && mainSource.includes('ensureServerSessionReady,')
    && mainSource.includes('initialSelectedSceneId: editorSession.selectedSceneId')
    && mainSource.includes('onPreviewCurrentScene: startEditorScenePreview'),
  'RolePlayScene editor should receive server API/session hooks for protected T2A generation',
);
assert.ok(
  mainSource.includes('let editorSession = {')
    && mainSource.includes('let editorPreview = null')
    && mainSource.includes('function startEditorScenePreview')
    && mainSource.includes('ensureAudioGate(store)')
    && mainSource.includes("translate('toolbar.backToEdit')")
    && mainSource.includes('function returnFromEditorScenePreview')
    && mainSource.includes('editorPreview.returnSceneId')
    && mainSource.includes('btnPlay.hidden = inEditorPreview ? true : false')
    && playerSource.includes('options.initialSceneId')
    && playerSource.includes('beginRunAt(initialScene.id)'),
  'RolePlayScene should launch editor current-scene previews through the real player and return to saved editor context',
);
assert.ok(
  editorSource.includes('apiClient.generateAudioFromText(textState.trimmedText, preset.options || {})')
    && editorSource.includes('createAudioFileFromBytes(')
    && editorSource.includes('result.data,')
    && editorSource.includes('createRolePlaySceneT2AAudioFilename(')
    && editorSource.includes('safeSceneId, index, preset.id')
    && editorSource.includes('setDialogueAudio(sceneId, index, generatedFile)')
    && editorSource.includes("globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio'))"),
  'RolePlayScene editor should generate MP3 bytes through T2A and attach them through the existing dialogue audio path',
);
assert.ok(
  editorSource.includes('let disposed = false')
    && editorSource.includes('disposed = true')
    && editorSource.includes('function getCurrentT2ALine(sceneId, index, expectedText)')
    && editorSource.includes("showMessage({ textId: 'inspector.dialogue.t2aLineChanged' })")
    && editorSource.includes('if (!disposed) {\n        update();\n      }'),
  'RolePlayScene dialogue T2A should ignore stale async results after line changes or editor teardown',
);
assert.ok(
  editorSource.includes('let activeDialoguePreview = null')
    && editorSource.includes('function previewDialogueAudio(sceneId, index)')
    && editorSource.includes('new Audio(src)')
    && editorSource.includes('stopDialoguePreview({ refresh: false })')
    && editorSource.includes("showMessage({ textId: 'inspector.dialogue.audioPreviewFailed' })")
    && editorSource.includes('onPreviewDialogueAudio: previewDialogueAudio')
    && editorSource.includes('isDialogueAudioPreviewing: (sceneId, index)'),
  'RolePlayScene editor should manage one active edit-mode dialogue audio preview with cleanup and failure messaging',
);
assert.ok(
  editorSource.includes('stopDialoguePreview({ refresh: false });\r\n    unsubscribe();')
    || editorSource.includes('stopDialoguePreview({ refresh: false });\n    unsubscribe();'),
  'RolePlayScene editor teardown should stop active dialogue audio previews',
);
assert.ok(
  dialogueT2ASource.indexOf("globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio'))") > -1
    && dialogueT2ASource.indexOf("globalThis.confirm?.(translate('inspector.dialogue.confirmRegenerateAudio'))")
      < dialogueT2ASource.indexOf('apiClient.generateAudioFromText(textState.trimmedText, preset.options || {})')
    && dialogueT2ASource.includes("showMessage({ textId: 'inspector.dialogue.t2aCanceled' })"),
  'RolePlayScene dialogue T2A should confirm replacement before calling the bridge and cancel without generation',
);
assert.ok(
  inspectorSource.includes('ROLEPLAYSCENE_T2A_PRESETS.forEach')
    && inspectorSource.includes("actions.onGenerateDialogueAudio?.(scene.id, index, presetSelect.value)")
    && inspectorSource.includes('generateAudio.disabled = !t2aState.eligible || isGeneratingAudio')
    && inspectorSource.includes('ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH'),
  'RolePlayScene inspector should render per-line T2A preset controls with text eligibility gating',
);
assert.ok(
  inspectorSource.includes('getRolePlaySceneT2APresetFromAudioName(audioName)')
    && inspectorSource.includes("presetBadge.className = 'audio-info__badge'")
    && inspectorSource.includes("translate('inspector.dialogue.t2aPresetBadge'")
    && inspectorSource.includes('actions.isDialogueAudioPreviewing?.(scene.id, index) === true')
    && inspectorSource.includes("actions.onPreviewDialogueAudio?.(scene.id, index)")
    && inspectorSource.includes("translate('inspector.dialogue.playAudioPreview')")
    && inspectorSource.includes("translate('inspector.dialogue.stopAudioPreview')"),
  'RolePlayScene inspector should render edit-mode audio preview controls and best-effort T2A preset badges',
);

assert.ok(
  inspectorSource.includes('renderSpeechBubbleEditorSection(scene, actions)')
    && inspectorSource.includes('renderDialogueBubbleControls({ scene, line, index, anchors, actions })')
    && speechBubbleInspectorSource.includes('speech-bubble-editor')
    && speechBubbleInspectorSource.includes("translate('inspector.speechBubble.title')")
    && speechBubbleInspectorSource.includes("translate('inspector.speechBubble.scenePreviewHint')")
    && speechBubbleInspectorSource.includes('onUpdateDialogueBubble'),
  'RolePlayScene inspector should expose speech bubble authoring controls',
);

assert.ok(
  editorSource.includes("leftView = 'scenePreview'")
    && editorSource.includes("translate('editor.views.storyMap')")
    && editorSource.includes("translate('editor.views.scenePreview')")
    && editorSource.includes('renderScenePreview(leftContent, scene')
    && scenePreviewSource.includes('scene-preview__anchor-marker')
    && scenePreviewSource.includes('onAddOrMoveSpeechBubbleAnchor')
    && scenePreviewSource.includes("translate('editor.scenePreview.anchorHint')"),
  'RolePlayScene editor should place speech bubble anchors from the left Scene Preview view',
);

assert.ok(
  editorSource.includes('MAX_SPEECH_BUBBLE_ANCHORS')
    && editorSource.includes('deleteSpeechBubbleAnchor')
    && editorSource.includes("globalThis.confirm?.(translate('inspector.speechBubble.confirmDeleteUsedAnchor'")
    && editorSource.includes('bubble: { mode: BubbleMode.CENTER, anchorId: null }'),
  'RolePlayScene editor should enforce anchor limits and clear used anchor assignments after confirmation',
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
  mainSource.includes('allowPublish = true')
    && mainSource.includes("if (allowPublish && publishState !== 'current_version_published')")
    && mainSource.includes('renderUploadedDraftRows(body, drafts, { onDraftDeleted, allowPublish: !recoveryMode })'),
  'slot-limit recovery should hide publish actions so the upload recovery promise can only resolve through delete or cancel',
);
assert.ok(
  mainSource.includes("translate('server.slotRecoveryTitle')")
    && mainSource.includes("translate('server.slotRecoveryDescription')")
    && mainSource.includes("translate(recoveryMode ? 'server.cancelUpload' : 'server.close')"),
  'slot-limit recovery modal should clearly explain that deleting a draft frees a slot and continues upload',
);
assert.ok(
  mainSource.includes("const LEGACY_LOCALE_STORAGE_KEY = 'roleplayscene:locale'")
    && mainSource.includes('function migrateLegacyLocalePreference()')
    && mainSource.includes('storage.getItem(LOCALE_STORAGE_KEY)')
    && mainSource.includes('storage.removeItem?.(LEGACY_LOCALE_STORAGE_KEY)')
    && mainSource.indexOf('migrateLegacyLocalePreference();') < mainSource.indexOf('refreshLocaleUI(store.get().locale);'),
  'RolePlayScene should migrate the old standalone locale preference into the shared locale storage key before initial render',
);
assert.ok(
  mainSource.includes('missing_media_count')
    && mainSource.includes('validation_warning_count')
    && mainSource.includes('publish_state')
    && mainSource.includes('published_scene_id')
    && mainSource.includes("translate(showPublishedLive ? 'server.publishedLiveBadge' : 'server.publishedDeletedBadge')")
    && mainSource.includes('artifact_size_bytes')
    && mainSource.includes("translate('server.meta.missingMedia')")
    && mainSource.includes("translate('server.meta.validationWarnings')"),
  'uploaded draft manager should surface server metadata, warnings, and live/deleted published-copy status',
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
    && indexSource.includes('id="server-browse-published-btn"')
    && indexSource.includes('id="server-modal-overlay"')
    && indexSource.includes('tabindex="-1"'),
  'server status/actions and manager modal should be present in the static markup',
);

assert.ok(
  cssSource.indexOf('@media (max-width: 767px)') < cssSource.indexOf('.toolbar > .toolbar__server > button')
    && cssSource.includes('.toolbar > .toolbar__server > button {\n      display: none;'),
  'tablet header layout should keep direct server actions visible and hide them only on true mobile widths',
);

assert.ok(
  mainSource.includes("topbar?.classList?.add?.('topbar--server-stacked')")
    && cssSource.includes('.topbar.topbar--server-stacked > .toolbar {\n    display: contents;')
    && cssSource.includes('.toolbar.toolbar--server-stacked > .toolbar__server {\n    order: 3;\n    width: 100%;')
    && cssSource.includes('justify-content: flex-start;'),
  'mobile stacked header should keep title/mode/more on the first row and align the server badge left on the second row',
);

assert.ok(
  playerSource.includes("rightEl.classList?.add?.('pane--stage-only')")
    && playerSource.includes("introOverlay.className = 'player-intro-overlay'")
    && playerSource.includes("appendIntroUtilities(introOverlay")
    && playerSource.includes("startBtn.className = 'player-intro-begin'")
    && cssSource.includes('.player-intro-frame::after')
    && cssSource.includes('.player-intro-utilities')
    && cssSource.includes('.player-intro-cta'),
  'RolePlayScene intro should render as a theater-style stage overlay with floating utilities and centered Begin Story action',
);

assert.ok(
  indexSource.includes('class="app-messages__dismiss"')
    && indexSource.includes('<svg viewBox="0 0 24 24"')
    && cssSource.includes('.app-messages[hidden] { display: none; }')
    && mainSource.includes('function dismissMessage()')
    && mainSource.includes('lastMessagePayload = null;\n  if (!messageHost')
    && mainSource.includes("dismissButton.addEventListener('click', () => {\n    dismissMessage();"),
  'RolePlayScene message bar should use an accessible icon dismiss button that clears remembered message state',
);

assert.ok(
  inspectorSource.includes("const sceneHeading = document.createElement('h3')")
    && inspectorSource.includes('sceneHeading.textContent = scene.id')
    && inspectorSource.includes("translate('inspector.header.previewCurrentScene')")
    && inspectorSource.includes('actions.onPreviewCurrentScene?.(scene.id)')
    && !inspectorSource.includes('header.innerHTML = `<h3>${scene.id}</h3>`'),
  'RolePlayScene inspector should render imported scene IDs as text, not HTML, and expose current-scene preview',
);

assert.ok(
  editorSource.includes("inspectorHost.querySelectorAll('[data-focus-key]')")
    && editorSource.includes('element.dataset?.focusKey === focusKey')
    && !editorSource.includes('inspectorHost.querySelector(`[data-focus-key="${focusKey}"]`)'),
  'RolePlayScene editor should restore focus without interpolating imported IDs into CSS selectors',
);

console.log('server draft source tests passed');
