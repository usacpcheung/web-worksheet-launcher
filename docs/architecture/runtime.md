# Current runtime architecture

Reviewed against main `7bb19de` on 2026-10-06.

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

1. Editor persists an editable local draft and media in IndexedDB. Viewer preview uses the sibling viewer URL with `localDraftId`, `preview=1` and a freshness marker.
2. ZIP export serializes `manifest.json`, `content/worksheet.json` and `media/`. Upload sends those ZIP bytes; publishing validates and copies an uploaded artifact into a new published artifact. Listing metadata can differ from embedded content metadata.
3. Viewer source loading derives its read-only payload and creates a local attempt. Answers, progress and voice recovery autosave locally; submission/checking does not continuously synchronize them to the server.
4. Explicit attempt export/upload includes a worksheet snapshot, answers/check state and media. Uploaded attempt resume imports the embedded worksheet and creates a new local attempt; it does not fetch a newer publication.

See [launch and response contracts](../message-contract.md), [package formats](../contracts/package-formats.md), [local models](../contracts/local-models.md) and [API routes](../operations/server-runtime.md).

## RolePlayScene flow

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
