# Authentication for server reads

This is the current implementation reference for the read integration built on main `35c8524` (PR #319). The [workflow contract](authentication-workflows.md) records the complete target; mutation and provider migrations remain separate stages.

## Covered workflows

| Application | Read entry points |
| --- | --- |
| Editor | Draft manager/refresh, publication browse/search/refresh, open draft or publication as a local editable copy |
| Viewer | Attempt manager/refresh, attempt resume/download, publication browse/search and opening a selected/direct-linked worksheet |
| RolePlayScene | Draft manager/refresh, publication browse/search, draft/publication download, editable copies and published playback/direct links |

Local editing, local imports/exports, saved worksheets, answers and stories do not require authentication. A published artifact still requires server authentication. Server authorization and ownership checks remain authoritative.

Read controls remain discoverable when signed out. Selecting a read verifies session readiness and offers localized Sign in / Cancel when authentication is needed. The surrounding managers, editor, learner interface and scene player retain their existing layouts. Explicit Sign in remains a direct login action.

## Shared mechanism and ownership

`server/app/auth/read-auth-flow.js` coordinates readiness, contextual recovery and at most one repeat of a failed read. Callers pass only the read request; import, playback, confirmation and mutation callbacks are not retried by this helper.

- `session-coordinator.js` owns probe results for all three applications. `session-state-adapter.js` preserves silent editor/viewer checks and their existing state enums. RolePlayScene retains its existing visible checking feedback.
- The existing `auth-popup-flow.js` validates origin, source window, message type and flow ID and verifies the session. Read recovery also verifies readiness before resuming and requires an account subject.
- Provider adapters may use `ensure({ withContext: true, recoverAuth: false })` to verify readiness without starting shared read recovery; their existing sign-in surface owns login and explicit retry. Normal reads retain their recovery behavior.
- A successful `ensure({ withContext: true })` returns an account-only `isCurrent()` guard tied to verification. When readiness and the read are separate awaits, pass that result as `prepared` to `read(..., { preflight: false, prepared })`. Successful reads return their original account guard; adapters check it before rendering lists, downloading files or importing content, and after asynchronous preparation. Never capture a fresh account context after downloading old data. Compose the returned guard with the app's own operation guard. Read-only authentication recovery may replace the account guard only after fresh verification. `recoverAuth: false` retains these guards without opening login or replaying the request (used by login-callback refreshes).
- Concurrent read callers share a readiness preflight and a contextual prompt/login. Each caller retains its own context guard and cancellation. Closing one caller releases its wait without canceling a login used by another. Closing an editor or viewer server browser/manager now invalidates its selected open; a late download cannot replace the worksheet. Reopening requires a new explicit open. Viewer ownership checks continue through validation and each storage write; abandoned imports remove their staged records. Server-imported viewer media receives fresh local IDs so cleanup cannot delete or overwrite existing media. Account ownership remains guarded through asynchronous import preparation in all three apps, including RolePlayScene replacement confirmation.
- A newer authentication failure suppresses an older successful read. Same-account valid concurrent checks can finish; a verified account change invalidates earlier read continuations and clears cached server rows/pagination. Local content remains intact. A superseded RolePlayScene direct-link read returns its still-active loading screen to a retryable error rather than leaving it spinning.
- Structured `FORBIDDEN`/`PERMISSION_DENIED`, service failures and network failures do not initiate login recovery. ZIP artifact reads preserve explicit structured permission-denied codes before applying the legacy gateway/authentication fallback. Classification uses structured data, not translated text. The legacy API client's broad flags and mutation/provider classification remain unchanged.
- A repeated authentication failure after recovery is returned to the surface; it cannot create an unbounded retry loop. No POST, DELETE, microphone capture or provider call is passed to this read helper.
- List failure is distinct from successful empty results. Editor draft failures now have inline error state and hide obsolete slot counts. Existing RolePlayScene failure surfaces and viewer errors are retained. A successful current viewer attempt-list recovery clears its intermediate authentication error. RolePlayScene discussion-discard confirmation takes pointer and keyboard priority over an open server manager; Cancel restores focus without closing the manager.

## Blocked popup and same-tab return

A blocked popup offers another explicit attempt or same-tab sign-in. Before same-tab navigation, the adapter saves local work. Persistence failure stops navigation and leaves an explanation in the prompt. Canceling while persistence is pending prevents subsequent navigation.

The return uses the existing tab-scoped pending-intent store. It stores only an allowlisted read kind, resource ID, selected search filters, local context and known account subject. An unrelated pending mutation intent is not overwritten. A matching nonce, app and fifteen-minute expiry are required; the return is consumed once. A known account or local-context mismatch prevents automatic continuation. Saved filters are allowlisted again on consumption. Launch query parameters are removed from the return URL so the stored read is not also replayed by ordinary direct-link bootstrap. No cookies or tokens are stored.

Editor and viewer reuse local draft/attempt save paths. Viewer active or recoverable voice work blocks same-tab navigation; finish or discard that work, or use popup sign-in. RolePlayScene exposes a bounded `flushForNavigation` on its existing persistence cleanup handle. It waits for prior writes and saves current edits before navigation. RolePlayScene discussion text or pending discussion work prevents same-tab navigation because that work does not yet have a complete durable recovery contract; popup sign-in remains available. Direct published playback does not create a local authoring draft solely for authentication.

The route continues to use the deployment's existing `auth=1` OIDC entry. Real deployment acceptance must verify that gateway behavior; local routing simulations do not establish VPS/OIDC configuration.

## Deliberate boundaries

Upload, publish and deletion preparation is now documented in [Authentication for server mutations](authentication-mutations.md). Audio/transcription/rewrite execution policies are not migrated yet. Existing conflict/slot recovery, upload receipts, deletion uncertainty and explicit mutation confirmation remain in place; old viewer upload intents now return guidance without replay. The shared probe owner protects those callers from stale probe results, but this PR does not claim their complete future authentication policy is implemented.

Local content conversion remains in existing app code. Existing replacement confirmations and package validation must remain intact. Do not move those operations into the retried read callback.

## Verification

Run the full Node suite and retained-product browser smoke suite, including `read-auth-flow-smoke.mjs`. Shared tests cover bounded retry, forbidden/service failures, account changes, concurrent callers, stale success after a newer failure, post-download account changes, cancellation during validation and storage, preservation of existing media, replacement-confirmation races, prompt cancellation, popup retry, persistence ordering and return validation. Browser simulations cover contextual cancel, popup continuation and same-tab return across all three apps in English/Traditional Chinese and desktop/mobile layouts.

Before merge, deployed acceptance must verify the exact revision, real OIDC login, blocked-popup recovery, save/reload preservation, expiry between preflight and the read, both concurrent response orders and existing mutation/provider behavior. Record passing cases as text/JSON; screenshots are needed only for failures or ambiguous visual results.
