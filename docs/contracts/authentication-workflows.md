# Authentication workflows: implementation map and agreed target

Mapping baseline: main `980e131d580876bdbf2415a4b79359a3a5aefbce`, reviewed 2026-10-18 (Asia/Hong_Kong). This document has two distinct roles: sections 1–3 preserve the pre-migration mapping at that baseline; sections 4–7 define the agreed target and migration plan. **For the current read integration, see [Authentication for server reads](authentication-reads.md).** The remaining target is staged below; this baseline map is not a claim that those original entry paths remain unchanged.

This is the maintained reference for authentication behavior across the worksheet editor, learner viewer and RolePlayScene. The [popup/message contract](../message-contract.md) remains authoritative for callback validation and launch protocols. The [server runtime reference](../operations/server-runtime.md) owns the endpoint inventory and deployment configuration. Neither is replaced here.

## 1. Scope and boundaries

All product resource APIs require authenticated identity, including publication searches and published artifacts. “Published” does not mean anonymous access. The API enforces identity and resource ownership independently of frontend checks. `/healthz` is an intentional unauthenticated operational endpoint. Session discovery must remain usable to determine that login is required.

The separate same-origin rewrite bridge supplies text-to-audio, transcription and rewrite. Its authentication responses must be handled by these clients, but its backend implementation and OIDC/proxy configuration are outside this repository. A successful worksheet session check does not guarantee the next bridge request succeeds.

Local authoring, local save/reload, ZIP import/export, locally available playback, answer editing, local discussion text and printing do not acquire a login requirement. Retrieving missing server content does. Copying a known publication URL needs no server request; following it requires authentication. CLI maintenance is not an interactive browser-login feature.

## 2. Baseline implementation map (before migration)

Symbols below identify source paths to inspect when integrating; line numbers intentionally are not fixed. Shared session methods are not the whole workflow: trace their UI callers and response handlers too.

### Editor

Source: [editor/main.js](../../server/editor/main.js).

| Feature / route family | Current entry and checking | Current continuation / failure handling |
| --- | --- | --- |
| Server draft upload: `POST /drafts/upload` | `syncDraftBtn` disabled unless ready; click checks `ensureServerSessionReady`, then `runUploadRecoveryFlow` / `uploadCurrentDraftToServer`. | Initial auth failure stops; separate Sign in button. Attempted upload failure does not silently replay. |
| Manage drafts: `GET /drafts` | `manageUploadedDraftsBtn` disabled unless ready; `guardServerMenuAction` preflights. Manager calls `loadUploadedDrafts({preflight:false})` after the guard; Refresh also skips preflight. | Errors use notifications; the manager's rows/slot count do not have a complete independent load-error state. |
| Open/download draft or publication artifact | `reopenUploadedDraftAsLocalCopy`, `reopenPublishedPackageAsLocalCopy` use bounded session checks and package loading; server-dependent controls use ready state. | Failed preflight stops; package/context guards prevent stale content application. Preserve replacement confirmation and local content. |
| Publish uploaded draft: `POST /published` | Publish control disabled unless ready; guard and `publishUploadedDraftToServer` preflight. | Errors stop or enter existing publish conflict handling; successful publication and subsequent refresh are distinct outcomes. |
| Browse publications: `GET /published` | Entry disabled unless ready; `guardServerMenuAction` and `runPublishedSearch`. | Inline error/loading/empty states; request ownership suppresses obsolete search results. |
| Delete draft/publication | Row controls gated by ready state; `deleteUploadedDraft` / `deletePublishedPackage` use shared deletion flow with confirmation and session preflight. | One DELETE; no replay on uncertainty. Refresh failure does not negate confirmed deletion. |
| Generate prompt/option audio: bridge `/t2a` | Eligibility/busy state determines button availability, not just login. Click paths check session before `triggerProtectedAction`; generation uses `generateAudioTrack` or existing T2A handlers. | Initial session failure reports guidance and stops. Existing `SharedAuthGate` intent recovery can replay validated targets in its separate flow. This is not yet the target's uniform explicit-after-login execution policy. |
| Explicit Sign in | `beginServerSignIn` uses `startAuthPopupFlow`. | Fresh verification, flow-owned callbacks and draft-list refresh; distinct from protected-action redirect recovery. |

### Viewer

Source: [viewer/main.js](../../server/viewer/main.js); voice behavior also uses [answer-voice-workflow.js](../../server/viewer/answer-voice-workflow.js).

