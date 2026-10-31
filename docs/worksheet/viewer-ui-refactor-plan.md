# Viewer UI refactor — implementation plan draft

Status: Version C layout/chooser implementation authorized, 2026-10-30 (Asia/Hong_Kong).
PRs #332 and #333 remain open. Stage 3 is stacked on #333. The user
approved D1–D6 and the operation-panel placement below; D7 is accepted in section 11; D8 is agreed in the stage 4 motion plan
for later stages. Deployment and merging the stack require separate authorization.

Companion: [worksheet UI skill](../../.agents/skills/worksheet-ui-design-language/SKILL.md).
This plan is the durable written design baseline. Visual comparison uses
`worksheet-version-c-final.html`, supplied in the design-review conversation:
5,445,770 bytes; SHA-256
`0a030ce9d6d2cb09e838e71248b70a6352d2158bca9cbb51089f1061f855bc68`.
The standalone HTML is not committed or available through a repository-relative
link. If it is unavailable in a future session, request that exact artifact before
claiming visual fidelity. Never rely on a previous worker's `/workspace` path.

## 1. Goal and evidence

Present the worksheet as one continuous document, with mixed reading and question
sections, Version C navigation and a cooler blue theme. Preserve existing product
functions. The user selected C and requested the earlier reveal/stationary-hover
revision; final visual acceptance of that revised mockup is still to be recorded.
The HTML is a reference, not a pixel-perfect implementation requirement.

