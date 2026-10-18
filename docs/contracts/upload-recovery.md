# Shared upload conflict and slot recovery

`server/app/api/upload-recovery-flow.js` coordinates worksheet-draft,
worksheet-attempt and RolePlayScene-draft recovery. It does not own DOM, package
creation, authentication, transport, resource deletion or list presentation.

## Interface and ownership

`runUploadRecoveryFlow` accepts:

- `resource`: the existing upload-result classifier's resource kind.
- `submit(conflictAction)`: submit the prepared package using the app's existing
  upload method. Each authorized submission retains normal transport ID handling.
- `chooseConflict(result)`: show the app's existing UI and resolve `copy`,
  `replace`, or another value to stop.
- `recoverSlots(result)`: run the app's slot UI and existing confirmed deletion;
  only `{ deleted: true }` permits another submission.
- `isCurrent` and optional `signal`: context ownership and cancellation guards.
- Optional `initialResult`: consume an already-attempted upload, as needed for the
  viewer's protected-action boundary, without resubmitting it.
- Optional initial `conflictAction`.

The coordinator returns `{ status, result }`: `completed` for terminal transport
outcomes (including failure), `canceled` for canceled recovery, or `stale` when
context ownership changes. The original result is retained. It does not turn
cancellation after a confirmed successful mutation into an upload failure.

Each caller reserves its existing operation/flow lock and releases it in finally.
The coordinator checks ownership before submission and after each awaited
submission or decision. App callbacks must also check ownership before showing a
new dialog after an internal asynchronous request. Viewer slot-list failure is
reported and stops recovery; cached rows are not offered as fresh recovery data.
Viewer attempt-list requests that lose ownership return a non-success `superseded`
outcome, including late transport failures. Recovery stops quietly for this outcome.
An accepted response includes its normalized `uploadedAttempts` rows; recovery uses
those rows rather than rereading mutable session state. An explicitly empty list
stays empty instead of falling back to cached rows.

Editor draft-list refreshes accept results only from the latest request. Upload,
publication and deletion force a fresh list request rather than reuse a read
started before the mutation. Superseded results cannot replace rows or slot limits,
or produce refresh-failure feedback. Concurrent ordinary refreshes may share only
the currently owned request; independently cancellable requests are not shared.

## Recovery rules

Conflict decisions and successful slot deletion may repeat: another tab can
consume a freed slot or create a conflicting name. Every subsequent request
requires an explicit copy/replace choice or confirmed deletion. Slot recovery
preserves the chosen conflict action. Invalid choices, unconfirmed/failed deletion,
stale contexts and cancellation do not grant retry permission.

Authentication failures and all other terminal outcomes leave the coordinator.
Uncertain-upload receipt lookup remains inside the API client; it never causes
this coordinator to automatically resend a ZIP. Existing viewer no-auth-replay
rules remain unchanged. Browser UI and resource-specific policies remain with
the apps. Deletion now uses the [shared deletion lifecycle](deletion-lifecycle.md).
Publication creation remains separate work.

[Upload snapshot rules](upload-snapshots.md) apply throughout recovery. Local
changes are not silently included in subsequent attempts within the same flow.

## Slot deletion and list loading

Editor and viewer slot dialogs reserve a deletion before opening confirmation and
disable their deletion buttons until it settles. Their session deletion methods
also reject concurrent deletion of the same resource. The dialog supplies an
ownership callback so closing it or changing document context prevents a pending
confirmation from sending DELETE and prevents late responses from publishing
feedback or authorizing another upload. Closing a dialog after DELETE was sent
does not undo that server mutation. Locks are released in finally.

Viewer attempt lists use the API client's existing 15-second default list deadline,
including stalled response bodies. The recovery list accepts the upload flow's
abort signal, and the Cancel control is visible during this loading phase.
Cancellation or timeout ends recovery without resending a package. Normal manager
lists and post-deletion refreshes also benefit from the bounded list request.

## Verification

The coordinator unit matrix covers all three resource kinds, repeated recovery,
context/cancellation changes at await boundaries, strict deletion confirmation,
terminal failures and already-completed initial results. App-level RolePlayScene
race tests cover its production adapters and real slot/deletion callbacks.

`upload-recovery-coordinator-ui-smoke.mjs` and
`roleplayscene-recovery-coordinator-ui-smoke.mjs` drive production dialogs through
repeated slot/conflict responses in both languages and viewport sizes, comparing
actual ZIP request bytes and operation IDs. Existing snapshot, cancellation,
upload lifecycle and receipt-recovery suites remain required.

`slot-recovery-guards-ui-smoke.mjs` checks disabled duplicate deletion, re-enabling
after rejection, closed-dialog feedback suppression, and viewer recovery-list
cancellation/deadlines in both languages and viewport sizes. Session tests cover
duplicate calls, stale responses, preflight ownership and lock release on errors.