| Feature / route family | Current entry and checking | Current continuation / failure handling |
| --- | --- | --- |
| Browse published worksheets: `GET /published` | Landing control becomes “Login to browse”; `showPublishedPackagesBrowseModal` can start popup login. `browsePublishedPackages` uses `preflightPublishedSession`. | Dialog has sign-in, error, loading and empty states; successful login can load the requested list. |
| Open publication, including direct URL | `startFromPublishedPackage` checks session; bootstrap has dedicated publication authentication-recovery UI. | Selected resource can open after login. Preserve package loading/cancellation and URL-return behavior. |
| Manage attempts: `GET /attempts` | Landing “Login to manage” starts popup flow. `showUploadedAttemptsManagerModal` has sign-in controls. `listUploadedAttempts` checks cached `logged_in` state rather than always probing. | Inline signed-out/error states. A list/API failure and a session probe do not currently have identical state-transition behavior. |
| Open/download attempt artifact | `resumeUploadedAttempt` and `downloadUploadedAttempt` retrieve artifacts; no new per-action session preflight is imposed on these existing paths. | API errors reported; local resume/open checks remain separate. Do not confuse local attempt resume with server retrieval. |
| Upload attempt: `POST /attempts/upload` | Upload remains clickable subject to operation state; `triggerProtectedAction('uploadAttemptPackageAfterLogin')` uses `SharedAuthGate`. | Pre-POST login recovery may resume once. After an attempted upload fails, explicit Save is required; no automatic login replay of that failure. |
| Delete uploaded attempt | `deleteUploadedAttemptAndRefresh` uses shared deletion coordination, without a session preflight. | Server authorizes DELETE. Errors are reported; no automatic DELETE retry. This intentional current policy differs from editor/RolePlayScene. |
| Voice transcription / rewrite | Shared voice workflow calls `ensureServerSessionReady`, then bridge `/transcriptions` or `/rewrite`. | Preserves recovery text and applicable in-memory audio; explicit retry/sign-in affordances. Superseded preflight exits without fabricating auth failure or opening the microphone. |
| Explicit Sign in / return | `beginServerSignIn`, popup overrides, auth-return bootstrap and `SharedAuthGate`. | Existing popup and redirect paths coexist. Preserve their ownership checks during consolidation. |

The viewer has no publication-creation workflow and no server-side draft manager.

### RolePlayScene

Sources: [main.js](../../server/roleplayscene/scripts/main.js), [editor.js](../../server/roleplayscene/scripts/editor/editor.js), [discussion-state.js](../../server/roleplayscene/scripts/player/discussion-state.js).

| Feature / route family | Current entry and checking | Current continuation / failure handling |
| --- | --- | --- |
| Upload draft: `POST /roleplayscene/drafts/upload` | Toolbar remains clickable when signed out; `uploadCurrentProjectToServer` probes session. | Guidance and stop on initial failure; separate Sign in button. Existing conflict/slot recovery retains snapshot ownership. |
| Manage drafts: `GET /roleplayscene/drafts` | `loadUploadedRolePlaySceneDrafts` checks session before opening manager. | Signed-out initial access stops without a dialog. Existing-manager refresh failure replaces rows/slot count with inline feedback. |
| Browse publications: `GET /roleplayscene/published` | `loadPublishedRolePlaySceneScenes` checks session before opening browser. | Same signed-out stop behavior. Pending controls synchronized; failures show inline feedback in existing dialog and invalidate pagination. Only successful empty reads show no results. |
| Open draft / editable publication copy | `openUploadedRolePlaySceneDraft` uses bounded/cancellable session and artifact waits. | Existing project-replacement and import ownership remain authoritative. |
| Published playback / direct link | `openPublishedRolePlaySceneById`, direct-launch controller and URL identity. | Direct launch has dedicated sign-in recovery; ordinary browse/open probes first. Superseded preflight does not render a false direct-launch error. |
| Download draft/publication artifact | `downloadUploadedRolePlaySceneDraft`, `downloadPublishedRolePlayScene` preflight. | Failure reports guidance and stops; no automatic login popup from these ordinary actions. |
| Publish draft: `POST /roleplayscene/published` | `publishUploadedRolePlaySceneDraft` reserves flow, gathers confirmation/metadata and checks session. | Current failure reports guidance; superseded check exits quietly. Preserve publication conflict semantics. |
| Delete draft/publication | Shared deletion flow with app confirmation, session preflight and context ownership. | One DELETE. Slot recovery resumes only on confirmed current deletion; its direct continuation deliberately adds no extra list read. |
| Generate dialogue audio | Editor checks `ensureServerSessionReady` before bridge `/t2a`; owns line/project context. | Explicit action after login; obsolete context/results cannot attach audio. Superseded preflight exits quietly. |
| Discussion voice/rewrite | `RolePlaySceneDiscussionSession` injects session checking and Sign in into shared voice workflow. | Same shared recovery and supersession rules as viewer; UI and discussion lifecycle remain app-specific. |
| Explicit Sign in | `startServerSignIn` uses shared popup helper. | Direct-launch continuation is special; ordinary failed manager actions are selected again after login. |

