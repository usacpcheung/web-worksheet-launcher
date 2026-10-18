# Shared authentication foundation

This reference describes the first runtime extraction after main `980e131`. It does **not** implement the proposed cross-app sign-in UI or post-login continuation changes. The workflow mapping/target is tracked separately in [PR #318](https://github.com/usacpcheung/web-worksheet-launcher/pull/318); this implementation can merge independently of that documentation PR.

## Current integration

- `server/app/auth/session-coordinator.js` now owns the state/action ownership algorithm previously inline in RolePlayScene `probeServerSessionSilently`.
- RolePlayScene supplies its existing state store, UI update callback, bounded `probeSession` invocation, localized error presentation and operation guard. Its public helper signatures, result envelopes, notifications and login UI remain unchanged.
- `server/app/auth/session-outcome.js` provides a pure failure classifier. `session-readiness.js` uses its **legacy compatibility mode**, preserving existing 401/403/code/flag behavior for every existing consumer.
- Editor/viewer session orchestration is not migrated in this PR. API-client error flags, shared protected-intent replay, popup opening and callback validation are unchanged.

The classifier's new permission-aware policy is opt-in and is not yet used to change any app's login decisions. A later integration must migrate classification and its consumers together, including API-client `requiresSignIn` flags, app predicates and protected-action handlers. Changing only one predicate is insufficient.

## State ownership coordinator

`runOwnedSessionProbe({readState, writeState, probe, presentError, isCurrent})` coordinates one operation against an adapter-owned state store. It does not open login, retry requests, persist intents, emit notifications or execute protected actions.

Adapter requirements:

- `readState` returns the current state object. `writeState` stores that exact object and may refresh the app UI synchronously. External login/expiry updates replace the object rather than mutate the pending one.
- Canonical state statuses are `checking`, `ready`, `not_ready` and `error`. Other app enums need an adapter before migration.
- `probe` returns the normalized readiness result (`ok`, `status`, `user`, `error`) and **must be bounded**. The existing `probeSession` handles the timeout/network lifecycle; the coordinator does not introduce another timer or cache.
- `presentError` returns app-localized failure text. It does not decide whether to replay an action.
- `isCurrent` checks the originating action's context after asynchronous boundaries. It must be synchronous and side-effect free.
- A checking state contains in-memory `settled` and `expectedSubject` metadata. Do not persist this transient state or serialize it as a user/session payload.

Only the current probe owner can publish global state. A closed/replaced operation returns `{ok:false, skipped:true, status:'superseded'}` and releases its checking state without publishing the obsolete result. If a newer probe owns state, an older still-current action waits for that verdict; it can continue only when both results confirm the same nonempty account subject and the original known subject is compatible. Newer failure, external expiry or account change prevents continuation. Separate app state stores are isolated.

All current callers must treat supersession as a quiet exit, not infer a fresh authentication failure. Protected actions still perform their own post-await context checks and retain existing mutation uncertainty handling. This extraction does not promise account switching behavior beyond the existing concurrent-action safeguards.

## Failure classification

`classifySessionFailure(result, options)` returns a stable category without inspecting message prose or mutating the result. It accepts direct failures and existing `{result: ...}` wrappers. The original object remains with the caller for diagnostics.

| Input | New opt-in policy |
| --- | --- |
| Skipped/superseded | `superseded` |
| Explicit cancellation | `cancelled` |
| HTTP 401 | `authentication_required` |
| Structured `FORBIDDEN` / `PERMISSION_DENIED` | `permission_denied`, even if the legacy client set `requiresSignIn` |
| HTTP 5xx transport failure | `unavailable`; no login loop from an auth hint |
| Explicit authentication/session-expiry code or auth hint | `authentication_required` |
| Bare HTTP 403 without authentication evidence | `permission_denied` |
| Other failure / timeout / unknown prose | `unavailable` |

For `legacyAuthStatuses:true`, the existing readiness helper's predicate is preserved: auth hint, numeric-coercible 401/403, or `AUTH_REQUIRED` means authentication required; otherwise unavailable. This deliberate temporary mode does not claim to resolve permission classification throughout the apps.

The classifier consumes normalized API/probe evidence, not raw HTML or redirects. Existing API parsing remains responsible for identifying OIDC login responses. Readiness success is handled separately; this function classifies failures only.

## Verification and next integration

Unit tests exercise both completion orders, newer failure/account change, external state replacement, cancellation, rejected probes and isolation between adapters. Compatibility classification is checked against the previous predicate over status/code/flag combinations. Existing RolePlayScene preflight tests execute the real shared implementation through its production adapter.

Run the auth/RolePlayScene tests and full Node suite, plus list-feedback, deletion, popup/sign-in, direct-launch and voice browser coverage appropriate to the changed consumers. Simulated results do not establish live OIDC behavior. A deployment should verify that the new JavaScript modules load correctly and repeat focused session/list acceptance before merging.

Next: integrate contextual sign-in and list/open/download behavior across the apps according to the agreed workflow contract. Retain the existing [popup contract](../message-contract.md), [upload recovery](upload-recovery.md) and [deletion contract](deletion-lifecycle.md). Reuse the popup helper; do not add a second authentication protocol.
