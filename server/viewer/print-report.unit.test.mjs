import test from 'node:test';
import assert from 'node:assert/strict';
import { t, getLocale, setLocale } from '../app/i18n/index.js';
import * as model from './print-report-model.js';
import { buildWorksheetPrintReportHtml } from './print-report-html.js';
import { deterministicShuffle } from './worksheet-values.js';

// Direct module tests need no viewer bootstrap, DOM globals or rewritten imports.
const mod = { ...model, buildWorksheetPrintReportHtml, deterministicShuffle };

test('worksheet print preserves mixed section order, content formatting and stable answer identities', async () => {
  const blocks = [
    { blockId: 'q2', position: 3, kind: 'question', prompt: { text: 'Choose' }, responseConfig: {
      inputType: 'multiple_choice', selectionMode: 'multi', shuffleOptions: true,
      options: [{value:'a',label:'Alpha'}, {value:'b',label:'Beta'}, {value:'c',label:'Gamma'}],
    } },
    { blockId: 'intro', position: 0, kind: 'content', content: {text:'## Read first\n**Important**', format:'limited-markdown-v1'} },
    { blockId: 'q1', position: 1, kind: 'question', prompt: {text:'Zero'}, responseConfig:{inputType:'number'} },
    { blockId: 'reading', position: 2, kind: 'content', content: {text:'<script>unsafe()</script>'} },
    { blockId: 'q3', position: 4, kind: 'question', prompt: {text:'False'}, responseConfig:{inputType:'boolean'} },
    { blockId: 'end', position: 5, kind: 'content', content: {text:'End of worksheet'} },
  ];
  const answers = {q1:{value:0}, q2:{value:['c','a']}, q3:{value:false}};
  const before = JSON.stringify({blocks, answers});
  const model = await mod.buildWorksheetPrintReportModel({viewerPayload:{blocks}, answers, localAttemptId:'print-fixture'});
  assert.deepEqual(model.sections.map(s=>s.blockId), ['intro','q1','reading','q2','q3','end']);
  assert.deepEqual(model.questions.map(q=>q.questionNumber), [1,2,3]);
  assert.equal(model.questions[0].answerText, '0');
  assert.equal(model.questions[2].answerText, 'False');
  assert.deepEqual(model.questions[2].choices.map(c=>c.selected), [false,true]);
  const displayed = mod.deterministicShuffle(blocks[0].responseConfig.options, 'print-fixture:q2');
  assert.deepEqual(model.questions[1].choices.map(c=>c.label), displayed.map(o=>o.label));
  assert.deepEqual(model.questions[1].choices.map(c=>c.selected), displayed.map(o=>['a','c'].includes(o.value)));
  assert.equal(JSON.stringify({blocks, answers}), before, 'printing does not mutate worksheet or answers');
  const html = mod.buildWorksheetPrintReportHtml(model);
  assert.match(html, /<h2>Read first<\/h2>/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  const positions = ['intro','q1','reading','q2','q3','end'].map(id=>html.indexOf(`data-block-id="${id}"`));
  assert(positions.every((position,i)=>position>=0 && (!i || position>positions[i-1])));
  const readingOnly = await mod.buildWorksheetPrintReportModel({viewerPayload:{blocks:[blocks[1],blocks[5]]}});
  assert.equal(readingOnly.questions.length, 0);
  assert.match(mod.buildWorksheetPrintReportHtml(readingOnly), /End of worksheet/);
});

test('long printed choices use flowing layout instead of an unbreakable answer section', async () => {
  const model = await mod.buildWorksheetPrintReportModel({viewerPayload:{blocks:[{
    blockId:'long',kind:'question',prompt:{text:'Select'},responseConfig:{inputType:'multiple_choice',
      options:Array.from({length:20},(_,i)=>({value:String(i),label:'Long option '.repeat(50)}))},
  }]}});
  assert.equal(model.questions[0].layoutMode, 'flow');
  assert.equal(model.questions[0].sectionBreakModes.answer, 'flow');
});

test('buildWorksheetPrintReportModel formats answers, grading, and question images for print', async () => {
  const viewerPayload = {
    title: 'Practice Worksheet',
    subject: 'Mathematics',
    blocks: [
      {
        blockId: 'q_text',
        kind: 'question',
        position: 0,
        prompt: {
          text: 'Explain the pattern.',
          mediaRefs: [
            { usage: 'question_audio', assetId: 'audio_should_be_ignored' },
            { usage: 'question_image', assetId: 'img_1' },
          ],
        },
        responseConfig: { inputType: 'text' },
      },
      {
        blockId: 'q_multi',
        kind: 'question',
        position: 1,
        prompt: { text: 'Choose all prime numbers.' },
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [
            { id: 'opt_a', value: '2', label: 'Two', mediaRefs: [{ usage: 'option_audio', assetId: 'opt_audio_1' }] },
            { id: 'opt_b', value: '4', label: 'Four' },
            { id: 'opt_c', value: '5', label: 'Five' },
          ],
          correctAnswer: ['2', '5'],
        },
      },
      {
        blockId: 'q_bool',
        kind: 'question',
        position: 2,
        prompt: { text: 'The sun rises in the east.' },
        responseConfig: {
          inputType: 'boolean',
          correctAnswer: true,
        },
      },
    ],
  };

  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload,
    answers: {
      q_text: { value: 'It increases by 2 each line.' },
      q_multi: { value: ['5', '2'] },
      q_bool: { value: false },
    },
    studentName: 'Ada Lovelace',
    submittedAt: '2026-04-14T10:15:00Z',
    checkResult: {
      correctCount: 1,
      totalQuestions: 2,
      statusByBlockId: {
        q_multi: 'correct',
        q_bool: 'incorrect',
      },
    },
    storage: {
      localAssets: {
        get: async (assetId) => assetId === 'img_1'
          ? { binary: new Uint8Array([137, 80, 78, 71]), metadata: { mimeType: 'image/png' } }
          : null,
      },
    },
  });

  assert.equal(report.title, 'Practice Worksheet');
  assert.equal(report.schoolName, 'Hong Kong Red Cross Hospital Schools');
  assert.equal(report.subject, 'Mathematics');
  assert.equal(report.studentName, 'Ada Lovelace');
  assert.equal(report.checkedSummary, t('viewer.print.checkedSummary', { correct: 1, total: 2 }));
  assert.equal(report.questions.length, 3);
  assert.equal(report.questions[0].answerText, 'It increases by 2 each line.');
  assert.equal(report.questions[0].image.status, 'ready');
  assert.match(report.questions[0].image.src, /^data:image\/png;base64,/);
  assert.equal(report.questions[0].layoutMode, 'keep-all');
  assert.equal(report.questions[0].sectionBreakModes.prompt, 'keep');
  assert.equal(report.questions[0].sectionBreakModes.answer, 'keep');
  assert.equal(report.questions[1].answerText, 'A. Two\nC. Five');
  assert.equal(report.questions[1].result.label, t('viewer.check.correct'));
  assert.equal(report.questions[2].result.label, t('viewer.check.incorrect'));
  assert.equal(report.questions[2].result.detail, t('viewer.check.reveal.correctAnswer', { answer: 'True' }));
  assert.equal(report.questions[2].sectionBreakModes.checkedAnswer, 'keep');
});

