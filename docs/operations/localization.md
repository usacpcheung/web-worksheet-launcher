# Current localization

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/app/i18n/index.js`, `locales/en.js`, `locales/zh-Hant.js`, namespaced RolePlayScene dictionaries and `server/roleplayscene/scripts/i18n.js`.

Supported locales are `en` and `zh-Hant`. English is the default. Locale preference uses `worksheetLauncher.locale` in localStorage. A missing localized key falls back to English, then the key itself; storage failures do not prevent use. Shared `t(key, vars)` supplies placeholder interpolation and locale change notifications.

Editor/viewer fixed labels, modal controls, status/error wrappers, voice/recovery messages and print chrome use the shared dictionaries. RolePlayScene delegates to the same locale framework using `roleplayscene.*` keys; its historical local preference migration remains supported. This is broader than the early editor/viewer-only slice in the [archived i18n audit](../past/audits/i18n-audit.md).

Translate fixed application text, including accessible labels and local fallback messages. Do not translate authored worksheet/story content, titles, answers, scene IDs, package fields, API paths, protocol constants or voice-choice IDs. A dictionary does not automatically translate a backend/upstream message; existing server-message handling remains its own boundary. The shared login HTML still contains its own fixed English text, so this reference is not a claim that every visible string is localized.

Use `textContent` for plain user/translated text. Worksheet formatted content must use `server/app/worksheet-text.js`; scene dialogue remains plain text. Preserve placeholder escaping and user values in printed/template content.

Worksheet Chinese typography uses local Noto Sans HK subsets, restricted to CJK/punctuation, and does not change RolePlayScene fonts. See the [font reference](../../server/app/fonts/README.md).

For future UI changes, check both languages, desktop/narrow layouts, long labels and keyboard focus with the affected existing smoke scripts. Unit localization tests check keys/fallbacks but do not establish visual fit or complete translation coverage. See [testing](testing.md).
