# Dialogue order in the editor

This PR is stacked on #277 (`codex/worksheet-limited-markdown`).

Up/down buttons beside each dialogue's Remove action swap adjacent entries
within the current scene. Speaker, text, audio and bubble settings remain with
their entry. The persisted dialogue array is also the order used by Next and
Play all. Scene order and package schemas do not change.

The first/last arrows are disabled at the boundaries. After a move, focus and
visibility follow the moved entry. Any audio preview stops, and an unfinished
speaker-name draft and the visible voice-preset selection follow the entry.

While audio generation or its authentication check is pending in a scene,
that scene's arrows are disabled with an inline explanation. The action also
checks this lock, preventing stale event handlers from changing indexed audio
targets. Other scenes can still be reordered.

The voice-preset label uses the same field typography as adjacent labels.
No drag-and-drop, cards, collapsible settings, global font changes, or player
cosmetic changes are introduced.

Verification:

- `npm test`
- Start `node scripts/static-server.mjs`, then run
  `node scripts/roleplayscene-dialogue-order-smoke.mjs`.
- The browser smoke covers English/Traditional Chinese, desktop/mobile, both
  dialogue playback layouts, boundary buttons, focus, label styling, a
  serialization/hydration round trip, Next and Play all. Audio is simulated.

VPS acceptance: move a line with real attached audio and a named speaker;
save and reload; confirm Next/Play all follow the new order with the matching
audio and bubble settings. Confirm arrows lock during generation and unlock
after success/failure. No environment variables or database migration needed.
