# Fill-in-the-blanks questions

## Authoring

Choose **Fill in the blanks** in the question type menu. The ordinary prompt,
media and audio remain available. A separate passage uses the existing rich-text
toolbar, including paragraphs, line breaks, headings, lists, bold, italic,
underline and red text. This does not introduce a second editing engine.

Select a word or short phrase in one paragraph and choose **Make blank**, either
from the toolbar or the context menu. Selections crossing paragraphs, line breaks
or another blank are rejected with a nearby message. `[[12222]]` remains literal
text; it is never parsed as a blank token. Maximum: **20 blanks per question**.

Click a marked word or its numbered chip to edit one compact settings panel:

- **Type answers**: each blank has a main answer and up to 50 alternatives, or
  **Free response · teacher review** with no automatic grading. Both use the same
  50-character limit and assistance tools.
- **Choose from word bank**: one common bank contains the main answers plus up
  to 100 distractors. The reuse toggle applies to the whole question. Typed and
  word-bank blanks cannot be mixed within one question.

Blank IDs remain stable when their settings change. Removing a blank restores
its current marked text. If unchanged, its original inline formatting is also
restored. Undo restores the blank and its metadata as one step. Switching to
another question type requires the existing destructive-change confirmation.
Incomplete local drafts can be saved, but validation blocks export/publishing
until required answers and at least one blank are present.

## Learner interaction

Typed blanks accept up to **50 Unicode code points** (not UTF-16 code units).
The question hint states the limit; the nearby counter and ⋯ tools appear only
while the blank is focused/active. Paste inserts only the portion that fits,
preserving the text outside the selection, and shows a nearby limit message.
Native Undo remains available. Line breaks become spaces; IME composition is
validated when it finishes. Ordinary short/long text questions retain their
existing length and paste behavior.

Both checked and free typed blanks offer Add by voice, Rewrite and Undo through
⋯. Voice inserts at the selected caret or replaces selected text; Rewrite uses
the whole blank. They use the existing session checks, explicit Login/Cancel,
provider requests, cancellation and stale-result safeguards. Successful login
never starts recording automatically. A result exceeding 50 characters keeps
the original answer and presents the **complete proposed answer** for editing;
Apply is disabled until it fits. Local recovery survives reload. A retained
transcript after rewrite failure can be retried or explicitly used as text;
this is recovery, not a new transcription-only mode. No background provider
request is replayed after login. Undo restores the exact prior blank value.

Word-bank blanks have no character counter or voice tools. Learners can drag a
tile, choose a tile then a blank, or select a blank then a tile. Buttons work
with keyboard and touch. With reuse off, duplicate main answers share one tile
with a remaining-use badge; exhausted tiles leave the pool. Clearing or moving
a placed word returns the appropriate inventory. With reuse on, tiles remain
available. Distractors do not add extra copies of an existing answer word.

A question counts as answered when every blank has non-whitespace text. After
submission answers are read-only. Automatic checking trims outer whitespace and
ignores ASCII English letter case only; internal spaces and punctuation remain
significant. Alternative answers apply only to typed checked blanks. Free
responses show **Teacher review** and are excluded from the score. Printing
renders the passage with numbered answers and any applicable result labels.

## Stored configuration

```json
{
  "inputType": "fill_in_blanks",
  "mode": "typed",
  "reuseWords": false,
  "distractors": [],
  "passage": {
    "version": 1,
    "blocks": [{
      "tag": "p",
      "children": [
        { "tag": "text", "text": "Plants need " },
        { "tag": "blank", "id": "blank_water", "text": "water",
          "checking": "auto", "alternatives": ["rain water"] },
        { "tag": "text", "text": "." }
      ]
    }]
  }
}
```

The passage uses the restricted application rich-document nodes plus an inline
`blank` node. Blanks are valid only where inline text is valid. IDs contain
1–80 ASCII letters, digits, `_` or `-`, are unique within the question, and may
not be `__proto__`, `constructor` or `prototype`. `text` and every alternative or
distractor are single-line strings of at most 50 code points. Checked/bank main
answers must contain non-whitespace text; free marked text may be empty.
`checking` is `auto` or `free`. Optional `original` inline nodes and `initialText`
retain the original formatted selection for removal and must agree exactly.
Arbitrary HTML, nested blanks, unsupported nodes and malformed metadata fail
validation. Engine JSON is never the public package contract.

An answer is stored as, for example:

```json
{ "question_1": { "value": { "blank_water": " WATER " }, "answeredAt": "..." } }
```

Local voice recovery/Undo uses virtual IDs derived from the parent question ID
and blank ID. These IDs never become answer keys or server identities; collisions
with real question IDs are rejected. Recovery and raw recordings remain local
and are excluded from ZIPs and print, consistent with ordinary voice answers.

See [package formats](../contracts/package-formats.md) for version gates and
[local models](../contracts/local-models.md) for persistence boundaries.

## Focused acceptance

`scripts/fill-in-blanks-smoke.mjs` exercises English and Traditional Chinese at
1280 and 390 pixels: author/edit/remove/Undo, save/reopen, package v8, partial
paste/Undo, voice selection, Login/Cancel and explicit restart, overflow recovery
across reload, transcript recovery, bank placement/movement/inventory, local
resume, submission, grading and print. The provider, microphone and login are
isolated fixtures. Existing voice and rich-editor regression smokes remain required.

After deployment, use a disposable worksheet/attempt to check real microphone
permission, Login/Cancel then explicit recording, one rewrite, server save/resume,
ZIP export/import and the actual browser print preview. Automated mocked checks
do not establish real provider/device or VPS deployment behavior.
