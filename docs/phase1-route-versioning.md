# Compatibility Decision Note: Phase 1 Route Versioning

## Status

Recommended

## Decision

For Phase 1 compatibility, keep the current popup launcher flow intact as **v1**.

Specifically:

- Keep the existing parent-to-popup launch flow centered on `parent_prototype/parent.html` and `server/worksheet_launcher/render.html` as the current compatibility path. This preserves the Phase 1 launcher contract already documented in `docs/message-contract.md` and avoids accidental scope creep into a broader runtime. 
- Introduce any future full editor and viewer experiences under separate routes/pages in later phases, rather than folding them into the popup renderer entry point.
- Do **not** overload `server/worksheet_launcher/render.html` with full editor/viewer runtime behavior during Phase 1.
- If popup behavior ever needs expansion later, add versioned widget/runtime files rather than editing `server/worksheet_launcher/widgets/rewrite-widget.js` in place.

## Why this decision exists

The current popup renderer is intentionally constrained to **one question** and **one answer area**. That limitation is part of the Phase 1 contract, not an implementation gap, and it should remain a compatibility island while the broader product architecture is still being defined. The parent prototype, popup renderer, and message contract are therefore best treated as a stable v1 launcher slice rather than as the foundation for the eventual full editor/viewer runtime. Reserved popup extension points are compatibility placeholders only; they are not the default strategy for how the broader product contract should evolve. 

Implementation landmarks:

- Parent launcher prototype: `parent_prototype/parent.html`
- Popup renderer entry point: `server/worksheet_launcher/render.html`
- Shared popup widget implementation that should remain untouched for prototype-specific changes: `server/worksheet_launcher/widgets/rewrite-widget.js`
- Contract source of truth: `docs/message-contract.md`

## Route/file map

The table below names the intended application surfaces so later phases can add
new routes without blurring the current popup compatibility boundary.

