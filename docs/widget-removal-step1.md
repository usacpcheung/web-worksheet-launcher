# Widget retirement: Step 1 regression boundary

> Historical Step 1 baseline. Step 2 was stacked on its branch before merge;
> see [the approved removal scope](widget-removal-step2.md) for the current
> state. The evidence below describes the files before their retirement.

Status: preparation only. No runtime behavior, deployment route, payload format,
or legacy file is removed by this PR. Baseline: main-v1 c84927e.

## Code-derived scope

- `server/worksheet_launcher/render.html` loads `widgets/rewrite-widget.js`,
  its stylesheet, and `render.js`. This is the legacy popup surface.
- Editor and viewer `main.js`, and RolePlayScene `scripts/main.js`, import
  `server/app/api/server-api-client.js`, not the legacy widget.
- Viewer `answer-voice-workflow.js` calls `transcribeAudio` and `rewriteText`.
  Keep `/api/rewrite-bridge/transcriptions` and `/api/rewrite-bridge/rewrite`.
- RolePlayScene `scripts/player/discussion-state.js` and `ui.js` import that
  viewer voice workflow. It is shared product functionality, not widget code.
- RolePlayScene `scripts/editor/editor.js` calls `generateAudioFromText`.
  Its binary request helper uses `/api/rewrite-bridge/t2a`; keep this service
  and the shared client.
- The shared client uses `/worksheet_launcher/app/login/popup.html` for sign-in.
  This deployed URL refers to shared `server/app/login/` content, not the
  legacy renderer. Never remove an entire Apache URL prefix by name alone.
- Preserve all editor, viewer, RolePlayScene, shared app and API functionality,
  including local drafts/attempts, ZIP compatibility, publishing, auth, voice,
  audio generation, playback and dialogue ordering.

## Regression protection

`server/app/widget-removal-boundary.unit.test.mjs` scans runtime JS/HTML/CSS
in the three products and their shared app/API directories for direct legacy
references. It also executes shared session, rewrite, transcription and audio
client calls without loading a widget or renderer, checking authenticated URLs.

This is a direct-reference tripwire, not a complete dependency parser or proof
that every function is preserved. Computed URLs, server aliases and external
parent integrations require manual inspection. Existing product unit tests and
browser smoke tests remain required; do not replace them with this test.

Run `npm test`. Before each runtime-removal PR, rerun the existing viewer voice,
RolePlayScene voice/music/dialogue-order, Markdown, worksheet polish, imported
IDs, completed-review, package-progress and sign-in browser smoke scripts.
Use isolated fixtures, not production learner data. Repeat real HTTPS sign-in,
microphone/transcription, publish/load and autoplay checks on the deployment.

## Documentation update queue for later PRs

These are review targets, not permission to delete everything they mention:

| Document | Required follow-up when runtime retirement is approved |
| --- | --- |
| `AGENTS.md` | Replace frozen-widget/scaffold requirements with the approved retirement scope and retained-product guarantees. Until then all current rules remain binding. |
| `README.md` | Update project overview, parent integration and widget versioning; retain product routes and shared OIDC instructions. |
| `docs/README_rewrite_widget.md` | Mark legacy support retired and explain the supported replacement/boundary. |
| `docs/message-contract.md` | Record retirement of legacy launch/result interfaces in the same PR that changes them; do not conflate auth popup messaging with widget messages. |
| `docs/parent-launcher-sdk.md` | Document impact on external parent integrations before removing the SDK or launcher. |
| `docs/phase1-route-versioning.md` and `docs/render-security-headers.md` | Review legacy route/header guidance against actual Apache configuration; preserve shared routes and protections. |
| `docs/popup-compatibility-regression-checks.md` | Replace or archive only the checks for the explicitly retired surface. |
| `docs/adr-phase1-worksheet-model.md`, `docs/task-parent-launcher-cleanup.md`, `docs/temp-plan-viewer-rewrite-editor-t2a-not-final.md` | Label historical context rather than silently rewriting decisions. |

## Historical gate for Step 2

Merge in dependency order after checks pass; Step 2 may be developed stacked
on this tests/documentation-only PR while main-v1 remains unchanged. A separate approved
PR must enumerate exact deletion targets, inspect their callers and external
deployment consumers, update the applicable documentation/rules, and provide
a rollback plan. Do not delete bridge APIs, shared auth, storage or product
features merely because their names include rewrite, popup or worksheet_launcher.
