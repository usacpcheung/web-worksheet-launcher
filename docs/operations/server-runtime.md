# Server runtime and API reference

Baseline reviewed against main `7bb19de` on 2026-10-06; upload recovery updated on 2026-10-14 from main `a92c743`. Code authorities: `server/api/config.js`, `auth.js`, `server.js`, service modules, migration runner and `server/app/api/server-api-client.js`. Apache/OIDC and the rewrite bridge are external dependencies. Examples here describe the configured contract, not inspected live configuration.

## Setup and configuration

```bash
npm install
cp .env.example .env
# Configure DATABASE_URL and STORAGE_ROOT for the test installation.
npm run migrate
npm run start:api
```

`config.js` loads the repository-root `.env` via dotenv with `override: false`. Existing process variables keep precedence. All API, migration and artifact-maintenance commands share this configuration. The static development server is separate and does not proxy these APIs.

| Variable | Default / requirement |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URL. |
| `STORAGE_ROOT` | Required filesystem artifact root, resolved to an absolute path. |
| `HOST`, `PORT` | `127.0.0.1`, `8787`. Non-loopback binds require a proxy secret. |
| `AUTH_HEADER_SUB` | `x-oidc-sub`; required authenticated ownership subject. |
| `AUTH_HEADER_EMAIL`, `AUTH_HEADER_NAME` | `x-oidc-email`, `x-oidc-name`; optional display metadata. |
| `TRUSTED_PROXY_SECRET` | Optional on recognized loopback hosts, required otherwise; when configured, every protected request must carry its matching secret header. |
| `TRUSTED_PROXY_SECRET_HEADER` | `x-worksheet-proxy-secret`. |
| `PACKAGE_UPLOAD_MAX_BYTES` | `31457280` (30 MiB). |
| `ROLEPLAYSCENE_PACKAGE_MAX_UNCOMPRESSED_BYTES` | `67108864` (64 MiB). |
| `ROLEPLAYSCENE_PACKAGE_MAX_ENTRY_BYTES` | `33554432` (32 MiB). |
| `ROLEPLAYSCENE_PACKAGE_MAX_ENTRIES` | `200`. |
| `ROLEPLAYSCENE_PACKAGE_MAX_ENTRY_NAME_LENGTH` | `512`. |

Slots are currently fixed configuration values: three worksheet drafts, three uploaded attempts, and three RolePlayScene drafts per owner (separate resource lists). Browse defaults to 20 rows, maximum 100; offset is nonnegative. Lists return `draftSlotLimit`/`attemptSlotLimit` where applicable. There is no corresponding slot-limit environment variable.

## Paths and authentication

Browser base `/api/worksheet-launcher/v1` maps to Node `/api/v1`. For example `/api/worksheet-launcher/v1/session` maps to `/api/v1/session`. Never add another `/api` to the browser base.

`GET /healthz` is unprotected. All product API routes require authenticated identity. Published reads/search are available to authenticated users; draft/attempt reads, deletes and publishing enforce ownership. Browser requests send cookies with `credentials: include`, not trusted OIDC/proxy headers.

Apache should clear incoming identity/secret headers and inject trusted values only on its API proxy boundary. The shared `/worksheet_launcher/app/login/popup.html` establishes the OIDC session and reports completion; do not inject private proxy secrets into that browser page. Public static shared JS/CSS must remain loadable. The [message contract](../message-contract.md) describes the callback separately from retired widget messaging.

A deployment mapping can use:

```apache
ProxyPass /api/worksheet-launcher/ http://127.0.0.1:8787/api/
ProxyPassReverse /api/worksheet-launcher/ http://127.0.0.1:8787/api/
```

This fragment is not a complete vhost or an authorization to edit Apache. OIDC secrets, identity injection and protection rules remain deployment configuration, outside this repository review.

## Current endpoint inventory

Paths below are relative to the API base; use the browser base for clients or `/api/v1` for Node tests.

