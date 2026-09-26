import { translate } from '../i18n.js';
import { canEditSceneName, getSceneName, MAX_SCENE_NAME_LENGTH } from '../scene-name.js';

function wrappedField(label, value) {
  const field = document.createElement('label');
  field.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const wrapper = document.createElement('div');
  wrapper.className = 'rps-wrapped-text';
  wrapper.setAttribute('data-value', value);
  const input = document.createElement('textarea');
  input.rows = 1;
  input.value = value;
  wrapper.appendChild(input);
  field.append(caption, wrapper);
  return { field, input, wrapper };
}

export function renderSceneNameFields(scene, actions) {
  const host = document.createElement('div');
  host.className = 'rps-scene-identity';
  const value = actions.getSceneNameDraft?.(scene.id) ?? scene.name ?? getSceneName(scene);
  const name = wrappedField(translate('inspector.sceneName.label'), value);
  name.input.dataset.focusKey = `scene-name-${scene.id}`;
  name.input.setAttribute('aria-required', 'true');
  const error = document.createElement('p');
  error.className = 'rps-scene-name-error';
  error.id = 'rps-scene-name-error';
  name.input.setAttribute('aria-describedby', error.id);
  error.setAttribute('role', 'status');
  const validate = () => {
    const valid = canEditSceneName(name.input.value, scene.name ?? getSceneName(scene));
    error.textContent = valid ? '' : translate('inspector.sceneName.tooLong', { max: MAX_SCENE_NAME_LENGTH });
    error.hidden = valid;
    name.input.setAttribute('aria-invalid', String(!valid));
    return valid;
  };
  let composing = false;
  const update = () => {
    name.wrapper.setAttribute('data-value', name.input.value);
    if (composing) return;
    validate();
    actions.onUpdateSceneName?.(scene.id, name.input.value);
  };
  name.input.addEventListener('compositionstart', () => { composing = true; });
  name.input.addEventListener('compositionend', () => { composing = false; update(); });
  name.input.addEventListener('input', event => {
    name.wrapper.setAttribute('data-value', name.input.value);
    if (!event.isComposing) update();
  });
  name.input.addEventListener('blur', () => {
    if (!composing && validate()) {
      actions.onCommitSceneName?.(scene.id);
      if (!name.input.value.trim()) {
        name.input.value = scene.id;
        name.wrapper.setAttribute('data-value', scene.id);
      }
    }
  });
  validate();
  const id = wrappedField(translate('inspector.sceneName.idLabel'), scene.id);
  id.field.classList.add('rps-scene-id-field');
  id.input.readOnly = true;
  id.input.spellcheck = false;
  id.input.dataset.focusKey = `scene-id-${scene.id}`;
  host.append(name.field, error, id.field);
  return host;
}
