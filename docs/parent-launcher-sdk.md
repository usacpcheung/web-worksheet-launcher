# Parent Launcher SDK (WorksheetLauncher)

This document shows the public parent-side API for launching the worksheet popup and receiving one rewritten answer.

> **Source of truth:** `parent_prototype/sdk/parent-launcher.js` is the canonical SDK source in this repo.
> For new integrations, copy this file into your parent application and host it locally with your app bundle/static assets.
> Legacy path `server/worksheet_launcher/parent-launcher.js` is kept as a **compatibility-only mirror** for existing references and is not recommended for new integrations.

## Recommended integration path (local-hosted SDK)

1. Copy `parent_prototype/sdk/parent-launcher.js` into your consumer project (for example `public/vendor/parent-launcher.js` or similar).
2. Serve that copied SDK file from your parent app.
3. Include the script from your app-local path.

```html
<script src="/vendor/parent-launcher.js"></script>
```

## 5-line integration (selectors)

```html
<script src="/vendor/parent-launcher.js"></script>
<script>
const launcher = WorksheetLauncher.create({ renderOrigin: "https://oidc.example.com", renderPath: "/worksheet/render.html", trustedSenderOrigin: "https://oidc.example.com", questionSelector: "#question", answerTargetSelector: "#answer" });
document.querySelector("#open").addEventListener("click", () => launcher.open({ title: "Quick Check" }));
</script>
```

That is enough for the common case: question text is read from `#question`, and the returned answer is written into `#answer`.

## Advanced integration (callbacks instead of selectors)

Use this when your app state is not DOM-first, or when answer writing needs custom logic.

```html
<script src="/vendor/parent-launcher.js"></script>
<script>
const launcher = WorksheetLauncher.create({
  renderOrigin: "https://oidc.example.com",
  renderPath: "/worksheet/render.html",
  trustedSenderOrigin: "https://oidc.example.com",
  getQuestion: () => appState.currentPrompt,
  setAnswer: (answer, context) => {
    appState.latestAnswer = answer;
    renderAnswerPreview(answer, context.payload);
  },
  onStatusChange: (status, ok) => showBanner(status, ok),
  onError: (error, details) => reportLauncherIssue(error, details),
  onResult: (payload) => console.log("worksheetResult", payload)
});

document.querySelector("#open").addEventListener("click", () => {
  launcher.open({ title: appState.worksheetTitle || "Quick Check" });
});
</script>
```

## Required configuration

You must pass these fields to `WorksheetLauncher.create(config)`:

- `renderOrigin`: origin where the **deployed popup renderer** is hosted (for example `https://oidc.example.com`).
- `renderPath`: route on that deployed renderer origin (for example `/worksheet/render.html`).
- `trustedSenderOrigin`: strict origin allowed for `postMessage` results; this must match the deployed popup renderer origin (normally same as `renderOrigin`).

### Deployed renderer configuration examples

```js
// Parent app hosted at https://teacher.example.edu
// Popup renderer hosted at https://oidc.example.com
WorksheetLauncher.create({
  renderOrigin: "https://oidc.example.com",
  renderPath: "/worksheet/render.html",
  trustedSenderOrigin: "https://oidc.example.com",
  questionSelector: "#question",
  answerTargetSelector: "#answer"
});
```

```js
// Parent app and popup renderer on same deployed origin
WorksheetLauncher.create({
  renderOrigin: "https://app.example.edu",
  renderPath: "/worksheet/render.html",
  trustedSenderOrigin: "https://app.example.edu",
  questionSelector: "#question",
  answerTargetSelector: "#answer"
});
```

Do not point these values at non-renderer endpoints; they must resolve to the deployed popup renderer location that sends `worksheetResult` messages.

## Migration note (`server/worksheet_launcher/parent-launcher.js` users)

If your team currently references `server/worksheet_launcher/parent-launcher.js` directly:

1. Switch your source-of-truth copy to `parent_prototype/sdk/parent-launcher.js`.
2. Copy that file into your parent application repository and host it locally.
3. Update `<script src="...">` to your local path (for example `/vendor/parent-launcher.js`).
4. Keep `renderOrigin`, `renderPath`, and `trustedSenderOrigin` pointed at your deployed popup renderer.

The legacy `server/worksheet_launcher/parent-launcher.js` file remains compatibility-only and may lag behind canonical SDK updates.

You must also provide **one question source** and **one answer target**:

- Question source:
  - selectors mode: `questionSelector` (+ optional `questionExtractor(el)`), or
  - callback mode: `getQuestion()`.
- Answer target:
  - selectors mode: `answerTargetSelector`, or
  - callback mode: `setAnswer(answer, context)`.

## DOM assumptions (selectors mode)

When using selectors:

- `questionSelector` must resolve to an existing element at launch time.
- Question extraction order is:
  1. `data-question-text` (when present)
  2. element `.value` (for input/textarea)
  3. element `.textContent`
- Extracted question must be non-empty, and v1 supports exactly one question.
- `answerTargetSelector` should resolve to an existing element that can accept text (`value` or `textContent`).
- Launch should be triggered by a user gesture (for example button click) so popup blockers do not block `window.open(...)`.

## Optional hooks and subscriptions

### Callback hooks in config

- `onStatusChange(status, ok)`: user-facing status updates.
- `onError(error, details)`: rejected messages, validation failures, popup blocks, and other launch/runtime errors.
- `onResult(payload, launchContext)`: invoked after a valid `worksheetResult` is accepted.

### Event-style subscriptions on launcher instance

All return an unsubscribe function.

- `launcher.onOpen(cb)`
- `launcher.onBlocked(cb)`
- `launcher.onLaunchRejected(cb)`
- `launcher.onResultAccepted(cb)`
- `launcher.onMessageRejected(cb)`
- `launcher.onPopupClosedWithoutResult(cb)`

Utility methods:

- `launcher.clear()` resets current one-shot launch context.
- `launcher.destroy()` removes listeners and closes popup if still open.

## Common failure states and what to do

- **Popup blocked**: `open(...)` returns `false`; prompt user to allow popups and retry from a click.
- **Missing question source element**: throws error for invalid `questionSelector`; fix selector or use `getQuestion()`.
- **Empty or too-long question**: launch rejected if question is blank or exceeds max chars (default 800).
- **URL too long**: `open(...)` returns `false` when encoded launch URL exceeds max length (default 1800).
- **Invalid return origin**: launch rejected when parent origin is not a valid absolute http(s) origin.
- **Message rejected (security/contract)**:
  - wrong `event.origin`
  - wrong `event.data.type`
  - `event.data.rid` mismatch
  - invalid payload shape
- **Popup closed before result**: emits `popup_closed_without_result` status/event.

## v1 behavior boundary

Current launcher contract is single-launch, one-question mode only.
