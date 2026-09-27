import { translate } from '../i18n.js';
import { canEditProjectTitle, MAX_PROJECT_TITLE_LENGTH, projectTitleInputValue } from '../project-title.js';

const refreshers = new WeakMap();

export function refreshProjectTitleField(host, project, actions) {
  refreshers.get(host)?.(project, actions);
}

export function renderProjectTitleField(project, actions) {
  const originalTitle = project.meta?.title ?? '';
  const host = document.createElement('div');
  host.className = 'rps-project-title-field';
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.focusKey = 'project-title';
  const hint = document.createElement('small');
  hint.className = 'rps-project-title-hint';
  hint.id = 'rps-project-title-hint';
  const error = document.createElement('p');
  error.className = 'rps-project-title-error';
  error.id = 'rps-project-title-error';
  error.setAttribute('role', 'status');
  input.setAttribute('aria-describedby', `${hint.id} ${error.id}`);
  label.append(caption, input);
  host.append(label, hint, error);
  let composing = false;
  const validate = () => {
    const count = Array.from(input.value).length;
    const valid = canEditProjectTitle(input.value, project.meta?.title)
      || canEditProjectTitle(input.value, originalTitle);
    hint.textContent = translate(valid && count > MAX_PROJECT_TITLE_LENGTH
      ? 'inspector.projectTitle.legacy' : 'inspector.projectTitle.counter', { count, max: MAX_PROJECT_TITLE_LENGTH });
    error.textContent = valid ? '' : translate('inspector.projectTitle.tooLong', { max: MAX_PROJECT_TITLE_LENGTH });
    error.hidden = valid;
    input.setAttribute('aria-invalid', String(!valid));
    return valid;
  };
  const update = () => {
    if (!composing) validate();
    actions.onUpdateProjectTitle?.(input.value, { composing, originalTitle });
  };
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('input', event => {
    if (event.isComposing) composing = true;
    update();
  });
  input.addEventListener('blur', () => {
    if (!composing && validate()) actions.onCommitProjectTitle?.();
  });
  const refresh = (nextProject, nextActions) => {
    project = nextProject;
    actions = nextActions;
    caption.textContent = translate('inspector.projectTitleLabel');
    input.placeholder = translate('inspector.projectTitlePlaceholder');
    if (composing) return;
    const nextValue = projectTitleInputValue(actions.getProjectTitleDraft?.() ?? project.meta?.title);
    // Preserve the input's native undo history and active composition.
    if (input.value !== nextValue) input.value = nextValue;
    validate();
  };
  refreshers.set(host, refresh);
  refresh(project, actions);
  return host;
}
