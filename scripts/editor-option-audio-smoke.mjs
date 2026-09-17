// Real editor controls, isolated storage, synthetic session and audio actions.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async locale => {
        const i18n = await import('/server/app/i18n/index.js');
        i18n.setLocale(locale);
        window.cancelLabel = i18n.t('common.actions.cancel');
        const session = window.editorSession;
        session.state.draft.blocks = [{ blockId: 'audio-question', kind: 'question', position: 0,
          prompt: { text: 'Choose an answer' }, responseConfig: { inputType: 'multiple_choice', selectionMode: 'single',
            options: [
              { id: 'first', value: 'First answer', label: 'First answer', audioTracks: [
                { language: 'cantonese', assetId: 'existing-audio', sourceTextHash: 'fixture-hash', voicePresetId: 'cantonese' },
              ] },
              { id: 'second', value: 'Second answer', label: 'Second answer', audioTracks: [
                { language: 'english', assetId: 'fixture-audio', sourceTextHash: 'fixture-hash', voicePresetId: 'english' },
              ] },
            ] } }];
        session.state.selectedBlockId = 'audio-question';
        window.generationCalls = []; window.playedAssets = [];
        session.ensureServerSessionReady = async () => ({ ok: true });
        session.triggerProtectedAction = async (action, payload) => {
          window.generationCalls.push({ action, payload });
          await new Promise(resolve => { window.finishGeneration = resolve; });
          return window.generationOutcome === 'failure'
            ? { ok: false, error: { message: 'Synthetic generation failure' } }
            : { ok: true, status: 'executed' };
        };
        session.playAssetAudio = async id => { window.playedAssets.push(id); return { ok: false }; };
        session.notifyStateChange();
      }, locale);
      const first = page.locator('[data-option-audio-menu-key="audio-question:first"][data-option-audio-language="english"]');
      const generate = first.and(page.locator('[data-option-audio-action="generate"]'));
      const attach = first.and(page.locator('[data-option-audio-action="attach"]'));
      await page.locator('summary[data-option-audio-menu-trigger="1"]').first().click();
      await generate.waitFor({ state: 'visible' });
      assert.equal(await generate.isEnabled(), true);
      const chooser = page.waitForEvent('filechooser');
      await attach.click(); await (await chooser).setFiles([]);
      const secondPlay = page.locator('[data-option-audio-menu-key="audio-question:second"][data-option-audio-action="play"]');
      for (const outcome of ['success', 'failure']) {
        await page.evaluate(outcome => { window.generationOutcome = outcome; window.generationCalls = []; }, outcome);
        await generate.click();
        await page.waitForFunction(() => window.generationCalls.length === 1);
        const busyButtons = page.locator('button[data-option-audio-menu-key="audio-question:first"][data-option-audio-action]');
        assert.ok(await busyButtons.count() >= 8);
        assert.equal(await busyButtons.evaluateAll(buttons => buttons.every(button => button.disabled)), true,
          'all languages and attached-track replace/play/remove actions lock in the busy option');
        // Even a dispatched click must not admit a duplicate operation.
        await generate.dispatchEvent('click');
        assert.equal(await page.evaluate(() => window.generationCalls.length), 1);
        assert.equal(await secondPlay.isEnabled(), true, 'another option is not locked');
        const call = await page.evaluate(() => window.generationCalls[0]);
        assert.deepEqual(call, { action: 'editorOptionT2A', payload: { blockId: 'audio-question', optionId: 'first', target: 'option', language: 'english' } });
        if (shots) await page.screenshot({ path: `${shots}/option-audio-busy-${outcome}-${locale}-${width}.png`, fullPage: false });
        await page.evaluate(() => window.finishGeneration());
        await page.waitForFunction(() => !document.querySelector('[data-option-audio-menu-key="audio-question:first"][data-option-audio-language="english"][data-option-audio-action="generate"]').disabled);
        assert.equal(await attach.isEnabled(), true);
        assert.equal(await busyButtons.evaluateAll(buttons => buttons.every(button => !button.disabled)), true);
      }
      // English text requested in Mandarin opens a real confirmation before
      // any provider call. Cancel must release the same row lock.
      const mandarinGenerate = page.locator('[data-option-audio-menu-key="audio-question:first"][data-option-audio-language="mandarin"][data-option-audio-action="generate"]');
      const callsBeforeCancel = await page.evaluate(() => window.generationCalls.length);
      await mandarinGenerate.click();
      const cancel = page.getByRole('button', { name: await page.evaluate(() => window.cancelLabel), exact: true });
      await cancel.waitFor({ state: 'visible' });
      assert.equal(await generate.isDisabled(), true);
      assert.equal(await attach.isDisabled(), true);
      await cancel.click();
      await page.waitForFunction(() => !document.querySelector('[data-option-audio-menu-key="audio-question:first"][data-option-audio-language="english"][data-option-audio-action="generate"]').disabled);
      assert.equal(await page.evaluate(() => window.generationCalls.length), callsBeforeCancel, 'cancel must not reach the provider');
      assert.equal(await attach.isEnabled(), true);
      await page.locator('details.option-audio-menu[open] .option-audio-menu__close').click();
      await page.locator('summary[data-option-audio-menu-trigger="1"]').nth(1).click();
      await secondPlay.click();
      assert.deepEqual(await page.evaluate(() => window.playedAssets), ['fixture-audio']);
      if (shots) await page.screenshot({ path: `${shots}/option-audio-${locale}-${width}.png`, fullPage: false });
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: busy controls, success/failure/cancel recovery, duplicate guard, independent playback`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
