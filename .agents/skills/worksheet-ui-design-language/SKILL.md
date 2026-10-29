---
name: worksheet-ui-design-language
description: Use when changing the worksheet product UI in this repository, especially /server/editor or /server/viewer HTML, CSS, or DOM-rendering JavaScript. Apply this skill for editor authoring layout, viewer learner flow, shared modals/toasts/browse lists, form controls, buttons, icons, responsive behavior, or visual refresh work that should follow the repo design language.
---

# Worksheet UI Design Language

> Viewer target design, recorded 2026-10-29; not yet implemented.
> The viewer guidance below describes the selected Version C direction.
> See the [implementation plan](../../../docs/worksheet/viewer-ui-refactor-plan.md)
> for current-code evidence, pending decisions and staged acceptance gates.
> Existing interfaces remain valid until their migration PR is implemented.

## Overview

Use this skill to keep the worksheet editor and viewer feeling like one product while preserving their different jobs. The editor is a compact authoring tool; the viewer is a calmer learner-facing experience with larger task surfaces and persistent navigation.

Primary surfaces:

- `/server/editor/index.html`, `/server/editor/main.css`, `/server/editor/main.js`
- `/server/viewer/index.html`, `/server/viewer/main.css`, `/server/viewer/main.js`

For RolePlayScene-specific work, use `.agents/skills/roleplayscene-editor-ui-design/SKILL.md`.
Load both when a change genuinely spans worksheet and RolePlayScene UI.

## Product Boundaries

Follow the repository `AGENTS.md` for compatibility and cleanup rules. This
skill guides UI work; it does not authorize feature retirement or redesign.
Preserve save/resume, package compatibility, publishing, auth, completed-review
read-only behavior, voice recovery/undo and audio generation during visual work.
Viewer package/audio helpers and its voice workflow have cross-module consumers;
check those callers when touching shared behavior.

## Shared Product Language

Keep the app light, utilitarian, and workflow-focused:

- Preserve the bundled `Worksheet Chinese` font import from `server/app/fonts/worksheet-chinese.css` and the existing Inter/system fallbacks. Do not replace local font subsets with remote font requests as incidental UI cleanup.
- Use a light color scheme, neutral text, and pale gray/blue workspace backgrounds.
- Prefer white or near-white surfaces with thin neutral borders and restrained shadows.
- Use 8px radius for buttons, rows, inputs, menus, and compact tools; 10-12px for panels and modals. The selected viewer design may use its softer, larger radii within viewer-scoped styles; do not propagate those changes into the editor or shared dialogs.
- Favor compact, readable authoring controls and calmer, roomier viewer controls. Avoid marketing-style composition.
- Use blue as the main accent, green for saved/correct/success, amber for warnings, and red for destructive/error states. Preserve the viewer’s existing pale red False choice as an explicit exception: selecting False is not an incorrect-answer judgment.
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

### Design status and authority

Version C's continuous worksheet and ordered, paginated chooser are the selected
viewer direction. The latest standalone mockup is a visual and interaction
reference; it is not the production implementation or a source of business rules.
The detailed plan records trial parameters, open decisions and acceptance gates.
Do not describe a planned feature as shipped until the corresponding PR is merged
and its deployment status is known.

During migration, preserve the existing interface for areas outside each PR's
scope. The target design supersedes this skill's former mandatory bottom bar,
mobile stacked bottom zones and horizontal stepper layout. Earlier handoff rules
for an inline question grid also no longer define the selected chooser.

### Worksheet and actions

- Present actual content blocks and questions in worksheet order on a continuous,
  readable paper-like surface. Content blocks are first-class reading sections,
  not answerable questions. Never synthesize an introductory block from a demo.
- Use the selected desktop side action area and mobile launcher/drawer as the
  presentation reference. Preserve every existing action, its availability and
  enabled conditions. Keep header actions compact and clearly labelled.
- Keep navigation and primary worksheet actions easy to reach. Maintain clearance
  for fixed UI and ensure the first and last sections remain accessible.
- Keep the existing start/resume, package browser, upload manager and auth flows;
  this presentation redesign does not authorize redesigning those workflows.
