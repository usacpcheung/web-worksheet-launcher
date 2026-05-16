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
  assert.strictEqual(
    translate('messages.importMissingPackageProject'),
    '匯入失敗：套件缺少 content/project.json。',
    'New package missing-project error should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.manageTitle'),
    '管理已上傳的 RolePlayScene 草稿',
    'Server draft manager title should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.slotUsage', { used: 2, limit: 3 }),
    '已使用 2 / 3 個伺服器草稿欄位。',
    'Server slot usage should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.slotRecoveryTitle'),
    '伺服器草稿欄位已滿',
    'Server slot recovery title should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.publishConflictTitle'),
    '已存在同名發布項目',
    'Server publish conflict title should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.playAudioPreview'),
    '播放',
    'Dialogue audio preview play action should resolve from Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.t2aPresetBadge', { preset: '可愛女聲' }),
    'T2A：可愛女聲',
    'Dialogue T2A preset badge should resolve from Traditional Chinese locale',
  );

  setActiveLocale('en');
  assert.strictEqual(
    translate('messages.importConfirmAccept'),
    'Replace and import',
    'Import confirmation action should resolve from English locale',
  );
  assert.strictEqual(
    translate('messages.importUnsupportedPackage'),
    'Import failed: this RolePlayScene package format is not supported.',
    'Unsupported package error should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.conflictCopy'),
    'Save as copy',
    'Server conflict copy action should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.missingMediaBadge', { count: 2 }),
    '2 missing media',
    'Server missing-media badge should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.slotRecoveryDescription'),
    'Delete one uploaded RolePlayScene draft to free a slot. After deletion, this save will retry automatically.',
    'Server slot recovery description should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.meta.validationWarnings'),
    'Validation warnings',
    'Server validation-warning metadata label should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.publishNewVersion'),
    'Publish new version',
    'Server publish-new-version action should resolve from English locale',
  );
  assert.strictEqual(
    translate('server.publishConflictBody', { title: 'Clinic' }),
    'A published RolePlayScene named "Clinic" already exists. Edit the title and try again.',
    'Server publish conflict body should resolve from English locale and interpolate title',
  );
  assert.strictEqual(
    translate('inspector.dialogue.stopAudioPreview'),
    'Stop',
    'Dialogue audio preview stop action should resolve from English locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.audioPreviewFailed'),
    'Unable to play this audio preview.',
    'Dialogue audio preview failure should resolve from English locale',
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
