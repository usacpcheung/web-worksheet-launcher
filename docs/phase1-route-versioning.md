# Compatibility Decision Note: Phase 1 Route Versioning

## Status

Recommended

## Decision

Phase 1 should implement the local-first editor/viewer product on separate routes while keeping the current popup launcher flow intact as the bounded **v1 popup compatibility slice**.

Specifically:

- Keep the existing parent-to-popup launch flow centered on `parent_prototype/parent.html` and `server/worksheet_launcher/render.html` as the compatibility path preserved by `docs/message-contract.md`.
- Implement the actual Phase 1 editor and viewer experiences under separate routes/pages rather than folding them into the popup renderer entry point.
- Do **not** overload `server/worksheet_launcher/render.html` with full editor/viewer runtime behavior; it remains the popup compatibility surface only.
- If popup behavior ever needs expansion later, add versioned widget/runtime files rather than editing `server/worksheet_launcher/widgets/rewrite-widget.js` in place.

## Why this decision exists

The current popup renderer is intentionally constrained to **one question** and **one answer area**. That limitation is part of the popup compatibility contract, not an implementation gap in the actual Phase 1 product. The parent prototype, popup renderer, and message contract are therefore best treated as a stable v1 launcher slice preserved alongside Phase 1 editor/viewer implementation rather than as the foundation for the full runtime. Reserved popup extension points are compatibility placeholders only; they are not the default strategy for how the broader product contract should evolve. 

Implementation landmarks:

- Parent launcher prototype: `parent_prototype/parent.html`
- Popup renderer entry point: `server/worksheet_launcher/render.html`
- Shared popup widget implementation that should remain untouched for prototype-specific changes: `server/worksheet_launcher/widgets/rewrite-widget.js`
- Contract source of truth: `docs/message-contract.md`

## Legacy / compatibility popup flow

Treat the existing popup launcher flow as a legacy or compatibility-oriented integration path, not as the main worksheet runtime.

- `server/worksheet_launcher/render.html` remains only the popup compatibility renderer.
- The real worksheet editor must get its own app entry, such as `server/editor/index.html`.
- The real worksheet viewer must get its own app entry, such as `server/viewer/index.html`.
- Popup transport and query contracts defined in `docs/message-contract.md` do **not** define the editor/viewer product contracts.

This legacy/compatibility labeling is intentional so future implementation work does not accidentally extend the popup surface into the main runtime.

## Route/file map

The table below names the intended application surfaces so Phase 1 implementation can add
new routes without blurring the current popup compatibility boundary.

