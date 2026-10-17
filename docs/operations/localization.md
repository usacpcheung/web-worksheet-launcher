# Current localization

API-error presentation reviewed against the implementation on 2026-10-16. Code authorities: `server/app/i18n/index.js`, `locales/en.js`, `locales/zh-Hant.js`, namespaced RolePlayScene dictionaries and `server/roleplayscene/scripts/i18n.js`.

Supported locales are `en` and `zh-Hant`. English is the fallback. Startup first uses a saved `worksheetLauncher.locale` preference in localStorage; otherwise it normalizes the first available browser language. `zh-Hant`, `zh-HK` and `zh-TW` language prefixes select Traditional Chinese, English prefixes select English, and unsupported values fall back to English. A saved unsupported value falls back to English rather than proceeding to browser-language detection. A missing localized key falls back to English, then the key itself; storage failures do not prevent use. Shared `t(key, vars)` supplies placeholder interpolation and locale change notifications.

Editor/viewer fixed labels, modal controls, status/error wrappers, voice/recovery messages and print chrome use the shared dictionaries. RolePlayScene delegates to the same locale framework using `roleplayscene.*` keys; its historical local preference migration remains supported. This is broader than the early editor/viewer-only slice in the [archived i18n audit](../past/audits/i18n-audit.md).

Translate fixed application text, including accessible labels and local fallback messages. Do not translate authored worksheet/story content, titles, answers, scene IDs, package fields, API paths, protocol constants or voice-choice IDs. A dictionary does not automatically translate backend prose; structured API errors use the presentation boundary below. The shared login HTML and some viewer controls/number-input guidance still contain fixed English text (for example the literal True/False button labels), so this reference is not a claim that every visible string is localized.

Use `textContent` for plain user/translated text. Worksheet formatted content must use `server/app/worksheet-text.js`; scene dialogue remains plain text. Preserve placeholder escaping and user values in printed/template content.

Worksheet Chinese typography uses local Noto Sans HK subsets, restricted to CJK/punctuation, and does not change RolePlayScene fonts. See the [font reference](../../server/app/fonts/README.md).

For future UI changes, check both languages, desktop/narrow layouts, long labels and keyboard focus with the affected existing smoke scripts. Unit localization tests check keys/fallbacks but do not establish visual fit or complete translation coverage. See [testing](testing.md).

## User-facing API errors

The shared presentation boundary is `server/app/api/error-presentation.js`. UI wording lives in the `apiErrors` section of `server/app/i18n/locales/en.js` and `zh-Hant.js`. Change both dictionary entries to change an existing error's wording; no English-message matching is involved. Callers render using the selected locale at presentation time. An already-stored notification is a rendered string, so changing language does not retroactively translate its history.

`resolveErrorPresentation(result, { operation, source })` selects a key, validated interpolation parameters and bounded diagnostic metadata. `getApiErrorMessage` renders the selected key. Operation context distinguishes upload, publish, list, open, download, delete, session, audio and rewrite fallbacks. Repository domain codes are not interpreted as bridge domain errors. Unknown codes receive a localized operation fallback rather than raw upstream prose.

RolePlayScene ZIP, manifest, project, unsupported format/version and publish-validation codes map to invalid-package guidance. ZIP resource-limit failures use a separate localized message asking users to reduce contents or media size.

Known errors include authentication, conflict, exhausted storage slots, missing resources, invalid packages/IDs, prompt limits, already-published versions, missing scene media, upload-operation mismatch, rate limits, oversized uploads, unsupported voices and unreadable responses. Cancellation during upload and uncertain upload outcomes warn that the server may already have saved the item and ask users to check the server list. Download cancellation does not carry that upload warning. A retained HTTP rejection takes precedence over transport/cancellation symptoms: authentication, size and rate-limit rejections retain their specific guidance, while other interrupted 4xx responses use the operation fallback. Viewer technical disclosures keep their DOM identity during autosave and unrelated notification updates. Explicit permission errors and session-check timeouts retain specific guidance. Numeric slot/prompt parameters must be positive safe integers; arbitrary error details are not interpolated.

| UI boundary | Presentation owner |
| --- | --- |
| Editor upload/publish/list/open/delete and published browser | Shared API resolver |
| Viewer attempt upload/list/download/resume/delete, published list/open and direct-launch failures | Shared API resolver |
| RolePlayScene server managers and publishing errors | Shared API resolver; existing localized conflict/slot dialogs retain their actions |
| Editor and RolePlayScene text-to-audio API failures | Shared resolver with `source: 'bridge'` |
| Shared popup status, auth-gate recovery and viewer callback progress | Shared `apiErrors` dictionary; existing app-specific auth labels remain localized |
| Viewer/RolePlayScene answer voice and rewrite recovery | Existing structured voice-error normalization and localized workflow messages |

The resolver does not change API responses, bridge English diagnostics, request/retry behavior, auth decisions or saved content. Keep original structured results with their existing owners. Public technical details use only a bounded code, HTTP status and source label, rendered as plain text; raw messages, URLs, headers, request bodies and arbitrary details are excluded. Viewer upload disclosures and API-backed fatal panels use this sanitized presentation. Local boot/import diagnostics remain a separate boundary.

To add a new error meaning, register its stable code in the resolver, choose its applicable source, add matching keys/placeholders in both dictionaries, and test the real UI caller. Adding dictionary text alone cannot recognize a new code. Unknown errors remain localized while that mapping is absent. Do not alter auth or retry decisions based on translated text.

This is not a complete translation of every product string. Authored content, raw API/log diagnostics, local import/export/storage validation details, successful-import/upload validation warning details, the shared login HTML and remaining legacy fixed-English controls are outside this change. Keep those separate from API error presentation; never translate arbitrary server sentences using a phrase-replacement table.

### Viewer sign-in feedback

The viewer keeps popup guidance in `authFeedback` (translation key and parameters),
separate from upload/list `serverActionMessage` text. The start panel, active
worksheet and both server dialogs render it in a plain-text, polite status region.
Only the foremost region announces the current message. Keys are translated at
render time, and the attempt-manager busy button uses `common.actions.signingIn`.

Each sign-in flow owns its feedback. Superseded callbacks cannot overwrite the
current flow; successful completion and cancellation clear progress. Blocked-popup
and terminal failure guidance remains visible until a new sign-in flow begins.
The `viewer-auth-feedback-ui-smoke.mjs` browser regression checks rendered status
text in both locales and viewport widths, alongside the popup status and ownership
smokes. These isolated fixtures do not replace live sign-in acceptance testing.

A failed follow-up session probe leaves sign-in retry available. Dialogs clear
and render their busy state after the owning callback finishes; a settled probe
error does not count as an active session check when disabling sign-in controls.
