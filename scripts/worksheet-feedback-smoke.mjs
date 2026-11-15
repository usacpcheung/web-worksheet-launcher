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
        const s = window.editorSession;
        s.createBlock('question');
        s.state.draft.blocks = s.state.draft.blocks.filter(
          (b) => b.blockId === s.state.selectedBlockId,
        );
        s.state.draft.blocks[0].position = 0;
        s.notifyStateChange();
      });
      await page
        .locator('#editor-block-editor')
        .fill('Explain what you learned.');
      await page.locator('#editor-feedback-nav').click();
      assert.equal(
        await page.locator('#editor-feedback-enabled').isChecked(),
        false,
      );
      await page.locator('#editor-feedback-enabled').check();
      await page.evaluate(() => {
        const list = document.querySelector('.block-list');
        window.feedbackSidebarRows = [...list.children];
        window.feedbackSidebarMutations = [];
        window.feedbackSidebarObserver = new MutationObserver(records => {
          window.feedbackSidebarMutations.push(...records.map(record => record.type));
        });
        window.feedbackSidebarObserver.observe(list, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
        });
      });
      await page
        .locator('[data-feedback-target]')
        .pressSequentially('I can explain my ideas.', { delay: 5 });
      await page.locator('#editor-feedback-add-target').click();
      await page
        .locator('[data-feedback-target]')
        .last()
        .fill('I can listen to others.');
      await page.locator('#editor-feedback-student-limit').fill('50');
      await page
        .locator('#editor-feedback-student-prompt')
        .fill('What went well?');
      const draftId = await page.evaluate(async () => {
        await window.editorSession.saveNow();
        return window.editorSession.state.draft.localId;
      });
      assert.deepEqual(await page.evaluate(() => {
        window.feedbackSidebarObserver.disconnect();
        const rows = [...document.querySelector('.block-list').children];
        return {
          stable: rows.length === window.feedbackSidebarRows.length && rows.every((row, i) => row === window.feedbackSidebarRows[i]),
          mutations: window.feedbackSidebarMutations,
          selected: document.querySelectorAll('.block-list .selected').length,
        };
      }), { stable: true, mutations: [], selected: 0 }, 'Feedback typing and saving must not rebuild or flash question rows');
      await page.locator('.block-list .block-select').first().click();
      assert.equal(await page.locator('.block-list .selected').count(), 1);
      assert.equal(await page.locator('#editor-block-editor').isVisible(), true);
      await page.reload();
      await page.locator('#editor-feedback-nav').click();
      assert.equal(await page.locator('[data-feedback-target]').count(), 2);
      assert.equal(
        await page.locator('#editor-feedback-student-limit').inputValue(),
        '50',
      );
      assert.equal(
        await page.locator('.block-list + #editor-feedback-nav').count(),
        1,
      );
      assert.equal(
        await page.locator('.editor-activity-panel').getAttribute('open'),
        null,
      );
      await page.evaluate(async () => {
        const s = window.editorSession,
          m = await import('/server/editor/worksheet-package.js');
        const pkg = m.createWorksheetPackageFromDraft(s.state.draft);
        if (pkg.manifest.packageVersion !== 9)
          throw Error('Feedback package version');
        const parsed = m.parseWorksheetPackage(pkg.bytes);
        if (parsed.worksheet.feedback.targets.length !== 2)
          throw Error('Lost settings');
      });
      if (shots)
        await page.screenshot({
          path: `${shots}/feedback-editor-${locale}-${width}.png`,
          fullPage: true,
        });
      await page.locator('.stacked-actions button').last().click();
      await page
        .waitForFunction(() => window.viewerSession?.state.viewerPayload)
        .catch(async (error) => {
          console.error(
            page.url(),
            errors,
            await page.locator('body').innerText(),
          );
          throw error;
        });
      assert.equal(
        await page.locator('#viewer-feedback-section').isVisible(),
        false,
      );
      assert.equal(
        await page.locator('#viewer-feedback-nav').isVisible(),
        false,
      );
      await page
        .locator('.question-card textarea:not([readonly])')
        .first()
        .fill('My answer stays locked.');
      if (width === 390) await page.locator('.viewer-actions-launcher').click();
      await page.locator('.viewer-primary-actions button').nth(1).click();
      await page.waitForFunction(
        () =>
          window.viewerSession.state.status === 'completed' &&
          !window.viewerSession.state.isFinalizing,
      );
      assert.equal(
        await page.locator('#viewer-feedback-section').isVisible(),
        true,
      );
      assert.equal(
        await page.locator('.viewer-feedback-reminder').isVisible(),
        width === 390,
      );
      const rating = page.locator('[data-feedback-rating]').first();
      await rating.focus();
      await page.keyboard.press('End');
      assert.equal(
        await page
          .locator('[data-feedback-rating][aria-checked=true]')
          .first()
          .getAttribute('aria-label'),
        locale === 'en' ? '5 out of 5 stars' : '5 星（滿分 5 星）',
      );
      const input = page.locator('#viewer-feedback-student'),
        field = page.locator('.feedback-text-section').first();
      await input.fill('I learned to explain.');
      await input.fill('x'.repeat(51));
      assert.equal(await input.inputValue(), 'I learned to explain.');
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
      await field.locator('.question-card__voice-btn').click();
      const auth = page.locator('.read-auth-prompt');
      await auth.waitFor();
      await auth
        .getByRole('button', {
          name: locale === 'en' ? 'Cancel' : '取消',
          exact: true,
        })
        .click();
      assert.equal(await input.inputValue(), 'I learned to explain.');
      await field.locator('.question-card__voice-btn').click();
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
        await field.locator('.viewer-voice-recovery:visible').count(),
        0,
      );
      await field.locator('.question-card__voice-btn').click();
      await page.waitForFunction(
        () => window.viewerSession.voice.active?.state === 'recording',
      );
      await page.evaluate(() => window.viewerSession.voice.stop());
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.match(await input.inputValue(), /rose/);
      await field.locator('.question-card__undo-btn').click();
      assert.equal(await input.inputValue(), 'I learned to explain.');
      rewrite = 'A clear reflection.';
      await field.locator('.question-card__rewrite-btn').click();
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.equal(await input.inputValue(), 'A clear reflection.');
      await field.locator('.question-card__undo-btn').click();
      failRewrite = true;
      await field.locator('.question-card__voice-btn').click();
      await page.waitForFunction(
        () => window.viewerSession.voice.active?.state === 'recording',
      );
      await page.evaluate(() => window.viewerSession.voice.stop());
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.equal(
        await field.locator('.viewer-voice-recovery').isVisible(),
        true,
      );
      const attemptId = await page.evaluate(async () => {
        await window.viewerSession.autosave();
        return window.viewerSession.state.localAttemptId;
      });
      // The source may be edited or removed; the attempt still owns its feedback snapshot.
      await page.evaluate(async (draftId) => {
        const { viewerStorage } = await import(
          '/server/viewer/storage/index.js'
        );
        const d = await viewerStorage.drafts.get(draftId);
        d.feedback.targets[0].text = 'Changed source';
        await viewerStorage.drafts.put(d);
      }, draftId);
      await page.goto(
        base +
          '/server/viewer/index.html?localAttemptId=' +
          encodeURIComponent(attemptId),
      );
      await input.waitFor();
      assert.equal(
        await field.locator('.viewer-voice-recovery').isVisible(),
        true,
      );
      assert.match(
        await page.locator('.feedback-target-title').first().innerText(),
        /I can explain/,
      );
      assert.equal(await input.inputValue(), 'I learned to explain.');
      failRewrite = false;
      rewrite = 'Recovered reflection.';
      await field
        .locator('.viewer-voice-recovery')
        .getByRole('button', {
          name: locale === 'en' ? 'Retry rewrite' : '重試改寫',
          exact: true,
        })
        .click();
      await page.waitForFunction(() => !window.viewerSession.voice.active);
      assert.match(await input.inputValue(), /Recovered reflection/);
      const exported = await page.evaluate(async () => {
        const s = window.viewerSession,
          m = await import('/server/viewer/main.js');
        const pkg = await s.buildUploadedAttemptPackage();
        if (pkg.manifest.packageVersion !== 8) throw Error('Attempt version');
        const html = m.buildWorksheetPrintReportHtml(
          await m.buildWorksheetPrintReportModel({
            viewerPayload: s.state.viewerPayload,
            answers: s.state.answers,
            feedback: s.state.feedback,
          }),
        );
        return { bytes: [...pkg.bytes], html, answers: s.state.answers };
      });
      assert.equal(Object.keys(exported.answers).length, 1);
      assert.equal(
        Object.values(exported.answers)[0].value,
        'My answer stays locked.',
      );
      assert.match(exported.html, /print-feedback/);
      assert.match(exported.html, /Recovered reflection/);
      assert.match(exported.html, /★★★★★/);
      await page.evaluate(async (bytes) => {
        const s = window.viewerSession;
        const result = await s.importAttemptPackageFromFile(
          new Uint8Array(bytes),
        );
        if (result?.ok === false) throw Error('Import failed');
      }, exported.bytes);
      const importedId = await page.evaluate(
        () => window.viewerSession.state.localAttemptId,
      );
      await page.goto(
        base +
          '/server/viewer/index.html?localAttemptId=' +
          encodeURIComponent(importedId),
      );
      await input.waitFor();
      assert.match(await input.inputValue(), /Recovered reflection/);
      assert.equal(
        await page.locator('[data-feedback-rating][aria-checked=true]').count(),
        1,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      if (shots)
        await page.screenshot({
          path: `${shots}/feedback-viewer-${locale}-${width}.png`,
          fullPage: true,
        });
      // All categories and long targets must still fit the smallest supported layout.
      await page.evaluate(() => {
        const s = window.viewerSession;
        const payload = structuredClone(s.state.viewerPayload);
        payload.feedback.categories = ['student', 'teacher', 'peer'];
        payload.feedback.targets[0].text = 'Long target '.repeat(16);
        s.state.viewerPayload = payload;
        s.notifyStateChange();
      });
      await page.setViewportSize({ width: 320, height: 800 });
      assert.ok(await page.evaluate(() => {
        const body = document.querySelector('.viewer-feedback-body');
        return body.scrollWidth <= body.clientWidth + 1;
      }), 'Feedback must not overflow at 320px');
      // Legacy and explicitly disabled configurations expose no post-submit UI.
      for (const legacy of [false, true]) {
        await page.evaluate((legacy) => {
          const s = window.viewerSession;
          if (legacy) delete s.state.viewerPayload.feedback;
          else s.state.viewerPayload.feedback.enabled = false;
          s.notifyStateChange();
        }, legacy);
        assert.equal(await page.locator('#viewer-feedback-section').isVisible(), false);
        assert.equal(await page.locator('.viewer-feedback-reminder').isVisible(), false);
        assert.equal(await page.locator('#viewer-feedback-nav').isVisible(), false);
      }
      assert.deepEqual(errors, []);
      console.log('PASS feedback', locale, width);
      await context.close();
    }
} finally {
  await browser.close();
}
