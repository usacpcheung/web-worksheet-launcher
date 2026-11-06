import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8766';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant'])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
          viewport: { width, height: 1000 },
        }),
        page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
      await context.route(
        (u) => u.pathname.startsWith('/api/'),
        (r) =>
          r.fulfill({
            json: { ok: true, data: { items: [], user: { sub: 'fixture' } } },
          })
      );

      await page.addInitScript((l) => localStorage.setItem('worksheetLauncher.locale', l), locale);
      await page.goto(base + '/server/viewer/');
      await page.evaluate(async () => {
        const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
        const now = new Date().toISOString();
        await s.attempts.put({
          localId: 'image-smoke',
          localAttemptId: 'image-smoke',
          status: 'in_progress',
          startedAt: now,
          viewerPayload: {
            worksheetId: 'w',
            snapshotId: 's',
            snapshotVersion: 1,
            title: 'Drawing 圖片作答',
            blocks: [
              {
                blockId: 'q',
                kind: 'question',
                prompt: { text: 'Draw a reading corner. 畫出閱讀角。' },
                responseConfig: { inputType: 'image_response', maxImages: 3 },
              },
            ],
          },
          answers: {},
          metadata: {
            localId: 'image-smoke',
            origin: 'local_source',
            updatedAt: now,
          },
        });
      });
      await page.goto(base + '/server/viewer/?localAttemptId=image-smoke');
      await page.locator('.image-response-add').waitFor();
      const png = Buffer.from(
        await page.evaluate(async () => {
          const c = document.createElement('canvas');
          c.width = 400;
          c.height = 300;
          const g = c.getContext('2d');
          g.fillStyle = '#4b85b9';
          g.fillRect(0, 0, 200, 150);
          const b = await new Promise((r) => c.toBlob(r, 'image/png'));
          return [...new Uint8Array(await b.arrayBuffer())];
        })
      );
      const transparency = await page.evaluate(
        async (data) => {
          const { prepareAnswerImage } = await import('/server/app/prepare-answer-image.js');
          const original = new File([new Uint8Array(data)], 'drawing.png', { type: 'image/png' });
          const unchanged = await prepareAnswerImage(original);
          const large = new File([original, new Uint8Array(2 * 1048576)], 'large.png', { type: 'image/png' });
          const prepared = await prepareAnswerImage(large);
          const bitmap = await createImageBitmap(prepared.blob);
          const canvas = document.createElement('canvas');
          canvas.width = 400;
          canvas.height = 300;
          const g = canvas.getContext('2d');
          g.drawImage(bitmap, 0, 0);
          bitmap.close();
          return {
            unchanged: unchanged.blob === original,
            changed: prepared.changed,
            type: prepared.blob.type,
            size: prepared.blob.size,
            alpha: g.getImageData(399, 299, 1, 1).data[3],
          };
        },
        [...png]
      );
      assert(transparency.unchanged && transparency.changed);
      assert.equal(transparency.type, 'image/png');
      assert.equal(transparency.alpha, 0);
      assert(transparency.size <= 2 * 1048576);
      async function add(buffer = png, mimeType = 'image/png', name = 'drawing.png') {
        const waiting = page.waitForEvent('filechooser');
        await page.locator('.image-response-add').click();
        await (await waiting).setFiles({ name, mimeType, buffer });
      }
      await add();
      await page.waitForFunction(() => viewerSession.state.answers.q?.value?.length === 1);
      assert.equal(await page.locator('.image-response-card').count(), 1);
      await page.reload();
      await page.locator('.image-response-card').waitFor();
      await page.locator('.image-response-open').click();
      await page.locator('.worksheet-image-close svg').waitFor();
      const centered = await page.locator('.worksheet-image-close').evaluate((button) => {
        const b = button.getBoundingClientRect(),
          s = button.querySelector('svg').getBoundingClientRect();
        return (
          Math.abs(b.x + b.width / 2 - s.x - s.width / 2) < 1 &&
          Math.abs(b.y + b.height / 2 - s.y - s.height / 2) < 1
        );
      });
      assert(centered);
      await page.keyboard.press('Escape');
      await add(Buffer.alloc(10 * 1024 * 1024 + 1));
      await page.waitForFunction(() => !viewerSession.imagePending);
      assert.equal(await page.locator('.image-response-card').count(), 1);
      assert.match(await page.locator('.image-response-feedback').innerText(), /10 MB/);
      const jpg = await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 400;
        c.height = 300;
        c.getContext('2d').fillRect(0, 0, 400, 300);
        const b = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
        return [...new Uint8Array(await b.arrayBuffer())];
      });
      const original = await page.evaluate(() => viewerSession.state.answers.q.value[0].assetId);
      const largeJpg = Buffer.concat([Buffer.from(jpg), Buffer.alloc(2 * 1024 * 1024)]);
      const replaceChooser = page.waitForEvent('filechooser');
      await page.locator('[data-edit-image]').first().click();
      await (
        await replaceChooser
      ).setFiles({
        name: 'replacement.jpg',
        mimeType: 'image/jpeg',
        buffer: largeJpg,
      });
      await page.locator('.image-response-candidate').waitFor();
      await page.locator('.image-response-feedback button').first().click();
      await page.waitForFunction(() => !viewerSession.imagePending);
      assert.equal(await page.evaluate(() => viewerSession.state.answers.q.value[0].assetId), original);
      // A failed/stale transaction must persist neither replacement bytes nor references.
      const atomic = await page.evaluate(async () => {
        const s = viewerSession,
          id = s.state.localAttemptId,
          before = await s.storage.attempts.get(id);
        const stale = structuredClone(before);
        stale.answers.q.value = [];
        let saveRejected = false;
        try {
          await s.storage.attempts.put(stale);
        } catch {
          saveRejected = true;
        }
        let commitRejected = false;
        try {
          await s.storage.commitAnswerImages({
            attemptId: id,
            blockId: 'q',
            expected: [],
            next: [{ assetId: 'orphan' }],
            asset: {
              localId: 'orphan',
              binary: new Uint8Array([1]),
              metadata: { localId: 'orphan', ownerAttemptId: id },
            },
            isCurrent: () => true,
          });
        } catch {
          commitRejected = true;
        }
        const after = await s.storage.attempts.get(id);
        return {
          saveRejected,
          commitRejected,
          noOrphan: !(await s.storage.localAssets.get('orphan')),
          unchanged: JSON.stringify(after.answers) === JSON.stringify(before.answers),
        };
      });
      assert.deepEqual(atomic, {
        saveRejected: true,
        commitRejected: true,
        noOrphan: true,
        unchanged: true,
      });
      await add(Buffer.concat([Buffer.from(jpg), Buffer.alloc(2 * 1024 * 1024)]), 'image/jpeg', 'photo.jpg');
      await page.locator('.image-response-candidate').waitFor();
      await page.locator('.image-response-feedback .image-response-add').click();
      await page.waitForFunction(
        () => viewerSession.state.answers.q?.value?.length === 2 && !viewerSession.imagePending
      );
      await add();
      await page.waitForFunction(() => viewerSession.state.answers.q?.value?.length === 3);
      assert(await page.locator('.image-response-add').isDisabled());
      await page.locator('[data-edit-image]').nth(1).click();
      await page.locator('.image-response-confirm .confirm-modal__btn--destructive').click();
      await page.waitForFunction(
        () => viewerSession.state.answers.q.value.length === 2 && !viewerSession.imagePending
      );
      await add();
      await page.waitForFunction(
        () => viewerSession.state.answers.q.value.length === 3 && !viewerSession.imagePending
      );
      if (process.env.VIEWER_SMOKE_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/image-response-${locale}-${width}.png`,
          fullPage: true,
        });
      const roundtrip = await page.evaluate(async () => {
        const old = viewerSession.state.answers.q.value.map((r) => r.assetId);
        const zip = await viewerSession.buildUploadedAttemptPackage();
        await viewerSession.importAttemptPackageFromFile(zip.bytes);
        await viewerSession.storage.attempts.remove('image-smoke');
        for (const id of old)
          if (await viewerSession.storage.localAssets.get(id)) throw new Error('Owned image was not removed');
        return {
          version: zip.manifest.packageVersion,
          old,
          next: viewerSession.state.answers.q.value.map((r) => r.assetId),
          present: await Promise.all(
            viewerSession.state.answers.q.value.map(
              async (r) => !!(await viewerSession.storage.localAssets.get(r.assetId))?.binary
            )
          ),
        };
      });
      assert.equal(roundtrip.version, 4);
      assert.equal(roundtrip.next.length, 3);
      assert(roundtrip.next.every((id) => !roundtrip.old.includes(id)));
      assert(roundtrip.present.every(Boolean));
      await page.evaluate(async () => {
        viewerSession.state.studentNameResolved = true;
        await viewerSession.completeLocalAttempt();
      });
      await page.waitForFunction(
        () =>
          !document.querySelector('.image-response-add') ||
          document.querySelector('.image-response-add').hidden
      );
      assert.equal(await page.locator('[data-edit-image]:visible').count(), 0);
      await context.unrouteAll({ behavior: 'wait' });
      await page.evaluate(() => {
        const open = window.open.bind(window);
        window.open = (...args) => {
          const p = open(...args);
          p.print = () => {
            p.didPrint = true;
          };
          p.close = () => {};
          return p;
        };
      });
      const popup = page.waitForEvent('popup');
      await page.locator('[aria-describedby="viewer-print-hint"]').click();
      const printed = await popup;
      await printed.waitForFunction(() => window.didPrint, {}, { timeout: 10000 });
      assert.equal(await printed.locator('[data-answer-image]').count(), 3);
      await printed.close();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      console.log('PASS image attach/prepare/reload/package/print', locale, width);
      await context.close();
    }
} finally {
  await browser.close();
}
