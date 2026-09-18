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

## Verification

- `npm test`
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
