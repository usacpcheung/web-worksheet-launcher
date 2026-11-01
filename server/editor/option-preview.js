import { createChoiceButtonGroup, applyChoiceButtonGroupState } from '../viewer/choice-button-group.js';
import { normalizeAudioTracks } from './audio-tracks.js';
import { setWorksheetText } from '../app/worksheet-text.js';
import { t } from '../app/i18n/index.js';
export function showOptionPreview(block, session) {
  const controller = new AbortController();
  const opener = document.activeElement;
  const dialog = document.createElement('dialog'); dialog.className = 'editor-option-preview-dialog';
  dialog.setAttribute('aria-label', t('optionImages.preview'));
  const close = document.createElement('button'); close.type = 'button'; close.className = 'media-action-btn'; close.textContent = t('common.actions.close'); close.onclick = () => dialog.close();
  const host = document.createElement('div'); const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('../viewer/main.css', import.meta.url).href;
  const style = document.createElement('style'); style.textContent = ':host{display:block;color:#253c59;font:16px/1.6 "Worksheet Chinese",system-ui,sans-serif}.viewer-shell{display:block;min-height:0;padding:0}.question-card{padding:20px;margin:0}.question-card__prompt-label{margin-bottom:20px}.preview-audio{display:flex;flex-direction:column;gap:4px}.preview-audio select{width:44px}';
  const shell = document.createElement('div'); shell.className = 'viewer-shell';
  const card = document.createElement('div'); card.className = 'question-card';
  const prompt = document.createElement('div'); prompt.className = 'question-card__prompt-label worksheet-text'; prompt.id = 'option-preview-prompt'; setWorksheetText(prompt, block.prompt);
  const previewSession = { storage: session.storage, state: { answers: {} }, setAnswer(id, value) { this.state.answers[id] = { value }; } };
  let group;
  const createAudio = ({ audioTracks, legacyAudioRef }) => {
    const tracks = normalizeAudioTracks(audioTracks);
    if (!tracks.length && legacyAudioRef) tracks.push({ assetId: legacyAudioRef.assetId, language: 'cantonese' });
    if (!tracks.length) return null;
    const root = document.createElement('div'); root.className = 'preview-audio';
    const select = document.createElement('select'); select.setAttribute('aria-label', t('viewer.audio.chooseOptionAudioLanguageAriaLabel'));
    tracks.forEach(track => { const o = document.createElement('option'); o.value = track.assetId; o.textContent = t(`editor.media.audioTracks.languages.${track.language}`); select.append(o); });
    if (tracks.length > 1) root.append(select);
    const play = document.createElement('button'); play.type = 'button'; play.className = 'viewer-option-enlarge';
    let playing = false;
    const idle = () => { playing = false; play.textContent = '▷'; play.setAttribute('aria-label', t('editor.media.actions.play')); };
    idle();
    play.onclick = async () => {
      if (playing) { session.stopPreviewAudio(); idle(); return; }
      playing = true; play.textContent = '□'; play.setAttribute('aria-label', t('viewer.audio.stopOptionAudioAriaLabel'));
      const result = await session.playAssetAudio(select.value, { onEnded: idle, onError: idle, onInterrupted: idle });
      if (controller.signal.aborted) session.stopPreviewAudio();
      if (!result.ok) idle();
    };
    select.onchange = () => { session.stopPreviewAudio(); idle(); }; root.append(play); return root;
  };
  group = createChoiceButtonGroup({ block, labelId: prompt.id, controlId: 'option-preview', optionSource: block.responseConfig.options,
    session: previewSession, signal: controller.signal, reportMediaFeedback: () => {}, createViewerAudioControl: createAudio,
    updateSummary: () => applyChoiceButtonGroupState(group, previewSession.state.answers[block.blockId]?.value, block.responseConfig.selectionMode) });
  card.append(prompt, group); shell.append(card); shadow.append(link, style, shell); dialog.append(close, host); document.body.append(dialog);
  const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  dialog.addEventListener('close', () => { controller.abort(); session.stopPreviewAudio(); dialog.remove(); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
  dialog.showModal();
}
