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

Initial manager entry verifies authentication before mounting either view. Both
entry buttons are temporarily disabled while one opener owns that check; the
selected button shows Loading. Cancel leaves the editor intact with no manager
or authentication error, and returns keyboard focus to the entry once enabled.
Successful login opens the requested manager and passes
the verified account guard to its list read without a duplicate preflight.
Replacing the draft or disposing the shell invalidates a pending opener. Once
mounted, the existing modal revisions own list requests and Close/reopen behavior.
Refresh, search, pagination and mutation recovery retain their existing flows.
`editor-manager-entry-auth-smoke.mjs` covers both entries, cancellation, duplicate
clicks, service failure, popup/same-tab continuation and stale draft replacement
in both locales at desktop/mobile widths. Cross-app read and mutation auth smoke
tests cover the unchanged shared consumers.

Focused verification combines `editor-uploaded-drafts-view-smoke.mjs` with the
existing manager-loading, upload-result, publication, deletion, package-load and
mutation-manager authentication browser suites. Fixtures are isolated; these checks
do not claim live identity-provider or VPS acceptance.

The published-package browser is rendered by `published-browser-view.js`. It
receives filters, results, loading/error/pagination state, the current user's ID
(for Delete visibility) and opening IDs. It emits search/refresh with the current
input values, load-more without replacing the active search filters, and explicit
copy/open/delete/close callbacks. Timestamp formatting is injected from the
existing helper. No API client or editor session is passed into this view.

Search state, request sequence/revision checks, auth, pagination requests,
clipboard notifications, deletion confirmation and worksheet replacement remain
in `main.js`. The view uses the same disposal/current-context boundary as the
uploaded manager. Existing loading presentation, metadata, button labels and
owner-only Delete visibility are unchanged. `editor-published-browser-view-smoke.mjs`
covers this boundary in both locales and at desktop/mobile widths; the existing
workflow suites cover the integration.
The published view smoke also mounts the real shell with isolated API fixtures to
verify search/refresh filter capture and pagination append/reset. It waits for the
fixture draft's initial autosave before entering the server browser so an unrelated
save-driven shell update cannot reset partially entered fixture filters.
