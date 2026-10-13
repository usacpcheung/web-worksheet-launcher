# web-worksheet-launcher

Worksheet editor, learner viewer, and RolePlayScene authoring/playback with shared authentication, publishing, voice and AI services.

Base new branches and pull requests on `main`. The previous `main-v1` name in archived documents is historical.

## Documentation

Start at the [documentation index](docs/README.md). It separates current implementation references from [historical plans and review records](docs/past/README.md). The [document review register](docs/reviews/documentation-review-2026-10-06.md) records each original document's disposition and code evidence.

## Product entry points

- Worksheet editor: `server/editor/index.html`
- Learner viewer: `server/viewer/index.html`
- RolePlayScene editor/player: `server/roleplayscene/index.html`

These are public static applications with local autosave and import/export. Server upload, published browsing/loading, and AI services require sign-in. Worksheet attempts can be uploaded explicitly and resumed as local copies; this is not continuous server sync. RolePlayScene maintains one local story snapshot, rather than a local draft library.

The legacy single-question widget, renderer and parent SDK are retired. Shared login, rewrite, transcription and T2A remain supported. See the [retirement boundary](docs/contracts/widget-retirement.md).

## Local development

```bash
npm install
npm run serve:static
```

The static server defaults to `http://127.0.0.1:8765` and serves repository paths. Open `/server/editor/`, `/server/viewer/`, or `/server/roleplayscene/`. It does not provide the PostgreSQL API, OIDC or rewrite bridge.

For the Node API:

```bash
cp .env.example .env
# Set DATABASE_URL and STORAGE_ROOT for a local test installation.
npm run migrate
npm run start:api
```

The API uses PostgreSQL metadata and filesystem ZIP artifacts. Configuration loads the repository-root `.env` without overriding existing process variables. See [server setup and API routes](docs/operations/server-runtime.md) and the [implemented database schema](docs/contracts/database-schema.md).

## Routes and sign-in

Static/nested deployments may expose product pages under different prefixes. Resolve editor-to-viewer navigation relative to the current page, rather than assuming an absolute `/viewer/` path.

- Browser API prefix: `/api/worksheet-launcher/v1`
- Node API prefix: `/api/v1`
- Deployment proxy mapping: `/api/worksheet-launcher/` → `http://127.0.0.1:8787/api/`
- Shared browser login page: `/worksheet_launcher/app/login/popup.html`

The external session endpoint is `/api/worksheet-launcher/v1/session`, never `/api/worksheet-launcher/api/v1/session`. Apache OIDC and the separate AI bridge are deployment dependencies; their live configuration is not stored in this repository. The [message contract](docs/message-contract.md) describes callback validation and current viewer loading behavior.

## Development and maintenance references

- [Runtime ownership and code flows](docs/architecture/runtime.md)
- [Worksheet and attempt ZIP formats](docs/contracts/package-formats.md)
- [Worksheet voice generation](docs/worksheet/editor-voice-choice.md)
- [RolePlayScene voice generation](docs/roleplayscene/roleplayscene-voice-choices.md)
- [Testing guide](docs/operations/testing.md): `npm test` and browser smoke scripts are separate.
- [Published artifact maintenance](docs/operations/published-artifact-maintenance.md): audit, quarantine, restore and delayed purge.
- [Test-data cleanup](docs/operations/testing-data-cleanup.md): a different, destructive test-identity cleanup tool.

Contributor rules remain in [AGENTS.md](AGENTS.md); UI skills remain under `.agents/skills/`. Use [reference/](reference/README.md) only for ignored local comparison material. Keep secrets and local experiments out of tracked documentation.
