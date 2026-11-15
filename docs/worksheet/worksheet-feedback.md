# Worksheet assessment and feedback

A worksheet may have one optional feedback section, disabled by default. The
editor's **Assessment & feedback / 評估與回饋** sidebar button opens its settings;
the badge reports enabled/disabled state, while the checkbox changes it.

## Authoring

- Enable assessment, student written feedback, teacher written feedback, or a
  combination. At least one part must be enabled when the section is enabled.
- Assessment has 1–5 learning targets, each at most 200 characters. Stable target
  IDs survive reordering; deletion asks for confirmation.
- Student, teacher and peer/parent assessment categories apply to all targets.
  Select at least one when assessment is enabled.
- Each enabled written field has an optional instruction (500 characters maximum)
  and a character limit of 1–1,200, default 200. Counting/edit rejection follows
  normal short-text answers, including IME and paste handling.
- Incomplete settings can be saved locally, but preview, export and publication
  require valid configuration. Disabling the section retains its configuration.

Sidebar local actions use the existing neutral buttons without an enclosing card.
Feedback navigation follows the block list. Server features are in the renamed
collapsible panel with the ordinary Sign in / 登入 action. Activity is last and
starts collapsed. Selecting feedback does not create a question or content block.

## Submitted viewer

The section and its navigation/reminder are hidden until submission. Submitted
answers stay locked; feedback remains editable without a second submit step.
There are no author roles, ownership checks or required feedback fields. Partial
responses are valid and do not change question counts, grading or completion.

Each target/category accepts one rating from 1–5. Unrated is distinct from one
star; Clear returns to unrated. Selected stars use pale yellow and an amber
outline. Keyboard arrows and Home/End select ratings. Desktop has a feedback
action in the existing right action panel, with no status-row shortcut/banner.
The compact action layout has a thin reminder below the header. Both scroll to
the section after the questions.

Written fields reuse real Add by voice, Rewrite and Undo behavior, including
selection replacement, login/cancel before service use, explicit recording after
login, cancellation and recoverable transcription/rewrite failures. Feedback
voice targets are separate from question identities. Local recovery retains a
pending transcript after submission; ZIP files exclude recovery material and raw
recordings. Switching attempts cannot apply a stale voice result to another one.

Edits use the existing local autosave/reload journal. The save status explains
that an exported ZIP or server copy requires another explicit export/save.
Typing, ratings, local persistence, export and print need no server service after
the app is loaded; voice/rewrite and server operations retain their network and
authentication requirements. This feature does not add a PWA or offline reload.

## Persistence and printing

`worksheet.feedback` contains configuration; `attempt.feedback` contains
`{ ratings: { [targetId]: { [category]: 1..5 } }, text: { student?, teacher? } }`.
Responses never go into `answers` or `checking`. Empty response objects are
allowed before submission; populated responses require enabled feedback and a
submitted/checked attempt.

Any stored feedback configuration (including disabled configuration) requires
worksheet package/schema version **9** and attempt package version **8**. Existing
packages without the field keep their previous version and feedback stays off.
The API and browser share validation, rejecting invalid targets, categories,
limits and responses before persistence. No database migration is needed; deploy
the updated API parser and browser assets together.

The attempt owns its full worksheet snapshot/configuration and feedback. Import
and resume do not depend on the original worksheet/draft or retrofit later source
edits. Printing includes enabled targets/categories, selected stars, written
feedback and blank spaces for unanswered fields. It does not score feedback.

## Focused verification

- `npm test`: contracts, legacy compatibility, local persistence, server package
  validation, attempt export/import and print serialization.
- `scripts/worksheet-feedback-smoke.mjs`: actual editor/viewer flow, English and
  Traditional Chinese, desktop/mobile, keyboard stars, limits, autosave/resume,
  mock login/cancel and voice/rewrite/undo/recovery, ZIP round trip and printing.
- Shared voice, RolePlayScene voice/sign-in, fill-in-blanks, completed-review,
  drawer print and worksheet print browser regressions remain applicable.

Browser microphone, authentication and provider responses in automated fixtures
are mocked. Live OIDC, a real microphone/provider and final printed output still
need focused deployment acceptance.
