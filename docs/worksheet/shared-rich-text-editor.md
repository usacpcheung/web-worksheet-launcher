# Shared worksheet text editor

The authoring editor uses a compact Tiptap toolbar for every content block and
question prompt. It replaces the field-level Edit/Preview controls. Whole-worksheet
Open in Viewer and Back to editor remain unchanged. Student answers, metadata,
MC option labels, media controls, audio generation, voice/rewrite and authentication
keep their existing behavior. Fill-in-the-blank questions are a later PR.

## Editing behavior

The toolbar offers paragraph, H2–H4, bold, italic, underline, fixed red (`#b42318`),
bullets, numbering, quotation, clear formatting, undo and redo. Enter creates a
paragraph; Shift+Enter creates a line break. Formatting can be combined. Raw typed
or pasted Markdown is literal text; use the toolbar to format it. Existing fields
marked `limited-markdown-v1` load through the existing parser, including its literal
handling of incomplete or unsupported syntax. HTML paste is restricted by the
editor schema: unsupported styles, links and embedded media are not authoring tools.

Opening, importing or previewing a legacy worksheet does not migrate its text.
Unchanged fields preserve their source (including escaping and line endings).
After an edit, the adapter keeps plain text or limited Markdown only when that
representation reproduces the edited document. Otherwise it writes `rich-text-v1`.
Once a field uses rich text, subsequent editing keeps that representation.
There is no automatic migration of published packages or saved attempts.

Prompt limits remain 500 Unicode code points of trimmed spoken text. The counter
and audio eligibility use the same projection. Authors can save local over-limit
work without truncation; publication still rejects over-limit prompts. Content
blocks receive no new text-length limit. Short/long student answer limits are unchanged.

An editor instance and its undo history are retained for each visited block while
the authoring shell remains open. Autosave does not replace its document, selection,
or composing input. Changing locale or reloading recreates the shell and resets
undo history, while preserving saved content. Deleted blocks and previous drafts
are disposed. Async loading is guarded by the owning draft/block instance.
A failed bundle load offers Retry and leaves existing text unchanged.

## Application document contract

A rich field has a plain-text projection plus a restricted document:

```json
{
  "format": "rich-text-v1",
  "text": "Read this",
  "document": {
    "version": 1,
    "blocks": [{
      "tag": "p",
      "children": [{
        "tag": "u",
        "children": [{"tag": "red", "children": [{"tag": "text", "text": "Read this"}]}]
      }]
    }]
  }
}
```

This is an application schema, not Tiptap/ProseMirror JSON or stored HTML.
Block nodes are `p`, `h2`, `h3`, `h4`, `blockquote`, `ul`, `ol`; lists contain
`li` blocks, and quotes/list items contain block nodes. Inline nodes are `text`,
`br`, `strong`, `em`, `u`, `red`. Only `text` carries a string; only `ol` carries
an integer `start` (0–999999999). Unknown keys/tags, invalid nesting, unsupported
document versions, and mismatched plain-text projections reject. Defensive parsing
bounds are 32 levels and 100,000 nodes, independent of the existing text budgets.
Editing transactions exceeding those bounds are rejected with a visible message;
the previous document remains intact.

The lightweight shared renderer escapes text and emits allowlisted tags. `red`
emits a fixed CSS class. It accepts no arbitrary CSS, HTML, URLs or engine state.
The plain-text projection is used for speech, counts and list labels. Viewer state,
attempt ZIPs and print models retain the full document; format-only changes also
participate in viewer fingerprints. Print keeps its current report scope and flow.

## Package versions and rollout

Rich content requires worksheet **package/schema 7/7** and attempt **package/schema
6/1**. Feature-based export keeps earlier versions for worksheets without rich
fields. Existing worksheet versions 1–6 and attempt versions 1–5 remain readable.
Rich content disguised in an earlier envelope rejects before storage/publication.
No database migration or authentication/message-contract change is needed.

Deploy API and static assets together, then refresh open tabs. Old application
builds reject the new ZIP envelopes. This cannot protect direct IndexedDB drafts
from already-cached older code; do not edit new-format drafts in an older build.

## Dependencies and deployment

Tiptap core/StarterKit/PM are pinned to 3.33.0; esbuild is pinned to 0.28.2 and transitive
versions are locked in `package-lock.json`. They are build-only dependencies.
`npm run build:editor` produces the committed local ES module and dependency notices
in `server/editor/vendor/`. Ordinary static deployment needs no build step or CDN.
`npm run check:editor-bundle` checks byte-for-byte reproducibility in CI.

The engine bundle is **392,242 bytes / 124,499 gzip bytes** (approximately 121.5 KiB
compressed). This is engine size, excluding the small application adapter and shared
renderer. It is lazily loaded by the editor; the viewer and print do not request it.
Browser tests assert that separation. Gzip transfer depends on web-server compression.

## Focused acceptance

Automated coverage: legacy parsing/round trips, schema rejection and safe rendering,
worksheet and attempt version guards, upload/publication, local draft and attempt
persistence, print, prompt limits/audio eligibility, and existing learner behavior.
Chromium tests cover both locales at 1280px/390px, toolbar marks and blocks,
undo/redo, selection across save, block switching, composition via Chromium's input
protocol, reload, viewer review and print. These use isolated storage and mocked APIs.

For deployment acceptance:

1. Open a known old plain-text worksheet and a Markdown worksheet. Confirm literal
   punctuation and formatting; save/reopen with no changes.
2. In a content block and question, combine underline/red/bold; add a paragraph and
   Shift+Enter line break. Switch blocks, undo/redo, save and reload.
3. Use a real Chinese IME (including a mobile keyboard): compose while autosave runs,
   switch blocks after committing, and verify the complete text survives.
4. Export/import the worksheet, upload/publish one test copy, open it in the viewer,
   answer/submit, and check its attempt package and print preview.

Live authentication, audio providers, real-device IMEs and physical printing require
deployment acceptance; browser simulation is not evidence for those integrations.

## PR review evidence (2026-11-09)

Screenshots from the actual implementation using isolated acceptance fixtures:
[desktop](images/shared-rich-text-desktop.png), [Traditional Chinese mobile](images/shared-rich-text-mobile.png).

Review/fix/review findings addressed before PR creation:

- Viewer normalization and print projections originally omitted the new document;
  they now preserve it, with worksheet/attempt/print round-trip coverage.
- A field-key ordering difference triggered redundant editor replacement, damaging
  undo history. Normalized comparisons now preserve the live document and selection.
- Module-loading failures are cached by browsers. Retry now uses a fresh module URL;
  fault injection covers retry and a block switch while the bundle is delayed.
- Draft identity now participates in detail rendering; document-only formatting
  changes participate in viewer fingerprints and rendering signatures.
- Audio eligibility refreshes after external field updates. Over-complex pastes
  are rejected before changing the editor document, with visible feedback.

Validation: 1,884 Node tests, four CI-runner tests, reproducible bundle check, and
15 affected browser smoke scripts passed. Those include the new rich editor,
legacy Markdown, authoring polish, reorder/drag, draft replacement, audio consent
and options/voice choices, image responses/options, long answers, publication,
completed review and print. The original reorder smoke's textarea selector was
updated for the new contenteditable field, and its focus/keyboard assertions pass.
