---
name: roleplayscene-editor-ui-design
description: Use when changing RolePlayScene UI design for editor authoring surfaces or player/playback surfaces, including inspector controls, scene authoring workflow, playback theater UI, buttons, icons, media rows, action groups, choices, cue cards, modals, or styling. Follow /server/editor visual vocabulary for RolePlayScene controls while keeping editor layouts and player theater layouts distinct.
---

# RolePlayScene UI Design

Use this skill for RolePlayScene editor-mode and player/playback UI design.
Editor and player should feel like the same app, but they should not use the
same layout model.

The folder name is historical: this skill covers both modes. Follow repository
`AGENTS.md` for product compatibility and cleanup rules. UI guidance does not
authorize changing schemas, retiring features, or deploying changes.

The main reference surface is `/server/editor`, especially its authoring shell,
panels, section headers, buttons, icons, media rows, action groups, form
controls, and confirmation modals.

Primary implementation areas are `server/roleplayscene/scripts/editor/`,
`server/roleplayscene/scripts/player/`, `server/roleplayscene/scripts/main.js`,
and `server/roleplayscene/styles/app.css`. Use the worksheet UI skill as well
only when the change also touches worksheet surfaces or their shared patterns.

## Direction

RolePlayScene UI should feel unified, light, and purposeful:

- Light workspace with white panels on a pale gray background.
- Thin neutral borders, subtle shadows, and 8-12px radius.
- Dense but readable controls.
- Clear action grouping.
- Icons for compact repeated actions.
- Text labels where meaning must be obvious.

Editor mode should feel like a compact authoring tool. Player mode should feel
like a theater/playback surface, not an authoring inspector.

Avoid marketing-style UI, oversized hero sections, decorative gradients, visual
noise, heavy card stacks, raw browser controls, or one-off button styles.

## Shared Visual Vocabulary

Reuse the same visual vocabulary across RolePlayScene editor and player:

- Neutral/accent/danger action variants.
- Thin borders, light surfaces, restrained shadows, and consistent 8-12px
  radius.
- Compact button heights and aligned action groups.
- Icon + label buttons for clear workflow actions.
- Icon-only buttons for compact utility actions with `aria-label`.
- Editor-style icon set: inline SVG, no fill, `stroke="currentColor"`,
  rounded caps/joins, and consistent stroke width.
- Light rows/action rows for choices, media, history, and repeated controls.
- Muted badges/status text before action buttons when status describes the row.

Do not copy editor layout directly into player mode. Prefer playback-scoped
classes that reuse the same tokens and styling language. Avoid coupling player
CSS to editor-only implementation classes unless the shared class is already
stable and intentionally generic.

## Layout

For editor mode, follow `/server/editor` layout patterns:

- Use a two-pane or grid-based authoring surface.
- Put navigation, story map, or scene preview on the left.
- Put selected scene details on the right.
- Use white panels with neutral borders, subtle shadows, and compact padding.
- Use icon + heading section headers for major inspector groups.
- Avoid nested decorative cards. Use framed rows for repeated items, media rows,
  modals, and focused tools only.
- Prefer flatter inspector rows over stacked cards. Repeated dialogue and choice
  items should feel like light rows within one section, with minimal separators
  and no extra card chrome around every control group.
- Avoid divider-heavy layouts. Use spacing, alignment, subtle row backgrounds,
  and clear labels before adding horizontal rules.

For player/playback mode:

- Treat the stage image as the primary surface.
- The image must be fully visible; use contain-style sizing, not crop/cover,
  because speech-bubble anchors depend on the rendered image coordinate space.
- Keep playback controls near the stage as a lightweight floating toolbar.
- Keep normal dialogue as a readable overlay and speech-bubble dialogue as
  positioned bubbles on the image.
- Render choices as stage-centered overlays or player-surface rows, not as raw
  browser buttons or oversized solid blocks.
- Put secondary tools such as history and background music in compact drawers,
  popovers, or utility controls instead of a heavy side inspector unless there
  is enough meaningful content to justify a panel.
- On narrow screens, prefer vertical drawers/sheets over horizontal scrolling
  history rails.

## Buttons And Actions

Use consistent action categories.

- **Normal text buttons:** clear one-off actions such as add scene, add dialogue,
  or generate content. Use neutral border, white or pale gray background, 8px
  radius, compact padding, visible hover/focus states.
- **Icon buttons:** compact repeated actions such as delete, move, menu, copy,
  play/stop, or select. Use square 38px-ish buttons, centered icons, 8px radius,
  `aria-label`, and a `title` when discoverability helps.
- **Icon + label action buttons:** media/workflow actions such as attach,
  replace, view, play, generate, regenerate, and remove. Follow the
  `/server/editor` `media-action-btn` pattern: inline-flex, icon then label,
  8px gap, pale neutral background.
- **Preview/test actions:** keep visually distinct from structural edit actions
  such as add/delete, but use subtle accent styling rather than a loud CTA.
- **Danger actions:** use red text/border/pale red background only for destructive
  operations. Confirm destructive actions that remove meaningful content, media,
  or existing assignments.
- Keep related buttons aligned as a single action group. Buttons for one control
  row should not drift to different edges unless there is a clear primary/secondary
  split already used in `/server/editor`.
- Place descriptive badges before action buttons in the same row. For example,
  a generated-audio preset badge belongs before Replace/Play/Remove because it
  describes the attached media rather than acting on it.

Do not invent one-off button styles when an existing editor action pattern fits.
This also applies to player/playback controls and choice buttons.

## Icons

Use the `/server/editor` icon language:

- Inline SVG with 24x24 viewBox.
- No fill.
- `stroke="currentColor"`.
- Stroke width around `1.9`.
- Round caps and joins.
- Render through a shared helper where practical.

