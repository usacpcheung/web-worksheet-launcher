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

export function buildDiscussionPrintHtml(model, labels = {}) {
  const title = model?.title || 'RolePlayScene Discussion';
  const cards = Array.isArray(model?.cards) ? model.cards : [];
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
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #111827; background: #fff; }
    .discussion-print-report { display: grid; gap: 16px; }
    .discussion-print-title { margin: 0 0 8px; font-size: 22px; }
    .discussion-print-card { break-inside: avoid; border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; display: grid; gap: 10px; }
    .discussion-print-card header { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
    .discussion-print-card header span { width: 24px; height: 24px; display: inline-grid; place-items: center; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-weight: 700; font-size: 12px; }
    .discussion-print-card h2 { margin: 0; font-size: 16px; }
    .discussion-print-card h3 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #4b5563; }
    .discussion-print-grid { display: grid; grid-template-columns: 1.1in minmax(1.8in, .85fr) minmax(2.6in, 1.35fr); gap: 12px; align-items: start; }
    .discussion-print-card--no-image .discussion-print-grid { grid-template-columns: minmax(2in, .9fr) minmax(2.8in, 1.4fr); }
    .discussion-print-image img { width: 100%; max-height: 1.25in; object-fit: contain; border-radius: 6px; border: 1px solid #e5e7eb; background: #f9fafb; }
    .discussion-print-context, .discussion-print-answer { display: grid; gap: 8px; }
    .discussion-print-context p, .discussion-print-answer p { margin: 0; font-size: 12px; line-height: 1.45; white-space: normal; }
    .discussion-print-context ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.45; }
    .discussion-print-answer p { font-size: 13px; }
    @media (max-width: 720px) {
      .discussion-print-grid, .discussion-print-card--no-image .discussion-print-grid { grid-template-columns: 1fr; }
      .discussion-print-image img { width: 140px; }
    }
    @media print {
      body { padding: 12mm; }
      .discussion-print-card { break-inside: avoid; page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="discussion-print-report">
    <h1 class="discussion-print-title">${escapeHtml(title)} - ${escapeHtml(labels.reportTitle || 'Discussion Report')}</h1>
    ${cardHtml || `<p>${escapeHtml(labels.empty || 'No discussion text yet.')}</p>`}
  </main>
  <script>
    window.addEventListener('load', () => {
      window.focus();
      window.print();
    });
  </script>
</body>
</html>`;
}