test('buildWorksheetPrintReportModel normalizes unsafe image mime types for data urls', async () => {
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      subject: 'Mathematics',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Prompt', mediaRefs: [{ usage: 'question_image', assetId: 'img_unsafe' }] },
          responseConfig: { inputType: 'text' },
        },
      ],
    },
    storage: {
      localAssets: {
        get: async () => ({
          binary: new Uint8Array([137, 80, 78, 71]),
          metadata: { mimeType: 'image/png" onerror="alert(1)' },
        }),
      },
    },
  });

  assert.equal(report.questions[0].image.status, 'ready');
  assert.match(report.questions[0].image.src, /^data:image\/png;base64,/);
  assert.equal(report.questions[0].image.src.includes('onerror='), false);
});

test('buildWorksheetPrintReportModel normalizes image/jpg to image/jpeg for print data urls', async () => {
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      subject: 'Mathematics',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Prompt', mediaRefs: [{ usage: 'question_image', assetId: 'img_jpg' }] },
          responseConfig: { inputType: 'text' },
        },
      ],
    },
    storage: {
      localAssets: {
        get: async () => ({
          binary: new Uint8Array([255, 216, 255, 224]),
          metadata: { mimeType: 'image/jpg' },
        }),
      },
    },
  });

  assert.equal(report.questions[0].image.status, 'ready');
  assert.match(report.questions[0].image.src, /^data:image\/jpeg;base64,/);
});

