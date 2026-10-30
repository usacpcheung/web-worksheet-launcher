export const PRINT_REPORT_CSS = `
    @import url("${new URL('../app/fonts/worksheet-chinese.css', import.meta.url).href}");
    @page {
      size: A4 portrait;
      margin: 16mm 14mm 18mm 14mm;
    }

    :root {
      color-scheme: light;
      font-family: "Worksheet Chinese", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #20344d;
      background: #fff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: #20344d;
      background: #fff;
      font-size: 11.5pt;
      line-height: 1.65;
    }

    .print-report {
      width: 100%;
    }

    .print-header {
      border-bottom: 0.3mm solid #cfd5de;
      padding-bottom: 2.5mm;
      margin-bottom: 5mm;
      break-after: avoid;
    }

    .print-school {
      margin: 0 0 1.2mm;
      text-align: center;
      font-size: 17pt;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .print-title {
      margin: 0 0 2.4mm;
      text-align: center;
      font-size: 15.5pt;
      line-height: 1.2;
      font-weight: 700;
    }

    .print-meta {
      display: grid;
      grid-template-columns: minmax(24mm, 30mm) 1fr;
      column-gap: 3mm;
      row-gap: 1.2mm;
      margin: 0;
    }

    .print-meta-item {
      display: contents;
    }

    .print-meta-item dt {
      margin: 0;
      font-weight: 700;
    }

    .print-meta-item dd {
      margin: 0;
      font-weight: 400;
    }

    .print-question, .print-content {
      margin: 0 0 7mm;
      padding: 7mm 0 7mm 12mm;
      border-bottom: 0.25mm solid #dce6f5;
      background: transparent;
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question--keep-all,
    .print-question--keep-head,
    .print-question--flow {
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question-header {
      break-after: avoid;
      page-break-after: avoid;
      margin: 0;
      height: 0;
    }

    .print-question-number {
      position: relative;
      margin: 0;
      font-size: 9pt;
      font-weight: 500;
      color: #256ac4;
    }

    .print-question-ordinal {
      position: absolute;
      right: calc(100% + 3mm);
      top: -1.5mm;
      font-size: 22pt;
      line-height: 1.2;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
    }

    .print-question-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 7mm;
      align-items: start;
    }

    .print-question--flow .print-question-layout {
      display: block;
    }

    .print-question--flow .print-answer-area {
      margin-top: 5mm;
    }

    .print-prompt-area, .print-answer-area {
      min-width: 0;
    }

    .print-content-text {
      overflow-wrap: anywhere;
      line-height: 1.8;
    }

    .print-question-section--prompt > h3 {
      display: none;
    }

    .print-answer-text {
      border: 0.25mm solid #c8d7e0;
      border-radius: 3mm;
      background: #f8fbff;
      padding: 4mm;
      min-height: 15mm;
      overflow-wrap: anywhere;
    }

    .print-choices {
      display: flex;
      flex-direction: column;
      gap: 2.5mm;
      margin-bottom: 3mm;
    }

    .print-choice {
      display: flex;
      align-items: baseline;
      gap: 2.5mm;
      border: 0.25mm solid #cbd8e1;
      border-radius: 3mm;
      padding: 3mm;
      break-inside: avoid;
    }

    .print-choice-label {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .print-choice-prefix, .print-choice-mark {
      flex: none;
      font-weight: 600;
    }

    .print-choice-mark { min-width: 3mm; }
    .print-choice.is-selected { background: #edf5ff; border-color: #256ac4; }
    .print-choices--boolean { flex-direction: row; }
    .print-choices--boolean .print-choice { flex: 1; min-width: 0; }
    .print-choice.is-selected[data-boolean-value="true"] { background: #e8f6ee; border-color: #88ba9b; }
    .print-choice.is-selected[data-boolean-value="false"] { background: #fbeff0; border-color: #d5a3ab; }

    .print-choices + .print-answer-text {
      padding: 0;
      border: 0;
      border-radius: 0;
      min-height: 0;
      background: transparent;
      font-size: 9pt;
    }

    .print-question-section {
      margin-top: 0;
      padding-top: 0;
    }

    .print-question-section + .print-question-section {
      margin-top: 4.5mm;
      padding-top: 0;
    }

    .print-question-section--keep {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .print-question-section--flow {
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question-section--image {
      break-inside: auto;
      page-break-inside: auto;
    }

    .print-question-section h3 {
      margin: 0 0 2mm;
      font-size: 10pt;
      font-weight: 400;
      color: #526985;
      break-after: avoid;
      page-break-after: avoid;
    }

    .print-question-text,
    .print-answer-text,
    .print-result-detail,
    .print-question-media-note,
    .print-result-label {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .print-question-text { font-size: 14pt; font-weight: 450; line-height: 1.55; overflow-wrap: anywhere; }

    .print-question-image-wrap {
      margin-top: 0;
    }

    .print-question-image {
      display: block;
      max-width: 100%;
      max-height: 75mm;
      object-fit: contain;
      border: 1px solid #d7dbe2;
    }

    .print-question-media-note {
      color: #666;
      font-style: italic;
    }

    .print-question-section--result .print-result-label {
      margin-bottom: 1.5mm;
    }

    .print-result-correct .print-result-label {
      font-weight: 700;
    }

    .print-result-incorrect .print-result-label,
    .print-result-ungraded_missing_or_invalid_key .print-result-label {
      font-weight: 700;
    }

    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
`;
