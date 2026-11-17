# Editor status and notifications

This describes the editor implementation on this branch, based on PR #363. It
is not a claim of VPS deployment or acceptance.

The header contains one save/validation badge, the latest eligible notification,
a draft-information button and the existing language selector. On narrow screens
an active notification takes its own row. Notifications stay in normal page flow;
they do not float over fields, option buttons or modal actions.

The badge distinguishes save failure, saving, unsaved and saved states. Its issue
count comes from current validation results. The last saved snapshot's warning
is shown separately in the dialog, never added to that count. Current validation
success does not guarantee an operation will succeed: existing package/media,
authentication and distribution checks still apply.

The badge opens a compact Save and validation dialog; the information button
opens a smaller dialog with the draft ID and Copy action. Save time is displayed
in the former using local date/time formatting. Clipboard failure selects the ID
for manual copying. Both dialogs use the editor modal visual language, a centred
SVG close icon, keyboard focus containment, Escape and focus return. They do not
expand the header. Closing preserves scroll position; selecting a navigation
link closes first and then deliberately reveals the relevant editor section.

Navigation only targets a uniquely identified block or the worksheet feedback
settings. Errors for the same block share a link. There is no individual option,
blank, media-control or target navigation. General/unmapped errors have no link.
Targets are rechecked against current state. Draft/shell replacement closes the
dialog and prevents retained controls acting on a replacement draft.

The status dialog's Retry saving action uses the existing local save operation.
No generic notification-to-command or upload-retry mechanism is introduced.
Existing validation rules, including the untitled-worksheet fallback, are unchanged.
Known validation messages have friendly labels; unrecognized messages remain
visible as diagnostic text instead of being hidden or assigned a guessed target.

Only the newest eligible notification is shown. Presentation respects `showToast`,
the notification's creation time and custom TTL, with the existing five-second
default. A newer notice supersedes older ones; expiry/dismissal does not replay
those older notices. Dismissal remains in memory across UI-language changes and
does not delete Activity records. No new persistence/storage fields are added.

Activity retains its location, collapse/scroll behaviour, thirty-record batches
and existing retention policy. Only events already marked for logging appear
there; transient progress and `showToast: false` policies are preserved. Unchanged
history is not rebuilt on unrelated editor updates. Manual-save notifications use
the existing concise success message; the draft ID remains in its info dialog.

Ownership:
- `status-model.js`: presentation of existing state and validation locations.
- `status-panel.js`: badge, information control, dialogs and their lifecycle.
- `notification-panel.js`: header notice and Activity presentation/timers.
- `main.js`: state, save/validation ownership and block/feedback selection callbacks.

Verification: `status-model.test.mjs`, `editor-status-panel-smoke.mjs`,
`editor-notification-panel-smoke.mjs` and existing editor dialog, upload-result,
replacement, multiple-choice, option-audio and layout smokes. Browser fixtures
are isolated; simulated storage errors do not establish real-device quota behavior.
