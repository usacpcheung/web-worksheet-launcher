# web-worksheet-launcher

Simple web worksheet launcher for interactive lessons with popup rendering, AI rewrite support, and secure result return.

## Prototype Overview

Phase 1 establishes contracts and file scaffolding only.

- Parent prototype entry: `parent_prototype/parent.html`
- Popup renderer entry: `server/worksheet_launcher/render.html`
- Contract reference: `docs/message-contract.md`
- Widget styles placeholder: `server/worksheet_launcher/widgets/rewrite-widget.css`

## Compatibility Decision (Widget Versioning Rule)

- Do not modify `rewrite-widget.js` directly for prototype-specific behavior.
- Create a versioned widget file (for example, `rewrite-widget.v2.js`) and import it from `render.html` when needed.


## Local backend for launch APIs

A simple Node.js server is provided at `server/worksheet_launcher/server.js`.

- Serves popup assets (including `render.html`) from `server/worksheet_launcher/`
- Implements launch endpoints:
  - `POST /api/launches`
  - `POST /api/launches/consume`
  - `GET /api/launches/:launchId`

Run locally:

```bash
LAUNCH_API_TOKEN=dev-launch-token node server/worksheet_launcher/server.js
```

- `LAUNCH_TTL_MS` controls launch expiry window (default 5 minutes)
- `LAUNCH_CLEANUP_INTERVAL_MS` controls cleanup job cadence (default 30 seconds)
- `LAUNCH_EXPIRED_RETENTION_MS` controls how long expired records remain before cleanup deletion (default 60 seconds)
- `RETURN_ORIGIN_ALLOWLIST` (comma-separated origins) is required for `returnOrigin` validation
- `RATE_LIMIT_WINDOW_MS` controls rate-limit window (default 60 seconds)
- `CREATE_RATE_LIMIT_MAX` max create requests per window per client/IP (default 60)
- `CONSUME_RATE_LIMIT_MAX` max consume requests per window per client/IP (default 120)
- `TELEMETRY_ALERT_WINDOW_MS` rolling window used to detect telemetry spikes (default 5 minutes)
- `TELEMETRY_ALERT_AUTH_FAILURE_THRESHOLD` alert threshold for consume unauthorized spikes (default 10/window)
- `TELEMETRY_ALERT_EXPIRY_SURGE_THRESHOLD` alert threshold for consume expiry surges (default 15/window)


Integration onboarding endpoints (admin-authenticated with `Authorization: Bearer <LAUNCH_API_TOKEN>`):

- `POST /api/integrations/register`
- `POST /api/integrations/credentials/rotate`
- `POST /api/integrations/credentials/revoke`
- `GET /api/integrations/:tenantId/:clientId/onboarding`
- `GET /api/integrations/audit`

These endpoints support external parent app onboarding with tenant/client registration, allowed return origin configuration, credential provisioning, rotation/revocation workflows, and audit records.

Authn/authz model (prototype):

- `Authorization: Bearer <LAUNCH_API_TOKEN>` is required
- `x-tenant-id: <tenant>` is required
- `x-client-id: <client>` is required
- `x-user-id: <user>` (or legacy `x-owner-id`) is required
- `x-renderer-session-id: <session>` is required for create/consume and is bound to launch ownership
- Launch records are authorized by matching `tenantId + clientId + createdBy`


Telemetry and observability endpoints (admin-authenticated with `Authorization: Bearer <LAUNCH_API_TOKEN>`):

- `GET /api/telemetry/metrics`
  - counters for create/consume success + failure, expired launches, replay rejections
  - error category breakdowns for create and consume failures
  - recent threshold alerts
- `GET /api/telemetry/dashboard`
  - panel metadata for launch throughput, error categories, replay/expiry integrity, and alert threshold config
  - includes current telemetry snapshot to power dashboards quickly

Structured launch broker logs include correlation fields on create/consume outcomes:

- `launchId`, `rid`, `clientId`, `tenantId`, `status`, `code`
- emitted as `[launch]` log records for both success and failure paths
- abnormal spikes are emitted as `[alert] launch_broker_threshold_exceeded`
