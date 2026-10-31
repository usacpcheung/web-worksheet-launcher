# Continuous viewer validation

Recorded 2026-10-30 (Asia/Hong_Kong). This is local/CI evidence, not VPS acceptance.

## Scope and review

The candidate renders all ordered blocks with stable wrappers, uses one navigation
transition for scrolling/focus/jumps, and exposes one floating operation panel.
Current controls and styling remain while Version C presentation is staged later.
RolePlayScene continues to use the shared voice UI’s existing defaults; its player
code, voice workflow and API contracts are unchanged.

Review fixes covered native scroll anchoring during off-screen completion, focus
clearance above fixed controls, touch gestures versus activation, nested-scroller
boundaries, fast gestures ending in gaps, and unnecessary off-screen DOM updates.
The post-creation review also fixed Ctrl+Home/End page navigation so it updates
section identity; plain and modified boundary keys have bilingual browser coverage.
A subsequent review fixed resume restoration after header keyboard interaction:
late layout changes must not override the student’s first Tab/typing interaction.
Screenshot review added focused-answer clearance after resizing an already focused
answer, with a regression check that deliberately off-screen inputs stay off-screen.
Scroll selection waits for actual movement, avoiding a transition based on stale
geometry before a wheel event’s default scrolling takes effect.

## Automated coverage

- Full Node suite: 1,751 tests passed; the PR also runs the full suite in CI.
- Full browser suite: 54 scripts passed; affected fixtures were rerun after review fixes.
  The post-creation review runs the full suite again on the committed candidate.
- New navigation coverage exercises both locales at 1280px/390px: resume, stable
  controls, direct interaction, single-transition jumps, real wheel navigation,
  audio interruption, layout-preserved recording, cross-section rewrite/transcription,
  single operation status, focus/visual stability and short final sections.
- Existing voice, completed review, import IDs, lifecycle, editor, auth/upload and
  RolePlayScene fixtures remain in the suite. Current-question selectors now scope
  to the current section because other question controls intentionally coexist.

## Synthetic scale comparison

Chromium 148.0.7778.96 on the same cloud Linux machine; desktop/mobile viewport
widths, not physical mobile devices or CPU/network throttling. Baseline: PR #332
commit `4cf91bee7f473d8ad1d73170eadab4be55135783`. Candidate: this branch after
off-screen update optimization. Both used fresh isolated browser contexts and
local IndexedDB attempts with mocked API session responses.

Each 20/100/300-block package contains 20% reading sections, text/choice answers
and 2/10/30 prompt-image references to a small local SVG. These are synthetic
stress sizes, not claims about supported production limits. Initial load includes
navigation, answer readiness and fonts. Input p95 covers 30 input events with
synchronous rendering/layout and a frame between events. Heap is CDP JS heap
after GC, not total browser/native/media memory. Single runs are indicative.

| Renderer | Blocks | Width | Ready (ms) | Input p95 (ms) | Images mounted | JS heap (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| preparation | 20 | 1280 | 100 | 1.7 | 1 | 2.6 |
| preparation | 20 | 390 | 112 | 2.3 | 1 | 2.6 |
| preparation | 100 | 1280 | 117 | 1.7 | 1 | 2.6 |
| preparation | 100 | 390 | 109 | 1.5 | 1 | 2.6 |
| preparation | 300 | 1280 | 155 | 3.6 | 1 | 2.8 |
| preparation | 300 | 390 | 185 | 2.0 | 1 | 2.8 |
| continuous | 20 | 1280 | 193 | 3.0 | 2 | 2.7 |
| continuous | 20 | 390 | 175 | 2.2 | 2 | 2.7 |
| continuous | 100 | 1280 | 329 | 3.1 | 10 | 3 |
| continuous | 100 | 390 | 276 | 2.2 | 10 | 3 |
| continuous | 300 | 1280 | 497 | 7.3 | 30 | 3.6 |
| continuous | 300 | 390 | 472 | 4.3 | 30 | 3.7 |

Continuous rendering deliberately mounts more DOM/media than the baseline.
The initial 300-block version spent 35–38 ms in p95 input updates; avoiding
unchanged inactive-control writes reduced that to the values above. The fixture
does not establish budgets for real phones or large audio/image payloads.

## Remaining release acceptance

No VPS deployment or merge was performed. The agreed release gate is integrated
acceptance of the complete stacked Version C candidate, including real OIDC,
microphone/provider calls, touch/mobile keyboards, representative real packages
and printing. Chooser, ring, final styling and motion are later stages.
