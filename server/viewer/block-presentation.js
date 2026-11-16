import { setWorksheetText } from '../app/worksheet-text.js';
import { isFillInBlanks } from '../app/fill-in-blanks.js';
import { normalizePromptMediaRefs } from './worksheet-values.js';
import { bookIcon } from './worksheet-navigation.js';

// Presentation only: the caller owns card lifetime, answers and navigation.
export function createReadingBlockPresentation({ block, sectionLabelText }) {
  const card = document.createElement('article');
  card.className = 'content-card viewer-card-transition';
  const heading = document.createElement('h3');
  heading.className = 'viewer-section-label viewer-sr-only';
  heading.textContent = sectionLabelText;
  const body = document.createElement('div');
  setWorksheetText(body, block.content);
  const marker = document.createElement('div');
  marker.className = 'viewer-content-heading';
  marker.setAttribute('aria-hidden', 'true');
  marker.innerHTML = bookIcon;
  card.append(heading, marker, body);
  return card;
}

// Return the original nodes so answer controls can retain their label/focus
// association and share media feedback without rebuilding the prompt.
export function createQuestionPromptPresentation({
  block, sectionLabelText, questionNumber, scope, localAssets, createAudioControl, t,
}) {
  const card = document.createElement('article');
  card.className = 'question-card viewer-card-transition';
  const sectionLabel = document.createElement('h3');
  sectionLabel.className = 'viewer-section-label viewer-sr-only';
  sectionLabel.textContent = sectionLabelText;
  card.append(sectionLabel);
  const questionHeading = document.createElement('div');
  questionHeading.className = 'viewer-question-heading';
  const numberLabel = document.createElement('span');
  numberLabel.className = 'viewer-question-number';
  numberLabel.setAttribute('aria-hidden', 'true');
  numberLabel.textContent = String(questionNumber).padStart(2, '0');
  questionHeading.append(numberLabel);
  card.append(questionHeading);
  const label = document.createElement('div');
  label.className = 'question-card__prompt-label';
  const controlId = `answer-${block.blockId}`;
  label.id = `${controlId}-label`;
  label.addEventListener('click', () => document.getElementById(label.htmlFor || controlId)?.focus(), { signal: scope.signal });
  setWorksheetText(label, isFillInBlanks(block.responseConfig) && !String(block.prompt?.text || '').trim()
    ? { text: t('fillBlanks.type') }
    : { ...block.prompt, text: block.prompt?.text || t('viewer.stepper.question') });
  const mediaFeedback = document.createElement('p');
  mediaFeedback.className = 'viewer-media-feedback';
  mediaFeedback.setAttribute('role', 'status');
  mediaFeedback.setAttribute('aria-live', 'polite');
  const setMediaFeedback = (message) => {
    if (!scope.signal.aborted) mediaFeedback.textContent = message || '';
  };

  const promptMediaRefs = normalizePromptMediaRefs(block.prompt?.mediaRefs);
  const questionImageRef = promptMediaRefs.find((ref) => ref.usage === 'question_image') || null;
  const questionAudioRef = promptMediaRefs.find((ref) => ref.usage === 'question_audio') || null;

  const promptRow = document.createElement('div');
  promptRow.className = 'question-card__prompt-row';
  const promptTextWrap = document.createElement('div');
  promptTextWrap.className = 'question-card__prompt-text';
  promptTextWrap.append(label);
  promptRow.append(promptTextWrap);
  card.append(promptRow);

  const questionAudioControl = createAudioControl({
    audioTracks: block.prompt?.audioTracks,
    legacyAudioRef: questionAudioRef,
    kind: 'question',
    reportMediaFeedback: setMediaFeedback,
    signal: scope.signal,
  });
  if (questionAudioControl) promptRow.append(questionAudioControl);

  if (questionImageRef?.assetId) {
    const imageWrap = document.createElement('div');
    imageWrap.className = 'viewer-question-image-wrap';
    const imageEl = document.createElement('img');
    imageEl.className = 'viewer-question-image';
    imageEl.alt = t('viewer.print.questionImageAlt');
    imageWrap.appendChild(imageEl);
    card.append(imageWrap);
    localAssets?.get?.(questionImageRef.assetId).then((asset) => {
      if (scope.signal.aborted) return;
      if (!asset?.binary) {
        setMediaFeedback(t('viewer.image.missingWithId', { id: questionImageRef.assetId }));
        return;
      }
      const mimeType = asset?.metadata?.mimeType || 'image/png';
      const objectUrl = scope.createObjectURL(new Blob([asset.binary], { type: mimeType }));
      imageEl.onload = () => scope.releaseObjectURL(objectUrl);
      imageEl.onerror = () => {
        scope.releaseObjectURL(objectUrl);
        setMediaFeedback(t('viewer.image.couldNotRender'));
        imageWrap.remove();
      };
      imageEl.src = objectUrl;
    }).catch(() => {
      setMediaFeedback(t('viewer.image.couldNotLoad'));
    });
  }
  return { card, sectionLabel, questionHeading, promptRow, label, controlId, mediaFeedback, setMediaFeedback };
}
