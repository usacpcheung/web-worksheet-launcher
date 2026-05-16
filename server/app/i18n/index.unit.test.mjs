import test from 'node:test';
import assert from 'node:assert/strict';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('resolveInitialLocale uses saved preference before browser language', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  const storage = createStorage({ [mod.LOCALE_STORAGE_KEY]: 'en' });

  assert.equal(
    mod.resolveInitialLocale({ storage, navigator: { language: 'zh-HK', languages: ['zh-HK'] } }),
    'en'
  );
});

test('resolveInitialLocale maps Traditional Chinese browser locales to zh-Hant', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);

  assert.equal(mod.resolveInitialLocale({ storage: createStorage(), navigator: { language: 'zh-HK' } }), 'zh-Hant');
  assert.equal(mod.resolveInitialLocale({ storage: createStorage(), navigator: { language: 'zh-TW' } }), 'zh-Hant');
  assert.equal(mod.resolveInitialLocale({ storage: createStorage(), navigator: { language: 'zh-Hant' } }), 'zh-Hant');
});

test('unknown locales fall back to English', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);

  assert.equal(mod.resolveInitialLocale({ storage: createStorage(), navigator: { language: 'fr-FR' } }), 'en');
  assert.equal(mod.setLocale('fr-FR', { storage: createStorage() }), 'en');
});

test('setLocale saves preference to worksheetLauncher.locale', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  const storage = createStorage();

  mod.setLocale('zh-HK', { storage });

  assert.equal(storage.values.get(mod.LOCALE_STORAGE_KEY), 'zh-Hant');
  assert.equal(mod.getLocale(), 'zh-Hant');
});

test('t falls back to English and missing keys are safe', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  mod.setLocale('zh-Hant', { persist: false });

  assert.equal(mod.t('viewer.actions.submit'), '提交');
  assert.equal(mod.t('common.status.saved'), '已儲存');
  assert.equal(mod.t('viewer.actions.nonexistent'), 'viewer.actions.nonexistent');
});

test('t supports simple interpolation', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  mod.setLocale('en', { persist: false });

  assert.equal(
    mod.t('editor.server.uploadingDraftPackageProgress', { percent: 50, loaded: '1 MB', total: '2 MB' }),
    'Uploading draft package... 50% (1 MB / 2 MB)'
  );
});

test('shared locales expose modular RolePlayScene namespace', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);

  mod.setLocale('en', { persist: false });
  assert.equal(mod.t('roleplayscene.toolbar.edit'), 'Edit');
  assert.equal(mod.t('roleplayscene.inspector.dialogue.generateAudio'), 'Generate audio');

  mod.setLocale('zh-TW', { persist: false });
  assert.equal(mod.getLocale(), 'zh-Hant');
  assert.equal(mod.t('roleplayscene.toolbar.edit'), '編輯');
  assert.equal(mod.t('roleplayscene.server.manageTitle'), '管理已上傳的 RolePlayScene 草稿');
});

test('onLocaleChange notifies subscribers when shared locale changes', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  const observed = [];
  const unsubscribe = mod.onLocaleChange((locale) => observed.push(locale));

  mod.setLocale('zh-HK', { persist: false });
  mod.setLocale('en', { persist: false });
  unsubscribe();

  assert.deepEqual(observed.slice(-2), ['zh-Hant', 'en']);
});

test('viewer upload notification interpolation preserves percent symbol', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  mod.setLocale('en', { persist: false });

  assert.equal(mod.t('viewer.notifications.uploadAttempt.progressPercent', { percent: 42 }), 'Uploading attempt... 42%');
});

test('zh-Hant attempt slot limit strings are translated', async () => {
  const mod = await import(`./index.js?case=${Math.random()}`);
  mod.setLocale('zh-Hant', { persist: false });

  assert.equal(mod.t('viewer.attemptSlots.limitReached', { limit: 3 }), '已達上限 3');
  assert.equal(mod.t('viewer.attemptSlots.limitReachedUnknown'), '已達上限');
});
