# External Parent Integrator Quick-Start

This guide is for external parent applications integrating with the worksheet popup renderer.

Related references:

- Contract source of truth: `docs/message-contract.md`
- Parent reference implementation: `parent_prototype/parent.html`
- Renderer entrypoint: `server/worksheet_launcher/render.html`

---

## 1) Prerequisites

Before launching any popup, complete onboarding and credential setup.

### 1.1 Register integration

Register tenant/client metadata and allowed return origins:

`POST /api/integrations/register`

Example:

```json
{
  "tenantId": "tenant-1",
  "clientId": "client-1",
  "allowedReturnOrigins": ["https://parent.example"],
  "ownerMetadata": {
    "ownerTeam": "learning-platform",
    "contact": "owner@example.com"
  }
}
```

You will receive onboarding information and credential material (for example `clientSecret` and `credentialId`).

### 1.2 Credentials and headers

For launch APIs, include:

- `Authorization: Bearer <token-or-client-secret>`
- `x-tenant-id: <tenantId>`
- `x-client-id: <clientId>`
- `x-user-id: <userId>`
- `x-renderer-session-id: <sessionId>`

Notes:

- `x-renderer-session-id` is required for create + consume and must match between both calls.
- `returnOrigin` must be in the integration allowlist configured during registration.

### 1.3 Return origin setup

The popup posts results back with:

- message target = normalized `returnOrigin` from launch context
- parent must listen on that exact origin

Use a stable HTTPS origin in production.

---

## 2) Launch flow quick-start

The end-to-end flow is:

1. Parent creates launch (`POST /api/launches`) with worksheet + `rid` + `returnOrigin`.
2. Parent opens popup URL with query parameter `?launchId=<opaque-id>`.
3. Renderer consumes launch context via `/api/launches/consume`.
4. Renderer sends `worksheetResult` back to opener via `postMessage`.
5. Parent validates the message and applies answers.

### 2.1 Create launch

Request:

```http
POST /api/launches
content-type: application/json
authorization: Bearer <token>
x-tenant-id: tenant-1
x-client-id: client-1
x-user-id: user-1
x-renderer-session-id: sess_abc123...
```

```json
{
  "rid": "rid_123",
  "worksheet": {
    "v": 1,
    "title": "Quick Check",
    "q": ["Question 1", "Question 2"],
    "rewrite": true
  },
  "returnOrigin": "https://parent.example"
}
```

Success response:

```json
{
  "launchId": "opaque-id",
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

### 2.2 Open popup with `launchId`

```js
function buildPopupUrl({ renderOrigin, renderPath, launchId }) {
  return `${renderOrigin}${renderPath}?launchId=${encodeURIComponent(launchId)}`;
}

const popupUrl = buildPopupUrl({
  renderOrigin: "https://renderer.example",
  renderPath: "/worksheet/render.html",
  launchId
});

const popupRef = window.open(popupUrl, `worksheetPopup_${rid}`, "width=900,height=720");
if (!popupRef) {
  // popup blocked case
}
```

### 2.3 Receive `worksheetResult`

Renderer posts a payload like:

```json
{
  "type": "worksheetResult",
  "rid": "rid_123",
  "worksheet": { "v": 1, "title": "Quick Check", "q": ["Question 1"] },
  "answers": [
    {
      "index": 0,
      "question": "Question 1",
      "answer": "Student answer",
      "raw": "Student answer",
      "rewritten": "Student answer"
    }
  ],
  "meta": { "sentAt": "2026-01-01T00:00:00.000Z" }
}
```

---

## 3) Required security checks and expected errors

### 3.1 Parent-side required checks (must enforce)

On `window.message`:

1. `event.origin` must equal trusted renderer origin.
2. `event.data.type` must equal `"worksheetResult"`.
3. `event.data.rid` must match the outstanding launch request id.
4. Recommended hardening: `event.source === popupRef`.

If any check fails, ignore the message and do not apply results.

### 3.2 Launch API expected error codes

You should handle (at minimum):

- `unauthorized`
- `invalid_payload`
- `not_found`
- `expired`
- `already_consumed`
- `origin_not_allowed`
- `rate_limited`

Typical UX behavior:

- `expired` / `already_consumed` / `not_found`: ask user to relaunch from parent.
- `unauthorized`: prompt re-authentication or session refresh.
- `origin_not_allowed`: fix allowlist configuration.
- `rate_limited`: retry with backoff.

---

## 4) Sample code snippets (mirroring `parent_prototype/parent.html`)

### 4.1 Create launch helper

```js
async function createLaunch({ apiOrigin, authToken, tenantId, clientId, userId, rendererSessionId, rid, worksheet }) {
  const response = await fetch(`${apiOrigin}/api/launches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
      "x-tenant-id": tenantId,
      "x-client-id": clientId,
      "x-user-id": userId,
      "x-renderer-session-id": rendererSessionId
    },
    body: JSON.stringify({
      rid,
      worksheet,
      returnOrigin: window.location.origin
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || "unknown_error";
    const msg = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${code}: ${msg}`);
  }

  if (!payload?.launchId) {
    throw new Error("invalid_launch_response: Missing launchId");
  }

  return payload;
}
```

### 4.2 Open popup + track context

```js
const currentLaunchContext = new Map();
const popupRefsByRid = new Map();

