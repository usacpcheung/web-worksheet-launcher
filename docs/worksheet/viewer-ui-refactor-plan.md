# Current viewer layout and interaction

The continuous Version C viewer is implemented in the PR1/PR2 baseline.
This reference replaces the completed staged plan; the [original plan](../past/plans/viewer-ui-refactor-2026-10.md)
retains dated decisions and evidence. It is not a new roadmap or proof of current
VPS deployment. Use the actual code and [worksheet UI skill](../../.agents/skills/worksheet-ui-design-language/SKILL.md)
for changes; mockups must reflect existing behavior outside the proposed scope.

## Worksheet and navigation

- Reading blocks and questions render in worksheet order on one continuous surface.
  Only questions are numbered and counted for answered progress. Reading blocks
  keep their book icon and distinct pale surface.
- One current-section model serves scrolling, Previous/Next section, chooser and
  voice-operation View. Stable section geometry, not animated children, determines
  position. The reading line is 45% of viewport height; this is UI tuning, not a
  package contract.
- The ordered chooser contains question and reading rows with separate current
  and answered states. Pagination adapts to viewport height; required controls
  stay reachable without an internal list scrollbar. No grouping tabs are used.
- Resume restores the selected section after layout is ready without starting
  playback/recording. Explicit normal worksheet opening starts a fresh attempt;
  see [local lifecycle](../contracts/local-models.md#normal-attempts-temporary-preview-and-cleanup).
- Chooser rows and mounted answer inputs keep identity across status/answer updates.
  Focus, selection, IME composition and raw numeric edits must survive refreshes.

## Actions and answer surfaces

Desktop uses the side action panel; narrower screens use a launcher/drawer.
All actions preserve their actual availability, including submitted-only print in
the narrow menu. The attempt overflow menu groups server save, server-attempt
management, local ZIP export and details/print settings. Language switching keeps
its existing selection flow. Editor Preview displays its temporary-session banner,
Restart preview and a separated Back to editor control. Preview cannot export or
upload attempts, but supports answering, submission, feedback and print.

MC controls keep equal answer widths and audio-trigger sizes, stable shuffled
option values and associated media. Images have contained previews and a separate
enlarge action. True/False retains its existing green/red selection styling.
Standard text footers group counter, Add by voice, Rewrite and Undo compactly;
empty status rows collapse. Long text, image-response, fill-in-the-blanks and
feedback retain their documented type-specific controls.

## Voice, audio and motion

One operation panel owns stage announcements and Stop/Cancel/View while the source
question may be off-screen. Question-specific hints and recoverable text remain
beside their original input. Ordinary section transitions stop question playback
and notify the voice workflow: recording stops and processes its source; network
work remains attached to that source. Background completion cannot steal focus.
Language changes and page lifecycle retain their separate disposal rules.
See [voice behavior](viewer-voice-workflow.md).

Entry motion keeps text sharp, with separate prompt/media and answer layers.
Measure stable containers, keep revealed/edited/focused content steady, and never
restart effects merely for a state update. Explicit destinations settle promptly;
user scrolling interrupts programmatic navigation. Reduced-motion mode removes
movement and unnecessary smooth scrolling. Print omits fixed chrome and motion,
includes reading blocks/questions in order and enabled feedback, and keeps all
answer content. See [text rendering](worksheet-limited-markdown.md).

## Verification and historical evidence

Run the affected viewer scripts and shared-consumer coverage described in
[testing](../operations/testing.md). Preserve English/Traditional Chinese,
desktop/mobile, short/zoomed viewports, keyboard focus, long content, completed
review, audio and voice recovery. Current suite results belong to the current PR;
old timing figures and screenshot reports are not fresh acceptance.

Historical implementation records:
[continuous navigation](viewer-continuous-validation.md),
[Version C](viewer-version-c-validation.md),
[motion](viewer-motion-implementation.md), and
[visual refinement](viewer-visual-refinement.md).
