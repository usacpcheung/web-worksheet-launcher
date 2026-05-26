# RolePlayScene Responsive Layout Spec

## Status
- Draft for review
- Intended as a stacked PR on top of `codex/roleplayscene-theater-playback-ui`

## Problem Statement
Current playback UI uses multiple absolute-positioned rails and full-label action groups that do not degrade cleanly on narrow screens. This causes hidden, overlapped, or hard-to-reach controls.

Observed issues:
- Background music utility can become visually hidden or blocked on narrow viewports.
- Header action groups can overflow and clip, especially with longer localized labels.
- Playback controls rely on horizontal scrolling under narrow widths, reducing discoverability and accessibility.

## Goals
- Keep critical playback actions reachable at all supported viewport sizes.
- Define deterministic control priority and collapse behavior.
- Remove control overlap between utility and playback surfaces.
- Preserve existing playback behavior while improving responsive layout.
- Support English and Traditional Chinese labels without clipping critical actions.

## Non-Goals
- No changes to message contracts or backend APIs.
- No redesign of scene model or dialogue progression semantics.
- No visual theme overhaul beyond responsive structure and spacing.

## Existing Layout Summary
Playback scene uses these structural layers:
- Stage frame and theater overlay.
- Left utility rail for music and history utilities.
- Right control rail for playback controls.

Current narrow-screen behavior:
- Right rail stretches across width.
- Toolbar becomes horizontally scrollable.
- Left utility rail remains independently positioned.

Risk:
- Two rails can compete for limited vertical and horizontal space.
- Visual overlap and interaction occlusion can occur.

## Control Priority Model
Tier definitions:
- Tier 1: Always visible, immediate playback actions.
- Tier 2: Utility actions, quick access but collapsible.
- Tier 3: Global workflow actions, movable into overflow.

Action mapping:
- Tier 1: Previous, Next, Play/Stop audio, Play All/Stop All, Choices.
- Tier 2: Background Music, Story History.
- Tier 3: Import, Export, Save to Server, Manage Drafts, sign-in/server utilities.

## Breakpoint Strategy
Recommended responsive ranges:
- Desktop: `>= 1024px`
- Tablet: `768px - 1023px`
- Mobile: `< 768px`

### Desktop
- Keep two-rail theater layout.
- Full labels allowed.
- Utilities remain directly visible.

### Tablet
- Keep Tier 1 in a single stable playback dock.
- Convert Tier 2 to compact icon triggers.
- Move non-critical header actions into overflow where needed.

### Mobile
- Replace dual-rail interaction with one bottom playback dock for Tier 1.
- Expose Tier 2 via a Utilities trigger opening a bottom sheet.
- Keep header minimal and prioritize scene context + mode controls.
- Avoid horizontal-scroll-only access for critical actions.

## Interaction Requirements
- Every Tier 1 action reachable within one tap without horizontal page scroll.
- Utilities reachable within one additional tap.
- Closing overlays and sheets must preserve focus and keyboard navigation.
- Buttons must maintain touch target minimum of 44x44 CSS pixels.

## Accessibility Requirements
- All icon-only controls require explicit `aria-label`.
- Overflow and bottom sheet controls need `aria-expanded`, `aria-controls`, and focus return behavior.
- Keyboard tab order must remain logical after responsive rearrangement.
- Reduced-motion users should not rely on animations for state visibility.

## Localization Requirements
- Do not assume English label lengths.
- At narrow breakpoints, allow short labels or icon-with-label fallback.
- Avoid truncating Tier 1 labels to ambiguity.

## Technical Design Direction
- Introduce one responsive control orchestration layer that decides placement by breakpoint.
- Reuse existing control handlers and state flags; avoid duplicating playback logic.
- Keep rendering ownership in player UI modules, but route utility controls through a shared container map.

Container policy by breakpoint:
- Desktop: `left utility rail` + `right control rail`.
- Tablet: `top utility strip` + `bottom control dock`.
- Mobile: `bottom control dock` + `utility bottom sheet`.

## Migration Plan
Phase 1: Foundation
- Add explicit breakpoint classes and container slots.
- Remove layout collisions between utility and control surfaces.

Phase 2: Utility consolidation
- Implement utility entry point that can render as rail popover (desktop) or sheet (mobile).
- Move music and history into shared utility architecture.

Phase 3: Header responsiveness
- Add action priority and overflow grouping.
- Preserve sign-in/server status visibility.

Phase 4: Polish and hardening
- Fine tune spacing, density, and label behavior.
- Verify accessibility and localization scenarios.

## Acceptance Criteria
- No critical controls become hidden at 320px width.
- Music and history remain reachable in all breakpoints.
- No overlap between utility and primary playback controls.
- Tier 1 controls remain visible without relying on horizontal toolbar scroll.
- Playback behavior parity maintained with existing tests.

## Test Matrix
Viewports:
- 320x568
- 360x800
- 390x844
- 768x1024
- 1024x768

Scenarios:
- Speech bubble enabled and disabled scenes.
- Manual navigation and Play All flows.
- Choice overlay open/close cycles.
- Story history backward/forward/jump.
- Background music mute/volume interactions.

Locales:
- English
- Traditional Chinese

Input modes:
- Touch
- Mouse
- Keyboard only

## Rollout and PR Strategy
- Keep this spec-only PR stacked on the current playback PR.
- Implement responsive changes in follow-up PR(s) referencing this spec.
- Require before/after screenshots for desktop, tablet, and mobile in implementation PRs.
