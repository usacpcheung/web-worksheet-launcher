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

The current popup renderer is intentionally constrained to **one question** and **one answer area**. That limitation is part of the Phase 1 contract, not an implementation gap, and it should remain a compatibility island while the broader product architecture is still being defined. The parent prototype, popup renderer, and message contract are therefore best treated as a stable v1 launcher slice rather than as the foundation for the eventual full editor/viewer runtime. 

Implementation landmarks:

- Parent launcher prototype: `parent_prototype/parent.html`
- Popup renderer entry point: `server/worksheet_launcher/render.html`
- Shared popup widget implementation that should remain untouched for prototype-specific changes: `server/worksheet_launcher/widgets/rewrite-widget.js`
- Contract source of truth: `docs/message-contract.md`

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

Option 2 remains useful as a **secondary tactic** when the popup itself needs carefully scoped expansion later. In those cases, expansion should happen through versioned widget/runtime files loaded from `server/worksheet_launcher/render.html`, not by retrofitting `server/worksheet_launcher/widgets/rewrite-widget.js` with prototype-specific behavior.

## Implementation guidance

During Phase 1 and follow-on planning:

- Treat the current popup launcher flow as **v1 compatibility behavior**.
- Keep `server/worksheet_launcher/render.html` focused on the bounded popup renderer use case.
- Plan future editor/viewer work as separate routes/pages.
- If popup-specific behavior expands later, create versioned runtime assets and wire them in explicitly.
- Continue using `docs/message-contract.md` as the contract reference for the existing launcher flow until a later-phase route introduces a different interface contract.

## Recommendation summary

The recommended path is:

1. Preserve the current popup launcher flow as v1.
2. Add the future editor and viewer on separate routes/pages in later phases.
3. Avoid putting full editor/viewer runtime behavior into `server/worksheet_launcher/render.html` during Phase 1.
4. If popup evolution becomes necessary later, use versioned widget/runtime files instead of editing `server/worksheet_launcher/widgets/rewrite-widget.js` directly.
