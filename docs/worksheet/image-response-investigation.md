# Image-response questions

Implemented on a branch stacked on PR #342 (base `27486889b134551885c6f4cf24036b9ae624173c`). This is not a VPS deployment record.

## Authoring and size budget

Choose **Image response** in the existing question answer settings. A worksheet supports at most three such questions; each allows one, two or three images (default three). The picker shows the used count and disables adding another image-response type at the cap. Configuration validators also reject excess counts on import/export. Existing incomplete-submission policy remains: there is no new required-question setting. One saved image counts as answered; these answers are manually reviewed, like text answers.

The editor displays the maximum attempt budget, using actual stored worksheet-media bytes, configured answer-image capacity, text-answer capacity, worksheet JSON and a 1 MiB package allowance. Image capacity is `sum(maxImages) × 2 MiB`. Export/upload/publish enforce the budget against the existing 30 MiB limit; saving an editable local draft remains possible. Lowering image counts or reducing worksheet media can repair an over-budget draft. The viewer also checks the exact completed ZIP size. A custom server configured below the documented default remains a deployment constraint, not a reason to silently increase its limit.

## Attaching and preparing images

Only JPEG and PNG are supported. The browser rejects originals over 10 MiB before reading bytes, checks content/MIME, header dimensions and decodability, and rejects animated PNG. Limits are 24 million pixels and 8192 pixels on either side. These conservative bounds limit decoded memory; they do not promise performance on every phone. UI uses “MB” consistently with existing application byte-based limits.

A valid image at or below 2 MiB is retained unchanged. Larger originals are prepared locally, one at a time: maximum edge 2560, then 2200, 1900 and 1600 pixels, with JPEG quality steps 0.85/0.75/0.65. PNG stays PNG to retain transparency. Proportions are preserved. Actual output bytes determine success, not an estimated compression ratio. Students review the result before **Use this image**. Cancel or failure preserves the previous answer. Errors explain the size/dimension/type limit or inability to prepare/save the image. Original files and cancelled candidates are not persisted.

There is no cloud conversion, bundled explanation field or image scoring. Authors can add a separate text question for an explanation or generation prompt.

## Viewer, preview and printing

Images occupy a full-width answer area beneath the question, following the image-MC layout. The grid uses three columns above 650px of available answer width, two down to 411px, and one at 410px or below. Images are contained rather than cropped. Click a preview or its magnifier to enlarge; Previous/Next and position controls support multiple images. Replace/Remove are available only while answering. Removal asks for confirmation.

The shared image-preview close control uses a centered SVG in the existing circular button. This also fixes the existing MC option-image preview. Escape, backdrop closing and focus restoration are retained.

Submitted attempts show read-only images. Printing includes all saved images in their answer order, without cropping, on white paper, with bounded image height and existing student/school headers. Missing/unreadable answer images block printing rather than silently produce a partial answer. Existing submitted-only printing is retained.

## Persistence and compatibility

See the authoritative [package formats](../contracts/package-formats.md) and [local models](../contracts/local-models.md). Worksheet v5 and attempt v4 distinguish the feature from older readers. New readers retain older versions; MC images, prompt media, multilingual audio and Markdown can coexist with image answers.

Accepted bytes and ordered answer references commit together in IndexedDB. Stale image edits/autosaves cannot overwrite different saved image references. Export locks image editing while collecting a snapshot. Pending attachment work blocks submission/export/server save. Ordinary text-answer synchronization is unchanged; this is not a general collaborative editing system.

Local attachment does not require authentication. Existing server save login/cancel, attempt naming, three slots, conflicts, interrupted-upload recovery and prepared-package retries are reused. There is no automatic background cloud sync. Answer images travel in the attempt ZIP, with fresh local IDs and remapped references on import. Removing/replacing owned answer images reclaims their bytes; deleting an attempt also removes its owned answer assets while retaining worksheet/shared media.

## Validation and remaining acceptance

Automated coverage includes both languages and desktop/phone widths, question limits, actual-byte budget rejection, attach/resize/cancel/remove, reload, stale-save rejection and transaction rollback, ZIP round-trip isolation, submitted review, printing, and existing MC image selection/enlargement/package paths. Node tests cover older contracts and shared behavior.

Before deployment acceptance, try a real phone camera JPEG over 2 MB and a transparent PNG, confirm readable preparation, cancel/retry, export/reopen, and save/resume through the existing server manager. Real mobile memory/performance, camera file-picker behavior and VPS network interruption are not proven by desktop Chromium fixtures. The focused PR acceptance instructions describe those remaining checks.

## Review/fix/review record

1. **Package and persistence review:** extending the previous exact MC version checks was necessary for mixed worksheets; answer assets also needed collection and ID remapping. Fixed both paths, introduced atomic image/reference writes, and verified reload/export/import plus stale-write rejection. Existing MC lifecycle tests pass.
2. **Broader lifecycle review:** deleting/replacing images during export could invalidate its snapshot; old autosaves/recovery could restore removed references. Added the export edit lock and reference comparison guards. Owned-image cleanup preserves unrelated/shared worksheet assets and separate imports. Browser rollback/cancellation/deletion checks pass.
3. **UI and budget review:** ordinary buttons inside the answer form needed `type="button"`; generic answer refresh cleared image errors; the editor's detail-render optimization left budget text stale after media changes. Fixed all three. Budgeting now consistently counts UTF-8 content bytes, including Chinese. Both languages/widths pass, and screenshots were inspected.
4. **Server boundary recheck:** worksheet v5 publishes through the actual package service; attempt v4 validates bytes before storage, accepts a valid answer, and still rejects a fourth server slot. No database schema, auth, slot or upload-retry redesign was needed.

Focused VPS acceptance after deployment: create/publish an image-response worksheet;
attach a real camera JPEG over 2 MB and a transparent PNG; inspect and cancel/accept
the prepared image; reload and export/reopen; save/resume from the server; submit and
check print preview. Also enlarge one existing MC option image and check the centered
close control and Escape. Use disposable fixtures; do not delete existing attempts to
manufacture a slot-limit test already covered by the automated service regression.