| Method | Path | Body / purpose |
| --- | --- | --- |
| GET | `/session` | `{ready: true, user: {sub, email, name}}` in the JSON data envelope. |
| GET | `/upload-operations/:operationId` | Owner-scoped completed upload receipt, or `state: "unknown"`; never cached. |
| POST | `/drafts/upload` | Worksheet ZIP; query `title`, `subject`, `conflictAction`. |
| GET | `/drafts` | Owner's worksheet drafts and slot limit. |
| GET / DELETE | `/drafts/:uploadedDraftId/artifact` / `/drafts/:uploadedDraftId` | Owner ZIP download / delete. |
| POST | `/published` | JSON `{uploadedDraftId, title?, subject?}`; validates and publishes the persisted worksheet artifact. |
| GET | `/published` | Authenticated worksheet search; `title`, `subject`, `owner`, `q`, `limit`, `offset`. |
| GET | `/published/:publishedPackageId` | Publication metadata. |
| GET / DELETE | `/published/:publishedPackageId/artifact` / `/published/:publishedPackageId` | ZIP download / owner delete. |
| POST | `/attempts/upload` | Attempt ZIP; query `title`, `subject`, `conflictAction`. |
| GET | `/attempts` | Owner attempts and slot limit. |
| GET / DELETE | `/attempts/:uploadedAttemptId/artifact` / `/attempts/:uploadedAttemptId` | Owner ZIP download / delete. |
| POST | `/roleplayscene/drafts/upload` | Current RolePlayScene ZIP; query `title`, `description`, `conflictAction`. |
| GET | `/roleplayscene/drafts` | Owner scene drafts and slot limit. |
| GET / DELETE | `/roleplayscene/drafts/:uploadedDraftId/artifact` / `/roleplayscene/drafts/:uploadedDraftId` | Owner ZIP download / delete. |
| POST | `/roleplayscene/published` | JSON `{uploadedDraftId, title?, description?}`. |
| GET | `/roleplayscene/published` | `q`, `owner`, `title`, `description`, `limit`, `offset`; see the scene publishing contract. |
| GET | `/roleplayscene/published/:publishedSceneId` | Published scene metadata. |
| GET / DELETE | `/roleplayscene/published/:publishedSceneId/artifact` / `/roleplayscene/published/:publishedSceneId` | ZIP download / owner delete. |

The viewer handles attempt name conflicts and slot limits as upload outcomes after authentication, including copy/replace selection and deletion followed by an explicit retry. A non-auth upload error must not produce a sign-in warning. Failed session probes report that sign-in status could not be verified; actual authentication failures retain the shared sign-in recovery path.

Upload content type is `application/zip`; publish body is JSON, not the revision/content JSON proposed in old specifications. IDs in detail/publish routes are UUID-validated. Successful JSON responses use `{ok: true, data: ...}`; errors use `{ok: false, error: {code, message, details?}}`. Artifacts return ZIP bytes with length information. Unknown nested subroutes return not-found errors; they are not additional API capabilities.

Worksheet `q` searches title, subject, owner email or owner name; separate `title`, `subject` and `owner` filters combine with AND. Worksheet `owner` search matches owner email/name, not `owner_sub`. UI display can fall back to the subject ID without extending backend search semantics. RolePlayScene `q` searches title/description and `owner` separately searches email/name. See [worksheet contract](../contracts/editor-viewer-backend-contract.md) and [scene contract](../roleplayscene/roleplayscene-publishing-contract.md).

`conflictAction` accepts `replace` or `copy` (trimmed and case-normalized); missing or unrecognized values use `fail_on_conflict`. A copy action creates a new resource and consumes a slot. When a worksheet or RolePlayScene draft conflict generates a suffixed copy title, the service rewrites that title into the newly stored ZIP as well as its listing. Attempt copy changes only listing metadata, leaving its embedded worksheet/attempt bytes intact. Slot-full recovery frees a selected private resource and retries; it is not silent cleanup. Current content and publication marker behavior is documented in the [schema reference](../contracts/database-schema.md).

## AI services and deployment

The shared client calls separate same-origin `/api/rewrite-bridge/rewrite`, `/transcriptions`, and `/t2a` endpoints. This repository does not implement that bridge, its models, voice catalogue, live timeout settings or proxy configuration. Worksheet and RolePlayScene named voice choices are defined by checked-in presets; verify provider support when deploying. Historical model-status polling belonged to the removed widget and is not a product runtime dependency.

