# Version C visual refinement

This change is stacked on PR #335 (`afe9575c13b8f032e1ab1238d8d097d364da9caa`).
It implements the visual adjustments approved on 2026-10-30, with the explicit
exception that **prompt playback remains a small icon-only control**, matching
the option playback controls. It is not a new interaction design.

## Visual scope

- Restore the reference's subtle geometric background, square paper surface,
  inset section dividers and larger inner margins.
- Restore large two-digit question numbers in the margin and localized question
  type captions. Reading sections still do not consume question numbers. The
  original localized question heading remains available to assistive technology.
- Increase title and prompt size, balance desktop prompt/answer columns, and
  retain the bundled Worksheet Chinese font and existing fallbacks.
- Lighten answer-action controls, separate the character counter from the action
  row, and retain validation, recovery and disabled-state information.
- Compact the ring and action area; keep the current section in the ring and its
  accessible name, with the existing answered count beneath it. The repeated
  position line is visually hidden, not removed from the DOM.
- Refine chooser typography, type captions, borders and backdrop. Its measured
  pagination, row identities, keyboard behavior and accessible names are intact.
- Rebalance narrow-screen paper spacing and reserve clearance between answer
  controls and the floating actions launcher.

All prompt/option audio triggers remain 50 × 44 CSS pixels, including single- and
multiple-language controls. True/False selection colors, equal choice widths,
stationary hover feedback and visible keyboard focus remain intact.

No answer, playback, transcription, rewrite, navigation, progress, persistence,
authentication or submission logic changes. Motion triggers and the reading-line
model are unchanged. No editor or RolePlayScene styles or shared voice helpers
are changed. The new locale entries are viewer captions only. Printing omits
the decorative background; the existing generated report flow is unchanged.

## Review and verification

The accepted standalone reference was compared with locally rendered PR code at
1280 × 900 and 390 × 900, covering the header, short answer, choices and chooser.
The comparison uses synthetic local data; it does not create server resources.
Real validation/help content and authored reading-block formatting are retained,
even where the demonstration has less content. Trial controls and the diagnostic
reading line are not copied into production.

The review/fix/review cycle corrected:

1. The answer wrapper initially captured the new presentation heading. It now
   leaves that heading with the prompt. Browser coverage checks its location,
   numbering and rendered geometry.
2. A header button selector also matched playback controls. It is now constrained
   to the actual header; prompt and option controls retain identical dimensions.
3. Mobile answer borders approached the fixed launcher. Additional right-side
   clearance is checked against actual rendered control bounds.
4. At 200% document text size, a margin number extended 9px beyond the left edge
   on a 320px viewport. Decorative ordinals now use the reference's fixed CSS
   sizes within the fixed gutter. Normal browser zoom still scales the page;
   prompt, answer and caption text retains its existing relative sizing. The
   original accessible question heading is preserved, and enlarged-text coverage
   checks the visible ordinal bounds as well as the chooser.

The broader follow-up review covered selector scope, responsive wrapping,
accessible question names, locale captions, semantic selected/disabled states,
chooser focus and pagination, motion/print boundaries and shared consumers.

Validation:

- Node suite: 1,755 tests passed with local fixture-server access enabled.
- Nine browser smoke scripts passed: Version C, continuous navigation, entry
  motion, completed review, voice, imported IDs, rendering lifecycle, worksheet
  Markdown and worksheet polish.
- The final mobile-clearance correction is followed by another Version C and
  continuous-navigation pass and fresh desktop/mobile screenshot inspection.
- Version C coverage includes both locales, 320px mobile width, short landscape
  viewports, enlarged chooser text, audio menus, keyboard focus, stationary hover,
  equal audio sizes and numbering across mixed reading/question sections.
- The Markdown test now expects the approved 450 prompt weight while continuing
  to require 700 for explicit bold and Markdown prompt headings.
- The reverse-boundary voice test measures its scroll distance. After the browser
  scrolls to the voice button on mobile, a fixed 100px gesture no longer reaches
  the boundary in this taller layout. The 8px/4px small-scroll regressions remain
  unchanged, and actual boundary departure still must stop recording and preserve
  original-answer ownership without focus or scroll theft.

This is local Chromium evidence, not live microphone/provider, physical-device,
IME or Safari acceptance. The PR remains open; this work does not deploy the VPS
or merge the stack. Outstanding deployment acceptance from PR #335 still applies.
