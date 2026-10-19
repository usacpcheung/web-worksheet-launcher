import { t } from '../i18n/index.js';

// Presentation adapter only. Each app retains its surrounding feature surface.
export function promptForReadSignIn({ isCurrent = () => true, blocked = false, canRedirect = false, redirect, intent, confirmation = false } = {}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !isCurrent()) return Promise.resolve(false);
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    if (typeof dialog.showModal !== 'function') { resolve(false); return; }
    dialog.className = 'confirm-modal read-auth-prompt';
    dialog.style.cssText = 'box-sizing:border-box;max-width:min(440px,90vw);border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:#172033;background:white';
    const heading = document.createElement('h3');
    heading.id = `read-auth-${Math.random().toString(36).slice(2)}`;
    heading.textContent = t(confirmation ? 'mutationAuth.title' : 'readAuth.title');
    dialog.setAttribute('aria-labelledby', heading.id);
    const body = document.createElement('p');
    body.textContent = t(blocked ? 'apiErrors.popupBlockedHelp' : confirmation ? 'mutationAuth.confirm' : intent?.kind === 'mutation' ? 'mutationAuth.description' : 'readAuth.description');
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'confirm-modal__btn';
    cancel.textContent = t('common.actions.cancel');
    const accept = document.createElement('button');
    accept.type = 'button'; accept.className = 'confirm-modal__btn';
    accept.textContent = t(confirmation ? `mutationAuth.${intent.operation.startsWith('delete-') ? 'delete' : intent.operation}` : 'common.actions.signIn');
    actions.append(cancel, accept);
    if (canRedirect) {
      const sameTab = document.createElement('button');
      sameTab.type = 'button'; sameTab.className = 'confirm-modal__btn';
      sameTab.textContent = t('readAuth.sameTab');
      sameTab.onclick = async () => {
        sameTab.disabled = true; accept.disabled = true;
        try { await redirect({ isCurrent: () => !finished && isCurrent() }); finish(false); }
        catch (error) { body.textContent = t(error?.code === 'AUTH_LOCAL_WORK_PENDING' ? 'readAuth.pendingWork' : 'readAuth.saveFailed'); sameTab.disabled = false; accept.disabled = false; }
      };
      actions.append(sameTab);
    }
    dialog.append(heading, body, actions);
    document.body.append(dialog);
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true; clearInterval(timer); dialog.remove();
      if (previous?.isConnected) previous.focus?.();
      resolve(value);
    };
    const timer = setInterval(() => { if (!isCurrent()) finish(false); }, 100);
    cancel.onclick = () => finish(false);
    accept.onclick = () => finish(isCurrent());
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    try { dialog.showModal(); cancel.focus(); }
    catch (error) { finish(false); throw error; }
  });
}