RolePlayScene's probe currently has bounded independent requests. Its global session-state owner is distinct from an action's lifetime: concurrent current actions can continue only after compatible same-account results, without allowing old results to overwrite newer failure/account state. Do not simplify this into “latest check cancels every earlier action.”

## 3. Shared components and known integration gaps

| Component | Current responsibility / constraint |
| --- | --- |
| [session-readiness.js](../../server/app/auth/session-readiness.js) | Normalizes readiness, bounded probes and waiting. Unbounded callers can share an in-flight probe/cache; bounded callers own their request. Preserve timeout and late-response protections. |
| [auth-popup-flow.js](../../server/app/auth/auth-popup-flow.js) | Popup ownership, validated callback, polling/deadlines and fresh verification. Callback receipt alone is not login success. |
| [shared-auth-gate.js](../../server/app/auth/shared-auth-gate.js) | Editor/viewer persisted protected intents, local-record restoration and redirect replay. Requires record identity; cannot be applied unchanged to a browse action that has no local record. |
| [server-api-client.js](../../server/app/api/server-api-client.js) | Resource and bridge requests, credentials, structured failures and transport details. Currently marks HTTP 401 and 403 as requiring sign-in, including explicit structured `FORBIDDEN` responses. |
| [error-presentation.js](../../server/app/api/error-presentation.js) | Shared localized presentation. Classification and control flow must use codes/state, never translated text or English-message matching. |
| [answer-voice-workflow.js](../../server/viewer/answer-voice-workflow.js) | Shared viewer/discussion recording, rewrite, recovery and cancellation. Its folder does not imply viewer-only ownership. |

Gaps to address in later PRs: different signed-out affordances; inconsistent per-request expiry recovery; broad 403 classification; duplicated app session orchestration; record-based automatic replay versus the agreed mutation policy; account-bound invalidation of server lists/intents; and deliberate popup-blocked fallback. These are migration tasks, not claims that every path is currently defective or that the target already exists.

## 4. Agreed target behavior (partially implemented; see staged status below)

### Entry and login

1. Keep protected features discoverable and clickable when signed out. Operation-busy, invalid-input and unavailable-content states can still disable controls for their own reasons.
2. Selecting a protected feature requests session readiness. If authentication is required, show contextual Sign in / Cancel guidance in the relevant surface. Avoid stacking prompts. The standalone Sign in button starts login directly.
3. Reuse the shared OIDC popup protocol. A blocked popup offers explicit retry or same-tab sign-in; preserve required local work before navigation. If persistence fails, stop and explain rather than navigate and lose work.
4. Verify readiness after login. Distinguish sign-in required, permission denied, service/network failure, cancellation and stale context. Network failures must not launch login. Explicit permission denial must not cause a login loop; retain evidence-based handling for OIDC HTML/redirect responses.
5. One coordinated login flow per app instance; additional current intents may subscribe without opening competing popups. Every intent has its own ownership and cancellation. This is not a promise of a cross-tab singleton. Each tab must verify session/account identity before continuing.

### Continuation policy

| Requested operation | After successful login |
| --- | --- |
| Browse/search/refresh a server list | Automatically load only if its originating feature/filter context is still current. |
| Explicitly selected open/download/direct link | Continue if resource/context remains valid. Retain any existing confirmation before replacing unsaved local work. |
| Upload, publish, delete | Restore the prepared action; require its normal explicit execution/confirmation. Do not send automatically because login finished. |
| Audio generation, transcription or rewrite | Preserve recoverable work and offer explicit action/retry. Do not silently start capture or a provider request. |
| Explicit account Sign in with no pending action | Update account/session UI; do not invent a server action. |

An upload retry already authorized by the existing conflict/slot coordinator is distinct from replay after authentication. Preserve [snapshot](upload-snapshots.md), [upload recovery](upload-recovery.md) and [deletion](deletion-lifecycle.md) contracts. An uncertain mutation requires its existing reconciliation process; login success is not evidence that it failed or can be resent. Never queue an uncertain DELETE for automatic replay.

### Ownership, expiry and account identity

- Validate current operation, local record/project generation, resource ID and applicable dialog/filter revision after asynchronous boundaries.
- Closing/canceling invalidates the corresponding continuation, not unrelated valid actions. Closing one subscriber does not cancel login needed by another.
- Keep global session-state ownership separate from per-action validity. Concurrent same-account checks must not falsely cancel valid work. Older success cannot bypass newer authentication failure or account change.
- Do not interrupt local work on expiry. On the next protected action or an explicit API auth failure, expose contextual recovery and preserve local content.
- On confirmed loss of authentication, hide private server rows rather than present them as current. On authenticated network failure, retained rows must be explicitly marked as previously loaded; alternatively show an error state without rows. An empty success state requires a successful empty response.
- If verified account identity (`sub`) changes, invalidate prior-account server lists, pagination, operation receipts/continuations and pending server actions. Preserve local worksheets, attempts and stories. User must explicitly select any new upload/publication action under the new account.
- Same-tab return intents must be minimal, validated and account/context-bound; never persist cookies/tokens. Reuse existing local recovery storage deliberately, rather than introduce a competing journal.

