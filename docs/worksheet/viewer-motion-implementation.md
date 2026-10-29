# Viewer motion implementation — stage 4

Drafted 2026-10-30 (Asia/Hong_Kong). Stack on PR #334 at
`bf28fb29a7399e0eb04524bb3d7a58fcae64a91b`. Keep the existing stack open.
Implementation is in this PR; it remains unmerged and undeployed.

## Design baseline

Use the final Version C reference identified in the
[viewer plan](viewer-ui-refactor-plan.md). Keep blur-to-clear and element movement
as distinct effects. Begin while entering the viewport and finish about 15% of
viewport height before the 40% reading line. Use the same unobscured viewport as
section navigation, accounting for the operation panel and visual viewport.

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
