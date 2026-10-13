# Current RolePlayScene responsive layout

Reviewed against main `7bb19de` on 2026-10-06 from `server/roleplayscene/styles/app.css`, `scripts/player/ui.js`, `scripts/main.js` and the colocated UI skill. This describes source behavior, not newly measured browser acceptance.

Authoring uses map/preview plus inspector; narrow layout stacks the panes. Playback uses the stage image, dialogue/speech bubbles, side rails, floating playback toolbar and a Utilities panel. Utilities consolidates music/history and discussion controls where available. Its toggle exposes `aria-expanded`/`aria-controls`; the panel has a labeled dialog and close control.

Actual CSS breakpoints include:

| Maximum width | Current rule family |
| --- | --- |
| 1023px | Toolbar alignment/overflow placement. |
| 900px | Single-column layout, topbar/server stacking, left utility controls, bottom playback rail, fixed Utilities panel and safe-area/dock reservations. |
| 767px (within the narrow rules) | Intro utility clearance, server-action visibility and mobile choices dock. |
| 720px | Additional compact layout rules. |

At 900px and below `.theater-toolbar` explicitly has `flex-wrap: nowrap` and `overflow-x: auto`. The code therefore does not implement the old proposal's guarantee that every primary control is reachable without horizontal toolbar scrolling. The Utilities panel is fixed above the reserved dock with a capped height; do not infer a complete breakpoint orchestration layer from the old plan.

The [archived responsive proposal](../past/plans/roleplayscene-responsive-layout-spec.md) had recommended 1024/768 breakpoints, a no-scroll primary dock and 44px minimum targets. Some utility/dock ideas are implemented, but its full criteria are not demonstrated by current source or this documentation review. It remains historical design input, not an approved next task or completed acceptance checklist.

Use the [RolePlayScene UI skill](../../.agents/skills/roleplayscene-editor-ui-design/SKILL.md) for future work. Check both player dialogue modes, Utilities, choices/history/music and authoring in both locales and narrow/desktop sizes. Relevant scripts and their limits are in [testing](../operations/testing.md). Preserve image containment, exact scene flow, audio activation, voice capture coordination and focus; layout proposals are not permission to change those behaviors.
