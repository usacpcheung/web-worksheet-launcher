# Worksheet block move commands

> Current behavior reviewed against main `7bb19de` on 2026-10-06. Code evidence: [main.js](../../server/editor/main.js), [block-drag-reorder.js](../../server/editor/block-drag-reorder.js), [editor-reorder-smoke.mjs](../../scripts/editor-reorder-smoke.mjs). Test commands below are guidance, not a new test-run report.

The editor block menu provides Move up/down, Move to beginning/end, and
Move to position. Positions are one-based and count content and questions in
the same sequence. The selected position is the moved block's final position;
all other blocks retain their relative order.

While a block-list control has keyboard focus, Ctrl+Shift+Up/Down (Windows/Linux)
or Cmd+Shift+Up/Down (macOS) moves that block one position. These shortcuts do not
apply in text fields or elsewhere in the editor. The menu shows the shortcuts,
supports arrow/Home/End navigation, and Escape returns focus to its trigger.

Moves retain block identifiers, content and media references, use the existing
autosave path, and preserve the selected inspector block. Focus follows the
moved row; only the block list scrolls as needed to reveal it. The position
dialog supports cancellation and rejects a stale destination if the worksheet
identity or block sequence changes while it is open.

## Mouse dragging

Drag a block's grip to reorder within the block list, including the gaps between
rows. A blue insertion line shows the destination. Holding near the visible top
or bottom edge scrolls the list; moving nearer the edge increases the speed.
Leaving the list pauses scrolling; dropping outside or cancelling does not move
the block. Move commands remain the keyboard/touch alternative.

Autosave updates retain the drag source. A worksheet identity or block-sequence
change cancels the gesture rather than applying a stale destination. External
file/text drags are not accepted as block moves. Package formats, viewer behaviour
and RolePlayScene are unchanged.

## Verification

Run `npm test`, then start `node scripts/static-server.mjs` and run
`node scripts/editor-reorder-smoke.mjs`. The smoke uses isolated storage and
synthetic session responses with 18 mixed blocks. It covers endpoint/position
moves, cancellation, keyboard focus and shortcuts, text-field isolation, data
preservation and save/reload in English/Traditional Chinese at 1280px and 390px.
Optional `VIEWER_SMOKE_SCREENSHOTS` must point outside the repository.

Also run `node scripts/editor-drag-reorder-smoke.mjs`. It uses native Chromium
mouse dragging for both endpoints, gaps, autosave completion, cancellation,
focus and persistence in both locales/widths. Synthetic supplementary checks
cover external drags and stale worksheet/order changes. Narrow-width mouse tests
do not certify native touch dragging; use the move menu on touch devices.

Move commands and the drag controller are merged on `main`. No data migration is required for these features. Future rollout rollback must use the deployment’s recorded validated revision, not an old stacked-PR parent.