For deployment, record the currently validated release, preserve environment/database/storage, and run the applicable migration and API restart process when runtime/schema changes require it. Verify real HTTPS sign-in, publish/load, microphone/provider behavior and relevant device flows. Upload-operation recovery requires additive migration **015** before the updated API starts accepting operation IDs. Deploy the API before the updated static client. Repository validation does not apply a production migration or deploy to the VPS.

Use the [testing guide](testing.md), [artifact maintenance](published-artifact-maintenance.md) and [test-data cleanup](testing-data-cleanup.md). Administrative maintenance is CLI-only; it is not a newly exposed public API.

## Upload failures, cancellation and transaction uncertainty

The shared browser client's ZIP upload deadline is 120 seconds, covering transport and response-body reading for both XMLHttpRequest and fetch fallback. `createServerApiClient({ uploadTimeoutMs })` permits an explicit positive override. Editor/viewer expose Cancel during uploads; RolePlayScene changes its server Save button to Cancel. Cancellation returns `ABORTED`, and deadline expiry returns `UPLOAD_TIMEOUT`, releasing the upload state. The transport deadline starts when the ZIP request starts, after package preparation/preflight. Cancellation during preparation marks the request canceled before it can be sent; it does not interrupt ZIP construction itself.

Worksheet and RolePlayScene draft-list refreshes have a separate 15-second deadline covering headers and body reading (`listTimeoutMs` override). Their post-upload refreshes use the upload flow’s abort signal. Cancel during refresh stops the refresh and releases the busy state while retaining the successful upload result.

Worksheet and attempt network/timeout messages explicitly report an unconfirmed outcome: the server may already have saved the upload. Refresh the server list and check for the item before uploading again. These messages do not assert that the server rolled back.

A canceled or timed-out request may already have reached the server. The client can recover a committed upload using its operation receipt, as described below; it does not automatically resend an uncertain upload. If the outcome remains unknown, refresh uploaded items before starting another upload. ZIP downloads receiving a successful HTML response enter sign-in recovery (`AUTH_REQUIRED`); non-success gateway errors retain their HTTP failure classification. RolePlayScene draft downloads forward the caller's abort signal, and fetch upload body-read failures return structured transport errors.

Worksheet draft upload/publication, attempt upload and RolePlayScene draft upload/publication retain their newly written artifact if `COMMIT` was attempted but its acknowledgment fails. The database may already reference that file. Definite failures before `COMMIT` still remove unused artifacts. An uncertain commit can leave an unreferenced file; preserving it is safer than deleting a committed artifact. Published artifacts have the [maintenance audit](published-artifact-maintenance.md); that CLI does not reconcile draft/attempt orphans. There is no automatic reconciliation. Idempotent replay applies only to the three upload routes when they carry an operation ID; publishing remains outside this protocol.

Attempt replacement and deletion acquire the same per-owner transaction lock. All three upload services check that a replacement target still exists: if concurrent deletion wins, replacement rolls back, removes its unused new ZIP and returns a `409` missing-target error (`DRAFT_REPLACE_TARGET_MISSING`, `ATTEMPT_REPLACE_TARGET_MISSING` or `ROLEPLAYSCENE_DRAFT_REPLACE_TARGET_MISSING`). Worksheet and RolePlayScene draft deletion do not acquire the owner lock; their replacement checks prevent deleted content from being recreated during artifact writes.

## Upload operation IDs and recovery

Worksheet draft, worksheet attempt and RolePlayScene draft ZIP uploads accept an optional **`Idempotency-Key` UUID header**. Invalid keys return `400 INVALID_UPLOAD_OPERATION_ID` before reading the ZIP. The existing authenticated OIDC subject scopes the key: another owner cannot read or replay someone else's receipt. Existing callers without the header retain their previous behavior.

After acquiring the existing owner transaction lock, the service looks for a completed receipt. Its SHA-256 fingerprint binds the upload kind, exact listing metadata and conflict-action query values (before service normalization), and exact input ZIP bytes. Repeating the same completed request returns the original HTTP status and data without writing another artifact, replacing another item or consuming another slot. Changing the kind, bytes or query metadata under a completed key returns `409 UPLOAD_OPERATION_MISMATCH`, including whitespace/case changes that otherwise normalize to the same value. A new copy or a changed conflict decision should use a new key.