Common mapping:

- `play`: preview/play.
- `trash`: delete/remove.
- `image`: image media.
- `audio` / `audioAttached`: audio state.
- `upload`: attach/upload.
- `generate`: AI generation.
- `refresh`: regenerate/refresh.
- `eye`: view.
- `pencil`: edit/content.
- `list`: choices/options/flow.
- `check`: selected/saved/correct.
- `shield`: validation.
- `moreHorizontal`: overflow menu.
- `grip`: reorder/move.
- `lightbulb`: cue card/help prompt.
- `volume` / `music`: background music controls.
- `history`: story history drawer.

Do not mix unrelated icon styles in RolePlayScene UI. Avoid emoji as functional
icons when a matching editor-style icon exists.

## Forms And Sections

- Inputs, selects, and textareas should use `.control`-like styling.
- Labels should be concise and close to their controls.
- Inline add/edit controls should align with their associated input. Use a compact
  grid such as input column plus action-group column, and verify selector
  specificity does not let broader row grid rules push buttons to the far edge.
- Hints use muted text.
- Errors use compact red text near the field.
- Selects are for finite option sets.
- Checkboxes/toggles are for binary state.
- Segmented controls are for view or mode switching, such as Story Map / Scene
  Preview.
- Preserve IME composition behavior for text inputs.

RolePlayScene inspector sections should move toward `/server/editor` section
structure: scene basics, stage media, speech bubbles, dialogue, choices/flow,
and validation. Section headings are wayfinding elements, not hero titles.

## Media Rows

Use `/server/editor` media-row patterns for editor media fields and adapt their
visual language for player media utilities:

- Left side: media label and status.
- Right side: action group.
- Typical actions: Attach/Replace, View, Play, Generate/Regenerate, Remove.
- Use small badges or muted text for empty/attached status.
- Keep media rows visually flatter than cards: pale row background, compact
  spacing, aligned actions, and no nested panels inside the row.
- Avoid large image/audio previews in the inspector unless the task is visual
  placement. For placement, use Scene Preview.
- In player mode, background music should be a compact utility or popover rather
  than a large panel unless the surrounding layout intentionally supports it.

## Player Choices And Cue Cards

Playback choices should match the editor's light action-row language:

- Use light rows with thin borders and clear hover/focus states.
- Keep the clickable area large enough for playback, but avoid giant solid
  button blocks.
- Preserve multiline choice labels with `textContent`.
- Cue-card triggers should use the editor-style `lightbulb` icon, not emoji.
- Place cue-card icon buttons consistently before the choice text.
- Do not add new choice workflow actions unless requested; preserve existing
  choice selection and cue-card behavior.

## Player History

Story history is playback navigation, not editor metadata:

- Prefer a compact collapsible drawer or sheet over a permanent sparse side
  panel.
- Use a vertical connected stack for long dialogue-preview labels.
- Highlight the current entry and keep Back/Forward controls grouped at the top.
- Avoid horizontal scrolling history rails on mobile.
- Keep history visually secondary to the stage image.

## Modals And Accessibility

Use `/server/editor` confirmation modal language for new editor UI when
practical:

- Centered white modal, 12px radius, neutral border, restrained shadow.
- Right-aligned actions.
- Subtle blue primary action.
- Pale red destructive action.
- Restore focus when practical.

Accessibility requirements:

- Icon-only buttons have `aria-label`.
- Toggle-like controls use `aria-pressed`.
- Disabled states are visible.
- Focus rings are visible.
- User/imported text is written with `textContent`, not HTML interpolation.
- Menus and modal dialogs expose appropriate roles/labels.
- Do not remove keyboard access while compacting UI.
- If player/viewer code must change to support an editor-authored option, avoid
  cosmetic churn. Preserve stable DOM for animated player elements during simple
  state changes so CSS animations do not replay as flicker.
- Preserve stable DOM for player overlays and speech bubbles during simple
  playback state changes.

## RolePlayScene Rules

- This skill applies to RolePlayScene editor and player/playback UI design.
- Treat RolePlayScene editor as an authoring tool, not a presentation surface.
- Treat RolePlayScene player as a theater/playback surface, not an inspector.
- Keep story map and scene preview as editor surfaces.
- Speech bubble anchor placement belongs in Scene Preview.
- Dialogue, choices, and media controls should use compact editor action
  patterns.
- Keep full-project Play and editor preview behavior visually and conceptually
  separate.
- Do not change schema, launch hash, postMessage contracts, storage shape, or
  player behavior when a task is only visual refresh.

## Behavior and Regression Boundaries

- Preserve dialogue ordering together with attached media, scene IDs and links,
  import/export compatibility, direct published links and draft persistence.
- Preserve discussion text/recovery/undo across UI changes and navigation.
  Discussion uses `server/viewer/answer-voice-workflow.js`; changes there
  also require viewer regression checks.
- Preserve explicit audio activation, background-music capture coordination and
  browser Back/Forward restoration. Redraws must not bypass blocked autoplay.
- Keep plain scene dialogue/choice text on the existing `textContent` path;
  worksheet Markdown support is not permission to introduce scene rich text.
- Run affected Node tests and the relevant browser scripts separately:
  `scripts/roleplayscene-dialogue-order-smoke.mjs`,
  `scripts/roleplayscene-voice-smoke.mjs`,
  `scripts/roleplayscene-music-navigation-smoke.mjs` and/or
  `scripts/roleplayscene-smoke.mjs`. Shared sign-in UI has
  `scripts/package-sign-in-style-smoke.mjs`.
- Inspect script setup before use. Check editor/player modes as affected,
  English/Traditional Chinese, desktop/mobile, focus and console errors.
  Fixture audio/microphone/auth checks do not establish live-provider or
  real-device compatibility; report that limitation.
