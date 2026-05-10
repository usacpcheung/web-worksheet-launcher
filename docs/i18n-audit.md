# i18n Audit: Editor + Viewer UI

## 1) Summary

### Phase 2 implementation note

- Supported locales are `en` and `zh-Hant`.
- Locale preference is stored in `localStorage` under `worksheetLauncher.locale`.
- English is the default and fallback locale; missing locale keys must fall back to English and missing keys must render the key instead of crashing.
- Current scope is editor/viewer application UI chrome only. Worksheet/user-authored content, package/attempt names, widget strings, backend/API errors, API routes, protocol tokens, and package format are out of scope.
- Initial migrated slice: editor main action buttons/section headings, viewer start screen/action bar labels, language selectors, and common buttons such as Save, Cancel, Close, Delete, Refresh, and Load more where touched by the first slice.

### Files inspected

- `server/editor/index.html`
- `server/editor/main.js`
- `server/viewer/index.html`
- `server/viewer/main.js`
- `server/app/auth/shared-auth-gate.js`
- `server/app/auth/auth-popup-flow.js`
- `server/app/auth/session-readiness.js`

### Areas with the highest UI string density

- `server/editor/main.js`
  - Main toolbar/actions, block editor panel, upload/publish/modals, activity feed/toasts.
- `server/viewer/main.js`
  - Start screen, server-attempt management modals, published-package browser modal, viewer action bar, print report HTML/template.

### Risky mixed-content areas

- Template strings that mix fixed labels with user-authored values:
  - Examples: `Subject: ${...}`, `Package ID: ${...}`, `Delete "${row?.title}"...`, `Downloaded uploaded attempt "${title}"...`.
- Print template generation in viewer:
  - Fixed labels + worksheet prompt/answer content are assembled together in HTML.
- `innerHTML` rendering paths:
  - Mostly icon SVG or trusted template content, but print markup and some modal/list rendering paths require careful escaping and key-by-key migration.
- Fallback strings for user-authored content:
  - `Untitled`, `Untitled worksheet`, `No prompt text provided.` can be mistaken as content if boundaries are unclear.

## 2) Classification Table

Legend:
- `translate-now`: fixed user-facing app UI text; safe and high-value to migrate.
- `translate-later`: user-facing but tightly coupled with dynamic/runtime flow; migrate after base plumbing.
- `do-not-translate`: user-authored content, IDs, or technical/internal tokens.

