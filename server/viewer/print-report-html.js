import { t } from '../app/i18n/index.js';
import { blankDefinitions, checkBlanks, renderBlankPassage } from '../app/fill-in-blanks.js';
import { renderWorksheetText, WORKSHEET_TEXT_CSS } from '../app/worksheet-text.js';
import { bookIcon } from './worksheet-navigation.js';
import { PRINT_REPORT_CSS } from './print-report-styles.js';
import { getDefaultViewerPrintSchoolName } from './print-report-model.js';

// Generates the existing print document; opening/writing its window stays in main.
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMultilineTextForHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

export function buildWorksheetPrintReportHtml(reportModel) {
  const studentMeta = reportModel.studentName
    ? `
      <div class="print-meta-item">
        <dt>${escapeHtml(t('viewer.print.meta.student'))}</dt>
        <dd>${escapeHtml(reportModel.studentName)}</dd>
      </div>
    `
    : '';
  const submittedMeta = reportModel.submittedAtLabel
    ? `
      <div class="print-meta-item">
        <dt>${escapeHtml(t('viewer.print.meta.submittedAt'))}</dt>
        <dd>${escapeHtml(reportModel.submittedAtLabel)}</dd>
      </div>
    `
    : '';
  const checkedRow = reportModel.checkedSummary
    ? `
      <div class="print-meta-item">
        <dt>${escapeHtml(t('viewer.print.meta.checkResult'))}</dt>
        <dd>${escapeHtml(reportModel.checkedSummary)}</dd>
      </div>
    `
    : '';

  const sectionsHtml = (reportModel.sections || reportModel.questions || []).map((question) => {
    if (question.kind === 'content') return `
      <article class="print-content" data-block-id="${escapeHtml(question.blockId)}" aria-label="${escapeHtml(question.label)}">
        <span class="print-content-icon" aria-hidden="true">${bookIcon}</span>
        <div class="print-content-text worksheet-text">${renderWorksheetText(question.content)}</div>
      </article>`;
    const imageHtml = question.image?.status === 'ready' && question.image?.src
      ? `
        <div class="print-question-image-wrap">
          <img class="print-question-image" src="${escapeHtml(question.image.src)}" alt="${escapeHtml(question.image.alt || t('viewer.print.questionImageAlt'))}">
        </div>
      `
      : question.image?.status === 'missing'
        ? `<p class="print-question-media-note">${escapeHtml(question.image.message || t('viewer.print.questionImageUnavailable'))}</p>`
        : '';

    const checkedAnswerSectionClass = `print-question-section--${escapeHtml(question.sectionBreakModes?.checkedAnswer || 'keep')}`;
    const imageSectionHtml = imageHtml
      ? `
        <section class="print-question-section print-question-section--image print-question-section--flow">
          ${imageHtml}
        </section>
      `
      : '';
    const resultHtml = !question.blankConfig && question.result
      ? `
        <section class="print-question-section print-question-section--result ${checkedAnswerSectionClass} print-result-${escapeHtml(question.result.status || 'neutral')}">
          <h3>${escapeHtml(t('viewer.print.checkedResultHeading'))}</h3>
          <p class="print-result-label">${escapeHtml(question.result.label)}</p>
          ${question.result.detail ? `<p class="print-result-detail">${formatMultilineTextForHtml(question.result.detail)}</p>` : ''}
        </section>
      `
      : '';

    const blankHtml = question.blankConfig ? renderBlankPassage(question.blankConfig, blank => {
      const answer = question.blankAnswers?.[blank.id] || '';
      const result = checkBlanks(question.blankConfig, question.blankAnswers);
      const number = blankDefinitions(question.blankConfig).findIndex(b=>b.id===blank.id)+1;
      const status = result.statuses[blank.id];
      const note = question.blanksChecked || status === 'teacher_review' ? t('fillBlanks.'+status) : '';
      return `<span class="print-blank"><sup>${number}</sup> ${escapeHtml(answer || '________')} ${note ? `<small>(${escapeHtml(note)})</small>` : ''}</span>`;
    }) : '';
    const choicesHtml = question.choices?.length ? `
      <div class="print-choices${question.inputType === 'boolean' ? ' print-choices--boolean' : ''}">
        ${question.choices.map(choice => `
          <div class="print-choice${choice.image ? ' print-choice--image' : ''}${choice.selected ? ' is-selected' : ''}"${choice.booleanValue ? ` data-boolean-value="${escapeHtml(choice.booleanValue)}"` : ''}>
            ${choice.prefix ? `<span class="print-choice-prefix">${escapeHtml(choice.prefix)}</span>` : ''}
            <span class="print-choice-label">${escapeHtml(choice.label)}</span>
            ${choice.image?.status === 'ready' ? `<img class="print-option-image" src="${escapeHtml(choice.image.src)}" alt="${escapeHtml(choice.imageAlt)}">` : choice.image ? `<span class="print-option-image-unavailable">${escapeHtml(t('optionImages.unavailable'))}</span>` : ''}
            <span class="print-choice-mark" aria-hidden="true">${choice.selected ? '✓' : ''}</span>
          </div>`).join('')}
      </div>` : '';

    return `
      <article class="print-question print-question--${escapeHtml(question.layoutMode || 'keep-all')}" data-block-id="${escapeHtml(question.blockId)}">
        <header class="print-question-header">
          <h2 class="print-question-number" aria-label="${escapeHtml(t('viewer.print.questionNumber', { number: question.questionNumber }))}">
            <span class="print-question-ordinal" aria-hidden="true">${escapeHtml(String(question.questionNumber).padStart(2, '0'))}</span>
          </h2>
        </header>
        <div class="print-question-layout">
        <div class="print-prompt-area">
        <section class="print-question-section print-question-section--prompt print-question-section--${escapeHtml(question.sectionBreakModes?.prompt || 'keep')}">
          <h3>${escapeHtml(t('viewer.print.questionHeading'))}</h3>
          <div class="print-question-text worksheet-text">${renderWorksheetText(question.promptText?.trim() ? (question.promptField || { text: question.promptText, format: question.promptFormat }) : { text: t(question.blankConfig ? 'fillBlanks.type' : 'viewer.print.noPromptProvided') })}</div>
        </section>
        ${imageSectionHtml}
        </div>
        <div class="print-answer-area">
        <section class="print-question-section print-question-section--answer print-question-section--${escapeHtml(question.sectionBreakModes?.answer || 'keep')}">
          <h3>${escapeHtml(t('viewer.print.answerHeading'))}</h3>
          ${choicesHtml}
          ${blankHtml ? `<div class="print-blank-passage worksheet-text">${blankHtml}</div>` : ''}
          ${(question.answerImages || []).map((img,i)=>`<figure class="print-answer-image"><img data-answer-image src="${escapeHtml(img.src || '')}" alt="${escapeHtml(t('imageResponse.image',{number:i+1}))}"><figcaption>${i+1} / ${question.answerImages.length}</figcaption></figure>`).join('')}
          ${question.answerImages?.length || question.blankConfig ? '' : `<p class="print-answer-text">${escapeHtml(t('viewer.print.answerPrefix'))} ${formatMultilineTextForHtml(question.answerText)}</p>`}
        </section>
        ${resultHtml}
        </div>
        </div>
      </article>
    `;
  }).join('');

  return `<!doctype html>
<html lang="${escapeHtml(reportModel.locale || 'en')}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(reportModel.title)}</title>
  <style>${PRINT_REPORT_CSS}\n${WORKSHEET_TEXT_CSS}</style>

</head>
<body>
  <main class="print-report">
    <header class="print-header">
      <p class="print-school">${escapeHtml(reportModel.schoolName || getDefaultViewerPrintSchoolName())}</p>
      <h1 class="print-title">${escapeHtml(reportModel.title)}</h1>
      <dl class="print-meta">
        ${studentMeta}
        ${submittedMeta}
        ${checkedRow}
      </dl>
    </header>
    ${sectionsHtml}
    ${reportModel.feedbackHtml || ''}
  </main>
  <script>
    (function () {
      const images = Array.from(document.images || []);
      const waitForImages = images.length === 0
        ? Promise.resolve()
        : Promise.all(images.map((img) => (
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
        )));

      const waitForFonts = new Promise(resolve => {
        const ready = () => resolve(document.fonts ? document.fonts.ready : undefined);
        if (document.readyState === 'complete') ready();
        else window.addEventListener('load', ready, { once: true });
      });
      Promise.all([waitForImages, Promise.race([
        waitForFonts, new Promise(resolve => setTimeout(resolve, 5000))
      ])]).then(() => {
        if (typeof window.focus === 'function') {
          window.focus();
        }
        if ([...document.querySelectorAll('[data-answer-image]')].some(img => !img.naturalWidth)) { const error=document.createElement('p');error.textContent=${JSON.stringify(t('imageResponse.unavailable'))};error.setAttribute('role','alert');document.body.prepend(error);return; }
        if (typeof window.print === 'function') {
          window.print();
        }
      });

      window.addEventListener('afterprint', () => {
        if (typeof window.close === 'function') {
          window.close();
        }
      });
    }());
  </script>
</body>
</html>`;
}

