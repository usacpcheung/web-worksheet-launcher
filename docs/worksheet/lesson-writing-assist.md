# Writing assistance for HTML lessons

Serve trusted lessons over HTTPS on the worksheet application's origin. Include one module per page. Mark each supported field with a unique stable ID, an accessible label, a positive native maxlength, and a layout. Other inputs retain their original behavior.

```html
<script type="module" src="/worksheet_launcher/app/writing-assist.js"></script>
<label for="subject">主角</label>
<input id="subject" data-writing-assist="compact" maxlength="50">
<label for="notes">Reflection</label>
<textarea id="notes" data-writing-assist="toolbar" maxlength="1200"></textarea>
```

The module attaches to marked fields at module initialization. For dynamically inserted controls import the named functions from the same URL. Call `attach(input)` after inserting it and `detach(input)` to remove assistance. Repeated attachment is safe. Use `setLayout(input, 'compact')` or `setLayout(input, 'toolbar')` to change presentation while keeping the answer and Undo. Compact mode falls back to a toolbar in browsers without the popover API.

The lesson owns field styles, saving, and submission. Listen for the normal bubbling input event for typing, assisted edits, and Undo. Native maxlength and the counter use UTF-16 units, including two units for many emoji. The rewrite service also has a 2,000 Unicode-code-point input limit. Set document language to English or Traditional Chinese. Style the controls with the inherited variables `--wa-border`, `--wa-radius`, and `--wa-background`.

First use loads the shared voice workflow. Recording and processing require an authenticated session and an explicit click after login. While one field processes, students can type elsewhere. Undo and recovery live in page memory. Keep retryable audio or transcripts until resolved or discarded. Review a recovered result that exceeds the field limit before applying it. The lesson can live at any same-origin path.

## 用 AI 製作教材 · Instructions for an AI lesson generator

Replace the bracketed lesson details and paste this prompt into your AI tool.

```text
Create a Traditional Chinese HTML lesson about [topic] for [students].
It will be hosted under https://hs-app.hs.edu.hk/. Use the school's existing
writing assistance for [list the fields]. Load this module once per page:

<script type="module" src="/worksheet_launcher/app/writing-assist.js"></script>

Give each assisted text input or textarea a stable unique id, a matching
<label for="…">, and a positive maxlength. For this lesson use compact menus
(data-writing-assist="compact") for short fields with maxlength="50" and visible
buttons (data-writing-assist="toolbar") for a reflection with maxlength="1200".
Adjust these example limits to the teacher's requirements. Leave other fields
unmarked. Both layouts can coexist on one page.

Match the field font, width, height, background, border, corner radius and
focus colour to the lesson. Leave room for the dots inside compact fields.
Use --wa-border, --wa-radius and --wa-background to style assistance controls.

Use the component's own buttons, counter, timer, login and recovery flows.
Do not build another microphone toolbar or call the rewrite API directly.
Use the bubbling input event to update combined prompts, previews or autosave.
If creating marked fields after page setup, import attach from the same module
and call attach(field) after insertion. Keep saving and submission in the lesson.
```

**Testing the generated lesson.** A local file is useful for previewing the lesson layout. For login, voice, and rewrite, open its HTTPS URL on the worksheet application's origin. The lesson can sit in any folder there. To check the integration, rewrite one field, verify its dependent preview updates, then use Undo to restore both.
