import assert from 'assert';

const {
  translate,
  setActiveLocale,
  ensureLocale,
  getActiveLocale,
  getAvailableLocales,
  onLocaleChange,
  LOCALE_STORAGE_KEY,
} = await import('../scripts/i18n.js');

function resetLocale() {
  setActiveLocale('en');
}

try {
  resetLocale();

  assert.deepStrictEqual(
    getAvailableLocales(),
    ['en', 'zh-Hant'],
    'RolePlayScene should use the shared app locale list',
  );
  assert.strictEqual(ensureLocale('zh-TW'), 'zh-Hant', 'zh-TW should normalize through shared i18n');
  assert.strictEqual(ensureLocale('zh-HK'), 'zh-Hant', 'zh-HK should normalize through shared i18n');
  assert.strictEqual(ensureLocale('zz'), 'en', 'Unknown locales should resolve to English');
  assert.strictEqual(LOCALE_STORAGE_KEY, 'worksheetLauncher.locale', 'RolePlayScene should expose the shared locale storage key');

  setActiveLocale('zh-TW');
  assert.strictEqual(getActiveLocale(), 'zh-Hant', 'Active locale should use the shared zh-Hant code');
  assert.strictEqual(
    translate('player.choices.cueCardTitle'),
    '提示卡',
    'Cue-card title should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.choices.cueCardPlaceholder'),
    '可選的提示卡文字',
    'Inspector cue-card placeholder should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.importConfirmTitle'),
    '取代目前專案？',
    'Import confirmation title should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('toolbar.newStory'),
    '開始新故事',
    'New Story toolbar action should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.newStoryConfirmAccept'),
    '開始新故事',
    'New Story confirmation action should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.importMissingMediaWarning', { path: 'media/missing.mp3' }),
    '缺少媒體檔案：media/missing.mp3',
    'Import missing-media warning should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('messages.importMissingPackageProject'),
    '匯入失敗：套件缺少 content/project.json。',
    'New package missing-project error should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.manageTitle'),
    '管理已上傳的 RolePlayScene 草稿',
    'Server draft manager title should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.slotUsage', { used: 2, limit: 3 }),
    '已使用 2 / 3 個伺服器草稿欄位。',
    'Server slot usage should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.publishConflictTitle'),
    '已存在同名發布項目',
    'Server publish conflict title should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.publishedDeletedBadge'),
    '已發布副本已刪除',
    'Deleted published-copy badge should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('server.downloadingDraftProgress', { percent: 42 }),
    '下載中 42%',
    'Draft download progress should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.t2aPresetBadge', { preset: '可愛女聲' }),
    'T2A：可愛女聲',
    'Dialogue T2A preset badge should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.t2aLineChanged'),
    '音訊生成已取消，因為這句台詞已被修改。',
    'Dialogue T2A stale-line warning should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.speechBubble.anchorUsage', { label: 'A', count: 2 }),
    '定位點 A：被 2 句台詞使用',
    'Speech bubble anchor usage should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('editor.views.scenePreview'),
    '場景預覽',
    'Scene Preview view label should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('inspector.header.previewCurrentScene'),
    '預覽目前場景',
    'Preview Current Scene action should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('player.speechBubble.startDialogue'),
    '開始對話',
    'Speech bubble playback start action should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('player.speechBubble.pageStatus', { current: 2, total: 3 }),
    '2 / 3',
    'Speech bubble playback page status should resolve from shared Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('player.discussion.defaultSchoolName'),
    '香港紅十字會醫院學校',
    'Discussion print school default should follow Traditional Chinese locale',
  );
  assert.strictEqual(
    translate('player.discussion.printDetailsTitle'),
    '列印資料',
    'Discussion print details modal title should resolve from Traditional Chinese locale',
  );

  setActiveLocale('en');
  assert.strictEqual(
    translate('messages.importConfirmAccept'),
    'Replace and import',
    'Import confirmation action should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('toolbar.newStory'),
    'New Story',
    'New Story toolbar action should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('messages.newStoryConfirmTitle'),
    'Start a new story?',
    'New Story confirmation title should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('server.conflictCopy'),
    'Save as copy',
    'Server conflict copy action should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('server.slotRecoveryDescription'),
    'Delete one uploaded RolePlayScene draft to free a slot. After deletion, this save will retry automatically.',
    'Server slot recovery description should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('server.publishConflictBody', { title: 'Clinic' }),
    'A published RolePlayScene named "Clinic" already exists. Edit the title and try again.',
    'Server publish conflict body should resolve from shared English locale and interpolate title',
  );
  assert.strictEqual(
    translate('server.publishedLiveBadge'),
    'Published',
    'Live published-copy badge should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('inspector.dialogue.audioPreviewFailed'),
    'Unable to play this audio preview.',
    'Dialogue audio preview failure should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('inspector.speechBubble.lineModes.center'),
    'Center narration',
    'Speech bubble line mode should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('editor.views.storyMap'),
    'Story Map',
    'Story Map view label should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('editor.scenePreview.anchorHint'),
    'Place anchors on the scene preview.',
    'Scene Preview anchor hint should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('toolbar.backToEdit'),
    'Back to Edit',
    'Back to Edit toolbar action should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('player.speechBubble.stopAll'),
    'Stop All',
    'Speech bubble playback stop-all action should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('player.speechBubble.noDialogue'),
    'No visible dialogue for this scene.',
    'Speech bubble playback no-dialogue message should resolve from shared English locale',
  );
  assert.strictEqual(
    translate('player.discussion.defaultSchoolName'),
    'Hong Kong Red Cross Hospital Schools',
    'Discussion print school default should follow English locale',
  );
  assert.strictEqual(
    translate('player.discussion.printDetailsTitle'),
    'Print details',
    'Discussion print details modal title should resolve from English locale',
  );
  assert.strictEqual(
    translate('missing.key', { default: 'Fallback {value}', value: 'text' }),
    'Fallback text',
    'RolePlayScene wrapper should preserve default fallback interpolation',
  );

  const observed = [];
  const unsubscribe = onLocaleChange((locale) => observed.push(locale));

  setActiveLocale('zh-HK');
  setActiveLocale('en');

  unsubscribe();
  assert.deepStrictEqual(observed.slice(-2), ['zh-Hant', 'en'], 'Locale change listeners should receive shared locale updates');
  assert.strictEqual(getActiveLocale(), 'en', 'Active locale should reflect the latest shared locale change');
} finally {
  resetLocale();
}

console.log('i18n tests passed');
