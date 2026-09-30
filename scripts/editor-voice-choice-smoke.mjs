// Real editor/client, isolated storage and mocked bridge responses. No paid calls.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ROLEPLAYSCENE_T2A_PRESETS } from '../server/roleplayscene/scripts/t2a-presets.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const choices = { cantonese: 'cantonese_narrator_female', mandarin: 'mandarin_narrator_female', english: 'english_narrator_female' };
// MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo; zero coefficients produce silence.
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const audio = Buffer.concat(Array.from({ length: 40 }, () => frame));
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const requests = [];
      let behavior = 'success', pending, resolveHeld;
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        if (new URL(route.request().url()).pathname === '/api/rewrite-bridge/t2a') {
          assert.equal(route.request().method(), 'POST');
          requests.push(route.request().postDataJSON());
          if (behavior === 'hold') { pending = route; resolveHeld(); return; }
          if (behavior === 'failure') return route.fulfill({ status: 422, json: { ok: false, error: { code: 'VOICE_CHOICE_UNSUPPORTED', message: 'Synthetic choice rejection' } } });
          return route.fulfill({ contentType: 'audio/mpeg', body: audio });
        }
        return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } });
      });
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      assert.match(await page.title(), /Worksheet/i);
      assert.match(await page.locator('body').innerText(), /Worksheet|工作紙/i);
      await page.evaluate(async () => {
        const session = window.editorSession;
        session.state.draft.title = 'Narrator fixture';
        session.state.draft.assets = [];
        session.state.draft.blocks = [{ blockId: 'voice-question', kind: 'question', position: 0,
          prompt: { text: '題目內容 Prompt', format: 'plain_text', audioTracks: [] },
          responseConfig: { inputType: 'multiple_choice', options: [{ id: 'first', value: 'A', label: '答案內容 Answer', audioTracks: [] }], correctAnswer: 'A' } }];
        session.state.selectedBlockId = 'voice-question';
        session.notifyStateChange();
        await session.saveNow();
      });
      const promptGenerate = language => page.locator(`[data-prompt-audio-track-language="${language}"] [data-audio-track-action="generate"]`);
      const clickPromptGenerate = async language => {
        if (await promptGenerate(language).isVisible()) return promptGenerate(language).click();
        const row = page.locator(`[data-prompt-audio-track-language="${language}"]`);
        await row.locator('.audio-track-more-menu__toggle').click();
        await row.locator('[data-audio-track-overflow-action="generate"]').click();
      };
      const optionGenerate = language => page.locator(`[data-option-audio-menu-key="voice-question:first"][data-option-audio-language="${language}"][data-option-audio-action="generate"]`);
      const openOptionMenu = async language => {
        const menu = page.locator('details.option-audio-menu');
        if (!await menu.evaluate(el => el.open)) await menu.locator('summary[data-option-audio-menu-trigger="1"]').click();
        const more = menu.locator('details.audio-track-more-menu').filter({ has: optionGenerate(language) });
        if (await more.count() && !await more.evaluate(el => el.open)) await more.locator('summary').click();
      };
      const closeOptionMenu = async () => {
        const open = page.locator('details.option-audio-menu[open]');
        if (await open.count()) await open.locator('.option-audio-menu__close').click();
      };
      const waitIdle = async () => page.waitForFunction(() => !document.querySelector('[data-prompt-audio-track-language="english"] [data-audio-track-action="generate"]').disabled
        && !document.querySelector('[data-option-audio-language="english"][data-option-audio-action="generate"]').disabled);
      const attachments = () => page.evaluate(() => {
        const session = window.editorSession, block = session.state.draft.blocks[0];
        return { prompt: block.prompt.audioTracks, option: block.responseConfig.options[0].audioTracks, assets: session.state.draft.assets };
      });
      const confirmReplace = () => page.locator('.confirm-modal__actions button').last().click();
      for (const [language, voice_choice] of Object.entries(choices)) {
        for (const target of ['prompt', 'option']) {
          if (target === 'option') await openOptionMenu(language);
          const count = requests.length;
          if (target === 'prompt') await clickPromptGenerate(language);
          else await optionGenerate(language).click();
          try {
            await page.waitForFunction(({ target, language }) => {
              const block = window.editorSession.state.draft.blocks[0];
              return (target === 'prompt' ? block.prompt.audioTracks : block.responseConfig.options[0].audioTracks).some(track => track.language === language);
            }, { target, language });
          } catch (error) {
            console.error({ locale, width, target, language, requests, notifications: await page.evaluate(() => window.editorSession.state.notifications) });
            if (shots) await page.screenshot({ path: `${shots}/failure-${locale}-${width}.png` });
            throw error;
          }
          await waitIdle();
          assert.equal(requests.length, count + 1);
          assert.deepEqual(requests.at(-1), { text: target === 'prompt' ? '題目內容 Prompt' : '答案內容 Answer', format: 'mp3', response_mode: 'binary', voice_choice });
          if (target === 'option') await closeOptionMenu();
        }
      }
      const original = await attachments();
      for (const target of ['prompt', 'option']) {
        assert.deepEqual(original[target].map(track => track.voicePresetId), ['cantonese', 'mandarin', 'english']);
      }
      assert.equal(original.assets.length, 6);

      // Cancellation and bridge rejection must leave every existing attachment intact.
      let count = requests.length;
      await clickPromptGenerate('english');
      await page.locator('.confirm-modal__actions button').first().click();
      await waitIdle();
      assert.equal(requests.length, count);
      assert.deepEqual(await attachments(), original);
      behavior = 'failure';
      await openOptionMenu('english');
      await optionGenerate('english').click();
      await confirmReplace();
      await waitIdle();
      assert.equal(requests.length, count + 1);
      assert.deepEqual(await attachments(), original);
      assert.equal(await page.evaluate(() => window.editorSession.state.notifications.some(item => item.text.includes('Synthetic choice rejection'))), true);
      await closeOptionMenu();

      // A real in-flight response may not overwrite audio after the source changes.
      const held = new Promise(resolve => { resolveHeld = resolve; });
      behavior = 'hold'; count = requests.length;
      await clickPromptGenerate('english');
      await confirmReplace();
      await page.waitForFunction(() => document.querySelector('[data-prompt-audio-track-language="english"] [data-audio-track-action="generate"]').disabled);
      await held;
      assert.equal(requests.length, count + 1);
      await promptGenerate('english').dispatchEvent('click');
      assert.equal(requests.length, count + 1, 'duplicate clicks must not start another request');
      await page.evaluate(() => window.editorSession.updateBlockContent('voice-question', '改動 Changed'));
      await pending.fulfill({ contentType: 'audio/mpeg', body: audio });
      pending = null; behavior = 'success';
      await waitIdle();
      assert.deepEqual(await attachments(), original);
      await page.evaluate(() => window.editorSession.updateBlockContent('voice-question', '題目內容 Prompt'));
      if (shots) await page.screenshot({ path: `${shots}/editor-voice-choice-${locale}-${width}.png`, fullPage: false });

      // Exercise the real ZIP export/import and shared viewer storage with generated bytes.
      const imported = await page.evaluate(async () => {
        const session = window.editorSession;
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        const bytes = await session.buildCurrentDraftPackageZipBytes();
        const parsed = parseWorksheetPackage(bytes);
        const result = await session.importWorksheetPackageFile(new File([bytes], 'narration.zip', { type: 'application/zip' }), { convertToEditableDraft: true });
        if (result.canceled) throw new Error('Unexpected import cancellation');
        await session.saveNow();
        const block = session.state.draft.blocks[0];
        return { localId: session.state.draft.localId, prompt: block.prompt.audioTracks, option: block.responseConfig.options[0].audioTracks,
          manifest: parsed.manifest, packaged: parsed.worksheet.blocks[0], binaryCount: parsed.assets.length };
      });
      assert.equal(imported.binaryCount, 6);
      assert.equal(imported.manifest.assets.every(asset => asset.mimeType === 'audio/mpeg'), true);
      for (const target of ['prompt', 'option']) {
        assert.deepEqual(imported[target].map(track => [track.language, track.voicePresetId]), Object.keys(choices).map(language => [language, language]));
      }
      assert.equal(JSON.stringify(imported.packaged).includes('voice_choice'), false);
      await page.goto(base + '/server/viewer/index.html?preview=1&localDraftId=' + encodeURIComponent(imported.localId));
      await page.locator('[data-viewer-audio-control="question"]').waitFor();
      for (const target of ['question', 'option']) {
        const control = page.locator(`[data-viewer-audio-control="${target}"]`).first();
        for (const language of Object.keys(choices)) {
          await control.locator('.viewer-audio-control__trigger').click();
          await control.locator(`[data-audio-language="${language}"]`).click();
          await page.waitForFunction(() => window.viewerSession.activeAudio && !window.viewerSession.activeAudio.paused);
          await page.evaluate(() => window.viewerSession.stopActiveAudio());
        }
      }
      if (shots) await page.screenshot({ path: `${shots}/viewer-narration-${locale}-${width}.png`, fullPage: false });

      // The shared client must continue supporting RolePlayScene's unchanged raw presets.
      page.on('dialog', dialog => dialog.accept());
      await page.goto(base + '/server/roleplayscene/index.html');
      await page.locator('#file-input').setInputFiles({ name: 'dialogue.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        meta: { title: 'Raw voice fixture' }, scenes: [
          { id: 'start', type: 'start', dialogue: [{ text: '你好 Dialogue' }], choices: [{ id: 'next', label: 'Next', nextSceneId: 'end' }] },
          { id: 'end', type: 'end', dialogue: [], choices: [] },
        ],
      })) });
      await page.locator('#import-confirm-accept').click();
      await page.locator('#import-confirm-overlay').waitFor({ state: 'hidden' });
      for (const preset of ROLEPLAYSCENE_T2A_PRESETS) {
        await page.locator('.dialogue-t2a-controls__preset select').first().selectOption(preset.id);
        count = requests.length;
        const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/rewrite-bridge/t2a');
        await page.locator('.dialogue-t2a-controls button').first().click();
        await request;
        await page.waitForFunction(() => !document.querySelector('.dialogue-t2a-controls button').disabled);
        assert.equal(requests.length, count + 1);
        assert.deepEqual(requests.at(-1), { text: '你好 Dialogue', format: 'mp3', response_mode: 'binary', ...preset.options });
      }
      assert.deepEqual(pageErrors, []);
      // Chromium logs the deliberately injected HTTP rejection as a resource error.
      assert.deepEqual(errors.filter(message => message !== 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)'), []);
      console.log(`PASS ${locale} ${width}: six named requests, cancel/rejection/stale safety, ZIP round trip, six real viewer playbacks, five RolePlayScene raw requests`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
