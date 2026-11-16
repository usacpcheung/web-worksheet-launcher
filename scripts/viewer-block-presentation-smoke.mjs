import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  // Test the extracted boundary without booting a session or making API calls.
  // Integration/layout coverage remains in the viewer lifecycle and prompt smokes.
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${base}/block-presentation-fixture`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(`${base}/block-presentation-fixture`);
  await page.evaluate(async () => {
    const { createReadingBlockPresentation, createQuestionPromptPresentation } = await import('/server/viewer/block-presentation.js');
    const { createBlockViewScope } = await import('/server/viewer/block-view-host.js');
    const { t, setLocale } = await import('/server/app/i18n/index.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const urls = [], revoked = [];
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); urls.push(url); return url; };
    URL.revokeObjectURL = url => { revoked.push(url); revokeURL(url); };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    const asset = { binary: await png.arrayBuffer(), metadata: { mimeType: 'image/png' } };
    let sequence = 0;
    const mount = (prompt, { inputType = 'text', get = async () => asset } = {}) => {
      const scope = createBlockViewScope();
      let audioOptions;
      const view = createQuestionPromptPresentation({
        block: { blockId: `fixture-${++sequence}`, kind: 'question', prompt, responseConfig: { inputType } },
        sectionLabelText: 'Section', questionNumber: 2, scope, localAssets: { get }, t,
        createAudioControl: options => { audioOptions = options; return null; },
      });
      view.card.append(view.mediaFeedback);
      document.body.append(view.card);
      return { ...view, scope, audioOptions };
    };
    for (const locale of ['en', 'zh-Hant']) {
      setLocale(locale, { persist: false });
      const fields = [
        { text: '<b>literal 中文</b>' },
        { text: '## Heading 中文\n**Strong**', format: 'limited-markdown-v1' },
        { text: 'Rich 中文', format: 'rich-text-v1', document: { version: 1, blocks: [
          { tag: 'p', children: [{ tag: 'u', children: [{ tag: 'text', text: 'Rich 中文' }] }] },
        ] } },
      ];
      for (const [index, field] of fields.entries()) {
        const reading = createReadingBlockPresentation({ block: { content: field }, sectionLabelText: 'Reading' });
        const view = mount(field);
        check(reading.classList.contains('content-card') && !reading.querySelector('input,textarea'), 'reading has no answer control');
        check(reading.querySelector('.viewer-content-heading').getAttribute('aria-hidden') === 'true', 'reading icon is decorative');
        check(view.card.querySelector('.viewer-question-number').textContent === '02', 'question numbering preserved');
        check(view.label.id === `${view.controlId}-label`, 'stable prompt ID for aria-labelledby');
        if (index === 0) check(!view.label.querySelector('b') && view.label.textContent === field.text, 'plain text stays literal');
        if (index === 1) check(view.label.querySelector('h2') && reading.querySelector('strong'), 'Markdown uses the shared renderer');
        if (index === 2) check(view.label.querySelector('u') && reading.querySelector('u'), 'rich text uses the shared renderer');
        const input = document.createElement('input'); input.id = view.controlId;
        view.card.append(input); view.label.click();
        check(document.activeElement === input, 'prompt click focuses the answer');
        const review = document.createElement('div'); review.id = `${view.controlId}-review`; review.tabIndex = -1;
        view.card.append(review); view.label.htmlFor = review.id; view.label.click();
        check(document.activeElement === review, 'submitted placeholder can retarget prompt focus');
        view.scope.dispose(); input.focus(); view.label.click();
        check(document.activeElement === input, 'disposal removes the prompt listener');
        view.card.remove();
      }
      for (const inputType of ['text', 'fill_in_blanks']) {
        const view = mount({ text: '' }, { inputType });
        check(view.label.textContent === t(inputType === 'text' ? 'viewer.stepper.question' : 'fillBlanks.type'), 'translated empty prompt fallback');
        view.scope.dispose(); view.card.remove();
      }
      const prompt = { text: 'Image', mediaRefs: [{ usage: 'question_image', assetId: 'picture' },
        { usage: 'question_audio', assetId: 'legacy-audio' }], audioTracks: [{ language: 'english', assetId: 'audio' }] };
      const view = mount(prompt);
      check(view.audioOptions.audioTracks === prompt.audioTracks && view.audioOptions.legacyAudioRef.assetId === 'legacy-audio', 'canonical and legacy audio forwarded');
      check(view.audioOptions.signal === view.scope.signal && view.audioOptions.kind === 'question', 'audio shares card lifetime');
      const img = view.card.querySelector('img');
      await new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', () => reject(new Error('fixture image failed')), { once: true });
      });
      // Let every load listener finish, including the renderer's URL cleanup.
      await tick();
      check(img.naturalWidth === 2 && img.alt === t('viewer.print.questionImageAlt'), 'local image and alt render');
      check(revoked.includes(img.src), 'loaded image releases its URL');
      view.audioOptions.reportMediaFeedback('audio error');
      check(view.mediaFeedback.textContent === 'audio error' && view.mediaFeedback.getAttribute('aria-live') === 'polite', 'shared media status');
      view.scope.dispose(); view.audioOptions.reportMediaFeedback('late');
      check(view.mediaFeedback.textContent === 'audio error', 'disposed feedback ignores late audio results');
      view.card.remove();

      for (const [get, key] of [
        [async () => null, 'viewer.image.missingWithId'],
        [async () => { throw new Error('fixture storage failure'); }, 'viewer.image.couldNotLoad'],
        [async () => ({ binary: new Uint8Array([1, 2, 3]) }), 'viewer.image.couldNotRender'],
      ]) {
        const failed = mount(prompt, { get });
        for (let n = 0; n < 100 && !failed.mediaFeedback.textContent; n++) await new Promise(resolve => setTimeout(resolve, 10));
        check(failed.mediaFeedback.textContent === t(key, { id: 'picture' }), `localized image failure: ${key}`);
        if (key === 'viewer.image.couldNotRender') check(!failed.card.querySelector('img'), 'broken image wrapper removed');
        failed.scope.dispose(); failed.card.remove();
      }
      // A storage result arriving after replacement must not allocate a Blob URL
      // or change feedback in the removed card, whether it resolves or rejects.
      for (const reject of [false, true]) {
        let settle;
        const late = mount(prompt, { get: () => new Promise((resolve, fail) => { settle = reject ? fail : resolve; }) });
        late.scope.dispose(); late.card.remove();
        const before = late.card.outerHTML, count = urls.length;
        settle(reject ? new Error('late failure') : asset); await tick();
        check(late.card.outerHTML === before && urls.length === count, 'late asset result ignored after disposal');
      }
      // Dispose after allocating the URL but before the browser finishes decoding.
      const pending = mount(prompt); await Promise.resolve();
      const pendingImage = pending.card.querySelector('img'), pendingURL = pendingImage.src;
      pending.scope.dispose(); pending.card.remove();
      check(revoked.includes(pendingURL), 'pending URL released on disposal');
      pendingImage.onload(); pendingImage.onerror();
      check(revoked.filter(url => url === pendingURL).length === 1, 'late decode events do not double-revoke');
      check(!pending.mediaFeedback.textContent, 'late decode failure cannot announce an error');
    }
    check(urls.every(url => revoked.filter(value => value === url).length === 1), 'all allocated image URLs released exactly once');
  });
  assert.deepEqual(errors, []);
  console.log('Block presentation: formats, focus, locales, audio delegation, image errors and disposal passed');
} finally {
  await browser.close();
}
