# Phase 2: Editor Runtime (Local-first Multi-block)

## Scope implemented in Phase 2

- `/editor/` now runs a two-panel local-first editor runtime with:
  - Left panel: block library, worksheet outline, add/remove/reorder actions, import/export area.
  - Right panel: active block editor, type-aware settings, info/validation summary, protected-action placeholders.
- Worksheet content model for editor runtime is ordered `worksheet.blocks` with stable per-block `id`, `type`, `prompt`, and type-specific `config`.
- Supported block types:
  - `text_input`
  - `multiple_choice`
  - `numeric`
- Export format now includes `schemaVersion: 2`.
- Import accepts schema v2 payloads and maps legacy/simple payloads into the new block model when possible.

## Explicit non-scope / compatibility boundaries

- Popup compatibility flow is unchanged.
- `server/worksheet_launcher/render.html` behavior and popup message-contract obligations remain untouched.
- This Phase 2 work does **not** change `docs/message-contract.md` because no popup launch hash or popup `postMessage` contract fields were altered.