The successful resource mutation and receipt insertion commit in one transaction. A receipt write failure rolls the mutation back and removes its unused new ZIP. Lost commit acknowledgment leaves the original receipt available if PostgreSQL committed. Validation errors, conflicts and rolled-back operations do not create completed receipts.

`GET /upload-operations/:operationId` returns the ordinary JSON envelope with one of these data shapes:

```json
{"operationId":"11111111-1111-4111-8111-111111111111","state":"unknown"}
```

```json
{
  "operationId":"11111111-1111-4111-8111-111111111111",
  "state":"completed",
  "kind":"worksheet-attempt",
  "requestSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "result":{"ok":true,"statusCode":201,"data":{"uploaded_attempt_id":"22222222-2222-4222-8222-222222222222","upload_operation_id":"11111111-1111-4111-8111-111111111111"}},
  "completedAt":"2026-10-14T00:00:00.000Z"
}
```

Kinds are `worksheet-draft`, `worksheet-attempt` and `roleplayscene-draft`. `unknown` means no committed receipt is visible to this owner: the request may still be running, may have rolled back, or may never have arrived. It is not proof of failure or cancellation. The endpoint uses `Cache-Control: private, no-store`; clients also disable their fetch cache.

The shared client generates a fresh UUID for each upload invocation when `crypto.randomUUID` is available. Callers can supply `options.operationId` to explicitly retry an identical request. Successful modern-server responses include `data.upload_operation_id`; the client also returns top-level `operationId` on success or failure. Before transport, the client snapshots mutable ZIP bytes and the URL-encoded query values, then hashes them using Web Crypto. This includes `URLSearchParams` repair of lone UTF-16 surrogates, so the fingerprint matches what the API receives.

For a network error, upload timeout, malformed successful JSON, unexpected non-HTML success response or HTTP 5xx response, the client polls status within **one five-second total recovery budget** (`operationLookupTimeoutMs` override). Unknown receipts and transient lookup failures are retried with delays starting at 250 ms and capped at one second. Every request, response-body read and delay shares the remaining budget; polling does not restart the deadline. This allows an upload still finishing after a connection reset to commit before recovery gives up. A completed receipt matching the operation ID, kind and request fingerprint returns the original successful data with `recovered: true`. Wrong IDs, kinds, fingerprints, unsupported responses and permanent lookup failures stop recovery. Known HTTP 4xx upload rejections never enter recovery, even with malformed or interrupted error bodies. Both fetch and XHR retain status once response headers arrive; XHR's reset to status zero on a later timeout/network error does not erase it. Malformed 401/403 JSON retains `AUTH_REQUIRED` and the sign-in flag. Successful HTML continues to request sign-in instead of recovering from a receipt.

If hashing is unavailable or fails, the client still uploads but skips automatic recovery. The upload flow may remain busy for up to five seconds beyond its transport deadline while checking status. Explicit cancellation skips recovery or aborts its lookup/backoff. If the budget expires without a matching receipt, the original upload failure and operation ID are returned. A transaction can still commit later: this bounded recovery does not prove failure and does not make starting a new operation safe from duplicates. Refresh uploaded items before starting another upload.

`client.getUploadOperation(id, {signal})` exposes a single bounded lookup for callers; it does not itself poll. There is **no automatic POST retry**, so an older API that ignores the header or lacks the status endpoint cannot cause duplicate uploads through an automatic resend. Retry protection requires the migrated server; the returned client ID alone is not evidence that an older server stored a receipt.

Receipts are historical outcomes, not current item snapshots. They survive replacement/deletion so replay cannot recreate deleted content, and currently have no automatic expiration or cleanup. Their table grows with successful operations; plan retention/storage management before introducing a purge that would permit old IDs to be reused. The product UI does not yet persist operation IDs and exact ZIP snapshots across page reloads, or provide a dedicated retry/status screen. Starting another upload from the UI creates a new operation. Durable retry UX, idempotent publishing, server-side cancellation and orphan reconciliation remain separate work.