### Presentation boundary

Share session classification, coordination and continuation rules. Keep editor authoring, viewer learner and RolePlayScene presentation distinct. All new guidance uses existing English/Traditional Chinese localization infrastructure and the selected language. App adapters own focus, placement, accessibility and actionable error display; shared code must not embed module-specific DOM or compare translated messages.

## 5. Implementation sequence

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | This code-backed mapping and target contract; centralized index link. | Merged in #318. |
| 2 | Shared classification/session coordination with compatibility adapters; reuse popup/readiness helpers. Preserve existing UI until migrated. | Foundation merged in #319; editor/viewer silent ownership adapters integrated with reads. |
| 3 | Migrate browsing/managers/open/download across all three apps; account-bound lists and contextual prompts. | Implemented in the read integration; deployed acceptance pending. |
| 4 | Migrate upload/publication/deletion entry and post-login confirmation; retain existing mutation coordinators. | Planned. |
| 5 | Migrate audio/transcription/rewrite authentication and recovery, including both shared voice consumers. | Planned. |
| 6 | Remove superseded code only after consumer tracing; update current docs and run cross-app acceptance. | Planned. |

Each runtime PR must state which rows are migrated and which remain current legacy behavior. Do not mark this whole target implemented when only shared helpers exist. Publication creation consolidation (previous PR D) and list/download consolidation (previous PR E) remain separate roadmap work: coordinate overlapping changes and avoid extracting a second conflicting coordinator. This sequence intentionally prioritizes agreed authentication behavior; it does not declare the package/storage refactor finished.

## 6. Verification and acceptance

Required matrix for each integrated feature group:

- Signed out, signed in, probe failure, and expiry between probe and API request.
- Explicit 401, structured permission-denied 403, OIDC HTML/redirect response, 503, network failure and bounded timeout. Verify classification with actual response semantics, not status alone.
- Popup blocked/closed/canceled, bad origin/window/token callback, valid callback plus failed verification, and same-tab persistence failure/return.
- Concurrent actions and both completion orders; current same-account work continues, stale work does not. Cover newer auth failure, account change, and action canceled while waiting.
- Initial manager failure never becomes an empty-success list. Current failure has usable recovery; old failure cannot replace newer UI or session state.
- Local edits, prepared upload snapshots, voice recovery and unsaved replacement confirmations survive authentication handling. No duplicate mutation, microphone activation or provider call on supersession.
- Both languages and desktop/mobile for affected UI. Use actual UI where possible; label component simulations separately.

Start with existing `server/app/auth/*.test.mjs`, RolePlayScene `session-preflight`, `list-feedback`, `published-browser-race`, `delete-modal-ownership` tests, editor/viewer unit tests, and shared voice tests. Extend behavioral coverage rather than relying only on source-string assertions. Relevant browser suites include `roleplayscene-list-feedback-smoke.mjs`, `deletion-lifecycle-ui-smoke.mjs`, `package-sign-in-style-smoke.mjs`, `viewer-voice-smoke.mjs` and `roleplayscene-voice-smoke.mjs` under `scripts/`; inspect available auth/launch smoke coverage for the migrated entry points as well.

Run affected automated suites before deployed acceptance. Real VPS/local-browser acceptance verifies OIDC login and recovery; injected ready/auth/account responses prove controlled behavior, not real account switching. Record exact deployed SHA/file hashes, counts and cleanup. Passing cases can use text/JSON evidence; capture screenshots/video for failures or ambiguous visual behavior. Never expose cookies, private request headers or public debugging ports.

## 7. Completion and unresolved implementation choices

The user-facing behavior above is agreed. Internal helper signatures, probe cache strategy and adapter structure are implementation choices to resolve against code/tests, not new product decisions. Before introducing same-tab fallback, validate the actual return mechanism and persisted-work guarantees against the existing popup/message contract and deployment. Before changing 403 handling, verify bridge and proxy response shapes; a successful worksheet probe is not blanket authorization for another service.

Completion requires every mapped feature to follow its continuation policy, no remaining duplicate authentication implementation without an explicit reason, passing cross-app tests, and updated current references. Backend authorization, OIDC configuration and storage/ownership policy changes are outside this refactor unless separately approved.
