# Worksheet limited Markdown

> Updated on 2026-10-31 for the agreed H2–H4 heading subset and prompt typography trial. Code evidence: [worksheet-text.js](../../server/app/worksheet-text.js), [worksheet-package.js](../../server/editor/worksheet-package.js), [package-service.js](../../server/api/services/package-service.js), [main.js](../../server/viewer/main.js). Test commands below are guidance, not a new test-run report.

The implemented feature applies only to worksheet content text and question prompts. Authors now use the [shared text editor](shared-rich-text-editor.md). This document describes the retained legacy Markdown parser and package compatibility.

## Supported syntax

- Headings `##` through `####`, followed by a space. `#`, `#####` and `######` stay literal.
- Flat bullet lists (`- item`) and numbered lists (`1. item`). A numbered list retains its first number and numbers subsequent items sequentially.
- One-level quotes (`> quote`).
- Bold (`**text**`) and italic (`*text*`). Unmatched delimiters stay literal; combined triple-star syntax is not supported.
- Paragraphs, ordinary line breaks, and backslash punctuation escapes such as `\*` and `\\`.

Links, images, code, tables, task lists, horizontal rules, HTML, and embedded media are not enabled. Their syntax remains text. HTML is escaped even in supported formatting. There is no remote Markdown dependency; the shared editor supplies formatting controls.

## Compatibility and source preservation

The existing `content.format` and `prompt.format` fields determine interpretation:

| Field format | Interpretation |
| --- | --- |
| Missing or `plain_text` | Literal existing text |
| `limited-markdown-v1` | The subset above |
| `rich-text-v1` | Restricted application document; see shared editor contract |
| Other nonempty value | Rejected, never guessed or silently downgraded |

Existing published packages, imported source records, and saved attempt snapshots are not migrated just because somebody views them. Their punctuation remains literal. No batch rewrite of published artifacts or database migration is required.

Opening an existing local draft or converting a package to an editable draft now
preserves each field's source and format. The former eager plain-to-Markdown
conversion and notice have been removed. On editing, the shared editor retains a
legacy format only when it can represent the edited document faithfully; underline,
red and other richer structures use `rich-text-v1`. Imported source records remain
separate and unchanged. See the shared editor contract for details.

## Package versions and rollout

| Export | Plain text | Contains limited Markdown |
| --- | --- | --- |
| Worksheet ZIP | packageVersion 2 / schemaVersion 2 | packageVersion 3 / schemaVersion 3 |
| Attempt ZIP | packageVersion 1 / schemaVersion 1 | packageVersion 2 / schemaVersion 1 |

Worksheet readers continue accepting versions 1 and 2. Attempt readers continue accepting version 1. Markdown in a legacy ZIP envelope is rejected. The attempt record schema, database schema, launch parameters, and message contract do not change.

The newer ZIP versions make older application versions reject an unsupported package rather than open it for editing as plain text and lose its meaning. For deployments introducing this format support, update the API and browser assets together and refresh existing editor/viewer tabs. Previously cached application code cannot be retroactively taught to reject newly formatted IndexedDB drafts or direct in-browser payloads. Do not use an older application build to edit new-format drafts. Old published packages remain readable without re-publication.

## Rendering and safety

Legacy Markdown conversion for editing, viewer cards (editable and submitted), and the existing question print/PDF report use one renderer. The parser creates an internal tree; the serializer permits only `p`, `br`, `h2`–`h4`, `ul`, `ol`, `li`, `blockquote`, `strong`, and `em`. It escapes every source text node. The only generated attribute is a validated integer `ol start`. It never accepts author HTML as markup, generates URLs, or fetches resources.

Prompt audio generation uses a plain-text projection of that same tree, so spoken text excludes formatting markers. Existing operation identity and source-change guards remain in effect. Audio providers, authentication, learner voice/rewrite processing, and RolePlayScene are unchanged.

Question prompts have a 500 Unicode code-point budget, counted from trimmed spoken text rather than Markdown source. Punctuation, internal spaces/newlines, and displayed numbered-list numbers count. Backslash escapes are decoded once; Chinese punctuation and literal symbols remain. The same text projection drives audio eligibility, language checks, generation and source hashes. Content blocks have no new limit. Option audio retains its 200-character budget.

The prompt counter and inline warning allow authors to type/paste over 500 and save locally without truncation. Import/export also preserve long prompts. Publishing validates the stored uploaded artifact and returns `PROMPT_TOO_LONG` before creating a published artifact if any prompt exceeds 500. Previously published worksheets remain readable. Changing a block's type preserves both its source and format.

Before testing prompt audio beyond 200 on the VPS, configure the separate rewrite bridge with `T2A_MAX_TEXT_LENGTH=500`. This repository does not change that service or its configuration. The limit is an application budget policy, not a claim about provider capacity.

Printed output follows the existing report's question-only scope; it does not gain content-block sections. Package downloads store source Markdown rather than rendered HTML. Titles, instructions, choices, feedback, answers, and attached media retain their existing behavior.

## Verification

Run `npm test` and, with `node scripts/static-server.mjs` serving port 8765, `node scripts/worksheet-markdown-smoke.mjs`. Set `VIEWER_SMOKE_URL` for a different local server and `VIEWER_SMOKE_SCREENSHOTS` for screenshot output.

The Markdown smoke preserves legacy parser, limit/audio eligibility, package,
viewer/review/print and import checks at both locales and desktop/mobile widths.
Shared-editor interactions are covered by `worksheet-rich-text-smoke.mjs`. APIs are
mocked; these checks do not establish VPS/provider acceptance.

# Authoring polish and Chinese typography

The field-level Edit/Preview and syntax help controls are replaced by the shared
formatting toolbar. The prompt remains labelled “Question text / 題目文字”. Block
navigation still uses the shared plain-text projection before truncation.

Editor-origin viewer URLs retain the existing `preview=1` and `localDraftId`
parameters. The viewer offers Back to editor for that flow. Optional session
storage remembers the selected block and page/list scroll positions before
leaving the editor; the return URL always targets the local editor and draft.
If session storage is unavailable, navigation still works with normal draft
restoration. No package, launch hash or postMessage changes are involved.

Worksheet Chinese text uses locally hosted Noto Sans HK subsets. Latin fonts
retain their previous families. Body text uses 400, question prompts use 500,
and bold/headings use 700. See `server/app/fonts/README.md` for provenance,
licensing and refresh instructions. Print waits up to five seconds for fonts,
then permits system fallback instead of indefinitely blocking printing.

Run `node scripts/worksheet-polish-smoke.mjs` against the local static server
for bilingual desktop/mobile coverage of the toolbar, sidebar escaping,
return navigation after refresh, real browser font selection and overflow.

The H2–H4 restriction is an approved product change. Existing H5/H6 source remains intact and now displays literally; the package format identifier is unchanged. Prompt typography uses a shared Chinese/English/mixed-content trial baseline (20px desktop, 18px mobile, line-height 1.6), with H2/H3/H4 ratios 1.55/1.35/1.15 and print-scaled equivalents. Authored blank lines remain preserved.
