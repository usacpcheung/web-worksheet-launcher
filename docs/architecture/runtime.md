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

## Worksheet viewer block-presentation ownership

`server/viewer/block-presentation.js` renders reading cards and the question
number, formatted prompt, image and audio-control placement. It uses the shared
worksheet text renderer and receives the local asset store, translator, existing
card resource scope and a session-bound audio-control callback. It returns the
original DOM nodes so answer controls can retain their label/focus association
and share media feedback. Image URLs are released on load/error or card disposal;
late storage results and feedback are ignored after disposal.

`main.js` retains section numbering, card recreation signatures, answer controls
and updates, submitted-input behaviour, voice/rewrite/Undo and navigation.
`block-view-host.js` still owns card disposal and stable section wrappers. The
presentation module is statically imported; package formats, persistence and
offline behaviour are unchanged.

## Worksheet viewer checking-feedback ownership

`server/viewer/check-feedback.js` renders the existing correct, incorrect and
ungraded banners and answer-reveal messages from a response configuration,
learner answer and already computed status. It returns the banner/reveal nodes
and optional card class; it does not access session state or calculate scores.
The reveal formatter remains re-exported by `main.js` for existing callers.

`main.js` keeps checking eligibility and calculations, when feedback becomes
visible, card placement/recreation, submission and persistence. Ordinary text
questions remain ungraded and fill-in-the-blanks keeps its own feedback renderer.
Boolean display labels use the editor's existing translated vocabulary through
`getBooleanAnswerLabel` in `worksheet-values.js`: English True/False and
Traditional Chinese 是/否. Viewer buttons, checking reveals and printed choices
and answers use the same labels; boolean storage values and grading are unchanged.
Authored text and option labels are not translated.

## Worksheet viewer audio-control ownership

`server/viewer/audio-controls.js` owns the existing question/option audio buttons,
language menus, labels, focus, viewport positioning and UI state callbacks.
`main.js` creates one coordinator per viewer page with the existing icon helper
and translator. That coordinator survives shell renders, so all controls share
one open-menu owner and one lazily attached document dismissal listener. Each
control's existing abort signal owns its DOM listeners and positioning resources;
closing or disposing a menu cancels its frame and disconnects its observer.

`ViewerAttemptSession` still owns asset reads, audio players, object URLs,
single-playback enforcement and pending-request cancellation. Navigation and
block replacement still decide when to close menus and interrupt playback.
Option audio remains a sibling of the answer button and never selects an answer.
Source resolution uses the existing canonical track normalizer and legacy
attachment fallback. The module loads statically; no login, voice/rewrite,
generation, package, storage, CSS or playback-policy changes are introduced.

## Worksheet viewer print ownership

`server/viewer/main.js` keeps print-button availability, the student-name prompt,
school preference storage, popup creation and error/notification handling. It
statically imports the report builders; clicking Print does not lazy-load code.

- `print-report-model.js` prepares the ordered reading/question sections, answer
  and grading presentation, feedback and local image data URLs. It reads the
  supplied asset storage but does not save or modify the attempt. School-name
  defaults are shared with the existing settings UI; locale is read at call time.
- `print-report-html.js` renders that model with the existing text renderer and
  `print-report-styles.js`. It owns document markup and the existing embedded
  image/font readiness and print/afterprint script, but never opens the window.
- `worksheet-values.js` holds the existing value normalization and deterministic
  option shuffle used by both the live viewer and report. Neither renderer owns
  a separate copy of these rules. These modules do not import `main.js`.

Report tests import the builders directly. Viewer integration tests retain
coverage of popup timing, settings, package round trips and the actual print
entry points. This separation changes no package format, storage key, layout,
authentication or attempt lifecycle.

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
