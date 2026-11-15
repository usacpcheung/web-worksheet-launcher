import {
  createFeedbackConfig,
  assertFeedbackConfig,
  FEEDBACK_ROLES,
  FEEDBACK_TEXT_ROLES,
} from '../app/worksheet-feedback.js';
export const feedbackStarIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.3-.9z"/></svg>';
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
export function createFeedbackEditor({ t, changed, confirm, createTargetId }) {
  const root = node('section', 'editor-panel right editor-feedback');
  let draft, signature, error;
  const valid = () => {
    try {
      assertFeedbackConfig(draft.feedback);
      error.textContent = '';
    } catch {
      error.textContent = t('feedback.invalidConfig');
    }
  };
  const commit = (config, rebuild = false) => {
    draft.feedback = config;
    signature = JSON.stringify([draft.localId, config]);
    if (rebuild) render();
    else valid();
    changed();
  };
  const check = (label, value, apply, id) => {
    const wrap = node('label', 'feedback-check'),
      input = node('input');
    input.type = 'checkbox';
    input.checked = value;
    if (id) input.id = id;
    input.onchange = () => apply(input.checked, input);
    wrap.append(input, document.createTextNode(label));
    return wrap;
  };
  const button = (label, apply) => {
    const b = node('button', 'sidebar-action-btn', label);
    b.type = 'button';
    b.onclick = apply;
    return b;
  };
  function render() {
    const c = structuredClone(draft.feedback || createFeedbackConfig());
    root.replaceChildren(
      node('h2', '', t('feedback.title')),
      node('p', 'muted', t('feedback.editorIntro')),
    );
    root.append(
      check(
        t('feedback.enable'),
        c.enabled,
        (v) => {
          c.enabled = v;
          commit(c, true);
        },
        'editor-feedback-enabled',
      ),
    );
    error = node('p', 'control-error');
    error.setAttribute('role', 'status');
    if (!c.enabled) {
      root.append(node('p', 'muted', t('feedback.disabledHelp')), error);
      if (draft.feedback) valid();
      return;
    }
    const assessment = node('section', 'feedback-editor-part');
    assessment.append(
      check(
        t('feedback.assessment'),
        c.assessment,
        (v) => {
          c.assessment = v;
          commit(c, true);
        },
        'editor-feedback-assessment',
      ),
    );
    if (c.assessment) {
      assessment.append(node('p', 'muted', t('feedback.categoryHelp')));
      const categories = node('div', 'feedback-categories');
      FEEDBACK_ROLES.forEach((role) =>
        categories.append(
          check(
            t(`feedback.roles.${role}`),
            c.categories.includes(role),
            (v, input) => {
              if (!v && c.categories.length === 1) {
                input.checked = true;
                error.textContent = t('feedback.categoryRequired');
                return;
              }
              c.categories = FEEDBACK_ROLES.filter((r) =>
                r === role ? v : c.categories.includes(r),
              );
              commit(c);
            },
          ),
        ),
      );
      assessment.append(
        categories,
        node('h3', '', t('feedback.targets', { count: c.targets.length })),
      );
      c.targets.forEach((target, index) => {
        const row = node('div', 'feedback-target-editor'),
          field = node('div'),
          input = node('textarea', 'control');
        input.rows = 2;
        input.maxLength = 200;
        input.value = target.text;
        input.setAttribute(
          'aria-label',
          t('feedback.targetNumber', { number: index + 1 }),
        );
        input.dataset.feedbackTarget = target.id;
        const count = node(
          'p',
          'feedback-editor-count',
          `${target.text.length} / 200`,
        );
        input.oninput = () => {
          target.text = input.value;
          count.textContent = `${input.value.length} / 200`;
          commit(c);
        };
        field.append(input, count);
        const actions = node('div', 'feedback-target-actions');
        for (const [direction, key, path] of [
          [-1, 'moveUp', 'm6 14 6-6 6 6'],
          [1, 'moveDown', 'm6 10 6 6 6-6'],
        ]) {
          const b = button('', () => {
            [c.targets[index], c.targets[index + direction]] = [
              c.targets[index + direction],
              c.targets[index],
            ];
            commit(c, true);
            root
              .querySelector(`[data-feedback-target="${target.id}"]`)
              ?.focus();
          });
          b.className = 'icon-btn';
          b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="${path}"/></svg>`;
          b.setAttribute('aria-label', t(`feedback.${key}`));
          b.disabled =
            index + direction < 0 || index + direction >= c.targets.length;
          actions.append(b);
        }
        const remove = button('', async () => {
          const owner = draft,
            snapshot = JSON.stringify(c);
          if (
            !(await confirm({
              title: t('feedback.removeTitle'),
              bodyText: t('feedback.removeHelp'),
              confirmLabel: t('feedback.remove'),
              cancelLabel: t('common.actions.cancel'),
            }))
          )
            return;
          if (draft !== owner || JSON.stringify(draft.feedback) !== snapshot)
            return;
          c.targets.splice(index, 1);
          commit(c, true);
        });
        remove.className = 'icon-btn';
        remove.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
        remove.setAttribute('aria-label', t('feedback.remove'));
        remove.disabled = c.targets.length === 1;
        actions.append(remove);
        row.append(node('span', 'muted', String(index + 1)), field, actions);
        assessment.append(row);
      });
      const add = button(t('feedback.addTarget'), () => {
        c.targets.push({ id: createTargetId(), text: '' });
        commit(c, true);
        root
          .querySelectorAll('[data-feedback-target]')
          [c.targets.length - 1]?.focus();
      });
      add.disabled = c.targets.length >= 5;
      add.id = 'editor-feedback-add-target';
      assessment.append(add);
    }
    root.append(assessment);
    const text = node('section', 'feedback-editor-part');
    text.append(node('h3', '', t('feedback.written')));
    FEEDBACK_TEXT_ROLES.forEach((role) => {
      const field = c.text[role],
        wrap = node('div', 'feedback-text-config');
      wrap.append(
        check(
          t(`feedback.textRoles.${role}`),
          field.enabled,
          (v) => {
            field.enabled = v;
            commit(c, true);
          },
          `editor-feedback-${role}-enabled`,
        ),
      );
      if (field.enabled) {
        const grid = node('div', 'feedback-text-grid'),
          promptLabel = node('label', '', t('feedback.prompt')),
          prompt = node('textarea', 'control');
        prompt.rows = 2;
        prompt.maxLength = 500;
        prompt.value = field.prompt;
        prompt.id = `editor-feedback-${role}-prompt`;
        promptLabel.htmlFor = prompt.id;
        prompt.oninput = () => {
          field.prompt = prompt.value;
          commit(c);
        };
        const promptWrap = node('div');
        promptWrap.append(promptLabel, prompt);
        const limitLabel = node('label', '', t('feedback.limit')),
          limit = node('input', 'control');
        limit.type = 'number';
        limit.min = 1;
        limit.max = 1200;
        limit.step = 1;
        limit.value = field.limit;
        limit.id = `editor-feedback-${role}-limit`;
        limitLabel.htmlFor = limit.id;
        limit.oninput = () => {
          field.limit = Number(limit.value);
          commit(c);
        };
        const limitWrap = node('div');
        limitWrap.append(limitLabel, limit, node('p', 'muted', '1–1,200'));
        grid.append(promptWrap, limitWrap);
        wrap.append(grid);
      }
      text.append(wrap);
    });
    text.append(node('p', 'muted', t('feedback.toolsHelp')));
    root.append(text, error);
    if (draft.feedback) valid();
  }
  return {
    root,
    update(next) {
      const key = JSON.stringify([next?.localId, next?.feedback]);
      if (!next) return;
      draft = next;
      if (key === signature) return;
      signature = key;
      render();
    },
  };
}
