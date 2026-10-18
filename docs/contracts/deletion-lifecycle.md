# Shared server-resource deletion lifecycle

`server/app/api/deletion-flow.js` coordinates deletion of worksheet drafts,
worksheet publications, viewer attempts, RolePlayScene drafts and RolePlayScene
publications. It does not coordinate publication creation, ZIP upload, local
record deletion, backend file cleanup or authentication recovery.

## Adapter boundary

`runDeletionFlow` accepts a resource-specific `pending` Set and `key`, an optional
`confirm` callback, optional `preflight`, `remove`, optional `refresh`, and
`isCurrent`. The reservation spans confirmation, preflight, DELETE and refresh.
Different resource types use separate Sets; equal IDs in different types do not
block each other. Repeated actions on the same resource return `busy` without
calling confirmation or settling the original recovery flow.

Apps retain their dialogs, eligibility rules, endpoints, metadata, authentication
policy, list filters and rendering. UI callers supply confirmation callbacks that
return exactly `true` to proceed. Direct session callers may omit confirmation
when confirmation has already been handled by their caller. Viewer continues to
rely on server authorization for DELETE; this extraction adds no session probe or
authentication replay to that path.

Ownership is checked before starting and after confirmation/preflight. A stale
flow sends no DELETE. Once DELETE is sent, loss of ownership cannot undo it or
rewrite its outcome. App adapters suppress stale feedback and recovery callbacks.
Refresh callbacks also guard their own state updates across awaits. The coordinator
always releases its reservation, including on exceptions.

## Result contract

`ok` represents confirmed deletion, independently of refresh. `deleteResult`
retains the API result when a DELETE was attempted. No request is automatically
retried, and deletion has no upload-style receipt lookup.

| `deletionStatus` | Meaning |
| --- | --- |
| `confirmed` | Server returned application-level `ok: true` |
| `rejected` | Explicit HTTP 4xx rejection or structured non-transport application error |
| `uncertain` | Transport exception, interrupted/invalid response, HTTP 5xx, or missing outcome |
| `canceled` | Confirmation did not return `true`; DELETE not sent |
| `stale` | Ownership lost before DELETE; DELETE not sent |
| `preflight_failed` | Confirmation/preflight threw, or preflight refused; DELETE not sent |
| `busy` | This resource already has a pending deletion |

`refreshStatus` is `skipped`, `succeeded`, `failed` or `superseded`.
`refreshResult` retains the refresh result or a normalized exception result.
A failed refresh never changes `ok: true` or `deletionStatus: confirmed`.
A superseded refresh produces no refresh-failure warning.

Unknown deletion outcomes use `apiErrors.deleteUncertain` in the selected
language. The user is asked to refresh the list before deciding whether to retry.
Confirmed deletion with failed refresh uses `apiErrors.deleteRefreshFailed`.
Raw server prose and exception text are not used as translated user messages.

## Managers and slot recovery

Editor/viewer managers refresh their existing lists after confirmed deletion.
The editor publication adapter supplies its published search callback and keeps
its existing filters. That search rejects obsolete responses and returns its
result to the coordinator. RolePlayScene manager deletion refreshes data before
rendering an owned manager; its modal revision and project generation guard the
continuation.

Slot recovery retains the [upload coordinator](upload-recovery.md). Only a
confirmed deletion with current ownership authorizes continuation. A refresh
failure does not negate confirmed deletion. RolePlayScene slot recovery retains
its existing direct continuation without an extra list read. Closing or replacing
the originating flow prevents another upload, even if DELETE later succeeds.

Deleting a draft preserves its independent published artifact. Database ownership,
publication references, immediate owner deletion, best-effort artifact cleanup and
uncertain-commit behavior remain in the backend services unchanged.

## Verification

`deletion-flow.test.mjs` simulates all await boundaries, duplicate actions,
independent resources, explicit rejection, uncertain responses, exceptions and
refresh outcomes. Editor/viewer session tests and RolePlayScene adapter tests
exercise production methods with the real coordinator.

`deletion-lifecycle-ui-smoke.mjs` exercises all five resource managers in English
and Traditional Chinese at desktop/mobile widths using intercepted requests. It
checks cancellation, duplicate confirmation, lost responses and success followed
by failed refresh. Existing slot-recovery and upload browser suites verify that
this extraction preserves upload continuation and cancellation behavior. These
fixtures do not mutate real server resources or replace VPS acceptance testing.
