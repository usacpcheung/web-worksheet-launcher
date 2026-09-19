# web-worksheet-launcher

Worksheet editor, learner viewer, and RolePlayScene authoring/playback with shared authentication, publishing, voice and AI services.

## Development branch

The default branch is `main`, renamed from `main-v1` after PR #293 without
changing the application content. Base new work and pull requests on `main`.
Historical documents retain their original branch names and commit IDs; those
references are not instructions to use an old branch or rollback commit today.

## Product entry points

- Editor: `server/editor/index.html`
- Viewer: `server/viewer/index.html`
- RolePlayScene: `server/roleplayscene/index.html`
- Shared auth callback contract: `docs/message-contract.md`

The legacy single-question popup widget, parent demo and SDK are retired.
See [widget retirement scope and deployment gates](docs/widget-removal-step2.md).
This does not remove product rewrite, transcription, T2A or sign-in support.

## Editor/Viewer route assumptions

- Canonical product-style routes are `/editor/` and `/viewer/`.
- Static or nested deployments may instead serve those entries from file paths such as `server/editor/index.html`, `server/viewer/index.html`, and `server/roleplayscene/index.html`.
- Editor-to-viewer navigation should therefore resolve relative to the current page location (for example, sibling `../viewer/`) rather than hardcoding an absolute `/viewer/` URL.

## Local Reference Workspace

- Use `reference/` for local-only API references, draft script versions, and comparison material that can help AI-assisted changes.
- `reference/` contents are ignored by Git except for its scaffold files.
- Keep final source code and contracts in the tracked repo after reviewing changes.

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

Published Worksheet and RolePlayScene artifact audit, administrative
quarantine, restore, and delayed purge are available through
`npm run artifacts:maintain`. See
`docs/published-artifact-maintenance.md` for VPS operation and safety rules.

## Runtime layer map (current state)

- `server/editor/`: local-first editor with top-level Upload Draft, labeled draft metadata (Worksheet Title + Subject), row-based publish from uploaded drafts, and a dedicated published-package browser modal.
- `server/viewer/`: local-first runtime app for attempts and published-package open flows.
- `server/roleplayscene/`: local-first RolePlayScene builder/player ported as static assets, preserving its standalone autosave, import/export, and playback behavior.
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

Auth UX notes:

- Popup callback is the primary success signal.
- Any fallback session probing is silent + bounded (best-effort safety net for missed callback events).
- Auth-required server actions do a silent preflight session check; if session is missing/expired, actions are blocked and users are prompted to sign in again.

The popup login HTML is intentionally isolated under `server/app/login/` so Apache can protect only that path and avoid accidentally protecting shared runtime JS folders (for example `server/app/auth/` or `server/app/api/`).
