# web-worksheet-launcher

Simple web worksheet launcher for interactive lessons with popup rendering, AI rewrite support, and secure result return.

## Prototype Overview

Phase 1 establishes contracts and file scaffolding only.

- Parent prototype entry: `parent_prototype/parent.html`
- Popup renderer entry: `server/worksheet_launcher/render.html`
- Contract reference: `docs/message-contract.md`
- Render route security headers/CSP guidance: `docs/render-security-headers.md`
- Widget styles placeholder: `server/worksheet_launcher/widgets/rewrite-widget.css`

## Editor/Viewer route assumptions

- Canonical product-style routes are `/editor/` and `/viewer/`.
- Static or nested deployments may instead serve those entries from file paths such as `server/editor/index.html` and `server/viewer/index.html`.
- Editor-to-viewer navigation should therefore resolve relative to the current page location (for example, sibling `../viewer/`) rather than hardcoding an absolute `/viewer/` URL.

## Parent launcher SDK source

- Canonical SDK source in this repo: `parent_prototype/sdk/parent-launcher.js`
- For new integrations, copy/host from the canonical SDK source.

## 5-line parent integration

```html
<script src="./sdk/parent-launcher.js"></script>
<script>
const launcher = WorksheetLauncher.create({ renderOrigin, renderPath, trustedSenderOrigin, questionSelector: "#question", answerTargetSelector: "#answer" });
document.querySelector("#open").addEventListener("click", () => launcher.open({ title: "Quick Check" }));
</script>
```

For full setup options (selectors vs callbacks, hooks, and failure handling), see `docs/parent-launcher-sdk.md`.

## Compatibility Decision (Widget Versioning Rule)

- Do not modify `rewrite-widget.js` directly for prototype-specific behavior.
- Create a versioned widget file (for example, `rewrite-widget.v2.js`) and import it from `render.html` when needed.

## Local Reference Workspace

- Use `reference/` for local-only API references, draft script versions, and comparison material that can help AI-assisted changes.
- `reference/` contents are ignored by Git except for its scaffold files.
- Keep final source code and contracts in the tracked repo after reviewing changes.

## Parent SDK config

`WorksheetLauncher.create(config)` supports simple selector-based setup and advanced callback-based setup.

Required:

- `renderOrigin`
- `renderPath`
- `trustedSenderOrigin`

Question source:

- `questionSelector` + optional `questionExtractor(el)`, or
- `getQuestion()`

Answer target:

- `answerTargetSelector`, or
- `setAnswer(answer, context)`

Lifecycle hooks (optional):

- `onStatusChange(status)`
- `onError(error)`
- `onResult(payload)`

In v1, launcher behavior remains one-question mode only.


## Editor capabilities (Phase 2 runtime slice)

Phase 2 editor runtime slice is now delivered under `server/editor/` with local-only behavior:

- Center workspace for worksheet title, single-question prompt editing (v1), answer preview, and save-state status.
- Restore-on-load from IndexedDB (`latest` local draft) with blank draft bootstrap when no draft exists.
- Debounced autosave and dirty tracking for title/question/answer changes.
- Local validation guard for question prompt (`required`, max `800` chars per v1 launch contract).
- Protected rewrite/T2A actions remain disabled with “Sign in required” labels (no backend/auth calls in this slice).
