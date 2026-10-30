# Viewer motion implementation — stage 4

Drafted 2026-10-30 (Asia/Hong_Kong). Stack on PR #334 at
`bf28fb29a7399e0eb04524bb3d7a58fcae64a91b`. Keep the existing stack open.
Implementation is in this PR; it remains unmerged and undeployed.

## Design baseline

Use the final Version C reference identified in the
[viewer plan](viewer-ui-refactor-plan.md). Keep blur-to-clear and element movement
as distinct effects. Begin while entering the viewport and finish about 15% of
viewport height before the 40% reading line. Use the same visual viewport as
section navigation. Operation-panel height affects input clearance, not the
reading line or motion geometry (2026-10-30 acceptance correction).

Animate inner presentation elements, never the stable section wrappers measured
by section navigation. Group prompt and question media movement. Stagger MC rows;
reveal lower answer elements independently when a long question enters view.
Preserve the reference's approximate 520–760 ms slide durations and restrained
stagger, then verify the resulting effect on actual controls and narrow layouts.

## D8 agreement — 2026-10-30

The user agreed to match the mockup: retain off-screen replay from the final mockup. Rearm only after
an entire affected section/element has left the viewport with a generous margin
(reference: 140 px and approximately 190 ms). Do not restart effects on small
scroll reversals, answers, autosave, operation updates or resize.

## Implementation boundaries

- Add a viewer-only presentation controller owned by the shell AbortSignal.
- Reuse the section controller's viewport geometry rather than defining another
  reading line. Motion never activates sections or calls audio/voice services.
- Explicit navigation, resume destinations and control interaction settle the
  destination immediately. Protect pointer targets before movement, keyboard
  focus, selections, editing, recovery controls and open language menus.
- Observe replacement cards without remounting existing answer controls. Keep
  late background results at their original block without focus or scroll changes.
- Reduced motion, unsupported animation and print must leave all content clear
  and stationary. Dispose observers, animation handles and scheduled work on
  language change, viewer replacement and teardown.
- Do not change RolePlayScene, shared voice workflows, persistence or API contracts.

## Required implementation gate

Add browser coverage for separate blur and movement, early completion, long
questions, reverse scrolling, explicit jumps, focus/selection/audio-menu protection,
background rewrite/transcription, replacement cleanup, reduced motion and print.
Verify both locales, desktop/mobile, short/zoom-equivalent viewports and every
answer type. Inspect intermediate screenshots as well as settled output so a
missing animation cannot pass merely because the final layout looks correct.

Repeat the existing 20/100/300-section performance comparison with motion enabled,
including scroll/input responsiveness and cleanup. Run the full Node and browser
suites and GitHub Regression gate. After opening the implementation, review and
fix findings, then repeat a broader review and affected checks until no further
fix is identified. Leave the PR open. Integrated VPS/local-browser acceptance
remains a later step on the complete candidate, before an authorized merge.

## Implementation and review record

The viewer-only controller uses the existing section controller's viewport and
untransformed offset geometry. Prompt/media share a movement group; answer fields,
True/False controls and MC rows have their own reveal bounds. Progress is monotonic
while visible. Off-screen rearming uses the reference's 140px/190ms guard. Explicit
jumps/resume and interactions settle the section; focus, selection and audio-menu
state protect controls. Resize and status rendering do not reset visible progress.

The controller owns animation handles, observers and scheduled work through the
shell abort signal. Review added hidden-page cleanup. Reduced-motion/print CSS
also guarantees clear stationary content independently of animation scheduling.
No audio, voice, answer, storage, authentication or RolePlayScene service is called
by the motion controller.

A dedicated browser fixture checks intermediate blur plus a separate running slide,
off-screen replay, explicit jumps, focused-answer protection, print and reduced
motion, in both locales at 1280px and 390px. Intermediate screenshots are captured.
Existing continuous-navigation, voice, Version C and lifecycle fixtures are retained.
A pure geometry test checks early settling in both scroll directions. Full-suite
results and the final GitHub commit/run are recorded in the PR.

Synthetic scale checks reuse the 20/100/300-section fixture (20% reading; mixed
text/MC; 2/10/30 small images). These are local regression spot checks, not evidence
of low-end-device performance or live provider compatibility. Real-device and VPS
acceptance remain required before merging the completed candidate.

