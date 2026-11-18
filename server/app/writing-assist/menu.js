let opened;

function close(restoreFocus = false) {
  if (!opened) return;
  const { menu, trigger } = opened;
  opened = null;
  if (menu.matches(':popover-open')) menu.hidePopover();
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus({ preventScroll: true });
}

function position() {
  if (!opened) return;
  const { menu, trigger } = opened;
  const anchor = trigger.getBoundingClientRect();
  const top = anchor.bottom + menu.offsetHeight + 4 <= innerHeight
    ? anchor.bottom + 4 : anchor.top - menu.offsetHeight - 4;
  menu.style.left = Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, anchor.right - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
}

function open(control, last = false) {
  close();
  opened = control;
  control.menu.hidden = false;
  control.menu.showPopover();
  control.trigger.setAttribute('aria-expanded', 'true');
  position();
  const items = control.menu.querySelectorAll('button:enabled');
  (last ? items[items.length - 1] : items[0])?.focus();
}

export function attachMenu(panel, input, toolsLabel) {
  const trigger = panel.querySelector('.field-tools');
  const menu = panel.querySelector('.field-actions');
  const control = { menu, trigger };
  let compact;
  menu.id = input.id + '-tools';
  const name = (input.labels?.[0]?.textContent || input.getAttribute('aria-label') || input.id) + ' · ' + toolsLabel;
  trigger.setAttribute('aria-label', name);
  trigger.setAttribute('aria-controls', menu.id);
  menu.setAttribute('aria-label', name);
  trigger.addEventListener('click', () => opened === control ? close(true) : open(control));
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open(control, event.key === 'ArrowUp');
  });
  menu.addEventListener('click', event => {
    if (compact && event.target.closest('button:enabled')) close(true);
  });
  menu.addEventListener('keydown', event => {
    if (!compact || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('button:enabled')];
    const i = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  return mode => {
    if (opened === control) close();
    compact = mode === 'compact' && 'showPopover' in HTMLElement.prototype;
    panel.parentElement.classList.toggle('wa-compact', compact);
    trigger.hidden = !compact;
    menu.hidden = compact;
    menu.toggleAttribute('popover', compact);
    if (compact) menu.setAttribute('popover', 'manual');
    menu.setAttribute('role', compact ? 'menu' : 'group');
    for (const button of menu.children) {
      if (compact) button.setAttribute('role', 'menuitem');
      else button.removeAttribute('role');
    }
  };
}
for (const event of ['pointerdown','focusin']) document.addEventListener(event, ({target}) => {
  if (opened && !opened.menu.contains(target) && !opened.trigger.contains(target)) close();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && opened) { event.preventDefault(); close(true); }
});
window.addEventListener('resize', position);
document.addEventListener('scroll', position, true);
