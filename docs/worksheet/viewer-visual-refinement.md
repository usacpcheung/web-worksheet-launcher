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

The background was subsequently revised following visual feedback: a pale blue
canvas with broad translucent blue planes replaces the grey outlined geometry.
The decorative SVG covers the viewport without tiling and leaves the white paper
unchanged. Fresh desktop/mobile previews and the existing bilingual Version C
browser smoke passed for this background-only revision; no interaction code or
layout measurements changed.

No answer, playback, transcription, rewrite, navigation, progress, persistence,
authentication or submission logic changes. Motion triggers and the reading-line
model are unchanged. No editor or RolePlayScene styles or shared voice helpers
are changed. Locale changes are limited to viewer captions and the approved shorter English
Previous/Next labels. Printing omits the decorative background; the popup and
completion requirement remain intact. The separately approved print-body expansion
is recorded below.

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


## Follow-up: utilities, chooser close and worksheet printing

The user approved moving the desktop utilities above the progress ring, shortening
English navigation to Previous/Next, and printing reading/content blocks together
with student answers in worksheet order. The chooser close icon was also reported
as incorrectly rendered.

- The same live utility elements move between the desktop rail and mobile header;
  their handlers, state, accessible names and focus survive responsive changes.
  Four normal utilities fit one compact row. Conditional print/cancel actions
  remain available and may use another row.
- The chooser uses a centered, font-independent SVG close icon inside its existing
  40px button. Its accessible name, closing action and focus return are preserved.
- The printed body now follows the worksheet's mixed section order, with content
  formatting, question images, margin numbers, type captions, choice surfaces and
  student answers. Reading blocks do not consume question numbers. Student/school
  metadata and existing checking results remain present.
- Printed option letters and selections use the same deterministic shuffle seed
  as the live attempt; stored values and payloads are unchanged. Zero, False,
  unanswered values, literal answer text and escaped content remain distinguishable.
- Short questions use prompt/answer columns. Long questions and answers flow across
  pages. Both locales retain the bundled font, and interactive chrome stays out of
  the report. No save/submission or print-window lifecycle change was introduced.

Review corrected a language-selector layout gap that initially wrapped the fourth
utility onto another row, and a duplicate colon in the existing printed answer
prefix. Follow-up review checked responsive focus, selector scope, option identity,
HTML escaping, empty/content-only worksheets and long-content pagination.

Validation for this follow-up:

- Node suite: 1,757 tests, including mixed-section printing and long-choice layout.
- All six final browser smokes passed: Version C, continuous navigation, completed
  review, voice, worksheet printing and Markdown. They cover both locales,
  desktop/mobile utility placement, retained
  focus, language-menu bounds, chooser icon geometry and actual close behavior.
- A new print smoke exercises the real completed-attempt print popup with local
  fixtures, verifies section order, image loading, shuffled choices, zero/False,
  unanswered fields and unchanged answers, and generates A4 PDFs in both locales.
- PDF text extraction verified all 80 reading paragraphs, all 65 answer lines and
  final section markers across nine pages per locale. Rendered PDF pages and fresh
  desktop/mobile/chooser screenshots were inspected.
- Playwright request interception stalled CSS imports in the generated popup;
  disabling fixture interception after viewer loading resolved this test-only
  problem. Production popup code was not changed to accommodate the fixture.

The final review found no further issue requiring a fix.

These checks use local synthetic data and Chromium. Native print-dialog behavior,
physical printing and VPS acceptance still require the user's local session.


## Follow-up: remove presentation captions

The user subsequently removed question-type captions from the worksheet, chooser
and printout, and removed visible Reading/閱讀 labels from content sections and
navigation. This supersedes the caption presentation described above.

Questions retain margin numbers; content blocks display their authored text.
The chooser identifies questions by number and content by book icon. The ring
shows a book icon while a content block is current, retaining the answered-question
count below it. Content blocks do not affect question totals or completion.
Screen-reader section labels remain descriptive, using Reading/閱讀; the viewer's
remaining Content/內容 fallback terminology is updated to match. Author-written
text is not renamed. Empty content entries use the existing Untitled fallback.

