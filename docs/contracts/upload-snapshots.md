# Package snapshots within an upload flow

An upload flow begins with an explicit server-save action and ends on success,
cancellation, terminal failure, or a stale document/attempt context. Its conflict
and slot-recovery dialogs belong to that same flow.

The editor captures a draft for package preparation; the viewer finishes its
local-state flush before preparing an attempt package. Once prepared, the ZIP
bytes, title and subject remain fixed through replace/copy and successful
slot-recovery retries. RolePlayScene already prepares its archive, title and
description once before its recovery loop and follows the same rule.

Edits made while a conflict or slot dialog is open remain local. They are not
silently included in a retry. A new explicit upload after the flow ends captures
current content. Package references retained by the editor/viewer flow are
cleared in its final cleanup; they are not stored in IndexedDB, login intents or
session storage. Standalone upload calls without an active UI flow prepare their
own package. Same-tab login return restores local work without uploading. The
next explicit upload prepares a package from that restored work; ZIP bytes are
not persisted across authentication navigation. See [mutation authentication](authentication-mutations.md).

Document ID and generation ownership checks remain authoritative: a retry may
not apply the old package to a replacement document, including reopening the
same ID in a new generation. In-place edits do not invalidate the captured
package. Cancellation does not guarantee that an already submitted request was
rolled back on the server.

## Request identity

A prepared package is not a transport operation ID. Each user-authorized
submission after a definitive conflict or slot rejection uses a new operation
ID, including when its conflict action changes. The existing transport owns
fingerprints and receipt recovery for each submission. An uncertain response
triggers receipt lookup, not automatic ZIP resubmission. The same operation ID
must never identify changed bytes or request metadata.

## Unchanged policies

Dialogs, package formats, authentication, slot limits, publication rules and
replacement identities remain app-specific. All three apps now use the
[shared recovery coordinator](upload-recovery.md) for repeated, user-authorized
conflict and slot recovery.
Local autosave remains independent of the retained upload package. List-refresh
failure does not invalidate a successful upload.

## Regression coverage

- Editor/viewer unit tests: one preparation per flow, stable metadata/bytes,
  rejected stale flow and fresh preparation for a later upload.
- `scripts/upload-snapshot-ui-smoke.mjs`: real buttons and ZIP requests through
  conflict → copy → full slots → confirmed deletion → retry; distinct request
  IDs; cancellation and fresh next upload; English/Traditional Chinese at desktop
  and mobile widths.
- Existing RolePlayScene upload-race tests: archive reuse through copy/replace
  and slot recovery, context ownership and cancellation.
- Existing upload lifecycle, cancellation and receipt-recovery suites retain
  coverage of stale contexts, busy ownership and transport recovery boundaries.

## Viewer attempt names and slot recovery

The viewer first obtains sign-in consent/readiness using the shared mutation
flow, then asks for an optional student name (unless already resolved), then
reviews the server name. A first name defaults to worksheet title plus student
name and is editable with a limit of 80 Unicode code points after trimming.
A saved name is displayed read-only; there is no manager rename action. Long
legacy saved names remain usable for replacement. Generated copy names reserve
space for their suffix inside the 80-character limit. The server returns the
actual saved `title` and `subject` so subsequent saves and authenticated resumes
keep the correct identity without changing the worksheet title.

A conflict replacement from the current viewer includes `expectedAttemptId` and
`expectedArtifactHash`. Under the existing account transaction lock, the server
rejects a missing/changed target with `ATTEMPT_REPLACE_TARGET_CHANGED`, before
storing bytes. Legacy clients without these optional fields keep their existing
conflict behavior. These fields participate in request identity only when sent;
legacy upload receipts remain compatible.

The three account-wide slots remain unchanged. Replacement consumes no new slot;
new saves and copies do. Full-slot recovery offers download of an existing record,
local export of the active attempt, and confirmed deletion. Deletion alone does
not retry the upload: the user must press **Continue saving to server**. A slot
freed by another client also requires this explicit decision. If another client
consumes the slot first, the existing recovery coordinator handles another
rejection without auto-deletion or changing the retained snapshot.

The manager can open from the answering interface. Resuming first flushes current
local work, refuses switching during voice/upload/finalization work, and keeps
the current attempt if fetching or validation fails. Successful resume updates
the local-attempt URL after restoration. Long names wrap to two lines in rows;
the expanded Details section exposes the complete name.
