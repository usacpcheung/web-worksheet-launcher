// Presentation only. Stable section/offset geometry never includes animated transforms.
export function layoutBounds(node) {
  let top = 0;
  for (let current = node; current; current = current.offsetParent) top += current.offsetTop;
  top -= window.scrollY;
  return { top, bottom: top + node.offsetHeight, height: node.offsetHeight };
}
export function revealProgress(rect, viewport, edge) {
  const height = viewport.bottom - viewport.top;
  const end = viewport.line + (edge === 'bottom' ? 1 : -1) * height * .15;
  return Math.max(0, Math.min(1, edge === 'bottom'
    ? (viewport.bottom - rect.top) / Math.max(1, viewport.bottom - end)
    : (rect.bottom - viewport.top) / Math.max(1, end - viewport.top)));
}
export function createEntryMotion({ container, viewport, signal }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const entries = new Map();
  let frame = 0, timer = 0, printing = false;
  const supported = typeof Element.prototype.animate === 'function';
  const selected = node => {
    const selection = getSelection();
    return selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode));
  };
  const settle = unit => {
    unit.animations.forEach(animation => animation.cancel());
    unit.animations = []; unit.state = 'settled'; unit.progress = 1;
    for (const node of unit.nodes) { node.style.filter = ''; node.style.transform = ''; node.style.opacity = ''; }
  };
  const protect = section => {
    const entry = entries.get(section);
    if (!entry) return;
    entry.protected = true;
    entry.units.forEach(settle);
  };
  const sync = () => {
    for (const [section, entry] of entries) if (!section.isConnected || section.firstElementChild !== entry.card) {
      entry.units.forEach(settle); entries.delete(section);
    }
    for (const section of container.children) {
      if (entries.has(section) || !section.firstElementChild) continue;
      const card = section.firstElementChild;
      const groups = [];
      const add = (nodes, kind, order = 0) => {
        nodes = nodes.filter(Boolean);
        if (nodes.length) groups.push({ nodes, kind, order, state: 'armed', progress: 0, edge: 'bottom', outside: null, animations: [] });
      };
      add([card.querySelector('.question-card__prompt-row'), card.querySelector('.viewer-question-image-wrap')], 'prompt');
      if (card.matches('.content-card')) add([...card.children], 'reading');
      add([...card.querySelectorAll('.viewer-answer-area > input, .viewer-answer-area > textarea')], 'answer');
      add([card.querySelector('.boolean-segmented-control')], 'boolean');
      [...card.querySelectorAll('.choice-button-group__row')].forEach((node, i) => add([node], 'choice', i));
      const entry = { card, units: groups, protected: false };
      entries.set(section, entry);
      // Replacement/status rendering cannot replay content already in view.
      const view = viewport();
      for (const unit of groups) {
        const rect = layoutBounds(unit.nodes[0]);
        if (rect.top <= view.line + (view.bottom - view.top) * .15 && rect.bottom >= view.top) settle(unit);
        else if (rect.bottom < view.top) unit.edge = 'top';
      }
    }
  };
  const update = () => {
    frame = 0;
    if (signal.aborted) return;
    sync();
    clearTimeout(timer); timer = 0;
    const view = viewport(), now = performance.now();
    let deadline = Infinity;
    for (const [section, entry] of entries) {
      const guarded = entry.card.contains(document.activeElement) || selected(entry.card)
        || entry.card.querySelector('.is-menu-open, .is-playing');
      if (reduced.matches || printing || !supported || guarded) { entry.units.forEach(settle); continue; }
      const sectionRect = section.getBoundingClientRect();
      const sectionOutside = sectionRect.bottom < view.top - 140 || sectionRect.top > view.bottom + 140;
      for (const unit of entry.units) {
        const rects = unit.nodes.filter(node => !node.hidden).map(layoutBounds);
        if (!rects.length) { settle(unit); continue; }
        const outside = rects.every(rect => rect.bottom < view.top - 140 || rect.top > view.bottom + 140);
        if (outside) {
          unit.outside ??= now;
          if (now - unit.outside >= 190) {
            if (sectionOutside) entry.protected = false;
            if (!entry.protected) {
              settle(unit); unit.state = 'armed'; unit.progress = 0;
              unit.edge = rects[0].top > view.bottom ? 'bottom' : 'top';
            }
          } else deadline = Math.min(deadline, unit.outside + 190);
          continue;
        }
        unit.outside = null;
        if (entry.protected) { settle(unit); continue; }
        if (!rects.some(rect => rect.bottom > view.top && rect.top < view.bottom)) continue;
        unit.progress = Math.max(unit.progress, ...rects.map(rect => revealProgress(rect, view, unit.edge)));
        if (unit.progress >= 1) { settle(unit); continue; }
        for (const node of unit.nodes) node.style.filter = `blur(${(1 - unit.progress) * 4}px)`;
        if (unit.state === 'armed' && unit.progress >= .25) {
          const distance = unit.kind === 'prompt' ? -36 : innerWidth <= 760 ? -22 : 28;
          unit.state = 'playing';
          unit.animations = unit.nodes.map(node => {
            const animation = node.animate([{ transform: `translateX(${distance}px)`, opacity: .65 }, { transform: 'translateX(0)', opacity: 1 }], {
              duration: unit.kind === 'choice' ? 520 : unit.kind === 'boolean' ? 760 : 720,
              delay: unit.kind === 'prompt' ? 0 : 120 + Math.min(150, unit.order * 55),
              easing: 'cubic-bezier(.18,.72,.2,1)', fill: 'backwards',
            });
            animation.id = 'viewer-entry-' + unit.kind;
            return animation;
          });
        }
      }
    }
    if (Number.isFinite(deadline)) timer = setTimeout(schedule, Math.max(1, deadline - now));
  };
  function schedule() { if (!frame && !signal.aborted && !document.hidden) frame = requestAnimationFrame(update); }
  for (const event of ['scroll', 'resize']) window.addEventListener(event, schedule, { passive: true, signal });
  window.visualViewport?.addEventListener('resize', schedule, { signal });
  reduced.addEventListener('change', schedule, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame); frame = 0; clearTimeout(timer);
      for (const entry of entries.values()) entry.units.forEach(settle);
    } else schedule();
  }, { signal });
  // Settle on pointer entry/down before hit targets can move underneath the user.
  for (const event of ['pointerover', 'pointerdown', 'focusin', 'input']) container.addEventListener(event, e => {
    const section = e.target.closest?.('.viewer-block-section');
    if (section) protect(section);
  }, { capture: true, signal });
  document.addEventListener('selectionchange', () => { for (const [section, entry] of entries) if (selected(entry.card)) protect(section); }, { signal });
  window.addEventListener('beforeprint', () => { printing = true; update(); }, { signal });
  window.addEventListener('afterprint', () => { printing = false; schedule(); }, { signal });
  const observer = new ResizeObserver(schedule); observer.observe(container);
  const changes = new MutationObserver(schedule); changes.observe(container, { childList: true, subtree: true });
  document.fonts?.ready.then(schedule);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect(); changes.disconnect();
    for (const entry of entries.values()) entry.units.forEach(settle);
    entries.clear();
  }, { once: true });
  sync(); schedule();
  return { settleSection(index) { protect(container.children[index]); }, refresh: schedule };
}