Caption spacing is removed so the question number aligns with its prompt in the
viewer and printout. Navigation, current-section detection and motion still use
the same existing controllers. No answer or stored-data changes are introduced.

Validation: all 1,757 Node tests and six Chromium smokes passed (Version C,
continuous navigation, entry motion, voice, worksheet printing and Markdown).
Desktop/mobile chooser and worksheet screenshots and printed PDF pages were
inspected. Both nine-page PDFs still contain all 80 reading paragraphs and all
65 answer lines. Final review found no further issue requiring a fix.


## Follow-up: structured question typography

Historical mapping below is superseded by the 2026-10-31 trial in
[Worksheet limited Markdown](worksheet-limited-markdown.md): 20px/18px prompt
body, 1.6 line height, H2–H4 at 1.55/1.35/1.15em, and prompt audio at the
top-right. Chinese, English and mixed text use the same provisional baseline;
UI locale does not determine worksheet typography.

Approved question-prompt mapping: body text is 1.375rem (22px at the default root)
on desktop and 1.25rem (20px) in the existing narrow/short viewport layout, with
1.65 line height. Headings h2–h6 use relative sizes 1.35, 1.18, 1.08, 1 and 1em,
weight 600 and 1.3 line height. Bold remains 700; italic keeps its semantic style.
Lists and quotations retain body size, with hanging list indentation, small
inter-item gaps and a subtle quote border. The first element has no extra top
margin. Authored paragraph breaks are preserved without additional paragraph
margins. Print uses the same hierarchy from a 12pt prompt base.

The existing bundled fonts remain. These rules are scoped to viewer prompts and
printed prompts; content blocks, editor preview styles, shared Markdown parsing,
format support and literal learner answers are unchanged. Text length does not
change font size. Responsive rem sizing preserves enlarged-text support.

Review covered CSS precedence over shared Markdown and print section headings,
relative sizes, list numbering, mixed Chinese/English wrapping, heading/bold
weights, first-element spacing and selector scope. The expanded Markdown smoke
exercises all supported heading levels, paragraphs, both list forms, quotations,
bold and italic in both locales at desktop/mobile widths and in generated print
output. All 1,757 Node tests and six browser smokes passed (Markdown, Version C,
continuous navigation, entry motion, voice and worksheet printing). Screenshots
were inspected for desktop, mobile and print. Follow-up review found no issue
requiring a fix. VPS deployment and native printing are not claimed.


## Accepted Style A and 45% reading line

The user accepted Style A from the standalone comparison and authorized changing
the production reading line to 45%. The title now uses the existing font at
weight 600, 48px desktop / 32px mobile (rem-based), normal letter spacing and
1.3 line height. Unboxed blue question numbers use weight 500, 36px desktop,
30px tablet and 24px mobile. Print retains its physical sizes with corresponding
600/500 title/number weights. No new decorative line or badge is added.

Section navigation now computes the reading line at 45% of the clipped visual
viewport, independent of operation-panel height. Motion receives that same
viewport; its existing 15% buffer naturally settles at 60% when entering from
below (30% from above). Slide durations and the navigation/voice state machines
are unchanged. This explicitly supersedes the earlier 40% geometry, not the
existing interruption, cancellation or result-ownership rules.

Review covered responsive typography, number clearance, shared geometry callers,
operation-panel independence, explicit jumps, scroll boundaries and reveal
settling. The boundary smoke's reverse-scroll measurement was updated to 45%.
Browser assertions verify 45% jump alignment, early settling and Style A type
sizes/weights. All 1,757 Node tests and six browser smokes passed (continuous
navigation, entry motion, Version C, voice, worksheet printing and Markdown).
Desktop/mobile rendered screenshots were inspected. Final review found no issue
requiring another fix. No VPS deployment or merge was performed.
