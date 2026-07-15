import { computeSceneGraphLayout } from '../editor/graph.js';
import { SceneType } from '../model.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMultiline(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}

function getSpeakerName(project, line) {
  if (!line?.speakerId) return '';
  const speaker = (project?.speakers || []).find(candidate => candidate.id === line.speakerId);
  return String(speaker?.name || '').trim();
}

function getSceneTypeRank(scene) {
  if (scene?.type === SceneType.START) return 0;
  if (scene?.type === SceneType.END) return 2;
  return 1;
}

export function buildDiscussionPrintModel(project, discussionSnapshot = {}) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  const layout = computeSceneGraphLayout(project);
  const discussionBySceneId = discussionSnapshot?.discussionBySceneId || {};

  const cards = Object.entries(discussionBySceneId)
    .map(([sceneId, entry]) => {
      const text = String(entry?.text || '');
      const scene = sceneById.get(sceneId);
      if (!scene || !text.trim()) return null;
      const position = layout.positions.get(sceneId) || { row: 9999, column: 9999 };
      return {
        sceneId,
        title: scene.id,
        type: scene.type,
        sort: {
          row: position.row,
          column: position.column,
          typeRank: getSceneTypeRank(scene),
        },
        image: scene.image?.objectUrl ? { src: scene.image.objectUrl, alt: scene.id } : null,
        dialogue: (scene.dialogue || [])
          .map(line => ({
            speaker: getSpeakerName(project, line),
            text: String(line?.text || '').trim(),
          }))
          .filter(line => line.text),
        choices: (scene.choices || [])
          .map(choice => String(choice?.label || '').trim())
          .filter(Boolean),
        discussionText: text,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (
      a.sort.row - b.sort.row
      || a.sort.column - b.sort.column
      || a.sort.typeRank - b.sort.typeRank
      || a.sceneId.localeCompare(b.sceneId)
    ));

  return {
    title: String(project?.meta?.title || 'RolePlayScene Discussion'),
    cards,
  };
}

export function buildDiscussionPrintHtml(model, labels = {}, details = {}) {
  const title = model?.title || 'RolePlayScene Discussion';
  const cards = Array.isArray(model?.cards) ? model.cards : [];
  const schoolName = String(details?.schoolName || labels.defaultSchoolName || '').trim();
  const studentName = String(details?.studentName || '').trim();
  const printedAt = String(details?.printedAt || '').trim();
  const reportTitle = `${title} - ${labels.reportTitle || 'Discussion Report'}`;
  const studentLabel = labels.student || 'Name';
  const dateLabel = labels.date || 'Date';
  const cardHtml = cards.map((card, index) => {
    const imageHtml = card.image
      ? `<div class="discussion-print-image"><img src="${escapeHtml(card.image.src)}" alt="${escapeHtml(card.image.alt || '')}"></div>`
      : '';
    const dialogueHtml = card.dialogue.length
      ? `<section><h3>${escapeHtml(labels.dialogue || 'Dialogue')}</h3>${card.dialogue.map(line => (
        `<p>${line.speaker ? `<strong>${escapeHtml(line.speaker)}:</strong> ` : ''}${formatMultiline(line.text)}</p>`
      )).join('')}</section>`
      : '';
    const choicesHtml = card.choices.length
      ? `<section><h3>${escapeHtml(labels.choices || 'Choices')}</h3><ul>${card.choices.map(choice => `<li>${formatMultiline(choice)}</li>`).join('')}</ul></section>`
      : '';
    return `
      <article class="discussion-print-card ${card.image ? '' : 'discussion-print-card--no-image'}">
        <header>
          <span>${index + 1}</span>
          <h2>${escapeHtml(card.title)}</h2>
        </header>
        <div class="discussion-print-grid">
          ${imageHtml}
          <div class="discussion-print-context">${dialogueHtml}${choicesHtml}</div>
          <section class="discussion-print-answer">
            <h3>${escapeHtml(labels.discussion || 'Discussion')}</h3>
            <p>${formatMultiline(card.discussionText)}</p>
          </section>
        </div>
      </article>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(reportTitle)}</title>
  <style>
    @page { size: A4 portrait; margin: 14mm 12mm 16mm; }
    :root { color-scheme: light; font-family: "Georgia", "Times New Roman", serif; color: #111; background: #fff; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; background: #fff; font-size: 10.5pt; line-height: 1.4; }
    .discussion-print-report { display: grid; gap: 5mm; width: 100%; }
    .discussion-print-header { border-bottom: 0.3mm solid #cfd5de; padding-bottom: 2.5mm; margin-bottom: 1mm; break-after: avoid; }
    .discussion-print-school { margin: 0 0 1.2mm; text-align: center; font-size: 17pt; line-height: 1.2; font-weight: 700; }
    .discussion-print-title { margin: 0 0 2.4mm; text-align: center; font-size: 15.5pt; line-height: 1.2; font-weight: 700; }
    .discussion-print-meta { display: flex; justify-content: space-between; gap: 8mm; margin: 0; font-size: 10.5pt; }
    .discussion-print-meta span { overflow-wrap: anywhere; }
    .discussion-print-card { break-inside: avoid; page-break-inside: avoid; border: 0.25mm solid #d1d5db; border-radius: 2mm; padding: 3mm; display: grid; gap: 2.5mm; }
    .discussion-print-card header { display: flex; align-items: center; gap: 2mm; border-bottom: 0.25mm solid #e5e7eb; padding-bottom: 2mm; break-after: avoid; }
    .discussion-print-card header span { width: 6mm; height: 6mm; display: inline-grid; place-items: center; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-weight: 700; font-size: 8pt; }
    .discussion-print-card h2 { margin: 0; font-size: 12pt; }
    .discussion-print-card h3 { margin: 0 0 1mm; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #444; break-after: avoid; }
    .discussion-print-grid { display: grid; grid-template-columns: 26mm 1fr 1.45fr; gap: 3mm; align-items: start; }
    .discussion-print-card--no-image .discussion-print-grid { grid-template-columns: 1fr 1.55fr; }
    .discussion-print-image img { width: 100%; max-height: 32mm; object-fit: contain; border-radius: 1.5mm; border: 0.25mm solid #e5e7eb; background: #f9fafb; }
    .discussion-print-context, .discussion-print-answer { display: grid; gap: 2mm; min-width: 0; }
    .discussion-print-context p, .discussion-print-answer p { margin: 0; font-size: 9.5pt; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
    .discussion-print-context ul { margin: 0; padding-left: 4.5mm; font-size: 9.5pt; line-height: 1.4; }
    .discussion-print-answer p { font-size: 10.2pt; white-space: pre-wrap; }
    .discussion-print-empty { margin: 0; font-size: 11pt; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <main class="discussion-print-report">
    <header class="discussion-print-header">
      ${schoolName ? `<p class="discussion-print-school">${escapeHtml(schoolName)}</p>` : ''}
      <h1 class="discussion-print-title">${escapeHtml(reportTitle)}</h1>
      <p class="discussion-print-meta">
        <span><strong>${escapeHtml(studentLabel)}:</strong> ${studentName ? escapeHtml(studentName) : '____________________'}</span>
        <span><strong>${escapeHtml(dateLabel)}:</strong> ${escapeHtml(printedAt)}</span>
      </p>
    </header>
    ${cardHtml || `<p class="discussion-print-empty">${escapeHtml(labels.empty || 'No discussion text yet.')}</p>`}
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

      waitForImages.then(() => {
        if (typeof window.focus === 'function') window.focus();
        if (typeof window.print === 'function') window.print();
      });

      window.addEventListener('afterprint', () => {
        if (typeof window.close === 'function') window.close();
      });
    }());
  </script>
</body>
</html>`;
}
