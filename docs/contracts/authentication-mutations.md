# Authentication for server mutations

This stage follows the read integration merged in #320. It implements stage 4 of the [authentication workflow contract](authentication-workflows.md), using the same session/login coordinator as [server reads](authentication-reads.md). It does not change backend authorization, OIDC, storage quotas or package formats.

## Covered actions

| App | Prepared server mutations |
| --- | --- |
| Worksheet editor | Upload current draft; publish an uploaded draft; delete uploaded drafts and publications |
| Learner viewer | Upload current attempt; delete uploaded attempts |
| RolePlayScene | Upload current project; publish an uploaded draft; delete uploaded drafts and publications |

Signed-out users can select available mutation controls. Invalid context, active work and duplicate-action guards still disable or reject actions. Resource rows still require an authenticated read, and publication owner controls retain their existing policy. Audio, transcription and rewrite retain their previous authentication adapters pending stage 5. Local actions remain available without login.

## Preparation and confirmation

`server/app/auth/mutation-auth.js` calls the existing `createReadAuthFlow().ensure()` coordinator. It accepts no transport or replay callback. Reads and mutations share the preflight/login promise, popup validation and fresh session verification.

- Already authenticated: the user's ordinary action/form/destructive confirmation authorizes the request.
- Authentication required: contextual Sign in / Cancel guidance precedes login. A successful login presents a separate, localized Upload, Publish or Delete confirmation. Neither login completion nor a canceled confirmation sends a request.
- Permission denial and unavailable service/network results do not initiate login.
- Preparation consumes the verification-bound guard returned by `ensure({withContext: true})`; it never captures a fresh guard after awaiting readiness. A newer observed sign-out invalidates the prepared result before confirmation or execution.
- After successful preparation, the returned account guard remains part of the app's ownership checks through packaging, conflict/slot choices, requests and refresh. Changing account, replacing the local record, closing the relevant manager or canceling an owned operation prevents stale work from continuing.
- A rejected mutation is not replayed after authentication. An observed authentication failure invalidates private rows/session readiness. The user must select a fresh action. Existing outcome feedback remains visible.

The shared prompt uses existing dialog styling, keyboard handling and English/Traditional Chinese catalogs. Its width includes padding and borders independently of app-level CSS; action buttons wrap on narrow screens. Each app retains its manager, publishing form, upload progress, delete confirmation and notification layout.

## Blocked popup and same-tab return

The existing tab-scoped pending-intent envelope (`kind: read-auth`, `readAuthReturn` nonce) now also accepts a validated `kind: mutation` descriptor. It contains an allowlisted operation, optional resource ID, allowlisted publication form values, local record identity and the previously verified account. The nonce, app, 15-minute lifetime, resource ID and account/local-context checks remain mandatory. Cookies, tokens and mutation transport payloads are not stored.

The existing save-before-navigation path must complete first. Voice/discussion work that cannot be durably restored still blocks navigation. Publication values longer than the return descriptor's 2,000-character field limit block navigation instead of being silently truncated; popup sign-in remains available.

On return, the app restores local work, displays guidance and opens the relevant manager when applicable. Publication title/subject/description are used to seed the matching form when the user selects Publish again. **No POST or DELETE runs on return.** Viewer return guidance is rendered on both the start screen and an active attempt. Account/context mismatch, failed session verification and return exceptions display an explanation without replaying the action. A delayed viewer return check cannot reopen a manager or publish guidance after the local attempt is replaced; canceled or superseded checks remain silent. The user selects and confirms the intended action again; deletion is never automatically resumed. An older viewer `uploadAttemptPackageAfterLogin` intent also stops at guidance instead of replaying its upload.

## Existing recovery boundaries

[Upload snapshots](upload-snapshots.md), [conflict/slot recovery](upload-recovery.md), receipt reconciliation, cancellation and [deletion uncertainty](deletion-lifecycle.md) remain authoritative. Authentication does not mean an uncertain request failed. No automatic retry is added for network errors, lost responses or DELETE uncertainty. Explicit conflict/slot choices continue within their original prepared upload and account context.

## Validation and deployment acceptance

Automated coverage includes shared preparation/recovery tests, application mutation ownership tests, cross-app upload auth browser simulations and existing upload/deletion/provider regression suites. Browser simulations intercept isolated fixture requests; they do not establish that deployed OIDC works.

Before merge, deploy the exact PR commit and verify all three apps in English and Traditional Chinese:

1. Signed-in upload/publish/delete still succeeds, including conflict/slot choices and cancellation.
2. Signed-out upload and expiry before publish/delete offer Sign in / Cancel. Cancel sends no mutation. Login alone sends no mutation; the explicit confirmation sends exactly one.
3. Popup blocked: retry and same-tab fallback preserve local work. Return sends zero mutations; a subsequent user action uses the restored local record/form metadata.
4. Close/cancel or replace context during preflight/login/packaging; switch accounts; verify no stale mutation or feedback reaches the new context.
5. Request-level 401 and structured permission 403, network failure and uncertain deletion remain bounded without automatic replay. Verify local work survives.
6. Retest basic reads/managers and provider functions as unchanged consumers. Record SHA, request counts and resource cleanup as text; capture screenshots/video only for failures or ambiguous UI.

### Acceptance coverage boundaries

- Shared prompt geometry is checked in all three apps, both languages, at 320, 390 and 1280 pixels, including the blocked-popup third action and post-login confirmations.
- Slot continuation requires a confirmed deletion. Browser fixtures cover successful deletion, cancellation and connection reset; local HTTP integration checks cover committed deletes with lost/truncated responses and successful deletes followed by failed refresh. These do not diagnose a live proxy or test-forwarding socket failure; deployed editor/RolePlayScene continuation still needs a successful live rerun if forwarding was interrupted.
- RolePlayScene archive inspection must support compressed entries, as its `scripts/utils/zip.js`/`fflate` reader does. The editor's stored-entry-only ZIP helper is not a general RolePlayScene inspection tool.
- RolePlayScene's delete confirmation replaces the manager. After confirmation closes, there is no manager Close button to click during preflight. Test cancellation before confirmation or invalidate the project/account context; do not count a nonexistent Close interaction as executed.
- Active viewer return replacement is tested through `tryResumeAttempt` because that screen has no import/replace control. Start-screen replacement is also tested through its import UI. These are distinct integration/UI coverage claims.
- An authenticated session and popup return do not prove a fresh external OIDC challenge. That remains a deployment check requiring an actual identity-provider sign-in; automated local fixtures do not replace it.
