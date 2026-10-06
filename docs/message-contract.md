# Active message, response and viewer launch contracts

Reviewed against main `7bb19de` on 2026-10-06. Runtime sources: `server/app/auth/auth-popup-flow.js`, `session-readiness.js`, `server/app/login/popup.html`, and the editor/viewer/RolePlayScene callers. Local response validators and viewer bootstrap are also checked below.

The parent SDK, widget renderer, `w`/`rid`/`returnOrigin` query and `worksheetResult` protocol are retired. Their original combined contract is preserved in [past/phase1/message-contract.md](past/phase1/message-contract.md). See the [active retirement boundary](contracts/widget-retirement.md). The shared login popup is a different, supported feature.

## OIDC popup callback

The same-origin browser page `/worksheet_launcher/app/login/popup.html` establishes the Apache OIDC session. `GET /api/worksheet-launcher/v1/session` is the background readiness endpoint; the Node path is `/api/v1/session`.

```json
{
  "type": "worksheet-launcher-auth-complete",
  "source": "editor",
  "authFlowId": "auth_flow_..."
}
```

`source` may be `editor`, `viewer`, or `generic`.
RolePlayScene also supplies `source: "roleplayscene"`; the popup echoes its supplied source without enumerated validation. `source` is context metadata, not an authentication decision.

Each product generates a per-flow `authFlowId` and passes it to the shared opener helper. That helper ignores messages with a different origin, non-record data, a different type, or a mismatched flow token. A valid callback triggers a fresh session probe; the message itself does not establish readiness. The popup posts only after its own bounded readiness check, using `window.opener.postMessage(payload, window.location.origin)`.

The current shared helper does not compare `event.source` to the opened window or validate the message's `source` field. Do not claim it implements the old parent SDK's window-reference check. This reference reports existing behavior; it does not relax repository guidance for future changes or add a runtime fix.

Callback completion is primary. Fallback readiness polling is silent and bounded; a flow owns cancellable probes and completion cleanup. Shared defaults are a 1-second polling interval, a 15-second polling budget and a 60-second hard flow deadline; callers may supply their own continuation/deadline controls. Invalid callbacks do not themselves cancel the fallback. API work still requires its own session/auth checks.

Voice capture and RolePlayScene line generation require a new explicit action after sign-in; they do not start automatically. Existing editor protected-intent recovery is separate and validates the original target before replay. Viewer redirect recovery uses the existing `authReturn`/`authCallback` path described below, not the retired worksheet result protocol.

## Editor/Viewer response schema normalization (local draft/snapshot/viewer payloads)

The editor + viewer runtime now uses these canonical `responseConfig` input types for question blocks:

- `text`
- `number`
- `boolean`
- `multiple_choice`

### Strict responseConfig inputType acceptance

- Loader/normalization paths accept only canonical `inputType` values: `text`, `number`, `boolean`, `multiple_choice`.
- Legacy aliases (`plain_text`, `short_text`, `single_choice`) are not coerced and must fail schema validation.
- Number-input legacy `step` compatibility normalization is removed; consumers must rely on canonical `numberRules` + `min`/`max` fields only.

### Canonical responseConfig examples

`text` (single-line or multi-line mode):

```json
{
  "inputType": "text",
  "maxLength": 200,
  "displayMode": "multi_line"
}
```

```json
{
  "inputType": "text",
  "maxLength": 120,
  "displayMode": "single_line"
}
```

`number` (input-format validation only; not correctness/equivalence grading):

```json
{
  "inputType": "number",
  "numberRules": {
    "allowedKinds": ["integer", "decimal"],
    "allowSigned": true,
    "decimalPlacesAllowed": null
  },
  "min": 0,
  "max": 100
}
```

`numberRules` constraints in this phase:

- Only integer/decimal syntax is in scope.
- Fraction syntax (for example `2/3`) is out of scope and must be rejected.
- `decimalPlacesAllowed: null` means unlimited decimal places.
- `allowedKinds` accepts only `integer` and/or `decimal`; when provided, an empty array is invalid at schema-validation time.
- `allowSigned: false` rejects prefixed signed inputs (`+` and `-`) during input-format validation.
- `min`/`max` are numeric validation controls in viewer answer handling:
  - values outside `min` and/or `max` are rejected with an inline error (no silent clamping)

`number` answer-key (`correctAnswer`) validity constraints:

- must be a finite `number`
- must satisfy `allowSigned` (no negative value when `allowSigned` is `false`)
- must satisfy `min` and `max` when those bounds are present
- for decimal values, must not exceed `decimalPlacesAllowed` when `decimalPlacesAllowed` is an integer
- canonical normalization prunes invalid `correctAnswer` values from persisted `responseConfig`

`boolean` (labeling guidance):

```json
{
  "inputType": "boolean"
}
```

UI copy for boolean prompts should use **“True / False”** helper/labels.

`multiple_choice` single-select:

```json
{
  "inputType": "multiple_choice",
  "selectionMode": "single",
  "shuffleOptions": false,
  "options": [
    { "value": "a", "label": "Option A" },
    { "value": "b", "label": "Option B" }
  ]
}
```

`multiple_choice` multi-select with deterministic shuffle:

```json
{
  "inputType": "multiple_choice",
  "selectionMode": "multi",
  "shuffleOptions": true,
  "options": [
    { "value": "x", "label": "Choice X" },
    { "value": "y", "label": "Choice Y" },
    { "value": "z", "label": "Choice Z" }
  ]
}
```

When `shuffleOptions` is enabled, viewer rendering should use a deterministic order for the active session (stable during that session).

