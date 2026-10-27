# Shared publication lifecycle

Worksheet Editor and RolePlayScene use `server/app/api/publication-flow.js` for
publication sequencing. Viewer has no publication-creation action. This module
reuses the existing mutation authentication adapters and API methods; it does not
change endpoints, metadata, package formats, publication identities or backend
rules.

## Two entry paths

`runPublicationFlow` owns the metadata/conflict loop. It receives initial metadata,
`collectMetadata`, `publish`, `isConflict`, `chooseConflict` and `isCurrent`.
A canceled form sends nothing. Only a recognized publication naming conflict and
an explicit `edit` decision reopen the form. The next POST still requires form
confirmation and fresh mutation preparation. Authentication failures, uncertain
responses and other errors are never automatically replayed.

`runPublicationAttempt` performs one preparation, submission and optional refresh.
It receives `preflight`, `submit`, a synchronous `onSubmitted` presentation callback,
`refresh` and `isCurrent`. Preparation delegates to the existing
[mutation authentication](authentication-mutations.md) adapter, which updates the
account guard before the next currentness check. Callbacks must not perform hidden
retries. Presentation callbacks remain synchronous and must not throw.

These two boundaries let Editor direct session callers publish already-confirmed
metadata without opening a UI form, while both product managers share the dialog
loop. The helper imports no DOM, localization, endpoint or authentication code.

## Reservations and product adapters

Reservations remain in product adapters and span all awaited coordinator work;
adapters release them in `finally`. This deliberately preserves existing policy:

- Editor `guardServerMenuAction` reserves one manager publication flow before the
  first dialog, through conflict editing and refresh. Its session method reserves
  each draft ID independently, so direct session calls for distinct draft IDs can
  still run concurrently. Duplicate requests for the same draft cannot release
  the original reservation.
- RolePlayScene `isPublishingDraftFlow` reserves the full flow before its first
  dialog; `publishingDraftIds` tracks the request-level UI. Its manager and story
  ownership remain separate from the shared sequence.

Editor retains title/subject and `PUBLISHED_PACKAGE_CONFLICT`; RolePlayScene retains
title/description and `ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT`. Forms, notifications,
list loaders, confirmation/focus behavior and restored login-return metadata stay
in their adapters. The per-product generation, manager revision and verified
account predicates remain authoritative. Adapters must guard their own asynchronous
list updates; the coordinator's post-refresh check cannot undo a stale write.

## Results and ownership

Before submission, stale ownership returns a skipped `superseded` result; canceled
metadata returns a skipped `cancelled` result. Preparation failure has
`phase: preflight` and sends no POST. Exceptions in preparation/submission are
returned with a safe `NETWORK_ERROR` and retained internal `cause`; presentation
uses existing safe localized error helpers, never raw exception text.

After a POST, the attempt returns the original `publicationResult`, preserves its
fields at the top level and adds `phase: submission` and `refreshStatus`.
A later context/account change suppresses presentation, conflict continuation and
refresh, but does not erase a received successful publication. RolePlayScene also
marks a manager-obsolete outcome skipped to prevent its outer loop reopening a
conflict dialog; confirmed `ok` is preserved.

`refreshStatus` is `skipped`, `succeeded`, `failed` or `superseded`;
`refreshResult` retains a returned result or normalized exception. A failed or
throwing refresh cannot replace confirmed publication success. Editor retains its
separate refresh warning; RolePlayScene's list loader presents returned failures,
while its adapter presents a thrown refresh failure. Previously thrown refresh
exceptions could escape the publication call; they now remain refresh outcomes.

There is no publication receipt lookup, new timeout, backend cancellation, or
automatic retry. The helper does not claim that a failed/lost response means the
server rolled back. Upload receipt and deletion recovery policies are unchanged.

## Verification

- `server/app/api/publication-flow.test.mjs`: ownership loss at every async stage,
  explicit conflict editing, cancellation, preparation failures, no replay of
  rejected/uncertain responses and independent refresh outcomes.
- Editor session tests: same-ID reservation, distinct-ID concurrency, metadata,
  late success after owner replacement and returned/thrown refresh failures.
- RolePlayScene publish tests: full-flow reservation, conflict metadata, account
  changes, manager replacement, safe errors and refresh outcomes, using the real
  shared helper with isolated adapters.
- `scripts/publication-flow-smoke.mjs`: both products, both locales and desktop/
  mobile; real forms, conflict editing, cancellation, duplicate confirm clicks,
  lost responses, failed refresh and browser errors with intercepted fixture APIs.
- Existing mutation auth/manager smokes retain popup/same-tab login, explicit
  post-login confirmation and metadata restoration coverage.

Synthetic fixtures do not establish live OIDC, real server publication or VPS
acceptance. Those remain deployment checks on the exact proposed revision.
