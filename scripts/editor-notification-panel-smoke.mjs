// Isolated editor fixtures; no real server data or mutations.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
        json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } },
      }));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession.status === 'ready');
      await page.evaluate(() => {
        const session = window.editorSession;
        session.state.notifications = [];
        session.state.activityLog = [];
        session.notifyStateChange();
      });
      const panel = page.locator('.editor-activity-panel');
      await panel.locator('summary').click();
      assert.equal(await panel.locator('.notification-feed-item').count(), 0);
      assert.equal(await panel.locator('.notification-feed__list .muted').count(), 1);
      assert.equal(await panel.locator('button').isVisible(), false);
      await page.evaluate(() => {
        const s = window.editorSession;
        for (let i = 1; i <= 65; i++) s.pushNotification({
          text: `Activity ${i}`, showToast: false, kind: i === 65 ? 'error' : 'info',
        });
        s.notifyStateChange();
      });
      const messages = panel.locator('.notification-feed-item__text');
      assert.equal(await messages.count(), 30);
      assert.equal(await messages.first().textContent(), 'Activity 65');
      assert.equal(await messages.last().textContent(), 'Activity 36');
      assert.equal(await panel.locator('.notification-feed-item[aria-live="off"]').count(), 30);
      assert.equal(await panel.locator('[role="alert"]').count(), 0);
      assert.equal(await page.locator('.notification-toast').count(), 0);
      await panel.locator('button').click();
      assert.equal(await messages.count(), 60);
      await panel.locator('button').click();
      assert.equal(await messages.count(), 65);
      assert.equal(await panel.locator('button').isVisible(), false);
      await page.evaluate(() => {
        const s = window.editorSession;
        for (let i = 1; i <= 6; i++) s.pushNotification({ text: `Toast ${i}`, kind: i === 6 ? 'error' : 'success' });
        s.notifyStateChange();
      });
      assert.deepEqual(await page.locator('.notification-toast__text').allTextContents(), ['Toast 3', 'Toast 4', 'Toast 5', 'Toast 6']);
      assert.equal(await page.locator('.notification-toast[role="alert"][aria-live="assertive"]').count(), 1);
      assert.equal(await page.locator('.notification-toast[role="status"][aria-live="polite"]').count(), 3);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `${locale}-${width}.png`), fullPage: true });
      }
      // Replace while an aged toast is active. Its remaining life must not restart.
      await page.evaluate(() => {
        const s = window.editorSession;
        s.state.notifications = [];
        const notification = s.pushNotification({ text: 'Language timer fixture', ttlMs: 5000 });
        notification.createdAt = new Date(Date.now() - 3000).toISOString();
        s.notifyStateChange();
        window.oldShell = document.querySelector('.editor-shell');
        window.oldShellMutations = 0;
        window.oldShellObserver = new MutationObserver(records => { window.oldShellMutations += records.length; });
        window.oldShellObserver.observe(window.oldShell, { childList: true, subtree: true });
      });
      await page.locator('.language-selector select').selectOption(locale === 'en' ? 'zh-Hant' : 'en');
      await page.evaluate(() => { window.oldShellMutations = 0; });
      assert.equal(await page.locator('.notification-toast').count(), 1);
      const title = page.locator('#editor-title-input');
      await title.fill('Notification refactor fixture');
      await title.focus();
      await page.locator('.notification-toast').filter({ hasText: 'Language timer fixture' }).waitFor({ state: 'detached', timeout: 3500 });
      assert.equal(await title.inputValue(), 'Notification refactor fixture');
      assert.equal(await title.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.oldShellMutations), 0);
      await page.evaluate(() => window.oldShellObserver.disconnect());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      // Deterministic disposal checks on the component itself, including queued callbacks.
      const lifecycle = await page.evaluate(async () => {
        const { createNotificationPanel } = await import('/server/editor/notification-panel.js');
        const scheduled = new Map(), cancelled = [], callbacks = [];
        const originalSet = window.setTimeout, originalClear = window.clearTimeout;
        let refreshes = 0, nextId = 0;
        window.setTimeout = callback => { callbacks.push(callback); scheduled.set(++nextId, callback); return nextId; };
        window.clearTimeout = id => { cancelled.push(id); scheduled.delete(id); };
        try {
          const component = createNotificationPanel({ t: key => key, requestRefresh: () => refreshes++ });
          const record = { id: 'fixture', text: '<img src=x onerror=alert(1)>', actionLabel: '<b>Save</b>', createdAt: new Date().toISOString() };
          const data = { activityLog: [record], notifications: [record] };
          component.update(data);
          component.update(data);
          const oneTimer = scheduled.size === 1;
          const literalText = component.toastRoot.querySelector('.notification-toast__text').textContent === record.text
            && component.toastRoot.querySelector('img, b') === null;
          component.update({ activityLog: [record], notifications: [] });
          const removedTimer = scheduled.size === 0;
          component.update(data);
          const before = refreshes;
          component.destroy();
          component.destroy();
          callbacks.forEach(callback => callback());
          component.activityRoot.querySelector('button').click();
          component.update(data);
          return { oneTimer, literalText, removedTimer, noTimers: scheduled.size === 0,
            noLateRefresh: refreshes === before, cancelled: cancelled.length };
        } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
      });
      assert.deepEqual(lifecycle, { oneTimer: true, literalText: true, removedTimer: true, noTimers: true, noLateRefresh: true, cancelled: 2 });
      assert.deepEqual(errors, []);
      console.log(`PASS notifications/activity ${locale} ${width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
