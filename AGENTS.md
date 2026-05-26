# AGENTS.md

This file defines contributor/agent operating rules for this repository.
Scope: entire repository tree from the project root.

## Project Scope

- Parent prototype entry point: `parent_prototype/parent.html`
- Popup renderer entry point: `server/worksheet_launcher/render.html`
- Interface contract source of truth: `docs/message-contract.md`
- RolePlayScene editor-mode UI guidance:
  `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`

## RolePlayScene Editor UI Guidance

- For RolePlayScene editor-mode UI changes, follow
  `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`.
- This guidance applies only to editor mode, not RolePlayScene player/viewer
  mode.

## Non-negotiable Compatibility Rules

- Do **not** modify `server/worksheet_launcher/widgets/rewrite-widget.js` for
  prototype-specific behavior.
- For prototype-specific widget behavior, create a versioned file (for example
  `server/worksheet_launcher/widgets/rewrite-widget.v2.js`).
- Load versioned widget files from `server/worksheet_launcher/render.html` when
  needed, instead of editing `rewrite-widget.js` in place.

## Contract Discipline

- Any change to launch hash parameters or popup `postMessage` schema must update
  `docs/message-contract.md` in the same PR.
- Parent-side validation must always enforce all of the following:
  - `event.origin`
  - `event.data.type`
  - `event.data.rid`

## Phase Boundary

- Phase 1 is contracts/scaffolding only.
- New runtime behavior must be introduced in later phases with explicit,
  versioned changes.

## PR Checklist

Before merging, confirm all of the following:

- `server/worksheet_launcher/widgets/rewrite-widget.js` is unchanged unless
  explicit approval exists for modifying it.
- If interfaces changed, `docs/message-contract.md` was updated in the same PR.
- Scaffold paths still exist:
  - `parent_prototype/parent.html`
  - `server/worksheet_launcher/render.html`
  - `server/worksheet_launcher/widgets/rewrite-widget.css`