## Deployed acceptance follow-up — 2026-10-30

The supplied acceptance report verified eleven deployed assets at `16fba040`
and recorded 59 passing cases, three failures representing one audio-language
menu clipping defect, two blocked cases and eight untested cases. The report
is acceptance evidence for that revision, not certification of this follow-up.

Audio menus previously opened downward unconditionally; the browser smoke checked
horizontal bounds only. Positioning now measures the visual viewport, flips above
when needed, clamps horizontally and constrains height with scrollable language
choices. Open-menu scroll/resize observers are disposed on close or shell abort.
Prompt and option menus retain their existing ownership, dismissal, focus and
playback behavior. Focus on opening does not scroll the worksheet. Review added
protection against resetting internal menu scroll during placement. Browser
regressions cover both locales, top/bottom edges, short screens, open-menu scroll/
resize and enlarged language rows with the final choice reachable.

The unexplained Q1-to-leading-reading transition during real recording remains
unresolved. Local synthetic recording investigation in both locales at desktop/
mobile widths preserves Q1 and capture through 1.8 seconds of idle status updates,
layout changes and viewport resize, then confirms deliberate scroll departure
stops capture. No navigation/voice state-machine change is justified by that
evidence. The follow-up live test must log input events, scroll/focus, section
identity and operation geometry around one real speech capture and deliberate
scroll departure. Synthetic capture cannot prove a real microphone/provider path.

Before merge: retest menu placement on the updated deployment; obtain successful
real transcription and real rewrite after natural scrolling; verify an actual
hidden-tab/return; use a publishable QA prompt for a fresh publish/open round trip.
Physical mobile/IME/native zoom/Safari limitations remain explicit. Keep the stack
open. This follow-up does not change Apache, API, persistence or RolePlayScene.

Local follow-up validation: 1,755 Node tests and all 56 browser smoke scripts
passed. Final bilingual menu screenshots were inspected. Review covered open/
close/abort observer cleanup, nested menu scrolling, focus return, viewport edges
and unchanged audio/voice ownership; no further change was identified after the
scroll-fallback fix. GitHub CI for the follow-up commit is recorded in the PR.

## Reading-line correction after focused retest — 2026-10-30

Focused deployed acceptance at `662f2a2` verified menu placement, stationary real
speech/transcription, controlled real rewrite after scrolling and publication.
It recorded 40 passes and two blockers: successful transcription after recording
was stopped by scroll departure, and genuine hidden-tab/return. Cleanup preserved
all original server resources. Environment coverage limitations remain unchanged.

The new event/geometry evidence identified a distinct panel-induced reversal:
explicit Q1 selection aligned its top near 360px on a 900px viewport. Opening
recording chrome shifted the 40% line to about 305px without moving the worksheet.
A small downward wheel then selected the preceding reading section and stopped
capture. The exact regression was reproduced locally before fixing it: an 8px
wheel changed Q1 to the introduction and advanced recording to processing.

Reading geometry now ignores operation-panel height. Navigation, explicit jumps
and motion use the same visual viewport; focused inputs still clear the panel
through a separate control viewport. No direction lock, recording lock, provider,
voice-state-machine or storage change is introduced. Browser regressions cover
small forward/reverse movement, panel growth, jumps while recording, real forward
and reverse boundary departure, late original-answer completion and focus/scroll
preservation in English/Traditional Chinese at desktop/mobile widths. All provider
and microphone data in these automated checks are synthetic.

The original uninstrumented incident is not retrospectively proven by this fix.
The reproduced panel-induced reversal is fixed locally; updated deployed real
speech/departure and genuine hidden-tab/return acceptance remain required. There
is no need to repeat the passed menu/publication matrix unless a new change affects
those areas. Keep the stack open until the remaining acceptance is resolved.

Validation for the reading-line correction: 1,755 Node tests and all 56 browser
smoke scripts passed locally (three shards: 19/19, 19/19, 18/18). The review/fix/
review cycle covered all consumers of viewport geometry, focused-input panel
clearance, genuine forward/reverse departure, motion, lifecycle cleanup and late
result ownership. The added repeat-recording fixture uses Discard to resolve its
previous canceled operation before starting again. No further production issue
was identified after the geometry correction. Final commit CI is recorded in the PR.