| Current English text (or group) | File path | UI area | Classification | Reason | Suggested i18n key |
|---|---|---|---|---|---|
| `Worksheet Editor`, `Worksheet Viewer` | `server/editor/index.html`, `server/viewer/index.html` | HTML title | translate-now | Fixed shell labels | `editor.title`, `viewer.title` |
| `Save Local Draft`, `Open in Viewer (same tab)`, `Import package (.zip)`, `Export package (.zip)` | `server/editor/main.js` | Editor main actions | translate-now | Core fixed buttons | `editor.actions.saveLocalDraft`, `editor.actions.openViewer`, `editor.actions.importPackage`, `editor.actions.exportPackage` |
| `Upload Draft`, `Browse Published Packages`, `Manage Uploaded Drafts`, `Sign in for server features` | `server/editor/main.js` | Editor server features | translate-now | Fixed CTA labels | `editor.server.uploadDraft`, `editor.published.browse`, `editor.uploadedDraft.manage`, `auth.signInForServerFeatures` |
| `Blocks`, `Block Details`, `Draft Info`, `Activity`, `Load older activity` | `server/editor/main.js` | Section headings | translate-now | Fixed headings | `editor.sections.blocks`, `editor.sections.blockDetails`, `editor.sections.draftInfo`, `common.activity`, `common.loadOlderActivity` |
| `Worksheet Title`, `Subject`, placeholders `Worksheet title`, `Subject` | `server/editor/main.js` | Form labels/placeholders | translate-now | Fixed form UI (not user-entered values) | `editor.form.title.label`, `editor.form.subject.label`, `editor.form.title.placeholder`, `editor.form.subject.placeholder` |
| `Select a block to edit.`, `Content text`, `Prompt`, `Prompt image`, `Prompt audio`, `None` | `server/editor/main.js` | Block detail panel | translate-now | Fixed helper/empty text | `editor.block.emptyState`, `editor.block.contentText`, `editor.block.prompt`, `editor.block.promptImage`, `editor.block.promptAudio`, `common.none` |
| `Answer input type`, `Selection mode`, `Max length`, `Response format`, `Min`, `Max`, `Allow signed values (+/-)`, `Decimal places`, `Blank = unlimited`, `Correct answer`, `Shuffle options` | `server/editor/main.js` | Question config labels | translate-now | Fixed config labels | `editor.question.*` |
| `+ Add option`, `Option {n}`, `Delete option {n}`, `Move up`, `Move down`, `Reorder block {n}`, `Drag block {n} to reorder` | `server/editor/main.js` | List controls/ARIA labels | translate-now | Fixed action labels with interpolation | `editor.option.add`, `editor.option.placeholder`, `editor.option.delete`, `editor.reorder.moveUp`, `editor.reorder.moveDown`, `editor.reorder.menuLabel`, `editor.reorder.dragLabel` |
| `Publish uploaded draft`, `Published package conflict`, `Uploaded draft already exists`, `Draft slots are full` + modal actions (`Cancel`, `Publish`, `Delete`, `Save as New Copy`, `Replace Uploaded Draft`, `Edit Published Name/Subject`) | `server/editor/main.js` | Modal titles/buttons | translate-now | Fixed modal UI | `editor.modal.publish.*`, `editor.modal.publishedConflict.*`, `editor.modal.uploadedDraftConflict.*`, `editor.modal.slotLimit.*`, `common.cancel`, `common.delete` |
| `Browse Published Packages`, `Filter by title/subject/owner email`, `Search published packages`, `Load more`, `Refresh`, `Close`, `No published packages found.` | `server/editor/main.js`, `server/viewer/main.js` | Published browse modal | translate-now | Shared fixed modal copy | `common.publishedBrowser.*` |
| `Copy Viewer Link`, `Open in Editor`, `Open package` | `server/editor/main.js`, `server/viewer/main.js` | Published list actions | translate-now | Fixed list actions | `editor.published.copyViewerLink`, `editor.published.openInEditor`, `viewer.published.openPackage` |
| `Saved`, `Last saved:`, `{n} issue(s)`, `No activity yet.` | `server/editor/main.js` | Status row/feed | translate-now | Fixed status UI | `common.saved`, `common.lastSaved`, `editor.validation.issueCount`, `common.activityEmpty` |
| `Server session: checking…`, `Server session: ready (...)`, `Server session: not ready...` | `server/editor/main.js` | Session status | translate-later | Includes dynamic state/user labels; migrate with formatter support | `auth.session.checking`, `auth.session.ready`, `auth.session.notReady` |
| Sign-in flow text: `Sign-in popup was blocked...`, `Sign-in completed...`, `Still waiting for sign-in confirmation...` | `server/editor/main.js`, `server/viewer/main.js`, `server/app/auth/auth-popup-flow.js` | Auth status/toasts | translate-later | Shared async flow copy across modules | `auth.popup.blocked`, `auth.popup.completedRefreshing`, `auth.popup.waitingCallback` |
| Viewer start screen: `Start Viewer`, `Resume previous attempt`, `No resumable local attempt found.`, `Manage server attempts`, `Import worksheet package (.zip)`, `Browse published packages`, `Resume attempt`, `Discard attempt` | `server/viewer/main.js` | Viewer start panel | translate-now | Fixed start-screen UX | `viewer.start.*` |
| Viewer boot/recovery UI: `Unable to open worksheet viewer`, `What you can do`, `Retry now`, `Continue sign-in`, `Cancel recovery`, `Sign in to open this worksheet`, `Go to start screen`, `Technical details` | `server/viewer/main.js` | Boot error/auth recovery panels | translate-now | Fixed user guidance copy | `viewer.boot.*`, `viewer.recovery.*`, `common.technicalDetails` |
| Viewer action bar: `← Back`, `Next →`, `Save`, `Submit`, `Check Answer` | `server/viewer/main.js` | Viewer nav/actions | translate-now | Core fixed buttons | `viewer.actions.back`, `viewer.actions.next`, `common.save`, `viewer.actions.submit`, `viewer.actions.checkAnswer` |
| Viewer details modal: `Technical details`, `Student name`, `Apply`, `Print school name`, `Save`, `Close`, `Copy` | `server/viewer/main.js` | Details modal | translate-now | Fixed modal labels/buttons | `viewer.details.*`, `common.copy`, `common.close` |
| Viewer manage attempts modal: `Manage Server Attempts`, `Resume, download, or delete...`, `Sign in`, `Refresh`, `Close`, `Loading uploaded attempts...`, `No uploaded attempts saved yet.`, `Resume`, `Download ZIP`, `Delete`, `Details` | `server/viewer/main.js` | Attempt manager modal | translate-now | Fixed modal/list UI | `viewer.serverAttempts.*` |
| Attempt conflict/delete modal copy: `Uploaded attempt already exists`, `Delete uploaded attempt?`, `Attempt slots are full`, `Save as copy`, `Replace server attempt` | `server/viewer/main.js` | Attempt conflict/limit modals | translate-now | Fixed modal copy | `viewer.attemptConflict.*`, `viewer.attemptDelete.*`, `viewer.attemptSlots.*` |
| Rewrite UI: `Rewrite`, `Rewriting…`, `Undo`, `Enter text to rewrite.`, `Answer is too long to rewrite...` | `server/viewer/main.js` | Question-level helper/actions | translate-now | Fixed helper/action text | `viewer.rewrite.*` |
| Check/reveal labels: `Correct`, `Incorrect`, `Not graded` | `server/viewer/main.js` | Result display | translate-now | Fixed status labels | `viewer.check.correct`, `viewer.check.incorrect`, `viewer.check.notGraded` |
| Print fixed labels: `Question {n}`, `Answer:`, `Not recorded`, `Question image`, `Question image unavailable.`, `No prompt text provided.` | `server/viewer/main.js` | Print report template | translate-now | Fixed print chrome labels | `viewer.print.questionNumber`, `viewer.print.answerLabel`, `viewer.print.notRecorded`, `viewer.print.questionImageAlt`, `viewer.print.questionImageUnavailable`, `viewer.print.noPromptProvided` |
| Default print school name `Hong Kong Red Cross Hospital Schools` | `server/viewer/main.js` | Print preference default | translate-later | Locale-sensitive default policy decision needed | `viewer.print.defaultSchoolName` |
| Interpolated metadata prefixes: `Subject:`, `Status:`, `Updated:`, `Submitted:`, `Checked:`, `Artifact size:`, `Package ID:` | `server/editor/main.js`, `server/viewer/main.js` | List metadata lines | translate-later | Needs placeholder-aware formatting and punctuation rules | `common.meta.subject`, `common.meta.status`, `common.meta.updated`, `common.meta.submitted`, `common.meta.checked`, `common.meta.artifactSize`, `common.meta.packageId` |
| User-authored values (`title`, `subject`, prompt text, option labels, student answers) | editor/viewer runtime data | Worksheet content | do-not-translate | Authored/user data, not app chrome | n/a |
| IDs and protocol constants (`localDraftId`, `publishedPackageId`, `AUTH_REQUIRED`, route/message tokens) | multiple files | Internal constants/contracts | do-not-translate | Technical/internal identifiers | n/a |

