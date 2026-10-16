import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  try {
    const a = await context.newPage(), b = await context.newPage();
    for (const page of [a,b]) await page.goto(`${base}/server/editor/main.css`);
    await a.evaluate(async () => {
      const storage = await import('/server/app/storage/local-storage.js');
      storage.setPendingIntent({ localId:'A', resumeFlagKey:'viewer', actionId:'upload', intentPayload:{localAttemptId:'A'} });
    });
    await b.evaluate(async () => {
      const storage = await import('/server/app/storage/local-storage.js');
      storage.setPendingIntent({ localId:'B', resumeFlagKey:'viewer', actionId:'upload', intentPayload:{localAttemptId:'B'} });
    });
    await a.reload();
    assert.equal(await a.evaluate(async()=> (await import('/server/app/storage/local-storage.js')).getPendingIntent().localId),'A');
    await a.evaluate(async () => {
      history.replaceState({},'', '?authReturn=1');
      const storage = await import('/server/app/storage/local-storage.js');
      const { SharedAuthGate } = await import('/server/app/auth/shared-auth-gate.js');
      const gate = new SharedAuthGate({resumeFlagKey:'viewer',storage:{pendingIntent:{get:storage.getPendingIntent,clear:storage.clearPendingIntent},resumeFlags:{get:()=>null}},checkSessionReady:async()=>({ok:true}),replayIntent:async()=>({ok:true})});
      await gate.restoreAfterAuthReturn();
    });
    assert.equal(await a.evaluate(async()=> (await import('/server/app/storage/local-storage.js')).getPendingIntent()),null);
    assert.equal(await b.evaluate(async()=> (await import('/server/app/storage/local-storage.js')).getPendingIntent().localId),'B');
    await b.reload();
    assert.equal(await b.evaluate(async()=> (await import('/server/app/storage/local-storage.js')).getPendingIntent().localId),'B');
    console.log('PASS: real tabs isolate pending actions through reload and authentication replay cleanup');
  } finally { await context.close(); }
} finally { await browser.close(); }