| Surface | Route/page namespace | Owning file(s) | Purpose | Expected input contract | Access mode | Content orientation | Phase status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Existing popup launcher parent | Local prototype page loaded directly in the parent environment | `parent_prototype/parent.html` | Hosts the prototype launcher controls, prepares the popup launch payload, and validates popup responses before mapping them back into the parent page. | Uses the launch parameters and popup response schema documented in `docs/message-contract.md`; parent-side validation must continue to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window`. | Local-only prototype surface. | Popup-launch-oriented. | Existing Phase 1 surface. |
| Existing popup renderer | `/worksheet/render.html` | `server/worksheet_launcher/render.html` | Renders the bounded popup worksheet experience for the current launcher flow. | Accepts the query-string launch contract (`?w=<base64url>&rid=<id>&returnOrigin=<origin>`) and `postMessage` exchange defined in `docs/message-contract.md`; fragments are intentionally not part of the v1 transport because they do not survive the OIDC redirect boundary. | Local-only prototype surface unless explicitly fronted by an authenticated host later. | Popup-launch-oriented. | Existing Phase 1 surface. |
| Existing parent SDK | Parent-loaded launcher module, not a standalone route | `parent_prototype/sdk/parent-launcher.js` | Encapsulates parent-side popup launch setup so integrators use one launcher entry instead of duplicating transport logic. | Must remain aligned with `docs/message-contract.md` for launch payload construction, trusted origin checks, and response correlation by request id. | Local-only prototype helper for parent integrations. | Popup-launch-oriented. | Existing Phase 1 surface. |
| Existing contract reference | Documentation surface, not a runtime route | `docs/message-contract.md` | Defines the source-of-truth transport contract for the current popup launcher flow. | Documents the launch URL parameters, popup message schema, aliases, and validation requirements used by the existing parent and popup surfaces. | Local documentation artifact. | Popup-launch-oriented. | Existing Phase 1 surface. |
| Planned editor app surface | Proposed distinct namespace such as `/editor/` with an entry page like `server/editor/index.html` | No implementation yet; reserve a dedicated editor app entry under `server/editor/` or an equivalently separate namespace. | Owns the future worksheet authoring/editor workflow rather than extending the popup renderer. | Expected to take an editor-specific draft identifier or draft document contract defined in a later-phase spec; it should not inherit the popup launch query or popup `postMessage` schema by default. | May remain public for fully local/in-browser authoring, but must become authenticated once it uses protected capabilities such as rewrite, T2A, autosave, durable storage, publish, or server-backed versioning. | Draft-oriented. | Phase 1 scaffolding only; no implementation exists yet. |
| Planned viewer app surface | Proposed distinct namespace such as `/viewer/` with an entry page like `server/viewer/index.html` | No implementation yet; reserve a dedicated viewer app entry under `server/viewer/` or an equivalently separate namespace. | Owns the future learner/product viewer experience for imported, local, or server-backed worksheets, including worksheet completion and continuation flows. | Expected to consume a snapshot identifier, imported worksheet document, or equivalent viewer contract defined in a later-phase spec; it should be viewer-driven rather than popup-launch-driven. | May remain public for local/imported worksheet use, but must add product gating when it loads protected server content or depends on authenticated services, stored learner state, server autosave, or other protected backend features. | Viewer/attempt-oriented. | Phase 1 scaffolding only; no implementation exists yet. |

Future phases must **not** repurpose `server/worksheet_launcher/render.html`
into the full worksheet product viewer unless there is an explicit versioning
change that defines that new role and separates it from the current v1 popup
launcher contract.

Access mode for those later routes should follow capability needs rather than route name alone: local or imported-worksheet experiences can remain public, while any route that loads protected server content or uses rewrite, T2A, autosave, publish, versioned storage, or persisted learner data must add the appropriate authentication and backend authorization.

## Options considered

### 1. New standalone editor/viewer routes

Create separate routes or pages for the future worksheet editor and learner viewer, leaving the Phase 1 popup launcher flow as a bounded compatibility surface.

**Pros:**

- Keeps the Phase 1 popup contract stable and easy to reason about.
- Separates popup-launch concerns from broader product navigation, persistence, and screen-level state.
- Makes it easier to evolve editor and viewer behavior without inheriting v1 popup constraints.
- Reduces the chance that `server/worksheet_launcher/render.html` becomes a mixed-responsibility entry point.

**Cons:**

- Requires additional route/page scaffolding in later phases.
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

Option 1 is preferred because the long-term editor and viewer flows are broader product surfaces, not just richer versions of the current popup. They will likely need their own routing, lifecycle management, persistence boundaries, and UI state models. Preserving the current popup renderer as a constrained v1 compatibility island prevents Phase 1 scaffolding from becoming an accidental architecture commitment. 

Option 2 remains useful as a **secondary tactic** when the popup itself needs carefully scoped expansion later. In those cases, expansion should happen through versioned widget/runtime files loaded from `server/worksheet_launcher/render.html`, not by retrofitting `server/worksheet_launcher/widgets/rewrite-widget.js` with prototype-specific behavior. Even then, those reserved popup extension points remain compatibility placeholders for the existing launcher flow rather than the default strategy for future editor/viewer contracts.


## Compatibility guardrails checklist

Use this checklist during review for any Phase 1 editor/viewer planning or scaffolding work:

- [ ] `docs/message-contract.md` remains the source of truth for the current popup launcher contract.
- [ ] Phase 1 editor/viewer work does **not** change popup query params or the popup `postMessage` schema defined in `docs/message-contract.md`.
- [ ] Any future popup-contract change updates `docs/message-contract.md` in the same change.
- [ ] Parent-side validation continues to enforce `event.origin`, `event.data.type`, `event.data.rid`, and `event.source === popup window` in the existing launcher flow implemented across `parent_prototype/sdk/parent-launcher.js`, `server/worksheet_launcher/render.js`, and `server/worksheet_launcher/render.html`.
- [ ] `server/worksheet_launcher/widgets/rewrite-widget.js` remains unchanged for prototype-specific behavior; use versioned files loaded from `server/worksheet_launcher/render.html` when needed.

## Implementation guidance

During Phase 1 and follow-on planning:

- Treat the current popup launcher flow as **v1 compatibility behavior**.
- Keep `server/worksheet_launcher/render.html` focused on the bounded popup renderer use case.
- Plan future editor/viewer work as separate routes/pages.
- If popup-specific behavior expands later, create versioned runtime assets and wire them in explicitly.
- Continue using `docs/message-contract.md` as the contract reference for the existing launcher flow until a later-phase route introduces a different interface contract.
- Treat reserved popup extension points as bounded compatibility placeholders only, not as a signal that future editor/viewer contracts should evolve through popup transport by default.

## Recommendation summary

The recommended path is:

1. Preserve the current popup launcher flow as v1.
2. Add the future editor and viewer on separate routes/pages in later phases.
3. Avoid putting full editor/viewer runtime behavior into `server/worksheet_launcher/render.html` during Phase 1.
4. If popup evolution becomes necessary later, use versioned widget/runtime files instead of editing `server/worksheet_launcher/widgets/rewrite-widget.js` directly.