Deterministic shuffle seed behavior (viewer):

- seed input is the string: ``${localAttemptId || "attempt"}:${blockId}``
- options for a given question stay stable for one attempt/session
- a different attempt id produces a different deterministic order
- when `shuffleOptions` is `false`, original option order is preserved

### Answer value shape rules

- `text` → `string`
- `number` → finite `number` (or empty when unanswered)
- `boolean` → `boolean` (or null/empty when unanswered)
- `multiple_choice` with `selectionMode: "single"` → `string` matching an existing `options[*].value`
- `multiple_choice` with `selectionMode: "multi"` → `string[]`

### Answer-key shape rules (`responseConfig.correctAnswer`, optional)

`responseConfig.correctAnswer` is optional editor/viewer worksheet model data used for answer-key authoring and rendering. It is separate from the retired popup query/result protocol.

When present on question blocks, `correctAnswer` must match the response input shape:

- `boolean` → `boolean`
- `number` → finite `number`
- `multiple_choice` with `selectionMode: "single"` → `string` matching an existing `options[*].value`
- `multiple_choice` with `selectionMode: "multi"` → `string[]` containing unique entries, where each entry matches an existing `options[*].value`

`multiple_choice` mode-switch + pruning/coercion behavior (editor/runtime normalization):

- canonical `selectionMode` is `single` unless explicitly set to `multi`
- canonical `shuffleOptions` is a boolean
- if `selectionMode` is `single`, non-string/invalid `correctAnswer` values are removed
- if `selectionMode` is `multi`, `correctAnswer` is coerced to unique valid `string[]` values (invalid/non-string/duplicate values are pruned)
- switching `single → multi` converts a valid single `correctAnswer` string to a one-element array
- switching `multi → single` keeps only the first valid array entry as the single `correctAnswer`; if none are valid, `correctAnswer` is removed



### Viewer client-side check eligibility (integration note)

Viewer client-side check UI is intentionally gated by answer-key availability in the viewer payload. Runtime helper implementation lives in `server/viewer/main.js` (`isGradeableQuestionBlock`, `hasGradeableQuestions`, `computeCheckResult`).

Contract expectations for viewer/server integration:

- Client-side check requires snapshot-derived viewer payload question blocks to include `responseConfig.correctAnswer`.
- If `correctAnswer` is omitted for all eligible question blocks, `hasGradeableQuestions()` returns `false` and the viewer check button does not render.
- This is expected behavior (not a launch/runtime error condition).
- For high-stakes grading, evaluate answers server-side and avoid shipping authoritative answer keys in client payloads.

## Viewer launch semantics

The outer `bootstrapViewer` shows a start panel when no recognized source/auth-return intent is present. It can offer Resume/Discard for a saved local attempt; ordinary no-parameter boot does not automatically resume. Internal `ViewerAttemptSession.bootstrap` also has a resume-flag fallback for recovery paths, so it should not be described as identical to the outer entry behavior.

For nonempty source values, current code precedence is:

1. `localAttemptId`: resume that attempt or fail.
2. `publishedPackageId`: sign-in preflight, ZIP download and import or fail/recover authentication.
3. `localDraftId` with `preview=1`: explicit editor preview; optional `draftUpdatedAt` freshness marker.
4. `importedWorksheetId`: open that local imported source.
5. `localDraftId` without preview: open the local draft-derived source.

This ordering follows `ViewerAttemptSession.bootstrap` and `loadViewerPayloadFromSources`, including combined parameters. A failed explicit target does not silently open unrelated content. Empty recognized parameters can still mark launch intent at the outer boundary; they are not a valid content source. Inline `viewerPayload` and `snapshot` URL query launches are not accepted. Snapshot terminology remains only in saved/derived compatibility models.

Actual errors include `LOCAL_ATTEMPT_RESUME_FAILED`, `LOCAL_DRAFT_NOT_FOUND`, `IMPORTED_WORKSHEET_NOT_FOUND`, `NO_CONTENT_SOURCE`, `INVALID_VIEWER_PAYLOAD`, and published not-found/auth/general boot errors. Do not rely on the unimplemented `LOCAL_DRAFT_PREVIEW_FAILED`/`PUBLISHED_PACKAGE_INVALID` names from old prose.

Published authentication recovery retains the same package intent and retries it after sign-in readiness. Normal published opens always download/import; there is no implemented publication-ID cache lookup or ETag/hash-validated cache-first shortcut. The imported local record can be used for local attempts/resume, which is a separate path. See [runtime flow](architecture/runtime.md) and [loading feedback](worksheet/viewer-package-load-progress.md).

## Auth-return compatibility

- `authReturn=1`: restore an existing protected intent when possible; if no explicit source and restoration fails, show the start panel with guidance. Explicit sources retain normal validation.
- `authReturn=1&authCallback=1`: callback-only recovery panel with bounded retry for transient/not-ready session results, keeping the intent until success or explicit cancellation. Retry, Continue sign-in and Cancel remain available.
- `SharedAuthGate` validates action payload/local identity and preserves local state around redirects. Legacy rewrite replay compatibility does not mean ordinary voice capture replays automatically.

## Related contracts

- [Local model boundaries](contracts/local-models.md)
- [ZIP packages and attempts](contracts/package-formats.md)
- [Worksheet published browsing](contracts/editor-viewer-backend-contract.md)
- [Server endpoints](operations/server-runtime.md)
- [RolePlayScene direct launch](roleplayscene/roleplayscene-direct-link-loading.md)
