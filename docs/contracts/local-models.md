# Local worksheet models and compatibility

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/editor/main.js`, `server/viewer/main.js`, `server/app/storage/`, `server/app/contracts/`, and RolePlayScene `scripts/storage.js`.

## Browser storage and identity

Worksheet IndexedDB is `worksheetLauncherStorage`, version 2, with `localDrafts`, `importedWorksheets`, `localAttempts` and `localAssets`. Records use `localId`; required metadata includes `localId`, `origin`, `updatedAt`. Binary assets are kept in `localAssets`. Small restore/resume/preference flags use localStorage/sessionStorage helpers, rather than replacing IndexedDB payloads.

Editor draft and viewer attempt IDs are client-generated prefix plus `crypto.randomUUID()` when available, with random/time fallback. They are not the old specification's `ld_<ulid>`/`la_<ulid>` contract. API draft, publication and uploaded-attempt UUIDs are separate identities and do not overwrite local record IDs.

RolePlayScene uses its own `roleplayscene` IndexedDB, version 1, `project` store, key `snapshot`, for one active local story. Autosave waits for transaction completion and reports failures. Discussion state/recovery uses sessionStorage; it is not part of saved story packages.

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

Supported question input types are `text`, `number`, `boolean`, `multiple_choice`. Deprecated aliases are rejected, not guessed. Markdown uses explicit text-format markers and a shared safe renderer; loading old packages does not migrate them merely for viewing. Local editable conversion and legacy audio migration are explicit compatibility paths, not abandoned code. See the [message/response contract](../message-contract.md) and [limited Markdown](../worksheet/worksheet-limited-markdown.md).