## 3) Suggested Locale Key Structure

Proposed stable key tree:

- `common.*`
- `common.actions.*`
- `common.modal.*`
- `common.status.*`
- `common.meta.*`
- `auth.*`
- `auth.popup.*`
- `auth.session.*`
- `editor.*`
- `editor.actions.*`
- `editor.sections.*`
- `editor.form.*`
- `editor.block.*`
- `editor.question.*`
- `editor.reorder.*`
- `editor.uploadDraft.*`
- `editor.publish.*`
- `editor.publishedBrowser.*`
- `editor.uploadedDrafts.*`
- `viewer.*`
- `viewer.start.*`
- `viewer.boot.*`
- `viewer.recovery.*`
- `viewer.actions.*`
- `viewer.details.*`
- `viewer.rewrite.*`
- `viewer.check.*`
- `viewer.attempt.*`
- `viewer.serverAttempts.*`
- `viewer.publishedBrowser.*`
- `viewer.print.*`

## 4) Recommended First Implementation Slice (next PR)

Safe, low-risk first slice:

1. Add shared i18n module + locale loader.
2. Add `en` and `zh-Hant` locale files.
3. Add language preference in `localStorage`.
4. Add simple language selector in editor and viewer shells.
5. Migrate high-visibility fixed labels first:
   - editor main buttons and section headings,
   - viewer start screen and action bar,
   - common modal buttons (`Cancel`, `Close`, `Delete`, `Save`, `Refresh`, `Load more`).
6. Migrate print fixed labels in a separate small commit in the same PR or immediately after.

Defer to later slice:

- Dynamic/auth/status strings with many async branches.
- Interpolated metadata rows (`Subject: ...`, `Updated: ...`) until placeholder conventions are finalized.

## 5) Translation Boundary Rules

The i18n framework should translate application UI only.

Do translate:

- Fixed application labels
- Buttons
- Modal UI
- Fixed print labels
- Empty states
- Status text
- Tooltips/ARIA labels that are user-facing

Do not translate:

- Worksheet title entered by teacher/user
- Subject entered by teacher/user
- Question prompt
- Option labels
- Student answer
- Uploaded/published package titles
- Attempt names
- Package metadata entered by users
- Internal constants, API route strings, protocol codes

## 6) Risk Notes for Next Implementation

- Template literals:
  - Many labels are in `\`${prefix}: ${value}\`` form. Move to key + placeholder patterns (`{value}`) and keep punctuation locale-specific.
- Mixed fixed and user-authored content:
  - Example paths around uploaded/published lists and conflict dialogs contain both fixed labels and user titles/subjects.
- Print rendering:
  - Print HTML is string-built; migrate carefully to avoid breaking escaping and layout.
- Modal rendering:
  - Multiple modals are built imperatively; ensure all button/title/warning text is key-driven, while user values stay raw (escaped).
- Server/auth status:
  - Some messages come from backend `error.message`; keep backend-provided text as-is for now (out of scope), but local wrapper/fallback text should be localized.
- `innerHTML` paths:
  - Most are icon SVG; do not route translated text through unsafe HTML insertion. Prefer `textContent` with formatted strings.