async function launchWorksheet({ worksheet, useCaseId, answerTargetIds }) {
  const rid = `rid_${Date.now()}`;
  const launch = await createLaunch({
    apiOrigin: "https://renderer.example",
    authToken: "...",
    tenantId: "tenant-1",
    clientId: "client-1",
    userId: "user-1",
    rendererSessionId: "sess_abc123",
    rid,
    worksheet
  });

  const popupUrl = `https://renderer.example/worksheet/render.html?launchId=${encodeURIComponent(launch.launchId)}`;
  const popupRef = window.open(popupUrl, `worksheetPopup_${rid}`, "width=900,height=720");
  if (!popupRef) throw new Error("popup_blocked");

  currentLaunchContext.set(rid, { rid, useCaseId, answerTargetIds });
  popupRefsByRid.set(rid, popupRef);
}
```

### 4.3 Message validation + answer routing

```js
window.addEventListener("message", (event) => {
  if (event.origin !== TRUSTED_SENDER_ORIGIN) return;

  const data = event.data;
  if (!data || data.type !== "worksheetResult") return;
  if (typeof data.rid !== "string" || !currentLaunchContext.has(data.rid)) return;

  const popupRef = popupRefsByRid.get(data.rid);
  if (!popupRef || event.source !== popupRef) return;

  const launchContext = currentLaunchContext.get(data.rid);

  // use-case-1: map first answer
  if (launchContext.useCaseId === "use-case-1") {
    document.getElementById("uc1Answer").value = data.answers?.[0]?.rewritten || data.answers?.[0]?.raw || "";
  }

  // use-case-2: map answers by index to configured target ids
  if (launchContext.useCaseId === "use-case-2") {
    launchContext.answerTargetIds.forEach((answerId, idx) => {
      const el = document.getElementById(answerId);
      if (el) el.value = data.answers?.[idx]?.rewritten || data.answers?.[idx]?.raw || "";
    });
  }

  currentLaunchContext.delete(data.rid);
  popupRefsByRid.delete(data.rid);
  try { popupRef.close(); } catch (e) {}
});
```

---

## 5) Troubleshooting

### OIDC redirect loses state

**Symptom:** popup returns without worksheet payload context.

**Cause:** hash fragments are not reliable through identity redirects.

**Fix:** always use query `launchId` and backend consume flow (do not transport worksheet/rid in hash).

### Popup blocked

**Symptom:** `window.open(...)` returns `null`.

**Fixes:**

- Trigger popup directly from a user gesture (button click).
- Show a clear message to allow popups for your site.
- Retry launch after popup permission is granted.

### Authentication failures (`unauthorized`)

**Checklist:**

- Verify bearer token / client secret.
- Confirm required headers (`x-tenant-id`, `x-client-id`, `x-user-id`, `x-renderer-session-id`).
- Ensure same renderer session id is used for create and consume.

### Origin mismatch (`origin_not_allowed` or ignored message)

**Checklist:**

- `returnOrigin` in create request must match allowlist origin exactly.
- Parent listener `TRUSTED_SENDER_ORIGIN` must equal renderer origin.
- Keep exact scheme/host/port matching in production and staging.

### Expired / already consumed launch

**Symptom:** consume fails with `expired` or `already_consumed`.

**Fixes:**

- Create a new launch and reopen popup.
- Avoid reusing old popup URLs.
- Keep launch TTL and user flow timing aligned.

---

## Production hardening checklist

- Use HTTPS for parent + renderer + APIs.
- Rotate credentials regularly.
- Rate-limit create/consume APIs.
- Monitor telemetry counters and alerts for auth-failure spikes and expiry surges.
- Treat launch IDs as secrets (do not log full values in client logs).
