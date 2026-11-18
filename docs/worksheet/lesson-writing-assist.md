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
