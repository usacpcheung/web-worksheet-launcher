// Pure geometry selection, shared by the browser controller and boundary tests.
export function sectionAtReadingLine(bounds, current, line, { atStart = false, atEnd = false, tolerance = 3 } = {}) {
  if (!bounds.length) return -1;
  if (atStart) return 0;
  if (atEnd) return bounds.length - 1;
  const index = Math.max(0, Math.min(current, bounds.length - 1));
  const old = bounds[index];
  if (line >= old.top - tolerance && line <= old.bottom + tolerance) return index;
  const match = bounds.findIndex(rect => line >= rect.top && line <= rect.bottom);
  if (match >= 0) return match;
  // A fast gesture can cross whole sections between frames and stop in a gap.
  // Keep the last section crossed in that direction, not a stale distant one.
  if (line > old.bottom) return Math.max(index, bounds.findLastIndex(rect => rect.bottom < line));
  const next = bounds.findIndex(rect => rect.top > line);
  return next < 0 ? index : Math.min(index, next);
}

// Only deliberate page scrolling can select by geometry. Layout/focus-induced
// scroll events have no navigation authority. Jumps are instant in this stage;
// motion is a later, separately reviewed presentation change.
export function createSectionNavigation({ container, getCurrentIndex, activate, getBottomInset = () => 0, layoutElements = [], signal }) {
  let scrolling = false;
  let restoring = true;
  let disposed = false;
  let frame = 0;
  let focusFrame = 0;
  let idleTimer;
  let pointerScroll = false;
  let touchY = null;
  let focusedControl = null;
  let focusedControlVisible = false;
  const sections = () => [...container.children];
  const viewport = () => {
    const visual = window.visualViewport;
    const top = visual?.offsetTop || 0;
    // Operation chrome must not move section boundaries: otherwise its arrival
    // makes the next small downward scroll select the preceding section.
    const bottom = Math.min(top + (visual?.height || window.innerHeight), window.innerHeight);
    return { top, bottom, line: top + Math.max(1, bottom - top) * 0.45 };
  };
  const controlViewport = () => {
    const view = viewport();
    return { top: view.top, bottom: Math.min(view.bottom, window.innerHeight - getBottomInset()) };
  };
  const stopTracking = () => { scrolling = false; clearTimeout(idleTimer); };
  const align = () => {
    const target = sections()[getCurrentIndex()];
    if (!target) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - viewport().line), behavior: 'instant' });
  };
  const track = () => {
    if (!scrolling || disposed || document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')) return;
    const bounds = sections().map(section => section.getBoundingClientRect());
    const atStart = window.scrollY <= 2;
    const atEnd = !atStart && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const index = sectionAtReadingLine(bounds, getCurrentIndex(), viewport().line, { atStart, atEnd });
    if (index >= 0 && index !== getCurrentIndex()) activate(index);
  };
  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; if (restoring) align(); else track(); });
  };
  const intentionalScroll = () => {
    restoring = false;
    scrolling = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopTracking, 200);
  };
  const isNestedScroller = (target, delta) => {
    for (let node = target instanceof Element ? target : null; node && node !== document.body; node = node.parentElement) {
      if (node.matches('select, dialog, [role="dialog"]')) return true;
      const style = getComputedStyle(node);
      const remaining = node.scrollHeight - node.clientHeight - node.scrollTop;
      if (/(auto|scroll)/.test(style.overflowY)
        && ((delta > 0 && remaining > 1) || (delta < 0 && node.scrollTop > 1))) return true;
    }
    return false;
  };
  window.addEventListener('wheel', event => {
    if (event.deltaY && !event.ctrlKey && !isNestedScroller(event.target, event.deltaY)) intentionalScroll();
  }, { passive: true, signal });
  window.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true, signal });
  window.addEventListener('touchmove', event => {
    const next = event.touches[0]?.clientY;
    const delta = touchY === null || next === undefined ? 0 : touchY - next;
    touchY = next ?? null;
    if (event.touches.length === 1 && delta && !isNestedScroller(event.target, delta)) intentionalScroll();
  }, { passive: true, signal });
  window.addEventListener('keydown', event => {
    // Tab/typing in header controls is also an interaction: late media must not
    // pull the page back to the resume target after keyboard use has begun.
    restoring = false; stopTracking();
    const boundaryKey = event.key === 'Home' || event.key === 'End';
    if (event.defaultPrevented || event.altKey || ((event.ctrlKey || event.metaKey) && !boundaryKey)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return;
    if (event.key === ' ' && event.target.closest?.('button, a')) return;
    if (!event.shiftKey && boundaryKey) {
      // Page-boundary keys are one explicit destination, like Previous/Next.
      // Avoid a browser smooth-scroll sequence being interrupted by layout updates.
      event.preventDefault(); restoring = false; stopTracking();
      const index = event.key === 'Home' ? 0 : sections().length - 1;
      if (index >= 0 && index !== getCurrentIndex()) activate(index);
      window.scrollTo({ top: event.key === 'Home' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' });
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) intentionalScroll();
  }, { signal });
  window.addEventListener('pointerdown', event => {
    restoring = false;
    stopTracking();
    pointerScroll = event.clientX >= document.documentElement.clientWidth;
    if (pointerScroll) intentionalScroll();
  }, { signal });
  window.addEventListener('pointerup', () => { pointerScroll = false; }, { signal });
  window.addEventListener('scroll', () => {
    if (scrolling || pointerScroll) { intentionalScroll(); schedule(); }
    if (focusedControl === document.activeElement && !focusFrame) {
      const rect = focusedControl.getBoundingClientRect();
      const { top, bottom } = controlViewport();
      focusedControlVisible = rect.bottom > top && rect.top < bottom;
    }
  }, { passive: true, signal });
  const revealFocusedControl = control => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = 0;
      if (disposed || document.activeElement !== control) return;
      const rect = control.getBoundingClientRect();
      const { top, bottom } = controlViewport();
      // A newly focused answer must fit above fixed navigation/operation UI.
      // Do this only on deliberate focus, never to pin an off-screen input.
      const offset = rect.top < top + 12 || rect.height > bottom - top - 24
        ? rect.top - top - 12 : Math.max(0, rect.bottom - bottom + 12);
      if (Math.abs(offset) > 1) {
        stopTracking();
        window.scrollBy({ top: offset, behavior: 'instant' });
      }
      focusedControlVisible = true;
    });
  };
  container.addEventListener('focusin', event => {
    const control = event.target;
    if (!control.matches?.('input, textarea, select')) return;
    focusedControl = control;
    focusedControlVisible = true;
    revealFocusedControl(control);
  }, { signal });
  const layoutChanged = () => { stopTracking(); schedule(); };
  const viewportChanged = () => {
    layoutChanged();
    // Preserve access when a keyboard/resize covers an answer that was visible.
    // An input deliberately scrolled off-screen must not pull the page back.
    if (focusedControlVisible && focusedControl === document.activeElement) revealFocusedControl(focusedControl);
  };
  window.addEventListener('resize', viewportChanged, { signal });
  window.visualViewport?.addEventListener('resize', viewportChanged, { signal });
  const observer = new ResizeObserver(layoutChanged);
  observer.observe(container);
  for (const element of layoutElements) observer.observe(element);
  document.fonts?.ready.then(() => { if (!disposed) layoutChanged(); });
  signal.addEventListener('abort', () => {
    disposed = true; stopTracking(); cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); observer.disconnect();
  }, { once: true });
  return {
    viewport,
    restore() { schedule(); },
    layoutChanged,
    interact() { restoring = false; stopTracking(); },
    jump(index, { focus = false } = {}) {
      restoring = false; stopTracking();
      if (focus) sections()[index]?.focus({ preventScroll: true });
      align();
    },
  };
}
