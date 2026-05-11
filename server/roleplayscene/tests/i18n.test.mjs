import assert from 'assert';

const {
  translate,
  setActiveLocale,
  addTranslations,
  ensureLocale,
  getActiveLocale,
  onLocaleChange,
  translations,
} = await import('../scripts/i18n.js');
await import('../scripts/i18n.zh-TW.js');

function resetLocale() {
  setActiveLocale('en');
}

try {
  resetLocale();

  addTranslations('fr', {
    toolbar: {
      edit: 'Modifier',
    },
  });

  setActiveLocale('fr');
  assert.strictEqual(translate('toolbar.edit'), 'Modifier', 'Locale-specific translation should be used when available');
  assert.strictEqual(
    translate('messages.exportFailed'),
    'Export failed.',
    'Missing keys should fall back to English translations',
  );
  assert.strictEqual(
    translate('player.choices.cueCardTitle'),
    'Cue card',
    'Cue-card title should fall back to English when locale key is missing',
  );
  assert.strictEqual(
    translate('player.choices.cueCardTriggerLabel', { label: 'North Gate' }),
    'Show cue card for North Gate',
    'Cue-card trigger text should fall back to English and interpolate variables',
  );

  setActiveLocale('zh-TW');
  assert.strictEqual(
    translate('player.choices.cueCardTitle'),
    '提示卡',
    'Cue-card title should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.choices.cueCardPlaceholder'),
    '可選的提示卡文字',
    'Inspector cue-card placeholder should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.importConfirmTitle'),
    '取代目前專案？',
    'Import confirmation title should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.importMissingMediaWarning', { path: 'media/missing.mp3' }),
    '缺少媒體檔案：media/missing.mp3',
    'Import missing-media warning should resolve from Traditional Chinese locale',
  );

  setActiveLocale('en');
  assert.strictEqual(
    translate('messages.importConfirmAccept'),
    'Replace and import',
    'Import confirmation action should resolve from English locale',
  );

  setActiveLocale('fr');

  assert.strictEqual(ensureLocale('fr'), 'fr', 'Known locales should be preserved');
  assert.strictEqual(ensureLocale('zz'), 'en', 'Unknown locales should resolve to English');

  const observed = [];
  const unsubscribe = onLocaleChange((locale) => observed.push(locale));

  setActiveLocale('en');
  setActiveLocale('fr');

  unsubscribe();
  const lastLocale = observed[observed.length - 1];
  assert.strictEqual(lastLocale, 'fr', 'Locale change listeners should receive updates');
  assert.strictEqual(getActiveLocale(), 'fr', 'Active locale should reflect the latest change');
} finally {
  resetLocale();
  delete translations.fr;
}

console.log('i18n tests passed');
