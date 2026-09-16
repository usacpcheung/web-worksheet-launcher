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
- RolePlayScene editor-mode UI guidance:
  `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`

## RolePlayScene Editor UI Guidance

- For RolePlayScene editor-mode UI changes, follow
  `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`.
- This guidance applies only to editor mode, not RolePlayScene player/viewer
  mode.

## Non-negotiable Compatibility Rules

- Widget retirement must not change any editor, viewer, or RolePlayScene
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

- Product regression and widget-retirement boundary tests pass.
- Core product functionality and shared services are preserved.
- Applicable contract and retirement documentation reflects the changes.
- External parent integrations and deployment mappings have been checked
  before deploying removal; record the rollback commit and live QA results.
