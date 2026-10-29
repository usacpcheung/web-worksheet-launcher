# Version C layout and chooser validation

Recorded 2026-10-30 (Asia/Hong_Kong). This stage is stacked on PR #333
(`98cc23ae717cc31ca92827dba2afd75f4428ac6f`) and remains unmerged. It implements
stage 3 of the [viewer plan](viewer-ui-refactor-plan.md), using the exact
standalone reference identified there. It does not implement motion/blur.

## Scope and preserved behavior

The viewer uses a continuous paper surface, right-side desktop actions and a
mobile/short-screen action drawer. The ordered chooser pages through reading and
question sections. Question numbering excludes reading sections; current position
and answered progress are distinct. Zero and False retain their existing answered
meaning. The original save, submit, check, upload/cancel, export, print, language,
details and preview-return handlers/availability remain in place.

Scrolling, chooser selection, Previous/Next section and operation View still use
PR #333's section-navigation path. Audio stop and voice navigation occur at the
same state transition. Answer controls, shuffling, input caching, completion,
recovery, Undo and background result ownership are retained. Only their viewer
presentation is changed. RolePlayScene code, shared voice helpers, APIs, storage,
authentication and Apache configuration are unchanged by this stage.

## Review findings handled

- The old horizontal stepper's earlier-section styling was not an answered mark.
  Chooser marks now use the same predicate as the answer summary.
- Measuring only the visible page could change capacity between pages and skip
  items. Capacity uses the tallest real row and actual dialog chrome at the
  current locale/font size. Rows stay mounted and all entries remain reachable.
- Reopening a native dialog can restore its previous row focus. Opening now
  explicitly anchors the current section; resizing retains the focused row.
- Native action drawers close before chooser/submit/check/save handlers run, so
  existing confirmation flows are not hidden behind a modal top layer.
- Markdown names use the existing plain-text converter and the first source
  line, without rendering untrusted HTML. Full row titles are accessible when
  their visual excerpt is shortened.
- Existing CSS could override the native hidden attribute on action controls.
  The continuous viewer explicitly preserves hidden states (including print
  and check before completion).
- Mobile launcher text was too tall on very short viewports. A fixed-size menu
  icon plus current question/book indicator preserves its accessible full label.
- Repeated status updates no longer rewrite unchanged row state. Section labels
  are computed before rendering rather than scanning all blocks per card.
- Navigation feedback is stationary, including touch hover. Desktop actions can
  scroll within the available viewport if enlarged text exceeds its height.
- Post-creation review reproduced enlarged desktop actions overlapping the
  floating operation panel. The side panel now reserves the measured operation
  panel height, including changes during recording and font/viewport resize. A
  real synthetic recording fixture checks this with 200% text size.
- A further accessibility pass reproduced wheel scrolling of the worksheet
  behind a native modal backdrop. The root scroll is locked while either viewer
  dialog is open, with a stable scrollbar gutter to avoid width jumps. The chooser
  fixture checks that backdrop wheel input leaves the worksheet position intact.
- Old smoke selectors were adapted to the real drawer/chooser and answer wrapper.
  Markdown parity still compares the exact rendered content, and the resume
  test checks programmatic scroll calls while allowing native scroll anchoring.

## Automated and visual checks

- Full Node suite: **1,754 passed**.
- Full browser suite: 55 scripts, covering editor/viewer/RolePlayScene and shared
  authentication, upload, cancellation and recovery. Final results are recorded
  in the PR along with the GitHub Regression run for its commit.
- New Version C browser fixture: English/Traditional Chinese; 16 questions with
  four interleaved reading sections; equal MC answer widths and single/multiple
  audio trigger dimensions; equal True/False widths; question numbering and
  zero/False completion; one modal at a time; Escape/focus return; current-row
  reopening; stable row identity/focus/hover across state updates; every entry
  exactly once across pagination; final-section selection; Previous and Save.
- Chooser layouts: 1280×900, 390×844, 320×568, 740×360, 640×450 and 320×225.
  The last two exercise CSS viewport sizes equivalent to 200%/400% zoom from
  1280×900. A separate 200% text-size case checks resizing while a row is focused.
  These are browser layout checks, not physical-device or browser-toolbar zoom
  acceptance. Dialog bounds and overflow are asserted; no list scrollbar or
  overflow clipping is used to hide inaccessible controls.
- Existing continuous-navigation/voice/lifecycle/review fixtures cover audio
  stop, recording/navigation, background rewrite/transcription, recovery/Undo,
  focus/clearance, save/resume, image cleanup, language replacement and completed
  read-only review. Markdown/print and preview-return assertions remain active.
- Desktop/mobile bilingual screenshots are inspected against the reference.
  The bundled Chinese font stays unchanged; the font smoke checks still verify
  local Chinese subsets and the existing Latin fallback.

## Synthetic scale check

Same Chromium process/fixture approach as stage 2: 20/100/300 total sections,
20% reading, mixed text/MC, 2/10/30 small SVG images, desktop 1280×900 and mobile
390×900. One isolated local run compared #333 with this stage:

| 300 sections | #333 desktop / mobile | Version C desktop / mobile |
| --- | --- | --- |
| Load to ready | 413 / 429 ms | 396 / 399 ms |
| Input handler + forced layout p95 | 3.9 / 3.3 ms | 6.4 / 6.1 ms |
| Collected JS heap | 3.7 / 3.7 MiB | 3.9 / 3.8 MiB |

The new headings and chooser increase DOM nodes (8,913 to 10,251 in this fixture).
These measurements are a regression spot check, not a device benchmark or a
claim about server latency, large real media, native browser memory or typing on
low-end phones. Integrated VPS/provider/microphone/mobile-device acceptance is
still deferred until the complete Version C candidate, before an authorized merge.
