# Current runtime architecture

Aligned to PR #349 (`99ba300`) and PR2 cleanup on 2026-11-16; see the [documentation index](../README.md) for release-status boundaries.

## Entry points and ownership

| Layer | Entry / owner | Current responsibility |
| --- | --- | --- |
| Worksheet authoring | `server/editor/index.html`, `main.js`, `main.css` | Local drafts, block/content editing, prompt/option media, audio generation, ZIP import/export, upload/publish and published editable copies. |
| Worksheet learner | `server/viewer/index.html`, `main.js`, `main.css` | Explicit source loading, local attempts, answers, submission/check/review, printing, voice/rewrite, attempt ZIP export/upload/resume. |
| RolePlayScene | `server/roleplayscene/index.html`, `scripts/main.js` | One local project; authoring/map/preview, import/export, server drafts/publications, direct-link playback and editable copies. |
| RolePlayScene authoring/player | `scripts/editor/`, `scripts/player/` | Scene/line editing, media, identity and names; playback/choices/history/music/discussion. |
| Shared browser services | `server/app/` | API client, session/auth, local worksheet storage, compatibility contracts, text renderer, fonts and localization. |
| Node API | `server/api/server.js`, `services/`, `storage/` | Trusted-proxy identity, owner-private ZIP drafts/attempts, authenticated published read/search, publishing and administrative artifact services. |

## Worksheet flow

1. Editor persists an editable local draft and media in IndexedDB. Viewer preview uses the sibling viewer URL with `localDraftId`, `preview=1` and a freshness marker. It owns a temporary attempt and never replaces the normal Resume target. Preview supports answering, submission, feedback and print; attempt export/server save are unavailable.
2. ZIP export serializes `manifest.json`, `content/worksheet.json` and `media/`. Upload sends those ZIP bytes; publishing validates and copies an uploaded artifact into a new published artifact. Listing metadata can differ from embedded content metadata.
3. Explicit normal worksheet opening derives its read-only payload and creates a fresh local attempt, even for the same worksheet. Replacement consent and successful persistence precede changing the single Resume target. Cancel/login alone never replace existing work. Answers, progress and voice recovery autosave locally; submission/checking does not continuously synchronize them to the server.
4. Explicit attempt export/upload includes a worksheet snapshot, answers/check state and media. Uploaded attempt resume imports the embedded worksheet and creates a new local attempt; it does not fetch a newer publication.

See [launch and response contracts](../message-contract.md), [package formats](../contracts/package-formats.md), [local models](../contracts/local-models.md) and [API routes](../operations/server-runtime.md).

## RolePlayScene flow

`scripts/main.js` composes the application: it owns editor/player mode, the active
project, authentication, server operations, dialogs and replacement/recovery
coordination. Two presentation controllers receive explicit dependencies from it:

- `scripts/ui/toolbar-controller.js` owns toolbar labels, session/busy presentation,
  mode visibility, responsive overflow, locale-select presentation and header
  measurement. `render(state)` receives presentation values; it does not retain an
  application-state copy or invoke server actions. Existing action buttons and their
  handlers survive reparenting. `main.js` keeps action handlers and the broader
  locale-change flow. `updateDraftAvailability(state)` changes busy controls
  without rearranging or closing the menu during draft progress. `destroy()`
  removes controller listeners and its resize
  observer only on non-cached page exit, preserving browser Back/Forward restoration.
- `scripts/player/discussion-print-controller.js` owns page-session print details
  and the details-to-print workflow. It receives the active-project getter,
  discussion session, existing dialog operations and message callback. Dialog
  revisions, nested-confirmation focus and cancellation remain in `main.js`.
  `scripts/player/discussion-print.js` still builds the print model and HTML without
  needing a dialog. Print preferences keep their existing in-memory lifetime.

Both controllers are statically imported at startup, with no framework, lazy-load
boundary, storage-key or package-format change. Required local controls remain
available after a successful page load followed by connection loss. The extraction
is for maintenance; a smaller entry file is not a loading-speed claim.

`scripts/storage.js` owns a single IndexedDB project snapshot. Its prepared-import/apply stages let the caller validate and confirm replacement before changing the active project. Server Save captures one serialized project for that save flow. Uploaded drafts and publications use separate RolePlayScene API routes and artifact buckets.

Direct `publishedSceneId` launches skip normal local persistence initialization until returning to the editor or accepting an editable copy. Playback keeps exact scene IDs for choices, automatic transitions and discussion associations. Names and story titles are presentation metadata; voice preferences are optional version-1 authoring fields. See the [RolePlayScene references](../README.md#roleplayscene).

## Shared dependencies

- Viewer imports worksheet package, ZIP and audio-track helpers from `server/editor/`. The worksheet API service also uses package/ZIP parsing from that folder.
- RolePlayScene package validation uses its shared scene identity validator and the bundled ZIP implementation; do not infer exclusive ownership from a module's folder.
- RolePlayScene discussion state/UI imports `server/viewer/answer-voice-workflow.js`. A change there affects both learner products.
- All products use `server/app/api/server-api-client.js` and shared session/auth helpers. Browser product APIs and the external AI bridge use separate fixed same-origin prefixes.
- Locale dictionaries and RolePlayScene's namespaced dictionary are supplied through shared localization. Worksheet Markdown and local Chinese fonts apply to worksheet text, not scene rich text.

## Implemented boundaries

PostgreSQL stores listing/ownership/artifact metadata; canonical content is filesystem ZIP data. The old proposed JSONB worksheet-content tables, server draft revisions, publication families and lineage events are not implemented. Local snapshot terminology is not an alias for the HTTP API's UUID identities.

Published worksheet opens perform session preflight and download/import every time. Imported records support local use/resume, but there is no implemented publication-ID cache lookup, ETag validation or cache-first network bypass. Uploaded attempts are portable snapshots, not a relational attempt-sync service. Guest server attempt APIs and continuous server autosave are not implemented.

Historical proposals remain under [past/plans](../past/README.md). Their remaining ideas are not an approved current roadmap. The legacy widget/SDK files are absent; preserve the [active retirement boundary](../contracts/widget-retirement.md).
