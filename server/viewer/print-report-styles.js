export const PRINT_REPORT_CSS = `
    @page {
      size: A4 portrait;
      margin: 16mm 14mm 18mm 14mm;
    }

    :root {
      color-scheme: light;
      font-family: "Georgia", "Times New Roman", serif;
      color: #111;
      background: #fff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: #111;
      background: #fff;
      font-size: 11.5pt;
      line-height: 1.45;
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

    .print-question {
      margin: 0 0 9mm;
      padding: 0 0 4mm;
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
      margin-bottom: 3mm;
    }

    .print-question-number {
      font-size: 13pt;
      font-weight: 700;
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
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #444;
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