test('classifyPrintQuestionLayout uses keep-all, keep-head, and flow thresholds conservatively', async () => {

  assert.equal(mod.classifyPrintQuestionLayout({
    promptText: 'Short prompt',
    answerText: 'Short answer',
    result: null,
    image: null,
  }), 'keep-all');

  assert.equal(mod.classifyPrintQuestionLayout({
    promptText: 'Prompt '.repeat(35),
    answerText: 'Answer',
    result: null,
    image: null,
  }), 'keep-head');

  assert.equal(mod.classifyPrintQuestionLayout({
    promptText: 'Prompt',
    answerText: 'Long answer paragraph '.repeat(30),
    result: { detail: 'Correct answer: Example' },
    image: null,
  }), 'flow');

  assert.equal(mod.classifyPrintQuestionLayout({
    promptText: 'Prompt with image',
    answerText: 'Supporting answer text '.repeat(16),
    result: null,
    image: { status: 'ready', src: 'data:image/png;base64,abc' },
  }), 'keep-head');
});

test('buildWorksheetPrintReportHtml omits empty student row and renders missing image note', async () => {
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      subject: 'Mathematics',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Describe the image.', mediaRefs: [{ usage: 'question_image', assetId: 'missing_img' }] },
          responseConfig: { inputType: 'text' },
        },
      ],
    },
    answers: {},
    studentName: '',
    submittedAt: '2026-04-14T10:15:00Z',
    storage: {
      localAssets: {
        get: async () => null,
      },
    },
  });

  const html = mod.buildWorksheetPrintReportHtml(report);
  assert.equal(html.includes('>Student<'), false);
  assert.equal(html.includes('Hong Kong Red Cross Hospital Schools'), true);
  assert.equal(html.includes(`<dt>${t('viewer.print.meta.subject')}</dt>`), false);
  assert.equal(html.includes('Mathematics'), false);
  assert.equal(html.includes(`<dt>${t('viewer.print.meta.submittedAt')}</dt>`), true);
  assert.equal(html.includes(t('viewer.print.questionImageUnavailable')), true);
  assert.equal(html.includes(t('viewer.print.answerPrefix')), true);
  assert.equal(html.includes(t('viewer.print.notAnswered')), true);
});

