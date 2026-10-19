// Exercise the shared prompt with each app's actual styles; no real server writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
try {
  for (const app of ['editor', 'viewer', 'roleplayscene']) for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({status:401,json:{ok:false,error:{code:'AUTH_REQUIRED'}}}));
      await page.goto(`${base}/server/${app}/`);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({width,height:900});
        for (const mode of ['sign-in', 'blocked', 'upload', 'publish', 'delete-draft']) {
          await page.evaluate(async mode => {
            const { promptForReadSignIn } = await import('/server/app/auth/read-auth-prompt.js');
            window.promptResult = null;
            void promptForReadSignIn({ intent:{kind:'mutation',operation:mode === 'sign-in' || mode === 'blocked' ? 'upload' : mode},
              confirmation: !['sign-in','blocked'].includes(mode), blocked:mode === 'blocked', canRedirect:mode === 'blocked',
              redirect:async()=>{throw Error('fixture must not navigate');},
            }).then(result => { window.promptResult = result; });
          }, mode);
          const dialog = page.locator('.read-auth-prompt');
          await dialog.waitFor();
          const geometry = await dialog.evaluate(node => {
            const r = node.getBoundingClientRect();
            return { fits: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= innerHeight,
              scrolls:node.scrollWidth > node.clientWidth + 1,
              buttonsFit:[...node.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left && b.right<=r.right && b.top>=r.top && b.bottom<=r.bottom;}),
              focusInside:node.contains(document.activeElement) };
          });
          assert.deepEqual(geometry,{fits:true,scrolls:false,buttonsFit:true,focusInside:true},`${app}/${locale}/${width}/${mode}`);
          await page.keyboard.press('Escape');
          await dialog.waitFor({state:'detached'});
          assert.equal(await page.evaluate(()=>window.promptResult),false);
        }
      }
      assert.deepEqual(errors,[]);
      console.log(`PASS ${app}/${locale}: all prompt variants at 320/390/1280px, containment and keyboard cancel`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
