# Worksheet block move commands

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

This feature does not alter drag/drop, package formats, viewer behaviour or
RolePlayScene. Drag edge-scrolling is a separate planned change.

## Verification

Run `npm test`, then start `node scripts/static-server.mjs` and run
`node scripts/editor-reorder-smoke.mjs`. The smoke uses isolated storage and
synthetic session responses with 18 mixed blocks. It covers endpoint/position
moves, cancellation, keyboard focus and shortcuts, text-field isolation, data
preservation and save/reload in English/Traditional Chinese at 1280px and 390px.
Optional `VIEWER_SMOKE_SCREENSHOTS` must point outside the repository.