test('buildWorksheetPrintReportHtml emits layout-mode classes for print pagination behavior', async () => {
  const html = mod.buildWorksheetPrintReportHtml({
    schoolName: 'School',
    title: 'Worksheet',
    subject: '',
    studentName: '',
    submittedAtLabel: 'April 14, 2026, 18:00',
    checkedSummary: '',
    questions: [
      {
        questionNumber: 1,
        promptText: 'Short prompt',
        answerText: 'Short answer',
        result: null,
        image: null,
        layoutMode: 'keep-all',
        sectionBreakModes: { prompt: 'keep', answer: 'keep', checkedAnswer: null },
      },
      {
        questionNumber: 2,
        promptText: 'Medium prompt',
        answerText: 'Answer',
        result: null,
        image: { status: 'ready', src: 'data:image/png;base64,abc', alt: 'Question image' },
        layoutMode: 'keep-head',
        sectionBreakModes: { prompt: 'keep', answer: 'flow', checkedAnswer: null },
      },
      {
        questionNumber: 3,
        promptText: 'Long prompt',
        answerText: 'Long answer',
        result: { status: 'incorrect', label: 'Incorrect', detail: 'Correct answer: Example' },
        image: null,
        layoutMode: 'flow',
        sectionBreakModes: { prompt: 'flow', answer: 'flow', checkedAnswer: 'keep' },
      },
    ],
  });
  const normalizedHtml = String(html || '').replace(/\r\n/g, '\n');

  assert.equal(normalizedHtml.includes('print-question--keep-all'), true);
  assert.equal(normalizedHtml.includes('print-question--keep-head'), true);
  assert.equal(normalizedHtml.includes('print-question--flow'), true);
  assert.equal(normalizedHtml.includes('print-question-section--prompt'), true);
  assert.equal(normalizedHtml.includes('print-question-section--image print-question-section--flow'), true);
  assert.equal(normalizedHtml.includes('print-question-section--answer'), true);
  assert.equal(normalizedHtml.includes('print-question-section--result'), true);
  assert.equal(normalizedHtml.includes('print-question-section--keep'), true);
  assert.equal(normalizedHtml.includes('print-question-section--flow'), true);
  assert.equal(normalizedHtml.includes(`>${t('viewer.print.questionHeading')}<`), true);
  assert.equal(normalizedHtml.includes(`>${t('viewer.print.checkedResultHeading')}<`), true);
  assert.equal(normalizedHtml.includes('.print-question-section--keep'), true);
  assert.equal(normalizedHtml.includes('break-inside: avoid;'), true);
  assert.equal(normalizedHtml.includes('.print-question-section--image'), true);
  assert.equal(normalizedHtml.includes('break-inside: auto;'), true);
  const mediumPromptIndex = normalizedHtml.indexOf('<div class="print-question-text worksheet-text">Medium prompt</div>');
  const imageSectionIndex = normalizedHtml.indexOf('<section class="print-question-section print-question-section--image print-question-section--flow">');
  assert.equal(mediumPromptIndex >= 0, true);
  assert.equal(imageSectionIndex > mediumPromptIndex, true);
  assert.equal(
    normalizedHtml.slice(mediumPromptIndex, imageSectionIndex).includes('</section>'),
    true
  );
  assert.equal(normalizedHtml.includes('size: A4 portrait;'), true);
  assert.equal(normalizedHtml.includes('max-height: 75mm;'), true);
  assert.equal(normalizedHtml.includes('object-fit: contain;'), true);
  const imageStyle = normalizedHtml.match(/\.print-question-image \{([^}]+)\}/)?.[1];
  assert.ok(imageStyle, 'question image uses the real stylesheet');
  assert.equal(imageStyle.includes('border-radius'), false);
  assert.equal(normalizedHtml.includes('border-top: 1px solid #eceff3;'), false);
  assert.equal(normalizedHtml.includes('border-bottom: 1px solid #dde2e8;'), false);
});



test('buildWorksheetPrintReportHtml includes core print style selectors from stylesheet module', async () => {
  const html = mod.buildWorksheetPrintReportHtml({
    schoolName: 'School',
    title: 'Worksheet',
    subject: '',
    studentName: '',
    submittedAtLabel: '',
    checkedSummary: '',
    questions: [],
  });

  assert.equal(html.includes('.print-header'), true);
  assert.equal(html.includes('.print-school'), true);
  assert.equal(html.includes('.print-title'), true);
  assert.equal(html.includes('.print-meta'), true);
});
test('buildWorksheetPrintReportHtml escapes image src attributes', async () => {
  const html = mod.buildWorksheetPrintReportHtml({
    schoolName: 'School',
    title: 'Worksheet',
    subject: '',
    studentName: '',
    submittedAtLabel: '',
    checkedSummary: '',
    questions: [
      {
        questionNumber: 1,
        promptText: 'Prompt',
        answerText: 'Answer',
        result: null,
        image: { status: 'ready', src: 'data:image/png;base64,abc" onerror="alert(1)', alt: 'Question image' },
        layoutMode: 'keep-all',
        sectionBreakModes: { prompt: 'keep', answer: 'keep', checkedAnswer: null },
      },
    ],
  });
  assert.equal(html.includes('onerror="alert(1)"'), false);
  assert.equal(html.includes('&quot; onerror=&quot;alert(1)'), true);
});

