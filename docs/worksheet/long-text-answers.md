# Long text answers

Text questions have a **Long text** checkbox in their existing answer settings.

| Setting | Default / maximum configured length | Learner tools |
| --- | --- | --- |
| Standard | 200 / 1,200 | Add by voice, Rewrite and rewrite Undo |
| Long text | 20,000 / 20,000 | Plain multiline text and character counter |

The long-text answer area occupies the full question width. It accepts pasted
conversations, prompts and other text without interpreting HTML or Markdown.
Whitespace and paragraphs are preserved. A custom positive limit below the mode's
ceiling is allowed. Switching off Long text asks for confirmation if the limit
will be reduced to 1,200. This changes authoring configuration, not saved answers.

Voice/rewrite controls, hints and retry entry points are unavailable for long
text; prompt audio still works. Eligible standard questions keep their existing
login/cancel, recording, selection replacement, recovery and undo behavior.
The shared provider input ceiling stays at 2,000 Unicode code points. Answer
counters and question limits retain the existing UTF-16 unit convention, so
common Chinese/English characters count as one and supplementary emoji as two.

An oversized paste is rejected completely with a nearby translated message,
retaining the prior answer and selection. IME input is checked after composition
ends. Saved or imported oversized answers are never shortened automatically;
they can be reduced in stages. Save/resume, ZIP packages, submitted review and
printing keep the entire answer. Print uses normal flowing text over as many
pages as needed, rather than the on-screen textbox's scroll viewport.

Existing packages without a text mode remain readable. Opening an old question
with a limit above 1,200 in the editor requires an explicit choice to enable long
text or reduce that limit before export/publish. See
[package formats](../contracts/package-formats.md#long-text-responses) and
[local models](../contracts/local-models.md#text-answer-mode-and-preservation).
No server storage, upload-slot, authentication, bridge or deployment changes are
needed; the 30 MiB package limit remains in effect.

## Focused deployment acceptance

1. In the editor, enable Long text for a Text question. Confirm the 20,000
   default, multiline preview and persistence after save/reload. Turn it off,
   cancel the reduction once, then confirm it; check the 1,200 limit.
2. Paste a multiline Chinese/English sample in a long answer. Confirm no
   voice/rewrite controls. Try a paste that would exceed the configured limit;
   the entire previous answer must remain with a clear message.
3. Save and resume, then export/import the attempt ZIP. Check beginning, middle,
   end, paragraphs and indentation. Submit and preview print; check the final
   line appears on the final answer page.
4. On a standard text question, verify the configured limit and existing
   voice/rewrite login/cancel and answer application. Repeat the visual check
   once at phone width; no need to retest unrelated menus or question types.

Automated coverage: `long-text-answer-smoke.mjs` uses the actual editor/viewer
with isolated local data in both locales at 1280px and 390px, including composition,
selection replacement, rejected paste, saved resume and completed review. The
print smoke uses a 350-line long answer. Package/contract tests cover versions,
server validation, legacy preservation and mixed image-response budgets. Existing
voice/selection, review, imported-ID, image-response and RolePlayScene voice
smokes protect adjacent behavior. Mocked browser inputs do not replace a brief
real-device composition/microphone check after deployment.
