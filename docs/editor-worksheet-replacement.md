# Editor worksheet replacement

The following editor actions show a replacement confirmation before loading:

- Import a local ZIP package (after choosing the file).
- Browse Published Packages → Open in Editor.
- Manage Uploaded Drafts → Open.

Cancel leaves the active worksheet unchanged. Confirm opens a local editable
copy; it does not alter the uploaded draft or published package on the server.
The outgoing worksheet is saved locally before import storage begins and again
before the active draft switches, to include edits made during asynchronous
loading. An outgoing save failure stops the switch and reports an error.
Export remains the way to keep a portable backup.

Legacy-audio migration confirmation is separate and remains supported.
New Worksheet retains its existing destructive-action confirmation.
Viewer and RolePlayScene loading behavior is unchanged.

## Download and opening feedback

Uploaded-draft and published-package Open buttons show Checking, Downloading,
Saving current worksheet and Opening stages. Download percentages appear only
when the response supplies a usable uncompressed Content-Length. Otherwise the
button shows Downloading without inventing a percentage. Download completion
is distinct from import completion; ZIP parsing and local storage can take longer.

Only one worksheet load runs at a time in an editor session. Other Open buttons,
local import, New Worksheet and viewer navigation are disabled until it finishes.
Closing the list does not cancel an accepted load; reopening it restores the
current progress. Failure releases the lock so the user can retry. Stage changes
are announced through a live status without announcing every percentage.

The UI yields before parsing to give feedback a rendering opportunity. This is
not a worker-based ZIP parser and does not guarantee smooth rendering throughout
large synchronous decompression operations.

## Verification

- `npm test`
- `node scripts/editor-load-progress-smoke.mjs` (self-hosted streamed fixtures:
  known/unknown size, invalid ZIP retry, shared lock, stable DOM during progress,
  close/reopen, save-stage feedback, both locales and desktop/mobile).
- `node scripts/editor-replacement-smoke.mjs` (set `VIEWER_SMOKE_URL` to the
  local static server; default for this script is `http://127.0.0.1:8892`).

The browser script uses isolated storage and synthetic server artifact responses
with real package parsing, dialogs and local persistence. It checks cancel,
failed outgoing save, successful retry, saved outgoing edits, initial keyboard
focus and dialog width for all three paths in English/Traditional Chinese at
1280px/390px. It does not validate live server authentication or VPS deployment.

For manual QA, use test copies: edit the current worksheet, choose each loading
action, cancel and verify the edits remain; repeat and confirm to open the
replacement. Check the warning in both languages and at mobile width.
