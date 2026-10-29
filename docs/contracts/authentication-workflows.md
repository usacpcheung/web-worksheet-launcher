# Authentication workflows: implementation map and agreed target

Mapping baseline: main `980e131d580876bdbf2415a4b79359a3a5aefbce`, reviewed 2026-10-18 (Asia/Hong_Kong). This document has two distinct roles: sections 1–3 preserve the pre-migration mapping at that baseline; sections 4–7 define the agreed target and migration plan. **For current integrations, see [server reads](authentication-reads.md), [server mutations](authentication-mutations.md), and [bridge workflows](rewrite-bridge-workflows.md).** The remaining target is staged below; this baseline map is not a claim that those original entry paths remain unchanged.

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
| 3 | Migrate browsing/managers/open/download across all three apps; account-bound lists and contextual prompts. | Merged in #320 after deployed acceptance passed. |
| 4 | Migrate upload/publication/deletion entry and post-login confirmation; retain existing mutation coordinators. | Merged in #321 after deployed acceptance; subsequent CI regression checks passed. |
| 5 | Unify the complete audio/transcription/rewrite request lifecycle, including authentication, cancellation, ownership, outcomes and recovery for both shared voice consumers. | [Shared lifecycle contract](rewrite-bridge-workflows.md); rewrite, transcription and T2A integrations merged through PR #326. |
| 6 | Remove superseded code only after consumer tracing; update current docs and run cross-app acceptance. | Bridge reconciliation and unused-wait cleanup are recorded in [bridge completion](rewrite-bridge-workflows.md#11-completion-reconciliation-and-evidence); this does not claim a repository-wide dead-code audit. |

Each runtime PR must state which rows are migrated and which remain current legacy behavior. Do not mark this whole target implemented when only shared helpers exist. Publication creation consolidation (previous PR D) is implemented by the [shared publication lifecycle](publication-lifecycle.md). List/download consolidation (previous PR E) remains separate workflow-level work, not a missing authentication integration. Their existing shared coverage is marked below. This inventory does not decide the remaining extraction scope or declare the package/storage refactor finished.

### Implemented shared coverage for publication and list/download planning

Code and caller review: main `a8660d5266bfd3aa22a43ed7f0494edcd6c315ae` (PR #328), 2026-10-27. **Implemented** below means the helper exists and is used by the named production consumers. It does not mean every surrounding product workflow is consolidated or that deployed acceptance was rerun for this inventory.

| Coverage already implemented | Shared implementation | Confirmed consumers and responsibility | Boundary retained by callers |
| --- | --- | --- | --- |
| Session classification and coordinated readiness | [session-outcome.js](../../server/app/auth/session-outcome.js), [session-coordinator.js](../../server/app/auth/session-coordinator.js), [read-auth-flow.js](../../server/app/auth/read-auth-flow.js) | Editor, Viewer and RolePlayScene use shared classification, probe ownership and account-bound readiness; concurrent current callers can share login recovery. | Product session UI, context invalidation and local-work preservation remain adapter responsibilities. This is not a cross-tab login singleton. |
| Authenticated server reads | `createReadAuthFlow().read()`; [read contract](authentication-reads.md) | All three products use the coordinator for server lists and selected artifact reads. It handles contextual authentication recovery, bounded read retry and verification-bound account guards. | Callers still own list state, pagination, request/filter ownership, download presentation, validation, import and replacement confirmation. Only the read request belongs in the retry callback. |
| Upload, publication and deletion authentication preparation | [prepareMutation](../../server/app/auth/mutation-auth.js); [mutation contract](authentication-mutations.md) | Editor and RolePlayScene publish/upload/delete; Viewer attempt upload/delete. Shared readiness and explicit post-login confirmation return an account guard before execution. | The helper accepts no transport/replay callback. Publication submission, conflicts, locks and post-success refresh are not coordinated by this helper. Viewer has no publication-creation action. |
| API transport and localized failures | [server-api-client.js](../../server/app/api/server-api-client.js), [error-presentation.js](../../server/app/api/error-presentation.js) | All three products use shared endpoint methods and structured error presentation for server resources; the client also supplies bridge transports. | Resource-specific endpoints, payloads and app feedback remain distinct. A shared client is not a shared publication or list controller. |
| Upload ownership and result classification | [UploadOperationSlot](../../server/app/api/upload-operation-lifecycle.js), [classifyUploadResult](../../server/app/api/upload-result.js) | Worksheet drafts, Viewer attempts and RolePlayScene drafts use shared operation ownership/cancellation primitives and resource-aware upload outcomes. | Adapters reserve/release their operations, guard progress and feedback, and preserve successful outcomes. The slot itself defines no network or retry policy. |
| Upload request identity and uncertain-response reconciliation | [server-api-client.js](../../server/app/api/server-api-client.js), [upload-operation-contract.js](../../server/app/api/upload-operation-contract.js); [request identity](upload-snapshots.md#request-identity) | All three ZIP upload routes share fingerprint/operation-ID handling and bounded receipt lookup after eligible uncertain responses. Lookup does not resend the ZIP. | This is upload recovery, not a publication or deletion receipt mechanism. Authentication recovery cannot authorize resending an uncertain mutation. |
| Explicit upload conflict and slot recovery | [runUploadRecoveryFlow](../../server/app/api/upload-recovery-flow.js); [recovery contract](upload-recovery.md) | Worksheet drafts, Viewer attempts and RolePlayScene drafts share the loop for explicit copy/replace choices and confirmed slot deletion. | Package creation, authentication, dialogs, deletion and list presentation remain outside the helper. Stable prepared ZIP bytes/metadata are already preserved by the adapters as documented in [upload snapshots](upload-snapshots.md). |
| Server-resource deletion lifecycle | [runDeletionFlow](../../server/app/api/deletion-flow.js); [deletion contract](deletion-lifecycle.md) | All five deletion adapters: worksheet drafts/publications, Viewer attempts, RolePlayScene drafts/publications. Shared reservation, confirmation/preflight, DELETE outcome and independent refresh outcome. | Local record deletion, backend artifact cleanup, publication creation and upload are outside this coordinator. No automatic DELETE replay or receipt lookup. |
| AI request lifecycle | [runProviderRequest](../../server/app/bridge/provider-request.js), [runAudioGeneration](../../server/app/bridge/audio-generation.js); [bridge contract](rewrite-bridge-workflows.md) | Viewer answers and RolePlayScene discussions share rewrite/transcription through `createVoiceWorkflow`; Editor prompt/option and RolePlayScene dialogue generation share T2A handling. Authentication, cancellation and stale/account-bound outcomes are implemented. T2A has separate preparation/provider deadlines and per-target Cancel. | Product recording/recovery UI and attachment/application remain adapter-owned. These helpers do not coordinate resource publication or artifact downloads; T2A deadlines do not impose new rewrite/transcription deadlines. |
| Worksheet publication search normalization, limited reuse | [published-packages-service.js](../../server/app/api/published-packages-service.js) | Viewer uses filter/pagination serialization, worksheet row normalization and page merging. | Editor calls `listPublishedPackages` directly; RolePlayScene uses its own list adapter. This existing helper is not evidence of completed cross-product list consolidation. |
| Existing file/package reuse | [worksheet-package.js](../../server/editor/worksheet-package.js), [zip-utils.js](../../server/editor/zip-utils.js), [audio-tracks.js](../../server/editor/audio-tracks.js); [runtime ownership](../architecture/runtime.md#shared-dependencies) | Worksheet package/ZIP helpers are reused by Viewer and backend worksheet services; audio-track helpers are reused by Viewer. Existing package validation and compatibility remain in use. | RolePlayScene keeps its own package/storage path and compressed ZIP support. Browser file saving, loading progress, import application and local replacement are not one shared lifecycle. See [package formats](package-formats.md). |

Production caller anchors for this inventory:

- [Editor](../../server/editor/main.js): `publishUploadedDraftToServer`, `loadUploadedDrafts`, `downloadWorksheetArtifact`, `runPublishedSearch`, `ensureMutationSessionReady` and the upload/deletion adapters.
- [Viewer](../../server/viewer/main.js): `listUploadedAttempts`, `downloadUploadedAttempt`, `browsePublishedPackages`, `startFromPublishedPackage`, `ensureMutationSessionReady` and the upload/deletion adapters.
- [RolePlayScene](../../server/roleplayscene/scripts/main.js): `publishUploadedRolePlaySceneDraft`, `loadPublishedRolePlaySceneScenes`, `loadUploadedRolePlaySceneDrafts`, `downloadPublishedRolePlayScene`, `downloadUploadedRolePlaySceneDraft` and `ensureMutationSessionReady`.
- Bridge consumers: [shared learner voice workflow](../../server/viewer/answer-voice-workflow.js), [RolePlayScene discussion adapter](../../server/roleplayscene/scripts/player/discussion-state.js) and [RolePlayScene audio editor](../../server/roleplayscene/scripts/editor/editor.js), alongside Editor audio generation.

For PR D/E planning, mark authentication, transport/error presentation and the applicable existing upload/deletion/bridge responsibilities above as **already implemented and to be reused**. Publishing, browsing and downloading are existing working features; their roadmap labels refer to possible further workflow consolidation. The following step 2 assessment identifies extraction candidates and the product differences that constrain them; neither this inventory nor that assessment closes either roadmap item.

Verification for this inventory is static source/caller tracing and documentation link/scope checks. Existing regression evidence remains in the linked feature contracts; no runtime suite or live OIDC/provider acceptance is claimed by this documentation update.

### Remaining duplication worth sharing

The publication recommendation below is now implemented by the [shared publication lifecycle](publication-lifecycle.md). The assessment records the original extraction rationale; worksheet page-helper reuse and browser file saving remain separate work.

Step 2 assessment against the same runtime baseline, 2026-10-27. These are recommendations for subsequent implementation, not new helpers or changed runtime behavior. Existing functionality and previously implemented shared coverage remain intact.

| Candidate and recommendation | Repeated production behavior | Smallest useful shared boundary | Why it warrants sharing; constraints |
| --- | --- | --- | --- |
| Publication lifecycle: recommend a focused extraction | Editor `publishUploadedDraftToServer` plus its manager Publish handler repeat RolePlayScene `publishUploadedRolePlaySceneDraft`: reserve a flow, gather metadata, prepare authentication, check ownership, submit, offer explicit edit after a naming conflict, refresh after success, release controls. Editor's conflict loop is in the UI caller; inspecting only the session method misses this duplication. | A publication-specific coordinator over injected metadata/confirmation, existing mutation preparation, submit, explicit conflict decision and refresh callbacks. Preserve the original submission result separately from refresh status. | Repeated asynchronous sequencing is substantial enough to justify one policy implementation. It must reserve the whole UI flow, including dialogs/conflict edits, while preserving direct session-call semantics and current per-app locking. Reuse `prepareMutation`; do not add login logic, upload receipts, automatic publish retries or provider-style deadlines. |
| Worksheet publication page handling: recommend extending reuse of the existing service | Editor `runPublishedSearch` and Viewer `browsePublishedPackages` both construct title/subject/owner queries and interpret items, hasMore and nextOffset, then replace or append rows. Viewer already calls `published-packages-service.js`; Editor repeats these steps inline. | Reuse the existing worksheet filter/page helpers in Editor after characterizing its current response handling. Extract only genuinely resource-neutral page operations for RolePlayScene if needed. | This is a smaller consolidation than a universal list controller. Normalization may add defaults or accept legacy aliases, so adoption must preserve current row/metadata semantics. RolePlayScene identity and metadata must not pass through worksheet-specific row normalization. |
| Browser file saving: recommend a small utility | Viewer `downloadUploadedAttempt` and RolePlayScene `downloadPublishedRolePlayScene` / `downloadUploadedRolePlaySceneDraft` each create a ZIP Blob/object URL, create and click an anchor, remove it and revoke the URL. Viewer delays revocation; RolePlayScene revokes immediately. | Save an already-prepared Blob with a caller-supplied filename; centralize anchor/object-URL cleanup with browser-tested revocation timing and cleanup on exceptions. | This repeated resource lifecycle is a clear small reuse opportunity. Authentication, byte validation, filenames, ownership checks immediately before saving and notifications stay in callers. Triggering an anchor does not prove that the user saved a file; preserve that distinction. Audit other export callers before expanding adoption. |
| Complete list request/state controller: defer broad extraction | Editor and Viewer replace prior request ownership; Editor draft reads also coalesce eligible reads and force fresh reads after mutations. RolePlayScene published browsing rejects overlapping loads. All protect account/context before applying rows and update loading/error/pagination state. | No new controller recommended in this step. Characterize those policies first; a narrowly reusable request-ownership primitive may be useful if it removes real duplication without hiding policy. | Similar code does not establish identical concurrency semantics. A universal controller could accidentally change which requests are admitted, suppress required post-mutation refreshes or show stale rows. Existing `readAuth` already owns authentication recovery and must remain the only such coordinator. |
| Combined download/open/import lifecycle: retain separate adapters | Editor `downloadWorksheetArtifact` resets an idle timer when byte progress advances; RolePlayScene editable-copy loading uses `waitForDraftRequest` with a fixed bound. Opening additionally validates packages, confirms replacement and persists a new local draft/story/attempt. Direct file downloads only trigger browser saving. | Reuse the existing transport/auth/package helpers and the proposed file-save utility. Do not merge these operations into one lifecycle on the present evidence. | Idle versus total timeout, playback versus authoring, worksheet versus compressed RolePlayScene ZIP handling, and replacement/persistence ownership are material differences. Matching fetch calls alone does not justify unifying them. |

#### Publication extraction constraints

The publication candidate has the strongest workflow-level case. Both apps already implement explicit conflict-edit loops, but expose different metadata (`title`/`subject` versus `title`/`description`) and conflict codes (`PUBLISHED_PACKAGE_CONFLICT` versus `ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT`). These stay in adapters. Both apps' manager-level and request-level reservations must be traced together before replacing locks.

Editor currently retains `publishResult` and separately reports a failed refresh; RolePlayScene announces publication success and then awaits its list loader. A proposed common result should retain confirmed submission success independently of refresh, without changing notification placement or reopening a closed manager. Neither publication path should inherit upload receipt lookup or interpret a lost response as authorization to resend. Any new publication uncertainty classification or recovery policy needs its own contract review; it is not implied by extracting common sequencing.

#### Verification required before implementation is accepted

- Publication: duplicate clicks before and during dialogs, cancel, login recovery and explicit confirmation, each naming-conflict/edit loop, stale document/manager/account at every await, confirmed success with failed or superseded refresh, and lost responses without automatic POST replay. Extend Editor session/UI coverage, [RolePlayScene publish tests](../../server/roleplayscene/tests/publish-flow.test.mjs) and [mutation manager browser coverage](../../scripts/mutation-manager-auth-smoke.mjs).
- Page helpers: unchanged query/row semantics, reset versus append after filter changes, empty success versus failed reads, invalidated pagination, reversed response order and fresh post-mutation reads. Retain [published page helper tests](../../server/app/api/published-packages-service.unit.test.mjs), [RolePlayScene race tests](../../server/roleplayscene/tests/published-browser-race.test.mjs) and the affected editor/viewer browser flows.
- File saving: correct bytes/name/MIME, successful browser download event, cleanup after success/exception and no save after invalidated ownership. Exercise both Viewer and RolePlayScene consumers; a mocked anchor click alone is insufficient to establish download behavior.
- Preserve English/Traditional Chinese, desktop/mobile, keyboard/focus behavior and all existing compatibility contracts. Apply the repository's cross-module test requirements when runtime extraction is implemented.

The original recommended implementation order was publication lifecycle first, then the smaller file-save utility and worksheet page-helper reuse as independently reviewable changes. Publication sequencing is now implemented; the latter two remain recommendations. This assessment narrows PR D/E into concrete candidates; it does not approve a broad package/storage rewrite or mark the roadmap items complete. Runtime tests were not rerun for this static assessment.

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
