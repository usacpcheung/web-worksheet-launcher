import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const target of ['prompt', 'option']) {
    const context = await browser.newContext();
    // A real browsing-context-group split: no postMessage callback is supplied.
    // Readiness is released by the test only after the soft polling window ends.
    await context.route('**/qa-isolated-login', route => route.fulfill({
      contentType: 'text/html', headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
      body: '<!doctype html><title>Isolated sign-in fixture</title><p>Waiting for simulated sign-in</p>',
    }));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/server/editor/'); await page.waitForFunction(() => window.editorSession);
    await page.evaluate(async ({ locale }) => {
      const { setLocale } = await import('/server/app/i18n/index.js'); setLocale(locale);
      const { AUTH_POPUP_FLOW_DEFAULTS } = await import('/server/app/auth/auth-popup-flow.js');
      AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs = 50;
      AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs = 200;
      AUTH_POPUP_FLOW_DEFAULTS.hardDeadlineMs = 10000;
      const s = window.editorSession;
      s.state.draft.blocks = [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: { inputType: 'multiple_choice', options: [{ id: 'o', value: 'a', label: 'Answer' }] } }];
      s.state.selectedBlockId = 'q'; s._readAuth = null;
      window.requests = 0; window.probes = 0;
      s.apiClient.getSessionSignInUrl = () => new URL('/qa-isolated-login', location.href).href;
      s.apiClient.getSession = async () => {
        window.probes++;
        return localStorage.getItem('qa-auth-ready') === '1'
          ? { ok: true, data: { ready: true, user: { sub: 'fixture', email: 'fixture@example.test' } } }
          : { ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } };
      };
      s.apiClient.generateAudioFromText = async () => { window.requests++; return { ok: true, data: new Uint8Array([1, 2, 3]) }; };
      s.notifyStateChange();
    }, { locale });
    if (target === 'option') await page.locator('[data-option-audio-menu-trigger]').first().click();
    const generate = target === 'prompt'
      ? page.locator('[data-prompt-audio-track-language="english"] [data-audio-track-action="generate"]')
      : page.locator('[data-option-audio-language="english"][data-option-audio-action="generate"]');
    await generate.click();
    const modal = page.locator('.read-auth-prompt'); await modal.waitFor();
    assert.equal(await page.evaluate(() => window.requests), 0);
    const popupEvent = context.waitForEvent('page');
    await modal.locator('button').nth(1).click();
    const popup = await popupEvent; await popup.waitForLoadState();
    await page.waitForFunction(() => window.probes >= 8);
    assert.equal(await popup.evaluate(() => window.opener === null), true, 'actual COOP-isolated popup');
    assert.equal(await page.evaluate(() => window.requests), 0);
    await popup.evaluate(() => localStorage.setItem('qa-auth-ready', '1'));
    await page.waitForFunction(() => document.querySelector('.read-auth-prompt button:nth-child(2)')?.textContent?.match(/Generate audio|產生語音/));
    assert.equal(await page.evaluate(() => window.requests), 0, 'no generation before confirmation');
    await modal.locator('button').nth(1).click();
    await page.waitForFunction(() => window.editorSession._audioOperations.size === 0);
    assert.equal(await page.evaluate(() => window.requests), 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Slow COOP-isolated popup: prompt/option generation returns to explicit consent in both locales, without callback or replay');
} finally { await browser.close(); }
