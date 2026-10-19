// Network-isolated acceptance of login preparation; no production resources.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
try {
  for (const area of ['editor', 'viewer', 'roleplayscene']) for (const locale of ['en', 'zh-Hant']) for (const recovery of ['popup', 'same-tab']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      let signedIn = false, posts = 0;
      await page.addInitScript(({locale, recovery}) => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        window.open = () => recovery === 'popup' ? { closed: false } : null;
      }, {locale, recovery});
      await page.route(url => url.pathname.startsWith('/api/'), route => {
        const request = route.request();
        if (request.method() === 'POST' || request.method() === 'DELETE') {
          posts++;
          // A definite permission rejection has no receipt lookup or login retry.
          return route.fulfill({ status: 403, json: { ok: false, error: { code: 'FORBIDDEN' } } });
        }
        const session = new URL(request.url()).pathname.endsWith('/session');
        return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn
          ? { ok: true, data: session ? { ready: true, user: { sub: 'qa' } } : { items: [] } }
          : { ok: false, error: { code: 'AUTH_REQUIRED' } } });
      });
      await page.goto(`${base}/server/${area}/`);
      if (area === 'viewer') {
        await page.evaluate(async () => {
          const { viewerStorage } = await import('/server/viewer/storage/index.js');
          const now = new Date().toISOString();
          await viewerStorage.attempts.put({ localId: 'mutation-qa', localAttemptId: 'mutation-qa', status: 'in_progress', startedAt: now,
            viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', title: 'Auth fixture', blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] },
            answers: { q1: { value: 'Keep this answer' } }, metadata: { localId: 'mutation-qa', origin: 'local_source', updatedAt: now } });
        });
        await page.goto(`${base}/server/viewer/?localAttemptId=mutation-qa`);
      }
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const clickUpload = async () => {
        if (area === 'editor') {
          await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
          await page.getByRole('button', { name: await label('editor.server.uploadDraft'), exact: true }).click();
        } else if (area === 'viewer') {
          await page.getByRole('button', { name: await label('viewer.upload.saveAttemptAriaLabel'), exact: true }).click();
        } else {
          const save = page.locator('#server-save-btn');
          if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
          await save.click();
        }
      };
      const prompt = page.locator('.read-auth-prompt');
      await clickUpload(); await prompt.waitFor(); assert.equal(posts, 0);
      await prompt.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await prompt.waitFor({state: 'detached'});
      assert.equal(posts, 0);
      await clickUpload(); await prompt.waitFor();
      if (recovery === 'popup') signedIn = true;
      await prompt.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).click();
      if (recovery === 'same-tab') {
        const sameTab = prompt.getByRole('button', { name: await label('readAuth.sameTab'), exact: true });
        await sameTab.waitFor(); signedIn = true;
        await Promise.all([page.waitForNavigation(), sameTab.click()]);
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('readAuthReturn'));
        await page.waitForFunction(text => document.body.innerText.includes(text), await label('mutationAuth.returned')).catch(async error => { console.log('RETURN DIAGNOSTIC', await page.evaluate(() => ({url:location.href, text:document.body.innerText.slice(0,6000), message:window.viewerSession?.state.recoveryMessage, pending:window.viewerSession?._readAuthReturn, id:window.viewerSession?.state.localAttemptId}))); throw error; });
        assert.equal(posts, 0, 'same-tab return never submits');
        await clickUpload();
      } else {
        const confirm = prompt.getByRole('button', { name: await label('mutationAuth.upload'), exact: true });
        await confirm.waitFor(); assert.equal(posts, 0, 'login success is not authorization');
        if (locale === 'en') await confirm.click();
        else {
          await prompt.getByRole('button', {name: await label('common.actions.cancel'), exact: true}).click();
          await prompt.waitFor({state:'detached'}); assert.equal(posts, 0);
          await clickUpload();
        }
      }
      for (let i = 0; posts === 0 && i < 100; i++) await page.waitForTimeout(50);
      assert.equal(posts, 1);
      await page.waitForTimeout(100);
      assert.equal(await prompt.count(), 0, '403 permission failure does not start login');
      if (area === 'viewer') assert.equal(await page.evaluate(() => window.viewerSession.state.answers.q1.value), 'Keep this answer');
      assert.deepEqual(errors, []);
      console.log(`PASS ${area}/${locale}/${recovery}: cancel, explicit confirmation, no replay, permission rejection`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
