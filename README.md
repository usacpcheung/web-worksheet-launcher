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
