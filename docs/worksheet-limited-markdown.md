# Worksheet limited Markdown

This feature is stacked on PR #276. It applies only to worksheet content text and question prompts. Authors edit plain source text, switch to Preview, and return to Edit with their selection restored. The adjacent formatting help is available in English and Traditional Chinese.

## Supported syntax

- Headings `##` through `######`, followed by a space. `#` stays literal.
- Flat bullet lists (`- item`) and numbered lists (`1. item`). A numbered list retains its first number and numbers subsequent items sequentially.
- One-level quotes (`> quote`).
- Bold (`**text**`) and italic (`*text*`). Unmatched delimiters stay literal; combined triple-star syntax is not supported.
- Paragraphs, ordinary line breaks, and backslash punctuation escapes such as `\*` and `\\`.

Links, images, code, tables, task lists, horizontal rules, HTML, and embedded media are not enabled. Their syntax remains text. HTML is escaped even in supported formatting. There is no toolbar, live side-by-side editor, or remote Markdown dependency.

## Compatibility and source preservation

The existing `content.format` and `prompt.format` fields determine interpretation:

| Field format | Interpretation |
| --- | --- |
| Missing or `plain_text` | Literal existing text |
| `limited-markdown-v1` | The subset above |
| Other nonempty value | Rejected, never guessed or silently downgraded |

Existing published packages, imported source records, and saved attempt snapshots are not migrated just because somebody views them. Their punctuation remains literal. No batch rewrite of published artifacts or database migration is required.

When an existing local draft is opened for editing, or a plain package is converted to an editable draft, its supported fields are escaped once and marked `limited-markdown-v1`. This preserves their displayed wording and punctuation. The editor shows an informational conversion notification at that point. Reopening an already converted draft neither repeats the notice nor escapes it again. A ZIP import retains its original imported source record; its editable draft is separate. Normal autosave persists local draft conversion. New blocks use the new marker.

After conversion, subsequent editing, saving, publishing, and export preserve the author's source, including backslashes and line endings. Learner answers and all other fields retain their existing interpretation.

## Package versions and rollout

| Export | Plain text | Contains limited Markdown |
| --- | --- | --- |
| Worksheet ZIP | packageVersion 2 / schemaVersion 2 | packageVersion 3 / schemaVersion 3 |
| Attempt ZIP | packageVersion 1 / schemaVersion 1 | packageVersion 2 / schemaVersion 1 |

Worksheet readers continue accepting versions 1 and 2. Attempt readers continue accepting version 1. Markdown in a legacy ZIP envelope is rejected. The attempt record schema, database schema, launch parameters, and message contract do not change.

The newer ZIP versions make older application versions reject an unsupported package rather than open it for editing as plain text and lose its meaning. When this feature is eventually deployed, update the API and browser assets together and refresh existing editor/viewer tabs. Previously cached application code cannot be retroactively taught to reject newly formatted IndexedDB drafts or direct in-browser payloads. Do not use an older application build to edit new-format drafts. Old published packages remain readable without re-publication.

## Rendering and safety

Editor preview, viewer cards (editable and submitted), and the existing question print/PDF report use one renderer. The parser creates an internal tree; the serializer permits only `p`, `br`, `h2`–`h6`, `ul`, `ol`, `li`, `blockquote`, `strong`, and `em`. It escapes every source text node. The only generated attribute is a validated integer `ol start`. It never accepts author HTML as markup, generates URLs, or fetches resources.

Prompt audio generation uses a plain-text projection of that same tree, so spoken text excludes formatting markers. Existing operation identity and source-change guards remain in effect. Audio providers, authentication, learner voice/rewrite processing, and RolePlayScene are unchanged.

Printed output follows the existing report's question-only scope; it does not gain content-block sections. Package downloads store source Markdown rather than rendered HTML. Titles, instructions, choices, feedback, answers, and attached media retain their existing behavior.

## Verification

Run `npm test` and, with `node scripts/static-server.mjs` serving port 8765, `node scripts/worksheet-markdown-smoke.mjs`. Set `VIEWER_SMOKE_URL` for a different local server and `VIEWER_SMOKE_SCREENSHOTS` for screenshot output.

The smoke check covers real editor preview/Edit/help interactions, autosave and selection retention, empty and long content, source ZIP round trips, legacy import conversion, submitted review, and generated print output at 1280px and 390px in both languages. APIs are mocked; this is not a VPS or real audio-provider acceptance test. Regression tests also cover safe syntax/escaping, unknown-format rejection before writes, plain/Markdown attempt upload and resume, and conversion idempotence.
