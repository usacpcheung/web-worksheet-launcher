# AGENTS.md

This file defines contributor/agent operating rules for this repository.
Scope: entire repository tree from the project root.

## Project Scope

- Worksheet editor: `server/editor/index.html`
- Worksheet viewer: `server/viewer/index.html`
- RolePlayScene: `server/roleplayscene/index.html`
- Shared application services: `server/app/` and `server/api/`
- Auth callback contract: `docs/message-contract.md`
- Legacy widget retirement scope: `docs/widget-removal-step2.md`

## UI Skill Routing

- For worksheet editor or viewer UI work, follow
  `.agents/skills/worksheet-ui-design-language/SKILL.md`.
- For RolePlayScene editor or player/playback UI work, follow
  `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`. Its historical
  folder name does not restrict it to editor mode.
- Keep authoring and learner/playback layouts distinct. Shared visual language
  is not permission to copy editor density into a player or viewer.

## Current Product and Shared Dependencies

- Preserve editor authoring, save/reload, import/export, preview, media/audio
  generation and publishing; viewer source loading, resume, answers, submission,
  completed review, printing and voice/rewrite; RolePlayScene authoring,
  dialogue/media associations, import/export, publishing and playback/discussion.
- `server/app/` holds shared auth, API clients, storage, contracts, text
  rendering and localization; `server/api/` provides server-backed services.
- Viewer consumes editor package/audio helpers. RolePlayScene discussion
  consumes `server/viewer/answer-voice-workflow.js`. A module's folder name
  does not imply exclusive ownership: trace consumers before changing it.
- Existing saved-content formats, legacy import/audio adapters and storage keys
  remain supported unless a separate, explicit retirement decision says otherwise.

## Non-negotiable Compatibility Rules

- Cleanup and widget retirement must not change any editor, viewer, or RolePlayScene
  functionality, including existing content compatibility and shared services.
- The legacy parent demo/SDK, popup renderer and rewrite widget have been
  removed by the approved retirement work. Do not reintroduce them.
- Keep shared rewrite, transcription and T2A bridge APIs, authentication,
  storage, publishing and all product runtime code intact during retirement.
- The deployed `/worksheet_launcher/app/login/popup.html` route is shared
  authentication, not the retired widget. Do not remove broad URL prefixes.

## Contract Discipline

- Changes to supported auth callback messages must update
  `docs/message-contract.md` in the same PR. Preserve origin, message type,
  source-window and auth-flow correlation validation.
- Legacy `worksheetResult` and launch-query contracts are historical only.
- Changes to product package/attempt contracts must update their applicable
  contract documentation and preserve existing content compatibility.

## Phase Boundary

- Historical Phase 1 scaffold requirements do not require restoring retired
  popup files. They are superseded by the widget retirement decision.
- Database, Apache, OIDC and external bridge deployment changes are outside
  the code-only widget retirement PR.

## PR Checklist

Before merging, confirm all of the following:

- Relevant regression checks pass; report commands, results and untested areas.
- Core product functionality and shared services are preserved.
- Applicable contract and retirement documentation reflects the changes.
- External parent integrations and deployment mappings have been checked
  before deploying removal; record the rollback commit and live QA results.

## Cleanup and Verification

- Do not infer dead code from names such as legacy, compatibility or stub,
  or from historical documentation alone. Check callers, dynamic/event wiring,
  stored data and external interfaces. Uncertainty means investigate, not delete.
- Remove a test only with evidence its exclusively retired behavior is gone.
  Replace brittle source-string assertions with behavior checks where practical;
  do not retain unreachable production code just to satisfy a source assertion.
- Test count is not a cleanup target. Keep data-loss, auth, cancellation,
  compatibility and shared-consumer coverage. Separate feature changes and
  large structural refactors from dead-code deletion.
- `npm test` runs Node tests under `server/`; it does not run browser smoke
  scripts. Run affected `scripts/*-smoke.mjs` explicitly for runtime/UI changes,
  including shared consumers. Use isolated fixtures, never production records.
- For cross-module cleanup, run the full Node suite and retained-product browser
  smoke suite. Verify English/Traditional Chinese and desktop/mobile where UI is
  affected. Mocked auth/microphone tests do not replace real deployment checks.
- Instructions-only changes require scope, consistency, link and skill validation;
  do not claim runtime tests were rerun if they were not.
- UI guidance is not authorization to change behavior, delete data, migrate the
  database, deploy to the VPS or merge PRs. Obtain the applicable approval.
