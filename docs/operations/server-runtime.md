# Server runtime and API reference

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/api/config.js`, `auth.js`, `server.js`, service modules, migration runner and `server/app/api/server-api-client.js`. Apache/OIDC and the rewrite bridge are external dependencies. Examples here describe the configured contract, not inspected live configuration.

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

Upload content type is `application/zip`; publish body is JSON, not the revision/content JSON proposed in old specifications. IDs in detail/publish routes are UUID-validated. Successful JSON responses use `{ok: true, data: ...}`; errors use `{ok: false, error: {code, message, details?}}`. Artifacts return ZIP bytes with length information. Unknown nested subroutes return not-found errors; they are not additional API capabilities.

Worksheet `owner` search matches owner email/name, not `owner_sub`. UI display can fall back to the subject ID without extending backend search semantics. RolePlayScene `q` searches title/description and `owner` separately searches email/name. See [worksheet contract](../contracts/editor-viewer-backend-contract.md) and [scene contract](../roleplayscene/roleplayscene-publishing-contract.md).

`conflictAction` supports explicit replace/copy handling. Slot-full recovery frees a selected private resource and retries; it is not silent cleanup. Current content and publication marker behavior is documented in the [schema reference](../contracts/database-schema.md).

## AI services and deployment

The shared client calls separate same-origin `/api/rewrite-bridge/rewrite`, `/transcriptions`, and `/t2a` endpoints. This repository does not implement that bridge, its models, voice catalogue, live timeout settings or proxy configuration. Worksheet and RolePlayScene named voice choices are defined by checked-in presets; verify provider support when deploying. Historical model-status polling belonged to the removed widget and is not a product runtime dependency.

For deployment, record the currently validated release, preserve environment/database/storage, and run the applicable migration and API restart process when runtime/schema changes require it. Verify real HTTPS sign-in, publish/load, microphone/provider behavior and relevant device flows. This documentation-only change requires no migration or API behavior change; it performs no VPS deployment.

Use the [testing guide](testing.md), [artifact maintenance](published-artifact-maintenance.md) and [test-data cleanup](testing-data-cleanup.md). Administrative maintenance is CLI-only; it is not a newly exposed public API.
