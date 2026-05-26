import { BubbleMode } from '../model.js';
import { translate } from '../i18n.js';

export const DIALOGUE_MIN_AUDIO_PAGE_SECONDS = 1;
export const DIALOGUE_CHARACTER_PAGE_UNITS = 36;
export const DIALOGUE_NARRATION_PAGE_UNITS = 80;
export const DIALOGUE_NO_AUDIO_MIN_SECONDS = 2;
export const DIALOGUE_NO_AUDIO_MAX_SECONDS = 8;

export function getWeightedTextLength(text) {
  return Array.from(String(text || '')).reduce((total, char) => {
    if (/\s/.test(char) || /[，、,.:;；。！？!?]/.test(char)) return total + 0.25;
    if (/[\x00-\x7F]/.test(char)) return total + 0.55;
    return total + 1;
  }, 0);
}

function splitByLimit(text, limit) {
  const source = String(text || '').trim();
  if (!source) return [''];
  if (getWeightedTextLength(source) <= limit) return [source];

  const breakPatterns = [/\n+/, /(?<=[。！？!?；;])/, /(?<=[，、,:])/, /\s+/];
  for (const pattern of breakPatterns) {
    const chunks = source.split(pattern).map(chunk => chunk.trim()).filter(Boolean);
    if (chunks.length <= 1) continue;
    const pages = [];
    let current = '';
    for (const chunk of chunks) {
      const candidate = current ? `${current}${pattern.source === '\\s+' ? ' ' : ''}${chunk}` : chunk;
      if (current && getWeightedTextLength(candidate) > limit) {
        pages.push(current);
        current = chunk;
      } else {
        current = candidate;
      }
    }
    if (current) pages.push(current);
    if (pages.every(page => getWeightedTextLength(page) <= limit * 1.2)) {
      return pages;
    }
  }

  const pages = [];
  let current = '';
  for (const char of Array.from(source)) {
    const candidate = current + char;
    if (current && getWeightedTextLength(candidate) > limit) {
      pages.push(current.trim());
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pages.push(current.trim());
  return pages.length ? pages : [source];
}

export function splitDialogueText(text, mode = BubbleMode.CENTER) {
  const limit = mode === BubbleMode.CENTER
    ? DIALOGUE_NARRATION_PAGE_UNITS
    : DIALOGUE_CHARACTER_PAGE_UNITS;
  return splitByLimit(text, limit);
}

export function estimateReadingSeconds(page) {
  const units = getWeightedTextLength(page);
  return Math.max(
    DIALOGUE_NO_AUDIO_MIN_SECONDS,
    Math.min(DIALOGUE_NO_AUDIO_MAX_SECONDS, 1.4 + units * 0.08),
  );
}

export function getLineAudioDurationSeconds(line, pages) {
  const direct = Number(line?.audio?.durationSeconds ?? line?.audio?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Math.max(
    pages.length * DIALOGUE_MIN_AUDIO_PAGE_SECONDS,
    pages.reduce((total, page) => total + estimateReadingSeconds(page), 0),
  );
}

export function hasDialogueLineContent(line) {
  return Boolean(String(line?.text || '').trim() || line?.audio?.objectUrl);
}

export function getDialoguePageText(line, index) {
  return line?.text || translate('player.dialogue.lineFallback', { index: index + 1 });
}