test('buildWorksheetPrintReportModel formats selected multiple-choice answers with option prefixes in option order', async () => {
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: 'Choose one.' },
          responseConfig: {
            inputType: 'multiple_choice',
            selectionMode: 'single',
            options: [
              { value: 'raw_a', label: 'Respiration' },
              { value: 'raw_b', label: 'Photosynthesis' },
            ],
          },
        },
        {
          blockId: 'q2',
          kind: 'question',
          position: 1,
          prompt: { text: 'Choose colours.' },
          responseConfig: {
            inputType: 'multiple_choice',
            selectionMode: 'multi',
            options: [
              { value: 'r', label: 'Red' },
              { value: 'b', label: 'Blue' },
              { value: 'g', label: 'Green' },
            ],
          },
        },
      ],
    },
    answers: {
      q1: { value: 'raw_b' },
      q2: { value: ['g', 'r'] },
    },
    submittedAt: '2026-05-01T06:35:00.000Z',
  });

  assert.equal(report.questions[0].answerText, 'B. Photosynthesis');
  assert.equal(report.questions[1].answerText, 'A. Red\nC. Green');
  assert.equal(report.questions[0].answerText.includes('raw_b'), false);
});

test('buildWorksheetPrintReportHtml records missing submitted timestamp without attempt id', async () => {
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      blocks: [{
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1' },
        responseConfig: { inputType: 'text' },
      }],
    },
    answers: { q1: { value: 'Answer' } },
    schoolName: 'School',
  });
  const html = mod.buildWorksheetPrintReportHtml(report);

  assert.equal(html.includes(t('viewer.print.meta.submittedAt')), true);
  assert.equal(html.includes(t('common.values.notRecorded')), true);
  assert.equal(html.includes('attempt_'), false);
  assert.equal(html.includes('Local attempt ID'), false);
});

test('buildWorksheetPrintReportModel marks oversized sections as flow to allow internal page breaks', async () => {
  const longPrompt = `Prompt line\n`.repeat(90);
  const longAnswer = `Answer line\n`.repeat(110);
  const report = await mod.buildWorksheetPrintReportModel({
    viewerPayload: {
      title: 'Worksheet',
      blocks: [
        {
          blockId: 'q1',
          kind: 'question',
          position: 0,
          prompt: { text: longPrompt },
          responseConfig: { inputType: 'text', correctAnswer: 'expected answer' },
        },
      ],
    },
    answers: { q1: { value: longAnswer } },
    checkResult: {
      correctCount: 0,
      totalQuestions: 1,
      statusByBlockId: { q1: 'incorrect' },
    },
  });

  assert.equal(report.questions[0].sectionBreakModes.prompt, 'flow');
  assert.equal(report.questions[0].sectionBreakModes.answer, 'flow');
  assert.equal(report.questions[0].sectionBreakModes.checkedAnswer, 'keep');
});

test('print keeps leading Markdown whitespace and therefore matches viewer formatting', async () => {
  const report = await mod.buildWorksheetPrintReportModel({ viewerPayload: { title: 'T', blocks: [{ blockId: 'q', kind: 'question', prompt: { text: '  ## Literal heading', format: 'limited-markdown-v1' }, responseConfig: { inputType: 'text' } }] }, answers: {} });
  assert.equal(report.questions[0].promptText, '  ## Literal heading');
  assert.ok(mod.buildWorksheetPrintReportHtml(report).includes('<p>  ## Literal heading</p>'));
});


test('statically imported report builders follow locale changes without mutating attempt data', async () => {
  const previousLocale = getLocale();
  const input = {
    viewerPayload: { title: 'Local worksheet', blocks: [{
      blockId: 'q', kind: 'question', position: 0,
      prompt: { text: 'A question' }, responseConfig: { inputType: 'text' },
    }] },
    answers: { q: { value: 'Student answer' } },
    studentName: '<Learner & family>',
  };
  const before = structuredClone(input);
  try {
    for (const locale of ['en', 'zh-Hant', 'en']) {
      setLocale(locale, { persist: false });
      const report = await mod.buildWorksheetPrintReportModel(input);
      const html = mod.buildWorksheetPrintReportHtml(report);
      assert.equal(report.locale, locale);
      assert.equal(report.schoolName, locale === 'en'
        ? 'Hong Kong Red Cross Hospital Schools' : '香港紅十字會醫院學校');
      assert.ok(html.includes(`<html lang="${locale}">`));
      assert.ok(html.includes(`<h3>${t('viewer.print.answerHeading')}</h3>`));
      assert.ok(html.includes('&lt;Learner &amp; family&gt;'));
      assert.deepEqual(input, before);
    }
  } finally {
    setLocale(previousLocale, { persist: false });
  }
});