Code evidence was reconciled against fetched `main`
`4a3675d3b834b711cef2589b10183adba39bf10e` (merge of PR #330).
Its file tree matches the initially inspected PR head
`4e43f9915379a33f4b2973cc4a3dbad9cfb90e67`. This records repository evidence,
not a verified deployed revision. Refresh main and review intervening changes
before runtime implementation.

| Existing code evidence | Implication for implementation |
| --- | --- |
| `server/viewer/main.js`: `renderCurrentBlockCard` clears the block container and control maps when its signature changes | Continuous rendering needs stable per-block ownership and deliberate disposal. Simply rendering all cards with the current function will not work. |
| `navigateToBlockIndex` closes audio menus, stops audio, calls `session.voice.navigate()`, persists position and renders | Extend this common transition path; avoid duplicate side effects from scroll, focus and button events. |
| `syncAnswerControlValues` updates the current block | Multiple mounted controls must receive appropriate updates, including off-screen operation results and read-only/validation states. |
| `computeAnswerSummary` counts nonempty answers on question blocks | Reuse it for completion; do not substitute visited sections or correctness. Zero and false remain valid answered values. |
| `server/viewer/answer-voice-workflow.js`: `navigate()` handles recording and pre-capture phases differently | Preserve the actual state machine rather than the mockup's simplified timers. |
| `docs/worksheet/viewer-voice-workflow.md` and existing browser smoke scripts | Use as behavior evidence and regression starting points, checking documentation against current code. |
| `AGENTS.md`: RolePlayScene consumes the viewer voice workflow | Shared workflow edits require consumer review and relevant RolePlayScene checks. |

Earlier handoff requirements for an inline three-column chooser and the earlier
motion schedule are superseded by subsequent user decisions. The handoff's
compatibility constraints remain useful. Neither handoff nor mockup authorizes
new business behavior or adding demo-only functions.

## 2. Selected design versus remaining acceptance

| Status | Decision |
| --- | --- |
| Selected direction | Continuous worksheet, mixed question/content order, Version C ordered and paginated chooser; no internal chooser scrollbar at supported sizes. |
| Selected direction | Question-only numbering; content remains navigable. Ring position and answered completion are independent. Previous/Next labels refer to sections. |
| Selected direction | Cooler blue theme, equal MC answer widths, equal audio trigger dimensions, plain option letters and equal-width True/False controls with existing green/red semantics. |
| Selected direction | Preserve both blur clearing and layered movement. Hover must not shift buttons or flash during state updates. |
| Reference layout | Desktop side action area; mobile launcher/drawer. Verify exact placement against the full production action inventory. |
| Latest trial values | Reading line at 45% viewport height (approved Style A follow-up); reveal settles at approximately 60% when entering from below. These are tuning values, not a package/API contract. |
| Pending final visual acceptance | Revised C mockup's motion timing, hover appearance, spacing and small-screen usability. |
| Accepted behavior rules | D1–D6 and the operation-panel placement in section 4, agreed 2026-10-30. D7 is accepted in section 11; D8 is agreed in the stage 4 motion plan. |

Keep production fonts and existing localization. Do not import the HTML's embedded
font/audio data, fixtures, hardcoded translations, simulated functions, diagnostic
controls or local-storage keys. Do not invent chapter/group metadata from variant B.

Version C's current trial palette is accent `#256ac4`, canvas `#f1f7ff`, tint
`#edf5ff`, ink `#20344d` and white paper. Production keeps its existing
fonts rather than the demo’s embedded font. These are reference values subject to actual contrast checks, not a requirement to copy demo CSS.
The chooser shows mixed titled rows, question numbers or reading icons, separate
current/answered markers, and page controls. It opens from the ring or labelled
Browse worksheet control. It has no grouping tabs or scrollable internal list.

## 3. Existing behavior to retain

- Question and option audio: only one active playback; preserve single-track play,
  multi-track language menu and Stop. On an actual current-section transition,
  preserve existing interruption behavior, including transitions into content.
- Recording: navigation stops capture and processes the original answer.
  Navigation during permission acquisition or initial session checking follows
  the existing cancel behavior; it must not start recording unexpectedly later.
- Transcription and whole-answer rewrite: work remains attached to its original
  attempt/block. Another question remains editable, while another voice/rewrite
  operation cannot start. Preserve View/Cancel and submission blocking.
- Preserve cancellation, stale-result rejection, caret insertion, selection-end
  insertion, raw answer text, validation limits, recovery, retry and Undo.
  Background completion neither scrolls nor steals focus.
- Preserve save/resume, imported and published worksheets, package/audio adapters,
  attempt export/upload, completed read-only review, checking and print report.
  UI relocation does not change action visibility or enabled conditions.
- Preserve deterministic option shuffling seeded by attempt/block identity,
  stable option-value mappings and associated images/audio. Scrolling, updates,
  language changes and resume must not reorder the same attempt's choices.
- Preserve lifecycle behavior explicitly: language switching currently rebuilds
  the shell and aborts its voice workflow; hiding the document calls voice
  navigation; page exit tears voice work down. Characterize current audio and
  recovery behavior for each event rather than copying the mockup's policies.
  Do not promise that operations survive these events without a separate decision.
- Preserve auth, bridge endpoints, account guards, storage keys and package/attempt
  contracts. No backend, Apache, database or API change is planned.
- Restore the block selected by the existing resume algorithm to the reading
  position after layout is ready. Do not persist pixel offsets or change storage
  shape just for the new layout. Avoid intermediate activation, duplicate
  autosaves, surprise focus changes or playback during restoration. Verify delayed
  media/fonts, imported attempts and completed review.

Before changing the renderer, inventory every production control and relevant state,
map its destination in the new layout, and record any gap in the mockup. Missing
mockup controls must not disappear from the product.

## 4. Interaction decisions

The ordinary rule is a stable section crossing the reading line. The following
rules cover exceptions that the single-block UI did not need to resolve. D1–D6
are accepted for the first implementation. Their small numeric tolerances are
implementation details to verify, not additional product decisions. D7 is accepted in section 11; D8 is agreed in the stage 4 motion plan.

| ID | Case | Recommended rule | Why it needs review |
| --- | --- | --- | --- |
| D1 | Gap, boundary jitter, short sections | Keep the last current section through a gap; switch at the next section boundary with a small tolerance. Use layout bounds, not animated card bounds. Do not debounce so heavily that ring and interaction disagree. | Exact tolerance and reverse-scrolling behavior need concrete tests. |
| D2 | Clicking or keyboard-focusing a noncurrent answer/audio control | Make that section current once before executing its action; clear its motion immediately. Ordinary scroll never moves keyboard focus. Do not pin the current section indefinitely to an off-screen focused input. | This is an exception to reading-line-only activation and may stop an operation on the old section. |
| D3 | Chooser/Previous/Next/View jump | Commit the target once, clear its effects and scroll to it. Intermediate sections crossed by programmatic scrolling do not activate. Explicit keyboard navigation gives a sensible destination focus. | Avoids repeated audio/recording transitions during one jump. |
| D4 | User interrupts a jump | Cancel the pending destination scroll; resume natural scroll tracking from actual geometry. Never force the user back to the old target. | Must cover wheel, touch and keyboard without hijacking input editing. |
| D5 | Keyboard, resize, image/font loading | Preserve current identity during non-user layout changes. Recompute geometry and apply tracking on the next intentional navigation/scroll. Reserve media space where possible. | Visual viewport changes must not stop recording by accident; distinguish browser-induced scroll from intentional navigation. |
| D6 | Start/end and long final section | Keep the first section at the start. At the end, allow the final section to become current even if its top cannot reach the line. Do not let an end-of-page shortcut override an explicit target or active editing. | Short final blocks, trailing space and keyboard shrinkage need testing. |
| D7 | Chooser opening, closing, resizing and zoom | Opening does not change the current section. From mobile, close the action drawer before opening chooser. Cancel restores opener/context; selecting navigates. Page capacity adapts while preserving the focused/current item where practical. Start with 320 × 568, 390 × 844, desktop and short landscape; test enlarged text and 200%/400% zoom. Reduce to one row and a compact/full-window arrangement when necessary. Keep title, full accessible row name, close and pagination reachable; never use hidden overflow to conceal a failure. If the tested layout cannot satisfy these requirements, resolve the design before release. | Prevent nested dialogs, lost focus and inaccessible rows at zoom/short heights. |
| D8 | Animation replay and interaction | Revealed content stays clear while visible. Prepare replay only after fully leaving the viewport with a margin; never replay on answer/status updates. Focus, selection and open controls stay stable. Explicit jumps settle immediately. | Decide whether the latest mockup's off-screen replay remains desirable in real use. |
| D9 | Operation status with multiple text questions mounted | Use one shared operation panel and retain question-specific hints/recovery. Keep Stop/Cancel/View reachable while the source is off-screen, including from content or non-text sections. Give one live region responsibility for announcing the operation stage; do not duplicate announcements or active controls in every mounted text question. | Current `createVoiceControls` creates a status component for each text question. Placement accepted: one fixed bottom-right operation panel on desktop, across the lower mobile viewport with clearance for controls. Keep one operation live region; reuse actual state/actions and per-question recovery. Do not duplicate Stop/Cancel/View in every mounted question. |

The 45% line uses the visual viewport (clipped to the layout viewport), with
keyboard/resize suppression under D5. The 2026-10-30 acceptance correction keeps
operation-panel height out of reading-line geometry: a panel appearing must not
make a small downward scroll select the preceding section. Input clearance still
uses the area above that panel, independently of section selection. Motion and
explicit jumps share the same reading geometry.

Progress counts answered questions using existing semantics, not correctness or
validity. Content-only and empty worksheets need a safe zero-total display.
Unnamed reading blocks need a localized fallback label; use an existing meaningful
title where available and otherwise a safe text excerpt/fallback, without inventing
required package metadata. Confirm the exact label strategy in the PR 1 inventory.

## 5. PR sequence and acceptance gates

PR 0–4 below are implementation-stage labels, not GitHub PR numbers. Each runtime
PR needs its own automated regression checks and review/fix loop. Per the user’s
2026-10-30 decision, implement on the preceding open PR branch and target that
branch in GitHub. Keep the stack open; deploy the complete Version C candidate
for integrated live acceptance, including preparation changes, before merging
in dependency order. Local integration testing continues at each stage. Do not stack the next PR
until the current PR passes its automated checks and the post-creation code
review/fix/review loop has no remaining issue requiring a fix.

### PR 0 — Document the target viewer design

- Update the existing worksheet UI skill and add this plan under `docs/worksheet/`.
- Add a discoverable entry to `docs/README.md`; resolve draft links for repository use.
- Preserve editor guidance; scope viewer-specific overrides explicitly.
- Record accepted versus pending decisions, reference artifact identity and local
  inspection revision. Keep the written baseline and exact artifact checksum here;
  do not commit the 5 MB standalone mockup or introduce broken worker-local links.
- Gate: review the wording, links, boundaries and decision statuses. No runtime test
  claim is needed for documentation-only changes. No application behavior changes.

### PR 1 — Prepare stable block rendering and common navigation

- Complete the production action/state inventory and reconcile intervening main changes.
- Extract manageable block-view lifecycle and update/dispose responsibilities.
  Keep the single-block interface while removing assumptions that prevent several
  controls coexisting. Keep implementation changes proportionate to this goal.
- Preserve block IDs, labels, control state, cached raw values, cursor/selection,
  answer handlers, media resources and navigation side effects.
- Characterize navigation through recording, permission/session checking,
  transcription, rewrite, cancellation and recovery before changing its entry points.
- Characterize language switching, document hiding/page exit and shell replacement;
  record existing operation/recovery behavior and verify disposal of stale UI.
  Capture the deterministic shuffle and existing resume-target rules as regression
  cases. Inventory all status/live-region instances before multiple blocks coexist.
- Gate: existing single-block UI and real workflows remain behaviorally unchanged;
  no leaks or duplicate handlers after navigation. Relevant Node/browser checks pass.

### PR 2 — Continuous worksheet and current-section navigation

- Render ordered reading/question sections with stable containers and controls.
- Implement agreed D1–D6 and D9 rules through one current-section transition path,
  separating scroll tracking from programmatic scrolling and presentation effects.
- Synchronize all mounted controls affected by operation/completion/check state.
  Keep off-screen answers and late-result guards correct. A mounted control is
  not necessarily visible or the learner’s focus target: preserve intentional
  in-question caret return without focusing an off-screen answer or interrupting
  another interaction. Implement agreed status ownership so controls remain
  reachable without many duplicate live announcements.
- Preserve resume identity and existing persistence format. Persist meaningful
  section transitions through existing autosave, not every scroll frame. Restore
  the resume target visually without triggering a sequence of navigation effects.
- Benchmark representative larger packages before accepting continuous rendering:
  record block/media counts, device/browser, initial load, scroll/input response
  and memory/resource cleanup against the baseline. Agree on practical budgets
  from real supported package sizes; the 16-question mockup is not a size limit.
  A material regression must be addressed in PR 2, not deferred to motion polish.
- Keep existing navigation/action controls usable until PR 3 replaces presentation.
  Use a stable, motion-free layout to isolate behavior regressions.
- Gate: continuous reading, editing, all navigation routes and cross-section
  operations pass; save/reload, submitted review and printing remain correct.
  Resolve D1–D6 and D9 before implementing dependent behavior.

### PR 3 — Version C navigation and visual layout

- Implement ordered paginated chooser, ring, question-only numbering and section labels.
- Apply blue styling, desktop/mobile action presentation and consistent answer/audio
  control sizes. Use existing fonts, translations, safe worksheet text rendering
  and real controls; retain all actions from the inventory.
- Keep chooser DOM stable during answer/status updates. Support focus/selection
  restoration, keyboard navigation and responsive pagination, including zoom.
- Gate: both locales, desktop/mobile/short viewports, all action states and long
  labels work without clipped/unreachable content or hover flicker. Apply the D7 agreement in section 11.

### PR 4 — Presentation motion and integrated release acceptance

- Add blur and layered movement independently of state/navigation. Apply accepted
  timing, replay rules, reduced motion and interaction protection; resolve D8.
- Repeat PR 2 performance checks with motion enabled, without prematurely adding
  virtualization that would unmount active controls or invalidate geometry.
- Complete full integrated acceptance on the deployed candidate, including real
  microphone/auth/provider/device checks that mocks cannot establish.
- Gate: behavior matches the accepted baseline, UI passes final review, known issues
  are resolved or explicitly accepted, and deployment/rollback evidence is recorded.

Scope may be split further if PR 2 becomes too large. Do not combine an unrelated
shared-service refactor or font migration with this redesign. PR 0 can record open
questions; it does not authorize coding unresolved behavior.

## 6. Verification matrix

| Area | Required evidence | Primary PRs |
| --- | --- | --- |
| Baseline compatibility | Existing Node suite and affected browser smokes; compare control/action inventory | 1–4 |
| Mixed sections | 16 questions + 7 content blocks, adjacent content, content before/after questions, all supported input types, valid zero/false answers, empty/content-only cases | 2–4 |
| Navigation | Slow/fast/reverse scrolling, long/short sections, first/last, gaps, every chooser page, Previous/Next, View, interrupted jump | 2–4 |
| Editable state | Caret/selection, IME composition, raw numeric input/error, changing answers, no remount on keystroke/status refresh | 1–4 |
| Lifecycle | Language change, tab background/return, page exit/reopen and shell replacement; preserve operation/recovery behavior and dispose stale UI | 1–4 |
| Audio | Prompt/option, one/multiple languages, absent audio, deterministic option/media associations, Play/Stop, menu handling, transition into content, resource cleanup | 1–4 |
| Voice/rewrite | Navigate during session check, permission request, recording, transcription and rewrite; original target completion, reachable nonduplicated View/Cancel, one stage announcement, other-answer edits, Undo, recovery/retry and late output | 1–4 |
| Persistence/review | Visual resume to the existing target after delayed media/fonts, imported IDs, package load, save/export/upload, completed read-only state, check feedback and actual print report | 1–4 |
| Responsive/accessibility | Desktop, tablet, 390px/320px mobile, short landscape, 200%/400% zoom and large text, real mobile keyboard, both locales, keyboard/dialog focus, screen-reader labels, contrast | 2–4 |
| Chooser stability | No internal scroll at tested sizes; every item reachable; no movement/flicker with pointer at row edge or async state updates; current and answered states distinct | 3–4 |
| Motion | Both directions, visible slides, earlier settling, no blur restart while visible, protected editing/selection/menu, reduced-motion and print | 4 |
| Performance/layout | Recorded baseline and representative package/device sizes, load/scroll/input response, image/font loading, no scroll-frame persistence or network requests, no leaks; mandatory gate in PR 2 | 2–4 |

Start from `npm test` and relevant existing browser scripts, particularly
`viewer-voice-smoke.mjs`, `viewer-imported-ids-smoke.mjs`,
`viewer-completed-review-smoke.mjs`, `worksheet-markdown-smoke.mjs` and
`worksheet-polish-smoke.mjs`. Include loading/auth/upload coverage when their
presentation or wiring is affected. Inspect each script's setup before running.
Update brittle single-card assumptions with meaningful equivalent assertions;
do not delete coverage merely because the new UI has multiple visible blocks.

Add focused regression cases for new scrolling/current-section logic and stable
multi-block updates. Test shared RolePlayScene consumers if shared code changes.
Use isolated fixtures and record created QA resources for cleanup; never delete
unrelated published packages or use real learner answers as fixtures.

Automated Chromium mocks establish neither actual microphone/provider behavior nor
Safari/mobile-keyboard compatibility. Record browsers, devices, commit, results and
untested areas. Obtain the applicable authorization before live provider calls or
VPS deployment; user approval of the plan alone is not deployment permission.

## 7. Rollout and rollback

Each runtime PR must remain functional and independently revertible on its tested
base. Before deploying a candidate, record the exact candidate and previously
validated deployment SHA. The agreed release path is one complete Version C candidate deployment followed
by integrated acceptance of the full stack; retest any fixes before release. Plan no storage migration or
new feature-flag infrastructure by default. If an intermediate production rollout
is unsuitable, agree on a test deployment instead of silently exposing unfinished UI.

Rollback must preserve saved attempts and use the actual validated predecessor,
not a historical SHA copied from old acceptance reports. Do not merge or deploy
solely because the standalone mockup passed visual checks.

## 8. Review order

1. Review this draft and the companion skill: scope, selected design, preserved behavior.
2. Confirm final C visual baseline and the five-PR sequence (documentation plus four runtime PRs).
3. Review D1–D6 and D9 before PR 2; D2, D5 and operation-status ownership deserve special attention.
4. D7 is recorded in section 11. Review D8 before motion implementation.
5. Review documentation PR 0 on its fetched main baseline; merge only when authorized. Documentation acceptance does not approve unresolved runtime behavior or authorize runtime implementation.

## 9. Rendering-preparation inventory and implementation boundary

Documentation stage 0 merged as [PR #331](https://github.com/usacpcheung/web-worksheet-launcher/pull/331).
Stage 1 retains the single visible block, existing CSS, stepper and bottom actions.
The continuous worksheet, chooser, ring, new labels and motion are not implemented
by this preparation. At the preparation stage D1–D9 were pending; section 4 and the agreement below
record subsequent approvals for the continuous-rendering stage.

The following inventory was checked against the stage-1 base `c2e1bc0`.
Functions are in `server/viewer/main.js` unless another module is named. This is
an implementation review inventory, not a new business contract.

| Surface/state | Existing source and behavior | Preparation responsibility |
| --- | --- | --- |
| Title, student identity, saved/answered/checked summary, warnings | `renderViewerShell`, `computeAnswerSummary`, learner-name form and technical-details dialog | Retain shell ownership, real counts, validation and localized messages. |
| Header actions | Language, information, attempt upload/cancel, export, completed-only print; preview return-to-editor flush | Preserve availability and handlers. Changing UI language rebuilds the shell; keep existing operation teardown and recovery. |
| Bottom actions | Save, Previous/Next, Submit, completed-only Check | Keep current placement, labels, conditions and navigation path. No new completion/edit mode. |
| Reading sections | `setWorksheetText` renders content using supported text formats | Create a block-owned reading view; no question control, answer number or fake intro. |
| Text answers | Single-line/multiline controls, counters, limits, raw cache, caret and selection | Keep input identity on answer/status updates. Cache remains keyed by block ID for the shell lifetime. |
| Number answers | Raw text input, format hints, inline errors and normalized saved value | Preserve incomplete/invalid focused text without replacing it during refresh; zero remains answered. |
| Boolean answers | Equal controls; selected value can be cleared by clicking again; false remains answered | Preserve selected/disabled state and current green/red semantics. |
| Choice answers | Single/multiple selection, keyboard movement, stable option values and attempt/block-seeded shuffle | Preserve order through navigation/resume, selected state and option audio associations. |
| Prompt image and prompt/option audio | Local assets, legacy and named tracks, one audio owner, multilingual menu, feedback | Card-scoped events and image URLs must be released on disposal; ignore late image loads. Session owns audio requests and interruption. |
| Voice/rewrite/recovery | `answer-voice-ui.js` and `answer-voice-workflow.js`: inline status, Stop/Cancel/View, retry, recovery editor, Undo and original-answer targeting | A disposed card must not cancel session-owned network work. Pass the shell signal to voice/auth work; use a separate scope for presentation resources. |
| Completed review/checking | Read-only text, blank-answer placeholder, hidden editing footer, grading banners and print report | Keep existing conditions and grading-driven remounts; ordinary status updates reuse the view. |
| Resume and loading | `computeResumeStartBlockIndex`, start/resume, imported/published loading, auth-return recovery | Preserve block-ID, index and first-unanswered fallback. Visual scroll restoration is stage 2; this stage still shows one block. |
| Page lifecycle | Hidden document calls voice navigation; page exit and shell replacement tear voice work down | Card disposal is independent of these shell/session lifecycle decisions. No new provider or auth policy. |

Preparation introduces `block-view-host.js`: the host replaces only a changed
block/presentation and calls the current view's update otherwise. Each view owns
its answer control, voice-control reference, feedback nodes and UI-resource scope;
these are no longer shell-wide maps cleared on every card change. The shell still
owns cached raw values, numeric errors, current index, autosave and the existing
navigation side effects. Block signatures keep the existing grading/content rules.

There is no persistent cache of detached cards and no multiple-card rendering yet.
A future continuous renderer can own several independent view instances after its
navigation and status-ownership decisions are accepted. Preparation does not
pre-approve that behavior or change the shared voice workflow.

Acceptance for this stage combines the existing viewer/worksheet browser fixtures
with `scripts/viewer-rendering-lifecycle-smoke.mjs` and the host/scope Node tests.
The new fixture covers both locales and desktop/mobile widths, same-control
selection retention, disposed-input isolation, raw numeric input, False/zero,
shuffle/resume, permission cancellation, language teardown and late image cleanup. Live deployment,
real microphone/provider calls and actual mobile devices remain separate acceptance
requirements before merging the runtime PR; synthetic fixtures are not that evidence.

## 10. Accepted continuous-navigation rules (2026-10-30)

- Start the reading line at 40% of the visual viewport, independent of the
  operation panel height (2026-10-30 acceptance correction). Measure stable
  section containers, not transforms. Keep the current section in gaps in either
  direction and use a small tolerance to avoid boundary jitter.
- Clicking or keyboard-focusing an answer or playback control makes its section
  current once before running the action. Ordinary scroll never moves focus.
- Previous/Next, chooser and operation View commit one destination before
  scrolling. Intermediate sections do not activate. Manual scroll interruption
  cancels the jump and resumes geometry-based tracking without forcing the target.
- Keyboard opening/closing, resize and delayed image/font loading preserve current
  identity. Recalculate positions and resume tracking on intentional navigation
  or scrolling; do not stop audio/recording because layout changed.
- The first section is current at the start. Intentional scrolling to the bottom
  may activate a short final section that cannot reach the reading line; never
  override an explicit target or activate solely because the keyboard opens.
- Use the final C mockup’s one floating operation panel: lower right on desktop,
  across the lower mobile viewport. Keep clearance from navigation and edited
  answers. Preserve production Stop/Cancel/View availability, recovery, result
  ownership and submission blocking rather than copying simulated mockup logic.
- Resume keeps the existing block-selection algorithm and persistence format.
  The restored target must be visible without intermediate navigation effects.

The user approved these behaviors individually. Chooser details and motion replay
remain later-stage decisions. The mockup checksum above still identifies the visual
reference; it does not authorize importing demonstration fixtures or fonts.

### Stage 2 implementation details

The initial controller uses instant jumps, with presentation motion deferred to
stage 4. The original operation-panel inset moved the reading line upward when
recording began. The acceptance correction now measures the visual viewport's
top and visible bottom clipped to the layout viewport, with a 40% reading line.
A separate panel-aware viewport preserves focused-input clearance. A 3 CSS-pixel
boundary tolerance prevents jitter. Wheel, touch,
page-scroll keys and scrollbar dragging authorize scroll tracking; ordinary
layout/focus-induced scroll events do not. Nested scrolling retains its own
behavior, including scrolling onto the page at a nested scroller's boundary.
Resize observers cover worksheet size, header and fixed controls. Focused inputs
receive clearance from fixed controls on entry; ordinary scrolling does not pin
an input. Native scroll anchoring preserves the reading position when earlier
content changes. All listeners/observers are disposed with the shell.

The original resume algorithm selects the initial section. Its resolved identity
is shared with the mounted controls even when saved IDs are stale; restoration
aligns the target until the first student interaction, with no intermediate
operation transitions or pixel-offset persistence.

See [continuous-viewer validation](viewer-continuous-validation.md) for local
coverage, review findings, synthetic scale measurements and the live acceptance
boundary. This stage retains the old navigation presentation; the final chooser,
ring and Version C appearance remain subsequent PRs.

## 11. Stage 3 — Version C layout and chooser (2026-10-30)

The user approved stacking this stage on #333 after its automation/review gate.
D7's recommended behavior is accepted for implementation: opening the chooser
keeps current section identity; mobile closes the action drawer first; cancel
returns to the visible opener (mobile launcher), selection uses the existing
section-navigation path. Resize retains the focused row and adjusts pagination.

This stage replaces the horizontal stepper and fixed bottom action presentation
with the reference's right-side desktop actions and a mobile/short-screen drawer.
All original action handlers and enabled conditions remain in place. Question
numbers exclude reading sections; the progress arc and answered marks use the
existing completion predicate (including zero and False). Reading sections have
separate labels and book icons. Prompt/answer columns collapse on narrow screens.
Single/multiple-track controls and MC answer widths align without altering audio,
option identities, shuffling or answer selection.

Chooser rows stay mounted. Pagination measures real row height with the current
font and locale and uses a consistent capacity across pages, down to one row.
Full names and answered/current states are accessible independently of visual
excerpts. Desktop and mobile/short-screen dialogs use native modal focus handling.
No scrolling list, grouping tabs, moving hover treatment or new storage contract
is introduced. Existing synthetic fixtures now exercise the responsive controls
instead of the removed horizontal stepper.

D8 (motion/replay) remains for the next stage. This stage does not add blur or
sliding animations. Keep the stack open; integrated VPS/real-device acceptance
still belongs to the complete Version C candidate before merging.

Stage 3 evidence: [Version C validation](viewer-version-c-validation.md).

Stage 4: [motion implementation and D8 agreement](viewer-motion-implementation.md).


Latest tuning decision: the accepted Style A mockup sets the reading line to 45%,
superseding the original 40% trial noted in the historical stage records.
The existing 15% reveal buffer remains, settling at 60% when entering from below.
