import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clickViewerAction } from './viewer-navigation-test-helpers.mjs';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: null, items: [] } } }));
    await page.goto(`${base}/server/viewer/`);
    await page.evaluate(async locale => {
      const { setLocale, t } = await import('/server/app/i18n/index.js');
      setLocale(locale);
      const { createTextAnswerControl, createTextFeedbackNodes, createTextAnswerPresentation, updateTextAnswerActions, updateTextAnswerReview, computeTextLengthFeedback } = await import('/server/viewer/text-answer-presentation.js');
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      for (const [config, tag, rows] of [
        [{ inputType: 'text', displayMode: 'single_line' }, 'INPUT', null],
        [{ inputType: 'text' }, 'TEXTAREA', 5],
        [{ inputType: 'text', textMode: 'long' }, 'TEXTAREA', 12],
      ]) {
        const control = createTextAnswerControl(config);
        check(control.tagName === tag && (rows === null || control.rows === rows), 'input shape stays unchanged');
        check(!control.hasAttribute('maxlength'), 'no native silent paste clipping');
      }
      const scope = new AbortController();
      const card = document.createElement('article');
      const control = createTextAnswerControl({ inputType: 'text' });
      control.id = 'module-text'; control.setAttribute('aria-describedby', 'module-text-counter');
      const nodes = createTextFeedbackNodes(control.id);
      const helper = document.createElement('p'), label = document.createElement('label');
      const add = document.createElement('button'), root = document.createElement('div');
      add.textContent = t('viewer.voice.add');
      let voiceClicks = 0, rewriteClicks = 0, undoClicks = 0, inputEvents = 0;
      add.addEventListener('click', () => { voiceClicks++; });
      control.addEventListener('input', () => { inputEvents++; });
      const view = createTextAnswerPresentation({ control, ...nodes, helper, label,
        voiceElements: { add, root }, t, createIcon: () => '<svg aria-hidden="true"></svg>',
        sharedStatusId: 'shared-status', signal: scope.signal,
        onRewrite: () => { rewriteClicks++; }, onUndo: () => { undoClicks++; },
      });
      card.append(control, view.reviewStatus, view.footer); document.body.append(card);
      check(view.footer.contains(add) && view.footer.contains(root), 'original voice nodes retained');
      add.click(); check(voiceClicks === 1, 'existing voice listener retained');
      const update = (value, enabled) => updateTextAnswerActions(view, {
        counterFeedback: computeTextLengthFeedback(value, 10), canRewrite: enabled,
        undoDisabled: !enabled, rewriteLabel: t(enabled ? 'viewer.rewrite.action' : 'viewer.rewrite.inProgress'),
        hintWarning: !enabled, hintText: enabled ? '' : 'warning',
      });
      control.value = '123456789'; control.focus(); control.setSelectionRange(2, 5);
      update(control.value, true);
      check(nodes.counter.textContent === '9/10' && nodes.counter.classList.contains('text-counter--warning'), 'warning counter');
      view.rewriteButton.click(); view.undoButton.click();
      update('12345678901', false);
      // Explicit dispatch also checks the guard, rather than relying on native disabled click suppression.
      view.rewriteButton.dispatchEvent(new Event('click')); view.undoButton.dispatchEvent(new Event('click'));
      check(rewriteClicks === 1 && undoClicks === 1, 'disabled callbacks suppressed');
      check(nodes.counter.classList.contains('text-counter--over') && view.rewriteHint.classList.contains('is-warning'), 'over-limit display');
      check(view.rewriteButton.textContent === t('viewer.rewrite.inProgress'), 'in-flight label updates in place');
      update('abc', true);
      check(nodes.counter.classList.contains('text-counter--normal') && !view.rewriteHint.textContent, 'warning clears');
      check(document.activeElement === control && control.selectionStart === 2 && control.selectionEnd === 5 && control.value === '123456789', 'presentation does not overwrite answer or selection');
      check(inputEvents === 0 && view.footer.querySelectorAll('button').length === 3, 'updates do not publish input or rebuild controls');
      scope.abort(); view.rewriteButton.click(); view.undoButton.click();
      check(rewriteClicks === 1 && undoClicks === 1, 'disposed listeners cannot invoke actions');
      control.readOnly = true; // A current voice operation owns this lock during editing.
      updateTextAnswerReview(view, { card, completed: false, hasAnswer: true });
      check(control.readOnly, 'editing presentation does not unlock voice');
      control.readOnly = false; // Voice update runs before the submitted presentation.
      updateTextAnswerReview(view, { card, completed: true, hasAnswer: true });
      check(control.readOnly && !control.disabled && !control.hidden && view.footer.hidden && helper.hidden, 'submitted answer remains copyable and locked');
      check(!control.hasAttribute('aria-describedby') && label.htmlFor === control.id, 'review accessibility');
      updateTextAnswerReview(view, { card, completed: true, hasAnswer: false });
      check(control.hidden && !view.reviewStatus.hidden && view.reviewStatus.value === t('viewer.review.notAnswered'), 'unanswered placeholder');
      check(view.reviewStatus.readOnly && !view.reviewStatus.disabled && label.htmlFor === view.reviewStatus.id, 'placeholder is copyable and labelled');
      view.reviewStatus.dispatchEvent(new Event('input'));
      check(inputEvents === 0, 'placeholder has no answer binding');
      card.remove();

      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      await viewerStorage.attempts.put({ localId: 'text-presentation', localAttemptId: 'text-presentation', status: 'in_progress', startedAt: now,
        viewerPayload: { worksheetId: 'text', snapshotId: 'text', snapshotVersion: 1, title: 'Text presentation 文字', blocks: [
          ['single', { inputType: 'text', displayMode: 'single_line', maxLength: 10 }],
          ['multi', { inputType: 'text', maxLength: 10 }],
          ['legacy', { inputType: 'text', maxLength: 2500 }],
          ['long', { inputType: 'text', textMode: 'long', maxLength: 20000 }],
        ].map(([blockId, responseConfig], position) => ({ blockId, responseConfig, position, kind: 'question', prompt: { text: blockId } })) },
        answers: { multi: { value: 'x'.repeat(12) }, legacy: { value: 'x'.repeat(2100) } },
        metadata: { localId: 'text-presentation', origin: 'local_source', updatedAt: now } });
    }, locale);
    await page.goto(`${base}/server/viewer/?localAttemptId=text-presentation`);
    const single = page.locator('#answer-single'), multi = page.locator('#answer-multi');
    const singleCard = single.locator('xpath=ancestor::article');
    await single.fill('123456789');
    assert.equal(await singleCard.locator('.text-counter').textContent(), '9/10');
    await single.evaluate(node => {
      window.originalTextControl = node;
      node.setSelectionRange(2, 4);
      window.viewerSession.state.undoBuffer.single = 'before';
      window.viewerSession.notifyStateChange();
    });
    assert.equal(await single.evaluate(node => node === window.originalTextControl && document.activeElement === node && node.selectionStart === 2 && node.selectionEnd === 4), true);
    const undo = singleCard.locator('.question-card__undo-btn');
    assert.equal(await undo.isEnabled(), true);
    // Whole paste rejection leaves the original value, selection and Undo entry intact.
    assert.equal(await single.evaluate(node => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'excessive text');
      return node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }), false);
    assert.equal(await single.inputValue(), '123456789');
    assert.equal(await undo.isEnabled(), true);
    assert.ok(await page.locator('#answer-single-error').textContent());
    await single.fill('abc');
    assert.equal(await undo.isDisabled(), true);
    assert.equal(await page.locator('#answer-single-error').textContent(), '');
    assert.equal(await singleCard.locator('.text-counter').textContent(), '3/10');
    // Short-answer IME commits only when composition finishes.
    await single.evaluate(node => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      node.value = '中文字'; node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.single.value), 'abc');
    await single.dispatchEvent('compositionend');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.single.value), '中文字');
    await single.evaluate(node => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      node.value = '中'.repeat(11); node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await single.dispatchEvent('compositionend');
    assert.equal(await single.inputValue(), '中文字');
    await multi.fill('x'.repeat(11)); // Imported oversized answer can be shortened in stages.
    assert.equal(await multi.inputValue(), 'x'.repeat(11));
    assert.match(await page.locator('#answer-multi-counter').getAttribute('class'), /--over/);
    await multi.fill('x'.repeat(10));
    assert.equal(await page.locator('#answer-multi-status').textContent() !== '', true);
    const legacy = page.locator('#answer-legacy');
    assert.equal((await legacy.inputValue()).length, 2100);
    const legacyCard = legacy.locator('xpath=ancestor::article');
    assert.equal(await legacyCard.locator('.question-card__rewrite-btn').isDisabled(), true);
    assert.ok(await legacyCard.locator('.question-card__rewrite-hint').textContent());
    await legacy.fill('short');
    assert.equal(await legacyCard.locator('.question-card__rewrite-btn').isEnabled(), true);
    assert.equal(await legacyCard.locator('.question-card__rewrite-hint').textContent(), '');
    assert.equal(await page.locator('#answer-long').locator('xpath=ancestor::article').locator('.question-card__rewrite-btn,.question-card__undo-btn,.question-card__voice-btn').count(), 0);
    if (shots) await page.screenshot({ path: `${shots}/text-${locale}-${width}.png`, animations: 'disabled' });
    await clickViewerAction(page, locale === 'en' ? 'Submit' : '提交');
    await page.waitForFunction(() => window.viewerSession.state.status === 'completed' && !window.viewerSession.state.isFinalizing);
    await page.evaluate(() => window.viewerSession.notifyStateChange());
    assert.equal(await single.evaluate(node => node.readOnly && !node.disabled), true, 'voice update must not unlock submitted text');
    assert.equal(await page.locator('#answer-long-review').isVisible(), true);
    assert.equal(await page.locator('#answer-long-review').inputValue(), locale === 'en' ? 'Not answered' : '未作答');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Text presentation: counters, action states, disposal, paste/IME, Undo, legacy limits and submitted locks passed in both locales and widths');
} finally { await browser.close(); }
