# Rewrite-bridge workflow map and shared contract

Status: **mapping approved in PR #322; opt-in shared foundation added; app integration pending**.
Reviewed against main `7762c74f63b119baeccaa513f3500746ff7b526a` (merged PR #321).
This document extends stage 5 of the [authentication roadmap](authentication-workflows.md).
It covers the complete provider-request lifecycle, not only sign-in. The mapping PR changed documentation only. The foundation below adds an opt-in
helper and tests; production app adapters have not migrated. No external bridge,
OIDC, database or deployment changes are included.

## 1. Scope and existing ownership

The same-origin bridge is an external service. This repository owns its browser
client and product workflows, not its backend, provider models or live timeout
configuration; see [server runtime](../operations/server-runtime.md).
All three operations already use [server-api-client.js](../../server/app/api/server-api-client.js).
Do not introduce a second transport client or use worksheet upload receipts for
provider requests: this code establishes no equivalent bridge receipt/idempotency contract.

| Operation and consumers | Existing transport contract | Product ownership |
| --- | --- | --- |
| Editor question/option audio, including named-language tracks and legacy audio intents | `generateAudioFromText(text, options, request)` → POST `/api/rewrite-bridge/t2a`; JSON, binary MP3 | Draft, question/option identity, voice selection, replacement confirmation, audio attachment and local persistence |
| RolePlayScene dialogue audio | Same T2A method and endpoint | Project, stable dialogue identity, speaker/voice choice, replacement confirmation and story audio attachment |
| Viewer answer voice; RolePlayScene discussion voice | `transcribeAudio(blob, {signal})` → POST `/api/rewrite-bridge/transcriptions`; multipart `audio` | Recording permission, media coordination, original answer/discussion and recovery persistence |
| Viewer whole-answer/transcript rewrite; RolePlayScene whole-discussion/transcript rewrite | `rewriteText(text, {signal})` → POST `/api/rewrite-bridge/rewrite`; JSON `{text, stream:false}` | Insertion/caret, answer limits, Undo, editable transcript recovery and final application |

Requests include same-origin credentials. Rewrite and transcription normalize
nonempty bridge `result` strings into `data.text`; transcription also returns
selected timing/request metadata. T2A requests specify MP3/binary output and
normalize bytes to `Uint8Array`. Named `voice_choice` cannot be combined with
legacy voice tuning options. Preserve both supported input modes.

Source entry points:

- [Editor main](../../server/editor/main.js): `generateAudioTrack`,
  `replayEditorPromptT2AIntent`, `replayEditorOptionT2AIntent`,
  `triggerProtectedAction` and their UI handlers. Trace both language-track and
  legacy no-language branches; they are supported adapters, not dead code.
- [RolePlayScene editor](../../server/roleplayscene/scripts/editor/editor.js):
  `generateDialogueAudio`; [request wait helper](../../server/roleplayscene/scripts/editor/audio-generation-request.js).
- [Shared voice workflow](../../server/viewer/answer-voice-workflow.js):
  `createVoiceWorkflow`; [recorder](../../server/viewer/answer-recording.js).
  Consumers are [Viewer main](../../server/viewer/main.js) and
  [discussion-state.js](../../server/roleplayscene/scripts/player/discussion-state.js).
- [RolePlayScene main](../../server/roleplayscene/scripts/main.js) supplies session
  checks and sign-in to both authoring and discussion adapters.
- [Shared auth gate](../../server/app/auth/shared-auth-gate.js),
  [session coordinator](../../server/app/auth/session-coordinator.js),
  [session outcomes](../../server/app/auth/session-outcome.js) and
  [error presentation](../../server/app/api/error-presentation.js) are existing
  foundations to reuse, not replace wholesale.

No Editor rewrite/transcription or Viewer T2A production caller was found in this
baseline. Sharing infrastructure does not add these features to those apps.

## 2. Current behavior and differences to preserve

| Area | Current behavior |
| --- | --- |
| Editor audio | Session checks and legacy protected-intent execution; target locks in replay handlers. Named tracks capture source-text hash and draft generation before attachment. Named-language failures preserve structured error fields; legacy no-language failures return only a display message. Requests do not pass an AbortSignal in these callers. |
| RolePlayScene audio | Per-dialogue lock, line identity and disposal checks, source-text/replacement checks, AbortController and a 120-second bound for each awaited session/provider operation. This is not one combined 120-second workflow deadline. |
| Viewer/discussion voice | Already one shared recording → transcription → rewrite workflow. One active operation per workflow instance, cancellation race protection and context/answer snapshot checks. No general provider deadline; pending work remains cancelable. |
| Voice recovery | Transcript is retained before rewrite. Rewrite retry reuses text; it must not transcribe again. Audio retained after transcription authentication failure is memory-only. Reload recovery excludes raw audio and rewritten candidates. |
| Local persistence | Viewer uses attempt recovery/autosave; discussion uses its own session storage and project generation/fingerprint. Authoring attaches assets through each product's existing model. |
| Presentation | Editor authoring, learner answers, dialogue generation and discussion controls remain different. The shared layer must not own their DOM, placement, confirmations or focus. |

Preserve details in [Viewer voice](../worksheet/viewer-voice-workflow.md),
[discussion voice](../roleplayscene/roleplayscene-discussion-voice.md),
[Editor voices](../worksheet/editor-voice-choice.md) and
[RolePlayScene voices](../roleplayscene/roleplayscene-voice-choices.md):
recording/size limits, Unicode rewrite limit, separate answer length limits,
append/caret insertion, Undo, navigation behavior, music/dialogue coordination,
legacy packages and named audio tracks. Navigation is not universally cancellation:
valid background work can remain attached to its original answer or scene.

## 3. Code-backed gaps and proposed resolution

These are source findings and migration risks, not newly reproduced live defects.
They do not establish that every affected user journey currently fails.

| Finding and trigger | Evidence / consequence | Proposed resolution |
| --- | --- | --- |
| Editor named-language T2A returns an authentication error after preflight | The named-language branches of `replayEditorPromptT2AIntent` and `replayEditorOptionT2AIntent` preserve `result.error`. `triggerProtectedAction` uses the legacy gate's default recovery, so a recognized authentication failure can queue recovery and later replay a valid stored intent. | Restore work and offer explicit Generate/Retry after verified login; never automatically resend a provider request on login return. Cover existing pending intents too. |
| Editor legacy no-language T2A returns an authentication error after preflight | Both replay handlers replace the transport error with `{ message }`. The gate loses status, code and `requiresSignIn`, cannot classify this result as authentication-related, and therefore does not queue recovery/replay for this failure. A localized sign-in message alone is not structured authentication handling. | Preserve structured failure fields and integrate contextual sign-in guidance with explicit Generate/Retry. Change the continuation policy in the same migration: restoring fields alone could enable the old automatic replay path. |
| Permission-denied bridge response resembles signed-out state | Binary transport classifies 401/403 before parsing the error body; voice `errorCode` also treats 403 as authentication. The presenter can recognize `FORBIDDEN`, but cannot recover a distinction already lost upstream. | Preserve structured permission codes before legacy auth fallback. Test actual bridge/proxy shapes; a successful worksheet session probe alone does not prove bridge permission. |
| Cancellation/transport outcomes differ by operation | T2A fetch rejection becomes `NETWORK_ERROR`; rewrite with/without a signal intentionally retains different legacy failure behavior in existing tests. | Characterize first, then migrate callers to a consistent structured outcome through compatibility adapters. Distinguish cancellation, timeout, network failure and malformed response. |
| A request stalls | RolePlayScene dialogue has bounded waits; Editor T2A and shared voice have different cancellation/deadline coverage. | Share waiting/cancellation mechanics, with explicit per-operation deadline policy. Preserve existing bounds until deployment evidence supports changes. |
| Account changes while generation runs | Shared voice validity covers attempt/project, target, editability and answer snapshot, but has no account subject in its context contract. Local content guards are not an account-generation guard. | Bind new operations to verified session generation and subject; invalidate continuation/application on observed account change without deleting local work. Test adapters as well as the helper. |
| Diagnostics differ between methods | Transcription sanitizes failures; rewrite can retain response previews in structured details. Shared voice selects a safe diagnostic whitelist. | Use a safe common diagnostic shape; keep text, audio, raw HTML, cookies and authorization data out of new logs/UI/persisted intents. Do not assume every existing preview is user-visible. |

Changing auth classification must retain evidence-based handling of OIDC HTML or
redirect responses. Do not blindly classify all non-JSON failures as sign-in, or
all 403 responses as permission denial. Unknown provider messages use localized
operation-level guidance; the external bridge may continue returning English.

## 4. Target contract

### Shared responsibilities

1. Validate input through the operation adapter, acquire the appropriate owner,
   and check session readiness before capture or a provider request.
2. Use the existing session/popup infrastructure and contextual Sign in / Cancel
   guidance. A callback is not proof of readiness. A network error does not open
   login. Login completion restores readiness, not permission to replay work.
3. Capture operation ID, target/content generation and verified account identity.
   Recheck ownership after asynchronous boundaries, including response body reads
   and before local application. Discard stale results without replacing newer UI
   or session state. Do not let one action invalidate unrelated valid actions.
4. Forward AbortSignal, settle canceled/timed-out work promptly even when a
   dependency ignores cancellation, consume late rejections and release owned
   locks/listeners. Canceling the browser wait does not undo server processing.
5. Normalize success and failures without translating strings in control flow.
   Distinguish authentication, permission, cancellation, timeout, transport,
   rate/size limits, malformed/empty output and upstream failure. Reuse the
   existing localization presenter with an operation fallback.
6. Never automatically retry a provider POST after an uncertain response. Offer
   explicit retry with preserved input and guidance that the earlier request may
   have completed. No upload receipt lookup, invented idempotency key or billing
   guarantee without an external bridge contract.
7. Apply output only through the owning app adapter. Preserve existing automatic
   insertion after a successfully authorized voice run; explicit post-login retry
   does not imply adding a new preview/confirmation to every successful result.

The common lifecycle should be small and composable. It must not become a second
voice pipeline, a generic product state store or a new authentication journal.
Exact helper names/signatures are implementation choices after characterization.

### App adapter responsibilities

- Input/voice selection and product limits; microphone/media coordination.
- Which actions may run concurrently and which target is locked. Preserve current
  concurrency initially rather than imposing a global three-app queue.
- Context revisions and current-input checks, replacement consent, attachment,
  Undo and local persistence/recovery.
- Distinct UI, accessibility/focus, selected-language messages and retry controls.
- Same-tab preservation through existing storage. If work cannot be saved, stop
  navigation with guidance; never silently discard memory-only recorded audio.

A confirmed session/account change invalidates pending execution, not local
worksheets, attempts or stories. The browser cannot detect every remote account
change instantly; readiness and API failures remain necessary validation points.

## 5. Decisions and implementation sequence

Already agreed: share the full request lifecycle; preserve distinct UI and content
models; use explicit provider action after login; retain local work; no automatic
paid/request replay; keep external service/configuration changes out of this refactor.

Before selecting new timeout values, obtain the actual proxy/bridge limits and
observed slow-call behavior. Until then, retain RolePlayScene's current bound and
make proposed new limits explicit for review. New automatic retries, a cross-tab
request queue, persistent audio recovery or bridge backend changes require a
separate decision; they are not prerequisites for this work.

| PR | Deliverable and boundary | Gate |
| --- | --- | --- |
| Mapping (merged #322) | Current call graph, differences, risks and target contract; documentation only | Approved and merged |
| Shared foundation (implemented opt-in; see section 7) | Characterization tests for all three endpoints; common outcome/cancellation/ownership mechanics and provider auth preparation using existing helpers. Keep legacy call signatures until migrated. | Behavioral tests for old adapters and new contract; no unannounced consumer behavior change |
| T2A integration | Migrate Editor prompt/option named and legacy paths plus RolePlayScene dialogue as one consumer group; explicit post-login retry and safe attachment | Both authoring apps, replacement/source-change races, real login and audio acceptance |
| Voice/rewrite integration | Migrate the existing shared pipeline and both Viewer/discussion adapters together; account binding and agreed deadline policy; preserve recording and recovery | Both consumers, microphone/Undo/navigation/recovery and provider acceptance |
| Completion cleanup | Remove only proven superseded paths, reconcile feature docs and verify all production callers | Full affected regression and cross-app acceptance; fold into integration if small and safe |

Each runtime PR must work independently and preserve unmigrated callers. Prefer
merging an accepted dependency before the next integration; if stacked for review,
merge in dependency order and retest the final combination. The sequence does not
reopen package/storage behavior or authorize unrelated large-file decomposition.

## 6. Verification and completion

Automated tests use isolated fixtures and synthetic provider responses, not paid
live calls. Start with `server/app/api/server-api-client.voice.unit.test.mjs`,
`server/viewer/answer-voice-workflow.unit.test.mjs`,
`server/roleplayscene/tests/discussion-voice.test.mjs`, Editor audio tests and
`server/app/auth/*.test.mjs`. Extend behavior checks at real adapters, not just
source-string assertions.

Required cases across applicable consumers:

- Characterize named-language and legacy no-language Editor failures separately;
  after migration, both preserve authentication classification and require an
  explicit provider action after login. Restoring error fields must not introduce
  automatic replay in the legacy path.
- Signed out, ready, probe failure, expiry after preflight, explicit forbidden,
  OIDC HTML/redirect, invalid JSON/MIME, empty output, 413/429/5xx and offline.
- Canceled/blocked popup, failed callback verification, same-tab save failure and
  return; no microphone activation or provider POST merely because login succeeds.
- Cancellation before send, during body read and after server success; stalled
  transport ignoring abort; late resolve/reject; correct lock release.
- Double-click and concurrent targets; reversed completion order; changed text,
  target removal, reused IDs, replaced draft/story, completed attempt and observed
  account change. No stale attachment/insertion or newer-state overwrite.
- Transcription success followed by rewrite failure: retained editable transcript,
  rewrite-only explicit retry, reload/discard/Undo and local persistence failure.
- Named voice and legacy audio compatibility, prompt/option/dialogue replacement,
  both languages and existing voice/media navigation behavior.

Run `npm test` and applicable `scripts/editor-voice-choice-smoke.mjs`,
`editor-option-audio-smoke.mjs`, `roleplayscene-voice-choice-smoke.mjs`,
`viewer-voice-smoke.mjs` and `roleplayscene-voice-smoke.mjs` for runtime changes.
Broaden to the retained-product suites for final cross-module cleanup.

Deployed acceptance must record exact SHA, real OIDC and microphone/provider
results, controlled network cases and test-data cleanup. A signed-in success does
not prove expiry or lost-response behavior. Use the local full Playwright context
for interception; text/JSON evidence is sufficient for passing cases, with images
for failures/ambiguous UI. Do not extract credentials or expose debugging ports.
Live provider calls and production test mutations need their applicable authorization.

Completion means all mapped callers use the reviewed lifecycle, intentional
adapter differences are documented, obsolete paths are removed only after caller
and saved-intent tracing, and automated plus deployed acceptance passes. This
mapping alone does not claim that outcome or certify the external bridge.


## 7. Shared foundation API (app integration pending)

[provider-request.js](../../server/app/bridge/provider-request.js) exports
`runProviderRequest({auth, request, intent, signal, isCurrent, timeoutMs})` and
`normalizeProviderResult(result)`. It is opt-in: existing production callers and
API method signatures are unchanged. The endpoint characterization tests record
legacy behavior rather than claiming those inconsistencies are already fixed.

- `auth` is the existing `createReadAuthFlow` interface. The helper calls `ensure`
  with `withContext: true` and consumes the verification-bound `isCurrent` lease
  returned by the coordinator. It fails closed if the lease is missing. A newer
  observed auth failure or account change invalidates the ready result, including
  the interval before the provider runner resumes. Existing callers that omit
  `withContext` retain their result shape. Shared read preflight and mutation
  preparation also consume this lease; read-only login retries use the lease
  captured around their fresh post-login verification. It does not call the read/replay method.
- After authentication recovery it returns `kind: 'retry_required'` without
  invoking `request`. The owning UI must require another explicit action.
- For an already-ready session, `request({signal, isCurrent})` runs once. It must
  return a result, not attach audio, insert text or mutate application state.
  Post-request authentication errors return to the adapter without starting login
  or retry. The adapter owns contextual guidance and observing current failures.
- Successful output retains `data` and has `kind: 'success'` plus `isCurrent()`.
  Check that predicate immediately before application and after any additional
  asynchronous conversion/persistence preparation. It is a validity guard, not a
  transaction or rollback mechanism.
- Error output contains a normalized category and safe code/status, without raw
  upstream message/details. Use the existing localized presenter with the
  operation fallback. Authentication-preparation failures carry
  `source: 'repository-api'`: present them with the session operation and that
  source to retain existing localized popup/session timeout guidance. Provider
  failures use the bridge source and preserve allowlisted actionable codes such
  as `VOICE_CHOICE_UNSUPPORTED`; raw messages remain excluded. `retry_required` and `superseded` are control outcomes for
  the adapter, not generic user-facing error messages.
- External cancellation settles promptly; context/account invalidation is also
  checked at boundaries and polled every 50 ms while waiting. Late promise
  settlement is observed but cannot update the returned result. Timers/listeners
  are released when the invocation finishes.
- `timeoutMs` defaults to `null` (no new deadline). If supplied, it covers this
  entire invocation, including authentication and response parsing. It is not
  equivalent to RolePlayScene's existing per-wait timeout; integration must
  preserve that policy explicitly rather than substitute the helper blindly.
- The helper never retries, persists content, records audio or implements fetch.
  It calls the existing client through the adapter callback. In particular it
  cannot recover a structured permission code already discarded by legacy T2A;
  that transport compatibility change belongs in the T2A integration.

Foundation verification is in
[provider-request.test.mjs](../../server/app/bridge/provider-request.test.mjs) and
[bridge characterization tests](../../server/app/api/server-api-client.bridge-contract.test.mjs),
including real session-coordinator and API-client adapters with synthetic responses.
These tests do not establish completed integration or live provider acceptance.
