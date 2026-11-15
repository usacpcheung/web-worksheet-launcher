import {
  feedbackEnabled,
  feedbackVoiceTargets,
  FEEDBACK_TEXT_ROLES,
  FEEDBACK_SECTION_ID,
} from '../app/worksheet-feedback.js';
import { createVoiceControls } from './answer-voice-ui.js';
import {
  getVoiceRecovery,
  hasPendingRecovery,
} from './answer-voice-workflow.js';
import { bindTextAnswerInput } from './text-answer-input.js';
import { requestVoiceSignIn } from './voice-sign-in.js';
const star =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.3-.9z"/></svg>';
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (label, fn, cls = '') => {
  const b = node('button', cls, label);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
export function createFeedbackView({
  session,
  t,
  signal,
  sharedStatusId,
  icon,
}) {
  const root = node('section', 'viewer-block-section viewer-feedback-section');
  root.id = FEEDBACK_SECTION_ID;
  const reminder = node('div', 'viewer-feedback-reminder'),
    reminderText = node('p');
  const view = () => {
    root.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    });
    root.querySelector('h2')?.focus({ preventScroll: true });
  };
  const nav = button(t('feedback.title'), view, 'viewer-bottom-action-btn');
  nav.id = 'viewer-feedback-nav';
  reminder.append(
    reminderText,
    button(t('feedback.go'), view, 'viewer-feedback-link'),
  );
  let owner = null,
    updates = [],
    saveState = null;
  const build = () => {
    root.replaceChildren();
    updates = [];
    const config = session.state.viewerPayload.feedback,
      body = node('div', 'viewer-feedback-body');
    const heading = node('h2', '', t('feedback.title'));
    heading.tabIndex = -1;
    body.append(
      heading,
      node('p', 'feedback-intro', t('feedback.viewerIntro')),
    );
    if (config.assessment) {
      body.append(
        node('h3', '', t('feedback.assessment')),
        node('p', 'feedback-intro', t('feedback.starHelp')),
      );
      const table = node('div', 'feedback-rating-table');
      table.style.setProperty(
        '--feedback-categories',
        config.categories.length,
      );
      const head = node('div', 'feedback-rating-head');
      head.append(node('span', '', t('feedback.learningTargets')));
      config.categories.forEach((role) =>
        head.append(node('span', '', t(`feedback.roles.${role}`))),
      );
      table.append(head);
      config.targets.forEach((target, index) => {
        const row = node('div', 'feedback-rating-row');
        row.append(
          node('p', 'feedback-target-title', `${index + 1}. ${target.text}`),
        );
        config.categories.forEach((role) => {
          const cell = node('div', 'feedback-rating-cell'),
            group = node('div', 'feedback-stars');
          group.setAttribute('role', 'radiogroup');
          group.setAttribute(
            'aria-label',
            `${target.text} — ${t(`feedback.roles.${role}`)}`,
          );
          const get = () =>
              session.state.feedback.ratings[target.id]?.[role] || 0,
            stars = [];
          for (let value = 1; value <= 5; value++) {
            const b = button(
              '',
              () => session.setFeedbackRating(target.id, role, value),
              'feedback-star',
            );
            b.innerHTML = star;
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-label', t('feedback.stars', { count: value }));
            b.dataset.feedbackRating = `${target.id}:${role}:${value}`;
            b.onkeydown = (event) => {
              if (
                ![
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                ].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 1
                  : event.key === 'End'
                    ? 5
                    : Math.max(
                        1,
                        Math.min(
                          5,
                          value +
                            (['ArrowRight', 'ArrowUp'].includes(event.key)
                              ? 1
                              : -1),
                        ),
                      );
              session.setFeedbackRating(target.id, role, next);
              stars[next - 1].focus();
            };
            stars.push(b);
            group.append(b);
          }
          const status = node('span'),
            clear = button(
              t('feedback.clear'),
              () => {
                session.setFeedbackRating(target.id, role, null);
                stars[0].focus();
              },
              'viewer-feedback-link',
            );
          clear.setAttribute(
            'aria-label',
            t('feedback.clearRating', {
              target: target.text,
              role: t(`feedback.roles.${role}`),
            }),
          );
          const foot = node('div', 'feedback-rating-foot');
          foot.append(status, clear);
          const choice = node('div', 'feedback-rating-choice');
          choice.append(group, foot);
          cell.append(
            node(
              'span',
              'feedback-category-label',
              t(`feedback.roles.${role}`),
            ),
            choice,
          );
          row.append(cell);
          updates.push(() => {
            const v = get();
            stars.forEach((b, i) => {
              b.classList.toggle('is-filled', i < v);
              b.setAttribute('aria-checked', String(i + 1 === v));
              b.tabIndex = i + 1 === (v || 1) ? 0 : -1;
              b.disabled = session.state.isFinalizing;
            });
            status.textContent = v ? `${v} / 5` : t('feedback.unrated');
            clear.hidden = !v;
            clear.disabled = session.state.isFinalizing;
          });
        });
        table.append(row);
      });
      body.append(table);
    }
    for (const block of feedbackVoiceTargets(session.state.viewerPayload)) {
      const role = block.responseConfig.feedbackTarget,
        field = config.text[role],
        section = node('section', 'feedback-text-section');
      const label = node('label', '', t(`feedback.textRoles.${role}`)),
        control = node('textarea', 'feedback-text-input');
      control.rows = 4;
      control.id = `viewer-feedback-${role}`;
      label.htmlFor = control.id;
      section.append(label);
      if (field.prompt)
        section.append(node('p', 'feedback-text-prompt', field.prompt));
      const counter = node('p', 'text-counter'),
        error = node('p', 'input-error');
      counter.id = control.id + '-count';
      error.id = control.id + '-error';
      error.setAttribute('role', 'status');
      control.setAttribute('aria-describedby', `${counter.id} ${error.id}`);
      bindTextAnswerInput(control, {
        config: block.responseConfig,
        signal,
        getValue: () => session.answerForVoice(block.blockId),
        rejected: () => {
          error.textContent = t('textAnswer.rejected', { max: field.limit });
        },
        accepted: (value) => {
          error.textContent = '';
          delete session.state.undoBuffer[block.blockId];
          session.setAnswer(block.blockId, value);
        },
      });
      const ui = createVoiceControls({
        session,
        block,
        control,
        t,
        signal,
        sharedStatusId,
        allowCompleted: true,
        isActive: () => root.contains(document.activeElement),
        view,
        requestSignIn: ({ isCurrent, confirm }) =>
          requestVoiceSignIn(session, {
            blockId: block.blockId,
            signal,
            isCurrent,
            confirm,
          }),
        canRestoreFocus: () => {
          const r = control.getBoundingClientRect();
          return (
            r.bottom > 0 &&
            r.top < innerHeight &&
            (section.contains(document.activeElement) ||
              document
                .getElementById(sharedStatusId)
                ?.contains(document.activeElement))
          );
        },
        applied: (value) => {
          control.value = value.text;
        },
      });
      const rewrite = button(
        t('viewer.rewrite.action'),
        () => ui.rewrite(),
        'question-card__rewrite-btn icon-nav-btn',
      );
      const undo = button(
        t('viewer.rewrite.undo'),
        () => {
          const value = session.state.undoBuffer[block.blockId];
          if (
            value !== undefined &&
            session.setAnswer(block.blockId, value) !== false
          ) {
            delete session.state.undoBuffer[block.blockId];
            session.notifyStateChange();
          }
        },
        'question-card__undo-btn icon-nav-btn',
      );
      const actions = node('div', 'feedback-text-actions');
      for (const [b, name] of [
        [ui.add, 'voice'],
        [rewrite, 'rewrite'],
        [undo, 'undo'],
      ]) {
        const text = node('span', '', b.textContent);
        b.replaceChildren(text);
        b.insertAdjacentHTML('afterbegin', icon(name));
        actions.append(b);
      }
      section.append(control, counter, actions, error, ui.root);
      body.append(section);
      updates.push(() => {
        const value = session.answerForVoice(block.blockId);
        if (control.value !== value && document.activeElement !== control)
          control.value = value;
        counter.textContent = `${value.length} / ${field.limit}`;
        ui.update();
        const busy =
          Boolean(session.voice.active) || session.state.isFinalizing;
        rewrite.disabled =
          busy ||
          !value.trim() ||
          hasPendingRecovery(
            getVoiceRecovery(session.state.voiceRecovery, block.blockId),
          );
        undo.disabled =
          busy || !Object.hasOwn(session.state.undoBuffer, block.blockId);
        if (session.state.isFinalizing) {
          control.readOnly = true;
          ui.add.disabled = true;
        }
      });
    }
    saveState = node('p', 'feedback-save-state');
    saveState.setAttribute('role', 'status');
    body.append(saveState);
    root.append(body);
  };
  return {
    root,
    reminder,
    nav,
    view,
    update() {
      const visible =
        session.state.status === 'completed' &&
        feedbackEnabled(session.state.viewerPayload?.feedback);
      root.hidden = reminder.hidden = nav.hidden = !visible;
      if (!visible) return;
      if (owner !== session.state.viewerPayload) {
        owner = session.state.viewerPayload;
        build();
      }
      updates.forEach((fn) => fn());
      const responses = session.state.feedback;
      reminderText.textContent = t(
        Object.keys(responses.ratings).length ||
          Object.values(responses.text).some((v) => v.trim())
          ? 'feedback.title'
          : 'feedback.reminder',
      );
      saveState.textContent = t(
        session.state.lastSaveError
          ? 'feedback.saveError'
          : session.state.autosavePending
            ? 'feedback.saving'
            : 'feedback.saved',
      );
      saveState.classList.toggle(
        'input-error',
        Boolean(session.state.lastSaveError),
      );
    },
  };
}
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export function feedbackPrintHtml(config, responses, t) {
  if (!feedbackEnabled(config)) return '';
  return `<section class="print-feedback"><h2>${escape(t('feedback.title'))}</h2>${
    config.assessment
      ? `<p>${escape(t('feedback.starHelp'))}</p><table><thead><tr><th>${escape(t('feedback.learningTargets'))}</th>${config.categories.map((r) => `<th>${escape(t(`feedback.roles.${r}`))}</th>`).join('')}</tr></thead><tbody>${config.targets
          .map(
            (target, i) =>
              `<tr><td>${i + 1}. ${escape(target.text)}</td>${config.categories
                .map((role) => {
                  const v = responses?.ratings?.[target.id]?.[role] || 0;
                  return `<td><span class="print-feedback-stars">${'★'.repeat(v) + '☆'.repeat(5 - v)}</span>${v ? `<br>${v} / 5` : ''}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('')}</tbody></table>`
      : ''
  }${FEEDBACK_TEXT_ROLES.filter((r) => config.text[r].enabled)
    .map(
      (r) =>
        `<div class="print-feedback-text"><h3>${escape(t(`feedback.textRoles.${r}`))}</h3>${config.text[r].prompt ? `<p>${escape(config.text[r].prompt)}</p>` : ''}<div class="${responses?.text?.[r] ? 'print-feedback-answer' : 'print-feedback-blank'}">${escape(responses?.text?.[r] || '')}</div></div>`,
    )
    .join('')}</section>`;
}