| Surface | Route/page namespace | Owning file(s) | Purpose | Expected input contract | Access mode | Content orientation | Phase status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Existing popup launcher parent | Local prototype page loaded directly in the parent environment | `parent_prototype/parent.html` | Hosts the prototype launcher controls, prepares the popup launch payload, and validates popup responses before mapping them back into the parent page. | Uses the launch parameters and popup response schema documented in `docs/message-contract.md`; parent-side validation must continue to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window`. | Local-only prototype surface. | Popup-launch-oriented. | Preserved Phase 1 compatibility surface. |
| Existing popup renderer | `/worksheet/render.html` | `server/worksheet_launcher/render.html` | Renders the bounded popup worksheet experience for the current launcher flow. | Accepts the query-string launch contract (`?w=<base64url>&rid=<id>&returnOrigin=<origin>`) and `postMessage` exchange defined in `docs/message-contract.md`; fragments are intentionally not part of the v1 transport because they do not survive the OIDC redirect boundary. | Local-only prototype surface unless explicitly fronted by an authenticated host later. | Popup-launch-oriented. | Preserved Phase 1 compatibility surface. |
| Existing parent SDK | Parent-loaded launcher module, not a standalone route | `parent_prototype/sdk/parent-launcher.js` | Encapsulates parent-side popup launch setup so integrators use one launcher entry instead of duplicating transport logic. | Must remain aligned with `docs/message-contract.md` for launch payload construction, trusted origin checks, and response correlation by request id. | Local-only prototype helper for parent integrations. | Popup-launch-oriented. | Preserved Phase 1 compatibility surface. |
| Existing contract reference | Documentation surface, not a runtime route | `docs/message-contract.md` | Defines the source-of-truth transport contract for the current popup launcher flow. | Documents the launch URL parameters, popup message schema, aliases, and validation requirements used by the existing parent and popup surfaces. | Local documentation artifact. | Popup-launch-oriented. | Preserved Phase 1 compatibility surface. |
| Phase 1 editor app surface | Proposed distinct namespace such as `/editor/` with an entry page like `server/editor/index.html` | No implementation yet; add a dedicated editor app entry under `server/editor/` or an equivalently separate namespace. | Owns the Phase 1 worksheet authoring/editor workflow rather than extending the popup renderer. | Should take an editor-specific draft identifier or draft document contract defined in the editor/viewer implementation, not the popup launch query or popup `postMessage` schema. | Public client-side app surface; authentication is required only when invoking protected backend or API capabilities such as draft save/load, publish, rewrite, T2A, or server-backed worksheet load. Local import/export, local autosave, and local preview must remain usable without login. | Draft-oriented. | Phase 1 implementation surface. |
| Phase 1 viewer app surface | Proposed distinct namespace such as `/viewer/` with an entry page like `server/viewer/index.html` | No implementation yet; add a dedicated viewer app entry under `server/viewer/` or an equivalently separate namespace. | Owns the Phase 1 learner/product viewer experience for imported, local, or server-backed worksheets, including worksheet completion and continuation flows. | Should consume a snapshot identifier, imported worksheet document, or equivalent viewer contract defined in the editor/viewer implementation; it should be viewer-driven rather than popup-launch-driven. | Public client-side app surface; authentication is required only when invoking protected backend or API capabilities such as server-backed worksheet load, attempt sync/save/load, rewrite, or T2A. Local preview/viewer use, local autosave, and local import/export-backed flows must remain usable without login. | Viewer/attempt-oriented. | Phase 1 implementation surface. |

Phase 1 implementation must **not** repurpose `server/worksheet_launcher/render.html`
into the full worksheet product viewer unless there is an explicit versioning
change that defines that new role and separates it from the current v1 popup
launcher contract.

Access mode for those Phase 1 editor/viewer routes should follow one consistent rule: editor and viewer routes/pages are public client-side app surfaces, and authentication is required only when the app invokes protected backend or API capabilities. Protected capabilities include draft save/load, publish, server-backed worksheet load, attempt sync/save/load, rewrite, and T2A. Local import/export, local autosave, local preview, and local viewer usage must remain usable without login.

## Options considered

### 1. Separate Phase 1 editor/viewer routes

Create separate routes or pages for the Phase 1 worksheet editor and learner viewer, leaving the popup launcher flow as a bounded compatibility surface.

**Pros:**

- Keeps the popup compatibility contract stable and easy to reason about.
- Separates popup-launch concerns from broader product navigation, persistence, and screen-level state.
- Makes it easier to evolve editor and viewer behavior without inheriting v1 popup constraints.
- Reduces the chance that `server/worksheet_launcher/render.html` becomes a mixed-responsibility entry point.

**Cons:**

- Requires additional route/page scaffolding during Phase 1 implementation.
- Introduces multiple runtime entry points to maintain.

### 2. Reusing popup renderer with versioned JS

Continue using `server/worksheet_launcher/render.html` as the shell, but add new versioned widget/runtime files over time for expanded popup capabilities.

**Pros:**

- Can preserve the existing popup launch surface for narrowly scoped enhancements.
- Aligns with the repository rule to use versioned files rather than editing `server/worksheet_launcher/widgets/rewrite-widget.js` in place.
- May be appropriate for future popup-specific extensions that still fit the popup interaction model.

**Cons:**

- Still risks turning the popup renderer into the default home for unrelated editor/viewer runtime behavior.
- Can blur the boundary between a compatibility launcher and the broader worksheet product.
- Makes implementers more likely to stretch the Phase 1 message/query contract beyond its intended single-question scope.

### 3. Why option 1 is preferred for the broader product flow

Option 1 is preferred because the editor and viewer flows are the actual Phase 1 product surfaces, not just richer versions of the current popup. They need their own routing, lifecycle management, persistence boundaries, and UI state models. Preserving the current popup renderer as a constrained v1 compatibility island prevents the compatibility slice from becoming an accidental architecture commitment for the implementation work now expected. 

Option 2 remains useful as a **secondary tactic** when the popup itself needs carefully scoped expansion later. In those cases, expansion should happen through versioned widget/runtime files loaded from `server/worksheet_launcher/render.html`, not by retrofitting `server/worksheet_launcher/widgets/rewrite-widget.js` with prototype-specific behavior. Even then, those reserved popup extension points remain compatibility placeholders for the existing launcher flow rather than the default strategy for future editor/viewer contracts.


## Compatibility guardrails checklist

Use this checklist during review for any Phase 1 editor/viewer implementation work:

- [ ] `docs/message-contract.md` remains the source of truth for the current popup launcher contract.
- [ ] Phase 1 editor/viewer implementation does **not** change popup query params or the popup `postMessage` schema defined in `docs/message-contract.md` unless the popup compatibility contract is explicitly versioned.
- [ ] Any future popup-contract change updates `docs/message-contract.md` in the same change.
- [ ] Parent-side validation continues to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window` in the existing launcher flow implemented across `parent_prototype/sdk/parent-launcher.js`, `server/worksheet_launcher/render.js`, and `server/worksheet_launcher/render.html`.
- [ ] `server/worksheet_launcher/widgets/rewrite-widget.js` remains unchanged for prototype-specific behavior; use versioned files loaded from `server/worksheet_launcher/render.html` when needed.

## Implementation guidance

During Phase 1 implementation and follow-on planning:

- Treat the current popup launcher flow as **v1 popup compatibility behavior**.
- Keep `server/worksheet_launcher/render.html` focused on the bounded popup renderer use case.
- Build editor/viewer work as separate routes/pages.
- If popup-specific behavior expands later, create versioned runtime assets and wire them in explicitly.
- Continue using `docs/message-contract.md` as the contract reference for the existing launcher flow until a later-phase route introduces a different interface contract.
- Treat reserved popup extension points as bounded compatibility placeholders only, not as a signal that future editor/viewer contracts should evolve through popup transport by default.

## Recommendation summary

The recommended path is:

1. Preserve the current popup launcher flow as the v1 popup compatibility slice.
2. Build the Phase 1 editor and viewer on separate routes/pages.
3. Avoid putting full editor/viewer runtime behavior into `server/worksheet_launcher/render.html`.
4. If popup evolution becomes necessary later, use versioned widget/runtime files instead of editing `server/worksheet_launcher/widgets/rewrite-widget.js` directly.