- Use readable spacing and responsive question/media/answer layouts. Long prompts,
  images, answers and translated text must not overlap controls or be clipped.

### Position, navigation and progress

- Use one current-section model for scroll navigation, Previous/Next, the chooser
  and voice-operation View. Follow the decision rules in the implementation plan;
  do not invent different navigation behavior for each entry point.
- Separate section identity, displayed question number and answered progress.
  Preserve stable block IDs and worksheet ordering. Question numbering excludes
  content blocks. The ring describes the current question or reading section;
  its completion arc uses the existing answered-question calculation.
- Restore the existing resume target in both state and scroll position after
  layout is ready. Restoration must not activate intermediate sections or start
  playback/recording; preserve the existing resume-selection algorithm.
- Label sequential navigation as Previous section / Next section
  (上一節 / 下一節), since it also visits reading sections.
- Use Version C's ordered chooser: question and reading titles in sequence,
  separate current and answered indicators, and responsive pagination. All items
  must be reachable without an internal chooser scrollbar at supported sizes.
  Reduce entries per page and use the agreed compact layout for short/zoomed
  viewports; never clip required controls or hide overflow to claim compliance.
  Full item names must remain accessible when visual excerpts are shortened.
  Do not add the rejected A/B tabs or grouping model.
- Use a compact, labelled chooser dialog. Avoid nested mobile dialogs; maintain
  predictable close, selection, Escape and focus-return behavior.
- Keep chooser row identities stable during answer/status updates. Preserve
  focus and hover; update states without rebuilding unchanged rows.
- Follow agreed navigation behavior for audio and voice operations. Rendering,
  animation or a section merely entering/leaving the viewport must not independently
  stop or start services; retain the separate page-lifecycle behavior below.

### Visual language and controls

- Use Version C's cooler blue accent and pale blue canvas with white reading
  surfaces. Retain semantic success, warning, error and existing True/False
  colors; labels and state indicators must work without color alone.
- Preserve the production bundled Chinese font and existing fallbacks. The demo's
  embedded Noto Sans HK font does not authorize a production font migration.
- Keep MC answer surfaces equal in width, including options without audio. Keep
  option letters plain and consistent. Reserve a consistent audio-control column;
  single-track and multi-track triggers have the same outer dimensions.
- Preserve deterministic option shuffling, stable option values and their media
  associations. Display letters are presentation, never answer identities.
- Keep True/False controls equal in width, with their existing pale green/red
  hover and selected semantics. Preserve validation and answer-selection rules.
- Keep question audio associated with its prompt and option audio with its
  option. Preserve direct single-track playback, multi-track language selection
  and Stop behavior. Audio language selection is separate from UI language.
- Use stationary hover feedback: background, border and subtle shadow changes.
  Do not move or resize navigation buttons on hover. Restrict mouse hover effects
  to suitable pointer devices; retain touch feedback and visible keyboard focus.

### Motion and interaction stability

- Preserve the chosen blur-to-clear treatment together with prompt/media slides
  and staggered answer/option movement. They are separate presentation effects.
- Begin entry effects while content enters the viewport and settle before the
  reading line. Reveal lower elements of long questions when those elements enter.
  Never wait for the whole long section to fit in the viewport.
- Measure stable layout containers, not animated transforms. Do not let motion
  change section detection, answers, permissions, requests or autosave semantics.
- Keep visible, revealed content clear. Do not restart animation on status updates
  or minor scroll reversal. Protect focused, edited or selected content and audio
  menus; never move a control away from an active pointer or text selection.
- Explicit navigation destinations must be clear and stable. Preserve natural
  scrolling and allow user input to interrupt programmatic scrolling.
- Reduced-motion mode must remove blur/movement and unnecessary smooth scrolling.
  Unsupported animation must degrade to visible, usable content.
- Preserve the existing print-report flow and content. Motion and fixed chrome
  must not leak into printed output or cause saving/submission.

### Behavior and compatibility

- Keep actual answer controls, validation, raw input/caret handling, autosave,
  resume, submission, check/review and import/export behavior as the baseline.
