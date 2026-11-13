// Isolated local fixtures; no login, microphone or provider services are used.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant'])
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (e) => {
        if (e.type() === 'error') errors.push(e.text());
      });
      let paidRequests = 0;
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => {
          if (/rewrite|transcriptions/.test(route.request().url())) paidRequests++;
          return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } });
        }
      );
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(
        async (locale) => (await import('/server/app/i18n/index.js')).setLocale(locale),
        locale
      );
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(() => {
        const session = window.editorSession;
        session.state.draft.blocks = [];
        session.createBlock('question');
        session.updateTitle('Long text practice · 長文字練習');
        session.updateBlockContent(
          session.state.selectedBlockId,
          'Paste a prompt or conversation.\n貼上提示詞或對話內容。'
        );
        session.notifyStateChange();
      });
      const toggle = page.locator('#editor-question-long-text');
      const limit = page.locator('#editor-question-max-length');
      const checkTextSettingsLayout = async () => {
        const lengthLabel = await page.locator('label[for="editor-question-max-length"]').boundingBox();
        const formatLabel = await page.locator('#editor-question-text-display-mode-label').boundingBox();
        const input = await limit.boundingBox();
        const format = await page.locator('.text-answer-settings .answer-toggle').boundingBox();
        if (width > 1100) {
          assert.ok(Math.abs(lengthLabel.y - formatLabel.y) < 1, 'Text-setting labels align even with validation feedback');
          assert.ok(Math.abs(input.y - format.y) < 1, 'Length and format controls share the same row');
        } else {
          assert.ok(formatLabel.y >= input.y + input.height, 'Text settings stack without overlap');
        }
        assert.ok(format.x >= 0 && format.x + format.width <= width, 'Format controls stay in the viewport');
      };
      assert.equal(await limit.getAttribute('max'), '1200');
      await checkTextSettingsLayout();
      assert.equal(await page.locator('[data-text-limit-error]').isVisible(), false, 'Empty validation feedback takes no space');
      if (shots) await page.locator('.answer-section').screenshot({ path: `${shots}/text-settings-${locale}-${width}.png` });
      await limit.fill('1201');
      assert.equal(await limit.getAttribute('aria-invalid'), 'true');
      assert.ok(await page.locator('[data-text-limit-error]').innerText());
      await checkTextSettingsLayout();
      await toggle.check();
      assert.equal(await limit.inputValue(), '20000');
      assert.equal(await limit.getAttribute('max'), '20000');
      assert.equal(await limit.getAttribute('aria-invalid'), 'false');
      await limit.fill('15000');
      await toggle.click();
      const modal = page.locator('.confirm-modal:visible');
      await modal.waitFor();
      const cancel = locale === 'en' ? 'Cancel' : '取消';
      await modal.getByRole('button', { name: cancel, exact: true }).click();
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await limit.inputValue(), '15000');
      await toggle.click();
      // Autosave replaces the draft object while confirmation is open. Unchanged
      // content must remain confirmable without relying on object identity.
      assert.equal(
        await page.evaluate(async () => {
          const previous = window.editorSession.state.draft;
          await window.editorSession.autosave();
          return previous !== window.editorSession.state.draft;
        }),
        true
      );
      await modal
        .getByRole('button', {
          name: locale === 'en' ? 'Switch to standard text' : '切換為一般文字',
          exact: true,
        })
        .click();
      assert.equal(await limit.inputValue(), '1200');
      await toggle.check();
      await page.evaluate(async () => window.editorSession.saveNow());
      await page.reload();
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), true, 'Mode survives editor reload');
      assert.equal(await limit.inputValue(), '20000');
      if (shots) {
        await toggle.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/long-text-editor-${locale}-${width}.png` });
      }
      const openViewer = await page.evaluate(async () =>
        (await import('/server/app/i18n/index.js')).t('editor.actions.openViewer')
      );
      await page.getByRole('button', { name: openViewer, exact: true }).click();
      const field = page.locator(
        '.question-card--long-text .viewer-answer-area > textarea:not(.question-card__review-status)'
      );
      await field.waitFor();
      assert.equal(
        await page
          .locator('.question-card__voice-btn, .question-card__rewrite-btn, .question-card__undo-btn')
          .count(),
        0
      );
      assert.equal(await field.getAttribute('maxlength'), null, 'No silent native paste clipping');
      const paste = async (text) =>
        field.evaluate((element, text) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', text);
          const allowed = element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
          );
          if (allowed) {
            element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end');
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
          }
          return allowed;
        }, text);
      const sample =
        '  User: Explain this example.\n\n  使用者：請解釋這個例子。\n  Assistant: <b>plain text</b>\n\n' +
        'Conversation 對話\n'.repeat(250);
      await field.focus();
      assert.equal(await paste(sample), true);
      assert.equal(await field.inputValue(), sample);
      assert.equal(await paste('x'.repeat(20000)), false);
      assert.equal(await field.inputValue(), sample);
      assert.ok(await page.locator('.question-card .input-error').innerText());
      // Selection replacement is measured against the resulting full answer.
      await field.evaluate((el) => el.select());
      assert.equal(await paste('中'.repeat(20000)), true);
      assert.equal((await field.inputValue()).length, 20000);
      assert.equal(await paste('x'), false);
      // IME input remains intact during composition and is rejected only at the end.
      await field.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value += '中文';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      assert.equal((await field.inputValue()).length, 20002);
      await field.dispatchEvent('compositionend');
      assert.equal((await field.inputValue()).length, 20000);
      await field.fill(sample);
      assert.equal(await page.locator('.question-card .input-error').innerText(), '');
      const attemptId = await page.evaluate(async () => {
        await window.viewerSession.autosave();
        return window.viewerSession.state.localAttemptId;
      });
      await page.goto(base + '/server/viewer/index.html?localAttemptId=' + encodeURIComponent(attemptId));
      await field.waitFor();
      assert.equal(
        await field.inputValue(),
        sample,
        'Local resume preserves newlines, indentation and complete answer'
      );
      const area = await page.locator('.question-card--long-text .viewer-answer-area').boundingBox();
      const prompt = await page.locator('.question-card--long-text .question-card__prompt-row').boundingBox();
      // Full-width answer is below the prompt, including on desktop.
      if (prompt) assert.ok(area.y >= prompt.y + prompt.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(
        await page.evaluate(
          async () =>
            (
              await window.viewerSession.voice.run(window.viewerSession.state.lastActiveBlockId, {
                mode: 'rewrite',
              })
            ).ok
        ),
        false
      );
      if (shots) {
        await field.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/long-text-viewer-${locale}-${width}.png` });
      }
      await page.evaluate(async () => window.viewerSession.completeLocalAttempt());
      await page.waitForFunction(() => window.viewerSession.state.status === 'completed');
      assert.equal(await field.evaluate((el) => el.readOnly && !el.disabled), true);
      assert.equal(await field.inputValue(), sample);
      assert.equal(await page.locator('.question-card__text-footer').isVisible(), false);
      assert.equal(paidRequests, 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(
    'Long text: editor toggle/caps, confirmation, bilingual responsive viewer, paste/IME, local resume and completed review passed.'
  );
} finally {
  await browser.close();
}
