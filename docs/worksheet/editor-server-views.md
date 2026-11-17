# Editor server-list views

The uploaded-draft manager's DOM is owned by `server/editor/uploaded-drafts-view.js`.
It renders a supplied display model and emits explicit open, copy-link, publish,
delete, refresh and close callbacks. The module also owns the existing timestamp,
publish-state and badge formatting helpers. Public helper exports from `main.js`
remain compatible.

`main.js` remains the owner of authentication, server requests, publication and
conflict flows, deletion confirmations, opening/replacing worksheets, modal-open
revisions, package-load progress and notifications. The view has no session or
API client reference. It preserves the existing classes, translations, action
availability, loading/error/empty states, slot count and foreground-dialog focus.

Each render aborts listeners on replaced controls. Destroying the shell disposes
the view. A shell-supplied current-context guard prevents mounted old controls
acting on a replacement draft. Listener disposal does not cancel a server operation
already in progress; existing operation guards still decide whether its result
may apply.

Focused verification combines `editor-uploaded-drafts-view-smoke.mjs` with the
existing manager-loading, upload-result, publication, deletion, package-load and
mutation-manager authentication browser suites. Fixtures are isolated; these checks
do not claim live identity-provider or VPS acceptance.
