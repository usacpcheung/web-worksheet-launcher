import { translate } from '../i18n.js';

function getClampedPercent(value) {
  return Math.max(0, Math.min(1, Number(value))) * 100;
}

function getPointerPosition(frame, event) {
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

export function renderScenePreview(hostEl, scene, actions) {
  hostEl.innerHTML = '';
  hostEl.classList.add('scene-preview');

  if (!scene) {
    const empty = document.createElement('p');
    empty.className = 'scene-preview__empty';
    empty.textContent = translate('editor.scenePreview.noScene');
    hostEl.appendChild(empty);
    return;
  }

  const speechBubble = scene.speechBubble || { enabled: false, anchors: [] };
  const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];

  const header = document.createElement('div');
  header.className = 'scene-preview__header';
  const title = document.createElement('h3');
  title.textContent = translate('editor.scenePreview.title', { sceneId: scene.id });
  header.appendChild(title);
  if (speechBubble.enabled) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = translate('editor.scenePreview.anchorHint');
    header.appendChild(hint);
  }
  hostEl.appendChild(header);

  const stage = document.createElement('div');
  stage.className = 'scene-preview__stage';

  const frame = document.createElement('div');
  frame.className = scene.image?.objectUrl
    ? 'scene-preview__frame'
    : 'scene-preview__frame scene-preview__frame--empty';
  frame.setAttribute('role', speechBubble.enabled ? 'group' : 'img');
  frame.setAttribute('aria-label', translate('editor.scenePreview.stageLabel', { sceneId: scene.id }));

  if (scene.image?.objectUrl) {
    const img = document.createElement('img');
    img.src = scene.image.objectUrl;
    img.alt = translate('inspector.image.previewAlt', { sceneId: scene.id });
    frame.appendChild(img);
  } else {
    const emptyStage = document.createElement('span');
    emptyStage.className = 'scene-preview__empty-stage';
    emptyStage.textContent = translate('editor.scenePreview.noImage');
    frame.appendChild(emptyStage);
  }

  if (speechBubble.enabled) {
    frame.addEventListener('click', (event) => {
      const point = getPointerPosition(frame, event);
      if (!point) return;
      actions.onAddOrMoveSpeechBubbleAnchor?.(scene.id, point);
    });

    anchors.forEach((anchor) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'scene-preview__anchor-marker';
      if (actions.isSpeechBubbleAnchorSelected?.(anchor.id)) {
        marker.classList.add('is-selected');
      }
      marker.textContent = anchor.label || '';
      marker.style.left = `${getClampedPercent(anchor.x)}%`;
      marker.style.top = `${getClampedPercent(anchor.y)}%`;
      marker.setAttribute('aria-label', translate('inspector.speechBubble.selectAnchor', { label: anchor.label || anchor.id }));
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        actions.onSelectSpeechBubbleAnchor?.(scene.id, anchor.id);
      });
      frame.appendChild(marker);
    });
  }

  stage.appendChild(frame);
  hostEl.appendChild(stage);
}
