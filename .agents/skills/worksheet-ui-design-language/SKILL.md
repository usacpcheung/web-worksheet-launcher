---
name: worksheet-ui-design-language
description: Use when changing the worksheet product UI in this repository, especially /server/editor or /server/viewer HTML, CSS, or DOM-rendering JavaScript. Apply this skill for editor authoring layout, viewer learner flow, shared modals/toasts/browse lists, form controls, buttons, icons, responsive behavior, or visual refresh work that should follow the repo design language.
---

# Worksheet UI Design Language

## Overview

Use this skill to keep the worksheet editor and viewer feeling like one product while preserving their different jobs. The editor is a compact authoring tool; the viewer is a calmer learner-facing experience with larger task surfaces and persistent navigation.

Primary surfaces:

- `/server/editor/index.html`, `/server/editor/main.css`, `/server/editor/main.js`
- `/server/viewer/index.html`, `/server/viewer/main.css`, `/server/viewer/main.js`

For RolePlayScene-specific work, also load `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`.

## Shared Product Language

Keep the app light, utilitarian, and workflow-focused:

- Use Inter/system font, light color scheme, neutral text, and pale gray/blue workspace backgrounds.
- Prefer white or near-white surfaces with thin neutral borders and restrained shadows.
- Use 8px radius for buttons, rows, inputs, menus, and compact tools; 10-12px for panels and modals; larger radii only where viewer cards already use them.
- Favor dense but readable controls over marketing-style composition.
- Use blue as the main accent, green for saved/correct/success, amber for warnings, and red only for destructive/error states.
- Keep focus rings visible and consistent with the existing blue ring language.
- Avoid decorative gradients, oversized hero sections, unrelated icon styles, and one-off button treatments.

Respect existing shared patterns across editor and viewer:

- `confirm-modal*` for centered dialogs and destructive confirmations.
- `notification-toast*` and notification feed/toast variants for status messages.
- `uploaded-draft-*`, `browse-modal*`, `browse-results`, and `published-result-*` for server/local package lists.
- `editor-section-header*` for icon + heading section headers where already shared.
- `muted`, compact red error text, and monospace IDs for metadata.

## Editor Direction

Design `/server/editor` as an authoring workspace:

- Keep the topbar compact and status-oriented: save state, validation, IDs, language, and session context.
- Preserve the main two-pane model: left navigation/actions, right block detail inspector.
- Use white panels on `#f3f4f6`, thin borders, subtle shadows, and compact padding.
- Represent repeated items as rows inside one section, not as card stacks.
- Use section headers with a 38px circular icon chip for major inspector groups.
- Use `.control` styling for inputs/selects/textareas; labels stay close to controls.
- Prefer grids for aligned form rows: answer grids, option rows, media rows, and metadata sections.
- Use compact row actions for media: label/status left, action group right.
- Use icon-only 38px buttons for repeated utility actions such as delete, reorder, copy, and overflow menus.
- Use icon + label buttons for workflow actions such as attach, view, play, generate, save, publish, browse, and import/export.
- Confirm destructive operations that delete blocks, media, drafts, published artifacts, or user work.

Editor UI should not feel like a landing page or a learner presentation. Keep it quiet, structured, and fast to scan.

## Viewer Direction

Design `/server/viewer` as a learner-facing flow:

- Keep worksheet content and questions as the primary surface.
- Use larger readable cards for content and questions; viewer cards may be softer and roomier than editor panels.
- Keep persistent navigation in the bottom bar. Preserve body/app bottom clearance variables so content is not hidden behind fixed controls.
- Use the stepper as progress/navigation, not as editor structure.
- Keep viewer header actions compact and icon-based.
- Use the start panel as a focused launch/resume surface, with simple sections for attempts and worksheets.
- Use bottom action buttons for learner actions such as save, complete, or check; avoid moving primary learner actions into scattered page regions.
- Use larger form controls for learner input than editor controls, with strong readability and clear checked/correct/incorrect states.
- Preserve animation and DOM stability for card transitions, check banners, text counters, and rewrite controls.
- On mobile, stack the bottom bar zones and maintain enough clearance for fixed controls.

Viewer UI should not inherit editor inspector density. It may share tokens and components, but the learner flow should feel calmer and more spacious.

## Buttons, Icons, And Controls

Follow existing control categories:

- Neutral buttons: white or pale gray background, neutral border, dark text.
- Primary/accent buttons: pale blue background, blue border/text, restrained hover.
- Danger buttons: pale red background, red border/text; reserve for destructive actions.
- Icon buttons: square, centered, 38px-ish in editor/header contexts, with `aria-label`.
- Menus: details/summary popovers with white surface, neutral border, 8-10px radius, and restrained shadow.
- Toggles and segmented controls: use `aria-pressed` or selected state classes, not hidden meaning in color alone.

Icon language:

- Use inline SVG helpers already present in the surface when possible.
- Use 24x24 viewBox, no fill, `stroke="currentColor"`, stroke width around `1.9`, rounded caps and joins.
- Do not mix emoji or unrelated filled icon styles into functional controls.
- Match common meanings already in the code: check, shield, pencil, list, image, audio, upload, generate, refresh, eye, trash, more, grip, attempts, worksheet, info, language.

## Responsive And Accessibility Rules

Before finishing UI work:

- Verify desktop and narrow mobile layouts for overlap, hidden fixed-bottom content, and long text wrapping.
- Keep explicit responsive constraints for fixed-format elements such as button rows, stepper nodes, option rows, media rows, and bottom bars.
- Preserve keyboard access for buttons, menus, modals, form controls, and steppers.
- Use `textContent` for user/imported text.
- Provide `aria-label` for icon-only buttons and accessible labels for dialogs/forms.
- Keep disabled states visibly disabled.
- Keep errors close to the field or action that caused them.
- Avoid changing contracts, storage shape, launch hash parameters, or `postMessage` schemas for purely visual work.

## Implementation Habits

- Read the relevant CSS and DOM-rendering code before changing UI; this repo builds UI mostly from JavaScript helpers and class names.
- Reuse existing class families before adding new ones.
- If a new pattern must be added, make it surface-scoped (`editor-*` or `viewer-*`) unless it is intentionally shared.
- Avoid coupling viewer-only UI to editor-only implementation classes except for already shared patterns.
- Keep visual edits narrowly scoped to `/server/editor` or `/server/viewer` unless the request explicitly includes popup renderer or parent prototype surfaces.
- Run the relevant unit tests when behavior changes; for visual-only CSS changes, at least inspect the rendered surface in browser tooling when practical.
