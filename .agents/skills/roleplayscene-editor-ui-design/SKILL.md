---
name: roleplayscene-editor-ui-design
description: Use when changing RolePlayScene editor-mode UI, inspector controls, scene authoring workflow, editor buttons, icons, media rows, action groups, modals, or styling. Follow /server/editor design language for editor mode only; do not apply to RolePlayScene player/viewer mode.
---

# RolePlayScene Editor UI Design

Use this skill for RolePlayScene editor-mode UI work only. Do not apply it to
RolePlayScene player/viewer mode; that experience can use a separate visual
style.

The main reference surface is `/server/editor`, especially its authoring shell,
panels, section headers, buttons, icons, media rows, action groups, form
controls, and confirmation modals.

## Direction

RolePlayScene editor mode should feel like a compact authoring tool:

- Light workspace with white panels on a pale gray background.
- Thin neutral borders, subtle shadows, and 8-12px radius.
- Dense but readable controls.
- Clear action grouping.
- Icons for compact repeated actions.
- Text labels where meaning must be obvious.

Avoid marketing-style UI, oversized hero sections, decorative gradients, visual
noise, or player/viewer styling.

## Layout

Follow `/server/editor` layout patterns:

- Use a two-pane or grid-based authoring surface.
- Put navigation, story map, or scene preview on the left.
- Put selected scene details on the right.
- Use white panels with neutral borders, subtle shadows, and compact padding.
- Use icon + heading section headers for major inspector groups.
- Avoid nested decorative cards. Use framed rows for repeated items, media rows,
  modals, and focused tools only.

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

Do not invent one-off button styles when an existing editor action pattern fits.

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

Do not mix unrelated icon styles in editor mode.

## Forms And Sections

- Inputs, selects, and textareas should use `.control`-like styling.
- Labels should be concise and close to their controls.
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

Use `/server/editor` media-row patterns for editor media fields:

- Left side: media label and status.
- Right side: action group.
- Typical actions: Attach/Replace, View, Play, Generate/Regenerate, Remove.
- Use small badges or muted text for empty/attached status.
- Avoid large image/audio previews in the inspector unless the task is visual
  placement. For placement, use Scene Preview.

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

## RolePlayScene Rules

- This skill applies only to editor mode.
- Do not redesign player/viewer mode while applying this skill.
- Treat RolePlayScene editor as an authoring tool, not a presentation surface.
- Keep story map and scene preview as editor surfaces.
- Speech bubble anchor placement belongs in Scene Preview.
- Dialogue, choices, and media controls should use compact editor action
  patterns.
- Keep full-project Play and editor preview behavior visually and conceptually
  separate.