- Preserve the complete voice/rewrite state machine, including session readiness,
  permission requests, recording, processing, cancellation, recovery and Undo.
  Do not reduce this to the mockup's timer simulations.
- Define operation-status ownership for multiple mounted blocks before implementation.
  Stop/Cancel/View must stay reachable without repeating the active operation's
  controls and live announcements in every text question. Use the plan's pending
  status-placement decision; do not silently invent a new operation flow.
- Preserve existing language-switch, page-hidden, page-exit and viewer-replacement
  behavior. These are lifecycle events, not ordinary section navigation. Dispose
  listeners, timers, media and controls correctly when the shell is replaced.
- Keep results attached to the original attempt and block, and preserve late-result
  protection. Background completion must not steal focus or scroll the worksheet.
- Maintain unique labels/IDs and isolated state when several question controls
  coexist. Do not recreate the worksheet form on each keystroke or scroll frame.
- No mock questions, synthetic answers/audio, demo localStorage keys, fake service
  calls, trial controls or diagnostic reading line may enter production.
- If implementation would alter an existing flow or function, identify the exact
  change and obtain the user's agreement before implementing that behavior change.

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
- Keep explicit responsive constraints for button/option/media rows and fixed action areas. For the target viewer, include the chooser, ring and mobile drawer; retain existing stepper/bottom-bar checks during migration.
- Preserve keyboard access for buttons, menus, dialogs, form controls and navigation. The viewer chooser must expose its current item and answered state accessibly.
- Use `textContent` for plain user/imported text. Supported worksheet Markdown must go through `server/app/worksheet-text.js` (`setWorksheetText` or `renderWorksheetText`); never interpolate raw input into HTML or bypass its format validation.
- Provide `aria-label` for icon-only buttons and accessible labels for dialogs/forms.
- Keep disabled states visibly disabled.
- Keep errors close to the field or action that caused them.
- Avoid changing contracts, storage shape, launch hash parameters, or `postMessage` schemas for purely visual work.

## Implementation Habits

- Read the relevant CSS and DOM-rendering code before changing UI; this repo builds UI mostly from JavaScript helpers and class names.
- Reuse existing class families before adding new ones.
- If a new pattern must be added, make it surface-scoped (`editor-*` or `viewer-*`) unless it is intentionally shared.
- Avoid coupling viewer-only UI to editor-only implementation classes except for already shared patterns.
- Keep visual edits scoped to the requested product surface and necessary shared helpers. The legacy widget renderer and parent prototype are retired; do not restore them.
- Run the relevant unit tests when behavior changes; for visual-only CSS changes, at least inspect the rendered surface in browser tooling when practical.

## Focused Regression Checks

- `npm test` is the Node suite; browser smoke scripts are separate.
- For text/layout changes, select `scripts/worksheet-markdown-smoke.mjs`,
  `scripts/worksheet-polish-smoke.mjs` and/or
  `scripts/viewer-completed-review-smoke.mjs` according to affected behavior.
- For voice/rewrite changes, use `scripts/viewer-voice-smoke.mjs` and
  `scripts/viewer-imported-ids-smoke.mjs`; check RolePlayScene discussion too
  when the shared voice workflow changes.
- For loading or auth UI, use `scripts/viewer-package-load-progress-smoke.mjs`
  or `scripts/package-sign-in-style-smoke.mjs`. Read each script's fixture/server
  setup before running it; do not point synthetic tests at production data.
- Check both supported locales, narrow/mobile and desktop layouts, keyboard
  focus, browser errors and the affected interaction. State what was not tested.
- Test current-section transitions separately from visual effects. Include mixed
  reading/question sequences, long sections, interrupted jumps and background
  voice completion. Test status refreshes without hover/focus loss.
- Every runtime PR needs acceptance evidence appropriate to its scope. Mocked
  microphone/auth/provider tests do not establish real-device or live integration
  compatibility. Use the plan's acceptance matrix and record remaining gaps.
- Evaluate representative large worksheets when continuous rendering is introduced,
  before adding motion. Record package sizes, media volume, load/scroll/input
  responsiveness and resource cleanup; repeat affected checks after animation.
