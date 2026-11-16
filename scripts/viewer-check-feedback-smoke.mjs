import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clickViewerAction } from './viewer-navigation-test-helpers.mjs';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const options = ['A', 'B', 'C'].map(value => ({ id: value, value, label: `Label ${value}` }));
const cases = [
  ['zero', { inputType: 'number', correctAnswer: 0 }, 0, 'correct', '0'],
  ['empty-number', { inputType: 'number', correctAnswer: 0 }, '', 'incorrect', '0'],
  ['false', { inputType: 'boolean', correctAnswer: false }, false, 'correct', 'False'],
  ['empty-boolean', { inputType: 'boolean', correctAnswer: false }, undefined, 'incorrect', 'False'],
  ['wrong-boolean', { inputType: 'boolean', correctAnswer: false }, true, 'incorrect', 'False'],
  ['single', { inputType: 'multiple_choice', options, correctAnswer: 'A' }, 'B', 'incorrect', 'A'],
  ['multi', { inputType: 'multiple_choice', options, selectionMode: 'multi', correctAnswer: ['A', 'B'] }, ['B', 'A'], 'correct', 'A, B'],
  ['empty-multi', { inputType: 'multiple_choice', options, selectionMode: 'multi', correctAnswer: ['A', 'B'] }, [], 'incorrect', 'A, B'],
  ['wrong-multi', { inputType: 'multiple_choice', options, selectionMode: 'multi', correctAnswer: ['A', 'B'] }, ['C'], 'incorrect', 'A, B'],
  ['missing-choice-key', { inputType: 'multiple_choice', options }, 'B', 'ungraded', 'B'],
  ['missing-key', { inputType: 'boolean' }, false, 'ungraded', 'False'],
  ['missing-key-empty', { inputType: 'number' }, undefined, 'ungraded', ''],
  ['literal-key', { inputType: 'multiple_choice', options: [{ id: 'tag', value: '<b>key</b>', label: 'Markup as text' }, ...options], correctAnswer: '<b>key</b>' }, 'A', 'incorrect', '<b>key</b>'],
];
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: null, items: [] } } }));
    await page.goto(`${base}/server/viewer/`);
    await page.evaluate(async ({ cases, locale }) => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const { emptyBlankConfig } = await import('/server/app/fill-in-blanks.js');
      const now = new Date().toISOString();
      const blocks = cases.map(([blockId, responseConfig], position) => ({
        blockId, kind: 'question', position, prompt: { text: `Check ${blockId} 檢查答案` }, responseConfig,
      }));
      blocks.push({ blockId: 'text', kind: 'question', position: blocks.length, prompt: { text: 'Unscored text' }, responseConfig: { inputType: 'text', maxLength: 200 } });
      blocks.push({ blockId: 'reading', kind: 'content', position: blocks.length, content: { text: 'Unscored reading' } });
      blocks.push({ blockId: 'blanks', kind: 'question', position: blocks.length, prompt: { text: 'Blank checking stays separate' }, responseConfig: {
        ...emptyBlankConfig(), passage: { version: 1, blocks: [{ tag: 'p', children: [{ tag: 'blank', id: 'water', text: 'Water', checking: 'auto', alternatives: [] }] }] },
      } });
      const answers = Object.fromEntries(cases.filter(row => row[2] !== undefined).map(([id, , value]) => [id, { value, answeredAt: now }]));
      answers.text = { value: 'Keep this text', answeredAt: now };
      answers.blanks = { value: { water: 'Water' }, answeredAt: now };
      await viewerStorage.attempts.put({ localId: 'check-fixture', localAttemptId: 'check-fixture', status: 'in_progress', startedAt: now,
        viewerPayload: { worksheetId: 'check-fixture', snapshotId: 'check-fixture', snapshotVersion: 1, title: 'Check presentation', blocks },
        answers, metadata: { localId: 'check-fixture', origin: 'local_source', updatedAt: now } });
    }, { cases, locale });
    await page.goto(`${base}/server/viewer/?localAttemptId=check-fixture`);
    await page.locator('#answer-zero').waitFor().catch(async error => {
      throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`);
    });
    // Invalid keys are rejected by package validation. Exercise their defensive
    // rendering directly, rather than putting an invalid package into the viewer.
    await page.evaluate(async () => {
      const { createCheckFeedback } = await import('/server/viewer/check-feedback.js');
      const { t } = await import('/server/app/i18n/index.js');
      for (const checkStatus of ['ungraded_missing_key', 'ungraded_missing_or_invalid_key']) {
        const result = createCheckFeedback({ responseConfig: { inputType: 'boolean', correctAnswer: 'invalid-key' }, learnerAnswer: false, checkStatus });
        if (result.checkReveal.textContent !== t('viewer.check.reveal.yourAnswer', { answer: 'False' })
          || !result.checkBanner.classList.contains('is-ungraded') || result.cardClassName !== null) {
          throw new Error('Ungraded defensive rendering must show the learner value without exposing the invalid key');
        }
      }
    });
    assert.equal(await page.locator('.viewer-check-banner').count(), 0, 'no results before submission/checking');
    const answersBefore = await page.evaluate(() => JSON.stringify(window.viewerSession.state.answers));
    await clickViewerAction(page, locale === 'en' ? 'Submit' : '提交');
    await page.waitForFunction(() => window.viewerSession.state.status === 'completed' && !window.viewerSession.state.isFinalizing);
    assert.equal(await page.locator('.viewer-check-banner').count(), 0, 'submission alone does not reveal answers');
    const checkLabel = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('viewer.actions.checkAnswer'));
    await clickViewerAction(page, checkLabel);
    await page.locator('[data-block-id="zero"] .viewer-check-banner').waitFor();
    const zh = locale === 'zh-Hant';
    const verify = async () => {
      assert.equal(await page.locator('.viewer-check-banner').count(), cases.length);
      for (const [id, , , status, answer] of cases) {
        const card = page.locator(`[data-block-id="${id}"] .question-card`);
        assert.equal(await card.locator(`.viewer-check-banner.is-${status}`).count(), 1, id);
        const title = status === 'correct' ? (zh ? '正確' : 'Correct') : status === 'incorrect' ? (zh ? '不正確' : 'Incorrect') : (zh ? '未評分' : 'Not graded');
        const detail = status === 'correct' ? (zh ? '做得好' : 'Great work') : status === 'incorrect' ? (zh ? '未完全正確' : 'Not quite') : (zh ? '缺少答案' : 'Missing answer key');
        const reveal = status === 'correct' ? `${zh ? '正確答案：' : 'Correct answer: '}${answer}`
          : status === 'incorrect' ? `${zh ? '不正確。正確答案：' : 'Incorrect. Correct answer: '}${answer}`
            : answer ? `${zh ? '你的答案：' : 'Your answer: '}${answer}` : (zh ? '未作答' : 'No answer');
        assert.equal(await card.locator('.viewer-check-banner__title').textContent(), title, id);
        assert.equal(await card.locator('.viewer-check-banner__detail').textContent(), detail, id);
        assert.equal(await card.locator('.viewer-check-reveal').textContent(), reveal, id);
        assert.equal(await card.evaluate((node, status) => node.classList.contains(`question-card--checked-${status}`), status), status !== 'ungraded', id);
      }
      for (const id of ['text', 'reading', 'blanks']) assert.equal(await page.locator(`[data-block-id="${id}"] .viewer-check-banner`).count(), 0, `${id} retains separate presentation`);
      assert.equal(await page.locator('.viewer-check-reveal b').count(), 0, 'answer values are text, never HTML');
      assert.equal(await page.evaluate(() => JSON.stringify(window.viewerSession.state.answers)), answersBefore, 'checking does not change answers');
      const result = await page.evaluate(() => window.viewerSession.state.checkResult);
      assert.equal(result.correctCount, cases.filter(row => row[3] === 'correct').length + 1);
      assert.equal(result.totalQuestions, cases.filter(row => row[3] !== 'ungraded').length + 1);
      assert.equal(result.blanksByBlockId.blanks.statuses.water, 'correct');
      assert.equal(await page.locator('#answer-zero').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    };
    await verify();
    await page.evaluate(() => { window.viewerSession.notifyStateChange(); window.viewerSession.notifyStateChange(); });
    await verify();
    if (shots) await page.screenshot({ path: `${shots}/check-${locale}-${width}.png`, animations: 'disabled' });
    await page.evaluate(() => window.viewerSession.saveNow());
    await page.reload();
    await page.locator('#answer-zero').waitFor();
    // Normal local checking is transient: resume retains submission and answers,
    // and the learner explicitly checks again. Preserve that existing policy.
    assert.equal(await page.locator('.viewer-check-banner').count(), 0);
    await clickViewerAction(page, checkLabel);
    await page.locator('[data-block-id="zero"] .viewer-check-banner').waitFor();
    await verify();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Checking presentation: zero/false/empty, single/multi choices, missing/invalid keys, bilingual layouts, no pre-check reveal, unchanged answers/scores and rechecking after resume passed');
} finally { await browser.close(); }
