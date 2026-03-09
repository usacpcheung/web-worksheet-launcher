# Parent Launcher SDK (WorksheetLauncher)

This document shows the public parent-side API for launching the worksheet popup and receiving one rewritten answer.

> **Source of truth:** `parent_prototype/sdk/parent-launcher.js` is the canonical SDK source in this repo.
> Legacy path `server/worksheet_launcher/parent-launcher.js` is kept as a **compatibility-only mirror** for existing references and is not recommended for new integrations.

## 5-line integration (selectors)

```html
<script src="/worksheet/parent-launcher.js"></script>
<script>
const launcher = WorksheetLauncher.create({ renderOrigin: "https://oidc.example.com", renderPath: "/worksheet/render.html", trustedSenderOrigin: "https://oidc.example.com", questionSelector: "#question", answerTargetSelector: "#answer" });
document.querySelector("#open").addEventListener("click", () => launcher.open({ title: "Quick Check" }));
</script>
```

That is enough for the common case: question text is read from `#question`, and the returned answer is written into `#answer`.

## Advanced integration (callbacks instead of selectors)

Use this when your app state is not DOM-first, or when answer writing needs custom logic.

```html
<script src="/worksheet/parent-launcher.js"></script>
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

- `renderOrigin`: origin where popup renderer is hosted (for example `https://oidc.example.com`).
- `renderPath`: route to renderer page (for example `/worksheet/render.html`).
- `trustedSenderOrigin`: strict origin allowed for `postMessage` results (normally same as `renderOrigin`).

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
