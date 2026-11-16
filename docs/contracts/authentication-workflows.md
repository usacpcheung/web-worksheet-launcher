# Current authentication workflows

Aligned to PR #349 (`99ba300`) and PR2 cleanup, 2026-11-16. The
[original mapping and extraction proposals](../past/audits/authentication-workflows-2026-10.md)
are historical. Read, mutation and provider integrations are implemented; there is
no outstanding feature plan implied by that earlier migration sequence.
The [popup/message contract](../message-contract.md) owns callback validation;
[server runtime](../operations/server-runtime.md) owns routes and deployment.

## Entry and continuation

| Action | Authentication and continuation |
| --- | --- |
| Local editing, import/export, answering, local save/resume, print and available media playback | No login. Network-dependent features still require connectivity; no PWA/offline reload is provided. |
| Server lists, artifact download, published opening and server attempt resume | Shared Sign in / Cancel, fresh session verification, bounded read retry and current account/context checks. A successful login can continue the selected read. |
| Upload, publish and delete | Shared preparation; popup login is followed by an explicit action confirmation. Same-tab return restores local work/guidance, never an automatic POST or DELETE. |
| Editor prompt/option audio generation | Initial Sign in / Cancel, explicit Generate audio confirmation after popup login, one provider request; a later auth failure never automatically resends generation. |
| RolePlayScene dialogue generation | Shared provider readiness and guarded results; explicit generation after login. |
| Viewer answer/typed-blank/feedback and RolePlayScene discussion voice/rewrite | Sign in / Cancel before service use; recording/rewrite requires another explicit action after login. Preserve actual recovery material and discard only stale authentication guidance. |

Published resources require login. The API independently enforces identity and
ownership; a successful worksheet-session probe does not guarantee bridge access.
The shared prompt accepts optional plain-text `warningText`; viewer opening uses
it to explain replacement of the normal local attempt. Login or Cancel alone
never replaces work. See [attempt lifecycle](local-models.md#normal-attempts-temporary-preview-and-cleanup).

Viewer server-browser entry verifies readiness before mounting the browser.
Cancel leaves the original screen visible. Expiry inside an already open browser
uses its inline Sign in/Close state, not an empty-success list or a second
unsolicited dialog. These presentation rules are detailed in [server reads](authentication-reads.md).

## Ownership and recovery

- Check operation, document/project/attempt, target, dialog and account ownership
  after asynchronous boundaries. Closing a browser invalidates its selected open.
- Newer auth failure or account change prevents stale continuation without deleting
  local worksheets, attempts or stories. Same-account concurrent work remains valid.
- Reads may retry their request within the shared policy. Import, confirmation,
  microphone activation and mutations never belong inside a retried read callback.
- Upload conflict/slot choices and receipt reconciliation retain their own rules;
  login does not authorize a resend after an uncertain mutation. DELETE is never
  automatically replayed. See [upload recovery](upload-recovery.md),
  [snapshots](upload-snapshots.md), [publication](publication-lifecycle.md), and
  [deletion](deletion-lifecycle.md).
- Same-tab fallback saves local work first, stores a minimal tab-scoped return
  intent, and validates nonce, expiry, account and local context on return.
  Persistence failure or unsupported voice/discussion recovery blocks navigation.
  Cookies/tokens are never persisted in those intents.
- Provider errors retain safe structured categories. Permission denial, unavailable
  service and network errors do not become login loops. Existing compatibility
  adapters remain; do not remove them based on low direct-call counts.

## Implemented shared coverage

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

The applications retain different layouts and package/loading adapters. Shared
helpers do not imply one identical user flow or a consolidated list/file-saving
controller. Earlier suggestions for further extraction are historical proposals,
not requirements for this cleanup. A later `main.js` refactor must preserve these
boundaries and be reviewed separately.

## Popup verification and slow login

The shared popup flow has a 60-second hard deadline and 1-second polling interval.
Its initial 15-second window is not the end of sign-in: bounded probes continue
until the deadline even if COOP severs the handle or no callback arrives. Callback
origin, source window and flow-token checks remain required. A fresh authenticated
session response establishes success; callback receipt or popup closure alone does
not. Cancellation/deadline cleanup stops probes and ignores late callbacks.

## Verification

Run the full Node and retained-product browser suites for cross-app changes.
Cover signed out/in, expiry, explicit permission denial, service/network failures,
blocked/closed popup, same-tab return, both concurrent completion orders, account
change and cancellation. Preserve local edits, prepared uploads, voice recovery,
focus and controls in English/Traditional Chinese and desktop/mobile layouts.
See [testing](../operations/testing.md) for commands and fixture boundaries.
Mocked auth proves controlled behavior; real OIDC/provider acceptance remains a
deployment check for the exact release. This document is not evidence of a new
live test or permission to deploy.
