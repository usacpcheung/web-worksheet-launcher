import { BubbleMode, MAX_SPEECH_BUBBLE_ANCHORS, SceneType } from '../model.js';

function hasDialogueContent(line) {
  return Boolean(String(line?.text || '').trim() || line?.audio);
}

export function validateProject(project) {
  const errors = [];
  const warnings = [];

  if (!project || !Array.isArray(project.scenes)) {
    return { errors: ['Project scenes are missing.'], warnings };
  }

  const scenes = project.scenes;
  const sceneIds = new Set(scenes.map(scene => scene.id));
  const speakerIds = new Set((Array.isArray(project.speakers) ? project.speakers : [])
    .map(speaker => speaker?.id)
    .filter(Boolean));
  const seenSceneIds = new Set();
  for (const [index, scene] of scenes.entries()) {
    const sceneId = typeof scene?.id === 'string' ? scene.id.trim() : '';
    if (!sceneId) {
      errors.push(`Scene ${index + 1} is missing an ID.`);
      continue;
    }
    if (seenSceneIds.has(sceneId)) {
      errors.push(`Scene ID "${sceneId}" is duplicated.`);
    }
    seenSceneIds.add(sceneId);
  }

  const startScenes = scenes.filter(scene => scene.type === SceneType.START);
  if (startScenes.length !== 1) {
    errors.push(`Project must have exactly 1 start scene (found ${startScenes.length}).`);
  }

  const endScenes = scenes.filter(scene => scene.type === SceneType.END);
  if (endScenes.length < 1) {
    errors.push('Project must have at least 1 end scene.');
  } else if (endScenes.length > 3) {
    errors.push(`Project can have at most 3 end scenes (found ${endScenes.length}).`);
  }

  if (scenes.length === 0 || scenes.length > 20) {
    errors.push(`Project must have between 1 and 20 scenes (found ${scenes.length}).`);
  }

  for (const scene of scenes) {
    const sceneChoices = Array.isArray(scene.choices) ? scene.choices : [];
    if (sceneChoices.length > 3) {
      errors.push(`Scene "${scene.id}" has ${sceneChoices.length} choices; maximum is 3.`);
    }

    sceneChoices.forEach((choice, idx) => {
      if (!choice.nextSceneId) {
        errors.push(`Choice ${idx + 1} in scene "${scene.id}" is missing a destination.`);
        return;
      }
      if (!sceneIds.has(choice.nextSceneId)) {
        errors.push(`Choice "${choice.label || `#${idx + 1}`}" in scene "${scene.id}" links to missing scene "${choice.nextSceneId}".`);
      }
    });

    const autoNext = scene.autoNextSceneId ?? null;
    if (autoNext) {
      if (scene.type === SceneType.END) {
        errors.push(`End scene "${scene.id}" cannot auto-advance to "${autoNext}".`);
      } else if (sceneChoices.length > 0) {
        errors.push(`Scene "${scene.id}" cannot have both choices and an auto-advance destination.`);
      }
      if (!sceneIds.has(autoNext)) {
        errors.push(`Scene "${scene.id}" auto-advances to missing scene "${autoNext}".`);
      }
    }

    if (scene.type === SceneType.END && sceneChoices.length > 0) {
      warnings.push(`End scene "${scene.id}" should not have outgoing choices.`);
    }

    (scene.dialogue || []).forEach((line, idx) => {
      if (line?.speakerId && !speakerIds.has(line.speakerId)) {
        warnings.push(`Dialogue line ${idx + 1} in scene "${scene.id}" is assigned to a missing speaker.`);
      }
    });

    const speechBubble = scene.speechBubble || {};
    if (speechBubble.enabled === true) {
      const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];
      if (anchors.length > MAX_SPEECH_BUBBLE_ANCHORS) {
        warnings.push(`Scene "${scene.id}" has more than ${MAX_SPEECH_BUBBLE_ANCHORS} speech bubble anchors.`);
      }
      const anchorIds = new Set(anchors.map(anchor => anchor.id).filter(Boolean));
      const visibleLines = (scene.dialogue || []).filter(line => (
        hasDialogueContent(line) && line.bubble?.mode !== BubbleMode.HIDDEN
      ));
      if (visibleLines.length === 0) {
        warnings.push(`Scene "${scene.id}" has speech bubble mode enabled but no visible dialogue lines.`);
      }
      anchors.forEach((anchor) => {
        const used = (scene.dialogue || []).some(line => (
          line.bubble?.mode === BubbleMode.ANCHOR && line.bubble.anchorId === anchor.id
        ));
        if (!used) {
          warnings.push(`Speech bubble anchor "${anchor.label || anchor.id}" in scene "${scene.id}" is not used by any dialogue line.`);
        }
      });
      (scene.dialogue || []).forEach((line, idx) => {
        if (!hasDialogueContent(line)) return;
        const mode = line.bubble?.mode || BubbleMode.CENTER;
        if (mode === BubbleMode.HIDDEN) {
          warnings.push(`Dialogue line ${idx + 1} in scene "${scene.id}" is hidden from speech bubble mode.`);
        } else if (mode === BubbleMode.ANCHOR && !anchorIds.has(line.bubble?.anchorId)) {
          warnings.push(`Dialogue line ${idx + 1} in scene "${scene.id}" is assigned to a missing speech bubble anchor.`);
        }
      });
    }
  }

  if (startScenes.length === 1) {
    const reachable = new Set();
    const queue = [startScenes[0].id];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (reachable.has(currentId)) continue;
      reachable.add(currentId);
      const scene = scenes.find(s => s.id === currentId);
      if (!scene) continue;
      for (const choice of scene.choices || []) {
        if (choice.nextSceneId && sceneIds.has(choice.nextSceneId)) {
          queue.push(choice.nextSceneId);
        }
      }
      if (scene.autoNextSceneId && sceneIds.has(scene.autoNextSceneId)) {
        queue.push(scene.autoNextSceneId);
      }
    }

    for (const scene of scenes) {
      if (!reachable.has(scene.id)) {
        errors.push(`Scene "${scene.id}" is unreachable from the Start scene.`);
      }
    }
  }

  return { errors, warnings };
}
