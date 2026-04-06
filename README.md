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

## Phase D server foundation (upload/publish/load/browse)

A first server-backed API foundation is available under `server/api/` with PostgreSQL metadata + filesystem ZIP artifact storage.

- Config and env validation: `server/api/config.js` and `.env.example`
- Migration bootstrap: `server/api/db/migrate.js`, SQL in `server/api/db/migrations/`
- API runtime: `server/api/server.js`
- Detailed phase notes: `docs/phase-d-server-foundation.md`

Quick start:

```bash
npm install
cp .env.example .env
# edit .env with DATABASE_URL + STORAGE_ROOT for your machine
npm run migrate
npm run start:api
```

`server/api/config.js` now auto-loads a repo-root `.env` file for local development via `dotenv` (without overriding variables that are already present in the process environment).

## Runtime layer map (current state)

- `server/editor/` and `server/viewer/`: local-first runtime apps (draft editing, package import/export, local attempts).
- `server/api/`: Node API foundation for server-backed draft upload/publish/load/browse.
- `server/app/contracts/`: shared local payload validators/mappers (includes transitional snapshot naming for compatibility).
- `server/app/auth/`: shared client-side auth-return gate used by editor/viewer protected-action stubs while API integrations are still being wired directly.

## OIDC popup sign-in flow (editor/viewer server features)

- Public external API prefix: `/api/worksheet-launcher/v1/*`
- Internal Node API prefix: `/api/v1/*`
- Reverse proxy mapping: `/api/worksheet-launcher/` -> `http://127.0.0.1:8787/api/`

Therefore:

- external `/api/worksheet-launcher/v1/session`
- maps to internal `/api/v1/session`
- never compose `/api/worksheet-launcher/api/v1/session`

Sign-in UX flow:

1. Editor/viewer opens `/worksheet_launcher/app/login/popup.html`.
2. Apache OIDC protects `/worksheet_launcher/app/login/` and handles login.
3. Popup posts `worksheet-launcher-auth-complete` back to opener and attempts to close itself.
4. Editor/viewer re-checks `GET /api/worksheet-launcher/v1/session` and updates server-feature UI automatically.

The popup login HTML is intentionally isolated under `server/app/login/` so Apache can protect only that path and avoid accidentally protecting shared runtime JS folders (for example `server/app/auth/` or `server/app/api/`).
