# Local Reference Directory

Use this folder for local-only material that should help AI-assisted edits but should not be committed to the repository.

Good candidates:

- API reference exports
- Draft or proposed script versions
- Vendor snippets you need to compare against current repo code
- Implementation notes tied to an upcoming local experiment

Guidelines:

- Treat files here as reference inputs, not source of truth
- Keep the canonical contract in `docs/message-contract.md`
- Keep canonical runtime code in the tracked repo files
- When a draft becomes real product code, move the final version into the tracked repo and review it normally
- Avoid placing secrets, tokens, or private credentials here

Suggested naming:

- `api-reference.md`
- `rewrite-widget.v2.reference.js`
- `render-flow-notes.md`

Typical AI prompt:

"Compare the tracked widget code with `reference/rewrite-widget.v2.reference.js` and apply the relevant changes to the repo implementation without modifying compatibility rules."