import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant'])
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let rewrite = 'rose',
        failRewrite = false,
        ready = true;
      await page.exposeFunction('fixtureSignIn', () => {
        ready = true;
      });
      await context.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({
            json:
              path.endsWith('/session') && !ready
                ? { ok: false, error: { code: 'AUTH_REQUIRED' } }
                : path.endsWith('/rewrite')
                  ? failRewrite
                    ? { ok: false, error: { code: 'UPSTREAM_ERROR' } }
                    : { ok: true, result: rewrite }
                  : path.endsWith('/transcriptions')
                    ? { ok: true, result: 'rose' }
                    : {
                        ok: true,
                        data: { user: { sub: 'fixture' }, items: [] },
                      },
          });
        },
      );
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          value: {
            getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          },
          configurable: true,
        });
        window.MediaRecorder = class {
          static isTypeSupported() {
            return true;
          }
          constructor() {
            this.state = 'inactive';
            this.mimeType = 'audio/webm';
          }
          start() {
            this.state = 'recording';
          }
          stop() {
            this.state = 'inactive';
            queueMicrotask(() => {
              this.ondataavailable?.({
                data: new Blob(['fixture'], { type: 'audio/webm' }),
              });
              this.onstop?.();
            });
          }
        };
      });
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(
        async (locale) =>
          (await import('/server/app/i18n/index.js')).setLocale(locale),
        locale,
      );
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(() => {
        window.editorSession.createBlock('question');
        window.editorSession.notifyStateChange();
      });
      await page.locator('#editor-block-editor').fill('Complete the passage.');
      await page
        .locator('#editor-question-input-type')
        .selectOption('fill_in_blanks');
      await page.locator('[name=prompt-placement][value=instructions]').check();
      await page.locator('.confirm-modal__actions button').last().click();
      const passage = page.locator('.editor-blank-passage .tiptap');
      await passage.fill(
        'Plants need water and sunlight.\nGive the plants water.',
      );
      const selectWord = async (word) => {
        await passage.evaluate((el, word) => {
          el.focus();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.parentElement.closest('.editor-blank-mark')) continue;
            const i = node.textContent.indexOf(word);
            if (i >= 0) {
              const r = document.createRange();
              r.setStart(node, i);
              r.setEnd(node, i + word.length);
              const s = getSelection();
              s.removeAllRanges();
              s.addRange(r);
              return;
            }
          }
          throw new Error('Text not found');
        }, word);
        await page.locator('#editor-make-blank').click();
      };
      await selectWord('water');
      await selectWord('sunlight');
      await selectWord('water');
      assert.equal(await passage.locator('.editor-blank-mark').count(), 3);
      const id = await page.evaluate(
        () => window.editorSession.state.selectedBlockId,
      );
      await page.locator('.editor-blank-chips [data-blank-id]').first().click();
      await page.locator('#editor-blank-alternative').fill('rain water');
      await page
        .locator('.editor-blank-settings button')
        .filter({ hasText: locale === 'en' ? 'Add' : '加入' })
        .click();

      // Removing an edited blank restores its current text; Undo restores its metadata.
      assert.match(
        await page.locator('.editor-blank-settings-head').textContent(),
        /1/,
      );
      await page.locator('#editor-blank-answer').fill('river');
      await page
        .locator('.editor-blank-settings')
        .getByRole('button', {
          name: locale === 'en' ? 'Remove blank' : '取消空格',
          exact: true,
        })
        .click();
      await page
        .locator('.confirm-modal')
        .getByRole('button', {
          name: locale === 'en' ? 'Remove blank' : '取消空格',
          exact: true,
        })
        .click();
      assert.equal(await passage.locator('.editor-blank-mark').count(), 2);
      assert.match(await passage.textContent(), /river/);
      await page.locator('.editor-blank-passage [data-command="undo"]').click();
      assert.equal(await passage.locator('.editor-blank-mark').count(), 3);
      await page.locator('.editor-blank-chips [data-blank-id]').first().click();
      assert.equal(
        await page.locator('#editor-blank-answer').inputValue(),
        'river',
      );
      assert.match(
        await page.locator('.editor-blank-settings').textContent(),
        /rain water/,
      );
      await page.locator('#editor-blank-answer').fill('water');
      await page.locator('.editor-blank-chips [data-blank-id]').nth(1).click();
      await page.locator('#editor-blank-checking').selectOption('free');
      await page.locator('#editor-blank-mode').selectOption('word_bank');
      await page.locator('#editor-blank-distractor').fill('sand');
      await page.locator('.editor-blank-add button').click();
      await page.locator('#editor-blank-mode').selectOption('typed');
      await page.evaluate(() => window.editorSession.saveNow());
      await page.reload();
      await page.locator('.editor-blank-mark').first().waitFor();
      assert.equal(await passage.locator('.editor-blank-mark').count(), 3);
      if (shots)
        await page.screenshot({
          path: `${shots}/blank-editor-${locale}-${width}.png`,
          fullPage: true,
        });
      const payload = await page.evaluate(async (id) => {
        const { createWorksheetPackageFromDraft, parseWorksheetPackage } =
          await import('/server/editor/worksheet-package.js');
        const draft = await window.editorSession.saveNow();
        const pkg = createWorksheetPackageFromDraft(draft);
        if (pkg.manifest.packageVersion !== 8)
          throw new Error('Wrong package version');
        const q = parseWorksheetPackage(pkg.bytes).worksheet.blocks.find(
          (b) => b.blockId === id,
        );
        const bank = structuredClone(q);
        bank.prompt = { ...bank.prompt, text: '', format: 'plain_text' };
        delete bank.prompt.document;
        bank.blockId = 'bank';
        bank.position = 1;
        bank.responseConfig.mode = 'word_bank';
        return {
          worksheetId: 'blank-fixture',
          snapshotId: 'blank-snapshot',
          snapshotVersion: 1,
          title: 'Fill in the blanks',
          blocks: [{ ...q, position: 0 }, bank],
        };
      }, id);
      await page.goto(base + '/server/viewer/index.html');
      await page.evaluate(async (payload) => {
        const { viewerStorage } = await import(
          '/server/viewer/storage/index.js'
        );
        const now = new Date().toISOString();
        await viewerStorage.attempts.put({
          localId: 'blank-smoke',
          localAttemptId: 'blank-smoke',
          status: 'in_progress',
          startedAt: now,
          lastActiveBlockId: payload.blocks[0].blockId,
          lastActiveIndex: 0,
          viewerPayload: payload,
          answers: {},
          metadata: {
            localId: 'blank-smoke',
            origin: 'local_source',
            updatedAt: now,
          },
        });
      }, payload);
      await page.goto(
        base + '/server/viewer/index.html?localAttemptId=blank-smoke',
      );
      const typed = page.locator('.viewer-blanks').first(),
        bank = page.locator('.viewer-blanks').nth(1);
      const inputs = typed.locator('input.viewer-blank-input');
      await inputs.first().waitFor();
      const blankLayout = await inputs.first().evaluate((field) => ({
        bottom: field.getBoundingClientRect().bottom,
        captionTop: field
          .closest('[data-blank-id]')
          .querySelector('.viewer-blank-caption')
          .getBoundingClientRect().top,
      }));
      assert.ok(
        blankLayout.bottom <= blankLayout.captionTop + 1,
        'Typed blank must not overlap its counter',
      );
      const ids = await inputs.evaluateAll((nodes) =>
        nodes.map((n) => n.closest('[data-blank-id]').dataset.blankId),
      );
      await inputs.first().fill('A'.repeat(40));
      await inputs.first().focus();
      await inputs.first().press('End');
      await page.evaluate(() => navigator.clipboard.writeText('B'.repeat(20)));
      await page.keyboard.press('ControlOrMeta+v');
      assert.equal(
        await inputs.first().inputValue(),
        'A'.repeat(40) + 'B'.repeat(10),
      );
      assert.match(
        await typed.locator('.viewer-blank-feedback').textContent(),
        /50/,
      );
      await page.keyboard.press('ControlOrMeta+z');
      assert.equal(await inputs.first().inputValue(), 'A'.repeat(40));
      await inputs.first().fill('red flower');
      await inputs.first().evaluate((e) => {
        e.focus();
        e.setSelectionRange(4, 10);
        e.dispatchEvent(new Event('select'));
      });
      const tools = typed.locator('.viewer-blank-trigger');
      const openTool = async (index, action) => {
        await inputs.nth(index).focus();
        await tools.nth(index).click();
        const menu = page.locator('.viewer-blank-menu');
        await menu.getByRole('menuitem', { name: action, exact: true }).click();
      };

      ready = false;
      await page.evaluate(() => {
        window.fixtureLogins = 0;
        window.open = () => {
          window.fixtureLogins++;
          void window.fixtureSignIn();
          return {
            closed: false,
            close() {
              this.closed = true;
            },
          };
        };
      });
      await openTool(0, locale === 'en' ? 'Add by voice' : '用語音加入');
      const auth = page.locator('.read-auth-prompt');
      await auth.waitFor();
      await auth
        .getByRole('button', {
          name: locale === 'en' ? 'Cancel' : '取消',
          exact: true,
        })
        .click();
      assert.equal(await inputs.first().inputValue(), 'red flower');
      assert.equal(
        await typed.locator('.viewer-voice-recovery:visible').count(),
        0,
      );
      await openTool(0, locale === 'en' ? 'Add by voice' : '用語音加入');
      await auth.waitFor();
      await auth
        .getByRole('button', {
          name: locale === 'en' ? 'Sign in' : '登入',
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          window.fixtureLogins === 1 &&
          !Object.keys(window.viewerSession.state.voiceRecovery).length,
      );
      assert.equal(
        await page.evaluate(() => window.viewerSession.voice.active),
        null,
      );
      assert.equal(
        await typed.locator('.viewer-voice-recovery:visible').count(),
        0,
      );
      await inputs.first().evaluate((e) => {
        e.focus();
        e.setSelectionRange(4, 10);
        e.dispatchEvent(new Event('select'));
      });
      await openTool(0, locale === 'en' ? 'Add by voice' : '用語音加入');
      await page.waitForFunction(
        () => window.viewerSession.voice.active?.state === 'recording',
      );
      await page.evaluate(() => window.viewerSession.voice.stop());
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.equal(await inputs.first().inputValue(), 'red rose');
      await openTool(0, locale === 'en' ? 'Undo' : '復原');
      assert.equal(await inputs.first().inputValue(), 'red flower');
      rewrite = 'x'.repeat(55);
      await openTool(1, locale === 'en' ? 'Add by voice' : '用語音加入');
      await page.waitForFunction(
        () => window.viewerSession.voice.active?.state === 'recording',
      );
      await page.evaluate(() => window.viewerSession.voice.stop());
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      const recovery = typed.locator('.viewer-voice-recovery:visible');
      await recovery.locator('textarea').waitFor();
      assert.equal(await inputs.nth(1).inputValue(), '');
      assert.equal(
        await recovery
          .getByRole('button', {
            name: locale === 'en' ? 'Apply answer' : '套用答案',
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await page.evaluate(() => window.viewerSession.autosave());
      await page.reload();
      await recovery.locator('textarea').waitFor();
      assert.equal(
        await recovery.locator('textarea').inputValue(),
        'x'.repeat(55),
      );
      await recovery.locator('textarea').fill('a flower');
      await recovery
        .getByRole('button', {
          name: locale === 'en' ? 'Apply answer' : '套用答案',
          exact: true,
        })
        .click();
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.equal(await inputs.nth(1).inputValue(), 'a flower');

      failRewrite = true;
      await openTool(1, locale === 'en' ? 'Add by voice' : '用語音加入');
      await page.waitForFunction(
        () => window.viewerSession.voice.active?.state === 'recording',
      );
      await page.evaluate(() => window.viewerSession.voice.stop());
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      await typed
        .getByRole('button', {
          name: locale === 'en' ? 'Use recovered text' : '使用復原文字',
          exact: true,
        })
        .click();
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.equal(await inputs.nth(1).inputValue(), 'a flower rose');
      failRewrite = false;
      await inputs.first().fill(' WATER ');
      await inputs.nth(2).fill('water');
      await bank.scrollIntoViewIfNeeded();
      const bankSlots = bank.locator('.viewer-blank-input');
      await bank.locator('[data-word="water"]').dragTo(bankSlots.first());
      assert.equal(await bankSlots.first().textContent(), 'water');
      await bankSlots.first().dragTo(bankSlots.nth(2));
      assert.equal(await bankSlots.first().textContent(), '');
      assert.equal(await bankSlots.nth(2).textContent(), 'water');
      await bankSlots.first().focus();
      await bankSlots.first().press('Enter');
      await bank.locator('[data-word="water"]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await bank.locator('[data-word="water"]').count(), 0);
      await bank.locator('.viewer-blank-clear').first().click();
      assert.equal(await bank.locator('[data-word="water"]').count(), 1);
      await bankSlots.first().click();
      await bank.locator('[data-word="water"]').click();
      await bankSlots.nth(1).click();
      await bank.locator('[data-word="sunlight"]').click();
      assert.equal(await bank.locator('.viewer-blank-trigger').count(), 0);
      assert.equal(
        (await bank.locator('.viewer-blank-caption').allTextContents()).join(
          '',
        ),
        '',
      );
      await page.evaluate(() => window.viewerSession.autosave());
      await page.reload();
      await inputs.first().waitFor();
      assert.equal(await inputs.first().inputValue(), ' WATER ');
      if (shots)
        await page.screenshot({
          path: `${shots}/blank-viewer-${locale}-${width}.png`,
          fullPage: true,
        });
      await page.evaluate(() => window.viewerSession.completeLocalAttempt());
      await page.waitForFunction(
        () => window.viewerSession.state.status === 'completed',
      );
      assert.equal(
        await typed.locator('.viewer-blank-submitted').nth(1).textContent(),
        'a flower rose',
      );
      const result = await page.evaluate(async () => {
        const m = await import('/server/viewer/main.js');
        const s = window.viewerSession;
        const result = m.computeCheckResult(
          s.state.viewerPayload,
          s.state.answers,
        );
        s.state.checkResult = result;
        s.notifyStateChange();
        return result;
      });
      assert.equal(result.correctCount, 5);
      assert.equal(result.totalQuestions, 5);
      assert.equal(
        await typed.locator('[data-result="teacher_review"]').count(),
        1,
      );
      const html = await page.evaluate(async () => {
        const m = await import('/server/viewer/main.js');
        const s = window.viewerSession;
        return m.buildWorksheetPrintReportHtml(
          await m.buildWorksheetPrintReportModel({
            viewerPayload: s.state.viewerPayload,
            answers: s.state.answers,
            checkResult: s.state.checkResult,
          }),
        );
      });
      const print = await context.newPage();
      await print.evaluate(() => {
        window.print = () => {};
        window.close = () => {};
      });
      await print.setContent(html);
      assert.equal(await print.locator('.print-blank').count(), 6);
      assert.match(
        await print.locator('.print-blank-passage').first().textContent(),
        /a flower rose/,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        true,
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `PASS blanks ${locale}/${width}: editor, reopen, v8 package, paste/Undo, voice selection, oversize recovery, word bank, persistence, grading and print`,
      );
    }
} finally {
  await browser.close();
}
