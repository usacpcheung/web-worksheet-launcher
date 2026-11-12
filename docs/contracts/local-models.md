# Local worksheet models and compatibility

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/editor/main.js`, `server/viewer/main.js`, `server/app/storage/`, `server/app/contracts/`, and RolePlayScene `scripts/storage.js`.

## Browser storage and identity

Worksheet IndexedDB is `worksheetLauncherStorage`, version 2, with `localDrafts`, `importedWorksheets`, `localAttempts` and `localAssets`. Records use `localId`; required metadata includes `localId`, `origin`, `updatedAt`. Binary assets are kept in `localAssets`. Small restore/resume/preference flags use localStorage/sessionStorage helpers, rather than replacing IndexedDB payloads.

Editor/viewer autosave remains debounced. When a page hides or unloads with pending edits, `server/app/storage/recovery-journal.js` synchronously journals the current record in per-tab sessionStorage under `worksheetLauncher:pending:` and starts an immediate IndexedDB save. On reload, the storage adapter restores a newer pending record before returning it. The restore compares the current IndexedDB record with the original read inside one read/write transaction, so a concurrent save, deletion or clear wins over stale recovery. It then removes that consumed or superseded journal entry. Equal timestamps with different content preserve the pending record unless a concurrent write invalidates the original read. Explicitly discarded editor drafts cannot be journaled or autosaved while replacement cleanup is pending. A late autosave from an earlier opening of the same draft or viewer attempt cannot mark the reopened record’s new edits as saved or apply stale save errors. Asset binaries stay in IndexedDB. If sessionStorage is unavailable or full, the unload handler requests the browser's unsaved-work confirmation. This protects ordinary reload/navigation, not an OS/browser process termination without lifecycle events or recovery after closing the tab.

Editor draft and viewer attempt IDs are client-generated prefix plus `crypto.randomUUID()` when available, with random/time fallback. They are not the old specification's `ld_<ulid>`/`la_<ulid>` contract. API draft, publication and uploaded-attempt UUIDs are separate identities and do not overwrite local record IDs.

RolePlayScene uses its own `roleplayscene` IndexedDB, version 1, `project` store, key `snapshot`, for one active local story. Autosave waits for transaction completion and reports failures. Discussion state/recovery uses sessionStorage; it is not part of saved story packages.

When reopening an editor draft, its displayed last-save time comes from the persisted `metadata.updatedAt`, not the current time. A saved legacy record with no usable timestamp displays “Save time unavailable”; a new unsaved draft displays “Not yet saved.” Failed saves retain the previous successful timestamp. Successful saves replace restored timestamps even after a backward clock correction; draft generation, revision and save-invocation order prevent an older completion from replacing newer save status. Pending/unsaved revisions are distinguished from saved revisions. Save-time text and viewer attempt-state/detail labels follow the selected English or Traditional Chinese locale; stored status codes and IDs do not change.

## Compatibility modules

The validators/mappers in `server/app/contracts/` retain these model boundaries:

- editable draft with `draftWorksheetId`, blocks and transient authoring fields;
- snapshot with `worksheetId`, `snapshotId`, positive schema/snapshot versions, publish metadata and required `sourceDraftRevision`;
- minimal viewer payload with identifiers, title and blocks;
- attempt payload with identifiers, learner/status and answers keyed only by question block IDs.

Draft-to-snapshot mapping strips transient fields and deep-clones content; snapshot-to-viewer sorts blocks by position and preserves question rendering/answer configuration. Attempt mapping drops responses for non-question blocks. See the [colocated module reference](../../server/app/contracts/README.md) and its fixtures.

These are client compatibility shapes. They do not prove the server implements relational snapshots, monotonic snapshot versions, server draft revisions, or aliases from `snapshotId` to `publishedPackageId`. Node upload/publish APIs operate on ZIP artifacts and server UUID metadata. The [archived Phase 1 ADR](../past/phase1/adr-phase1-worksheet-model.md) preserves original design rationale and examples but is not a current server schema.

## Viewer attempt continuity

Viewer creates a local attempt from a derived payload, with `sourceType`, `sourceId`, `sourceFingerprint`, source-local pointers where applicable, answer state and progress. `tryResumeAttempt` reconstructs local source content when available, falls back to its saved payload where supported, and rejects a recorded identity/fingerprint mismatch. The fingerprint is computed from viewer content; it is not the ZIP artifact's server SHA-256.

A publication open downloads/imports a worksheet, then uses the imported-worksheet local source path. Current viewer code does not maintain a publication-ID cache lookup or a server revision-sync relationship for that attempt.

Uploaded/local attempt ZIP restore uses its embedded worksheet and creates new imported and local attempt records. Package status `in_progress` maps to an editable local attempt; `submitted`/`checked` maps to completed review, with check metadata restored when present. Voice recovery is saved locally for retry but excluded from attempt packages, uploads and print. See [package formats](package-formats.md) and [voice recovery](../worksheet/viewer-voice-workflow.md).

## Text and response compatibility

Supported question input types are `text`, `number`, `boolean`, `multiple_choice`. Deprecated aliases are rejected, not guessed. Markdown uses explicit text-format markers and a shared safe renderer; loading old packages does not migrate them merely for viewing. Opening/editable import preserves the existing text representation. The shared editor writes a restricted rich document only when required; legacy audio migration remains a separate compatibility path. See the [message/response contract](../message-contract.md) and [limited Markdown](../worksheet/worksheet-limited-markdown.md).

Numeric answer keys use the shared number validator. A decimal-only question may retain a whole-valued decimal answer such as `1.0` (stored as numeric `1`); learner input formatting still follows the configured rules. Delayed question-image attachment checks the original draft generation, question and media references before applying. If the target changed, the newly stored unused asset is removed. A successful attachment schedules persistence before awaiting old-asset cleanup; cleanup failure or a later draft switch does not prevent the attachment from being saved.

Authentication pending intents use the same `worksheetLauncher:pendingIntent` key in per-tab sessionStorage, with an `intentId` per write. They survive same-tab login navigation and reload; closing the tab ends its pending automatic action, while saved local work remains in IndexedDB. Resume flags remain in localStorage for start-panel compatibility. An auth-return page can adopt a legacy localStorage pending intent once; new writes do not use that shared key. Clearing writes a per-tab tombstone to prevent legacy intent resurrection. A replay validates ownership after asynchronous boundaries and never clears a newer intent.

### Attempt menu identity

Local attempt records additionally retain `studentNameResolved`,
`attemptNameMode`, `attemptNameDraft`, `savedAttemptName`, `savedAttemptSubject`, and
`savedAttemptAccount`. Missing fields default to an unresolved optional student
name, an empty draft/name, and no server association. The saved name/subject are
remembered only after a successful server save or authenticated server resume.
The final name remains editable on every server save. New/edited names retain the
80-character limit; an unchanged legacy server name can still be saved. Automatic names follow
student-name corrections and become title-only when the student name is cleared.
An explicit empty student name is resolved and does not prompt again. Manual
attempt-name input selects custom mode, preserved across cancellation, reload,
export and import. Legacy records matching the current generated suggestion use
automatic mode; other existing names are conservatively preserved as custom.
Server-generated copy suffixes are preserved as custom names.
A different final name creates another entry; matching names use the existing
normalized owner/title/subject conflict choices. Slot-full recovery is unchanged.
Changing accounts does not grant access to the old account's records. No IndexedDB version migration is required.

The viewer's attempt menu offers server save, server-attempt management, local ZIP
export, and the existing details/print settings. Local Save is labelled “Save on
this device.” Export remains available without login. Printing remains the
existing report preview and is available after submission; before submission the
visible control explains its disabled state on hover, focus, or tap.

### Voice recovery selection range

Viewer attempt recovery and RolePlayScene session recovery may retain optional
`replaceStart` (UTF-16 offset) alongside the existing end `index` and `snapshot`.
Only valid nonempty ranges with intact surrogate boundaries allow replacement.
Missing/invalid ranges preserve insertion-only legacy behavior. Answer changes
require explicit recovery; append clears the range. Recovery remains excluded
from server attempt packages, worksheet/story packages and print.

## Image-response persistence

Image-response answer values are ordered arrays of `{ assetId }`, with their binary
media stored in `localAssets`. `commitAnswerImages` writes the new binary and answer
references in one transaction across `localAssets` and `localAttempts`. It compares
expected old references and rejects stale or completed attempts. Cancellation before
commit persists no candidate; a failed transaction leaves the previous answer intact.

Normal attempt autosaves and recovery-journal writes cannot replace different saved
image references. This prevents a stale text autosave from resurrecting a removed
image, but does not introduce general multi-tab text merging. Image work is serialized
within a viewer session; pending attachment blocks finalization/export/server save.
Export holds an image-edit lock while collecting the immutable package snapshot.

New answer assets have `metadata.ownerAttemptId`. Replacing/removing them reclaims
unreferenced bytes in the same transaction; deleting an attempt also removes its
owned answer assets. Imported answer-only assets receive the new attempt owner ID.
Worksheet/shared assets retain their existing lifetime. Import uses fresh identities
for both binaries and answer references; old packages and local records are unchanged.
No database version migration is required.


## Text answer mode and preservation

`responseConfig.textMode: "long"` opts an existing Text question into a multiline,
full-width answer surface without voice/rewrite/Undo assistance. `"standard"`
retains those controls. New standard limits are 1–1,200 (default 200); long limits
are 1–20,000 (default 20,000). Omitted mode is legacy standard text, with existing
saved limits/answers preserved. Switching long to standard requires confirmation
when the authored limit will reduce to 1,200; it never edits saved answers. Existing source-mismatch checks still apply when resuming an attempt against an edited worksheet.

Local answer strings retain whitespace and are no longer truncated during
normalization, autosave, recovery-journal writes, submission or package export.
Input limits apply to new edits, with whole-paste rejection and IME validation
only after composition ends. An existing over-limit answer can be shortened in
stages; rewrite Undo can restore its exact original snapshot. Long-mode questions
are excluded from the shared voice workflow, including retry/auth recovery entry
points; RolePlayScene's existing text questions remain eligible.

Rich prompt/content fields preserve their `document` alongside the validated plain `text` projection through draft, snapshot, viewer and attempt records. See [shared rich-text editor](../worksheet/shared-rich-text-editor.md).
