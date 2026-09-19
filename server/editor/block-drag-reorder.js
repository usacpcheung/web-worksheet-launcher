// Native mouse drag remains optional; move commands provide keyboard/touch access.
export function dropIndexAtY(rects, y, sourceIndex) {
  const before = rects.findIndex(rect => y < rect.top + rect.height / 2);
  const insertion = before < 0 ? rects.length : before;
  return Math.max(0, Math.min(rects.length - 1, insertion - (sourceIndex < insertion ? 1 : 0)));
}

export function edgeScrollSpeed(y, top, bottom) {
  if (y < top || y > bottom || bottom <= top) return 0;
  const zone = Math.min(48, (bottom - top) / 3);
  if (y < top + zone) return -600 * (1 - (y - top) / zone);
  if (y > bottom - zone) return 600 * (1 - (bottom - y) / zone);
  return 0;
}

export function attachBlockDragReorder(list, { getBlocks, getDraftId, onMove, onFinish, onStart }) {
  const doc = list.ownerDocument;
  const win = doc.defaultView;
  let drag = null;
  let frame = null;
  let point = null;
  let lastTime = null;
  const rows = () => Array.from(list.children);
  const clearMarkers = () => rows().forEach(row => row.classList.remove('block-item--drop-before', 'block-item--drop-after'));
  const current = () => {
    if (!drag || getDraftId() !== drag.draftId) return false;
    const blocks = getBlocks();
    return blocks.length === drag.ids.length && blocks.every((block, index) => block.blockId === drag.ids[index]);
  };
  const pause = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
    point = null;
    clearMarkers();
  };
  const finish = (refresh = true) => {
    if (!drag) return;
    pause();
    drag = null;
    rows().forEach(row => row.classList.remove('block-item--dragging'));
    doc.removeEventListener('dragover', outside, true);
    doc.removeEventListener('drop', outsideDrop, true);
    doc.removeEventListener('dragend', end, true);
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('visibilitychange', visibility);
    win.removeEventListener('blur', end);
    win.removeEventListener('pagehide', end);
    if (refresh && list.isConnected) onFinish();
  };
  function end() { finish(); }
  function keydown(event) { if (event.key === 'Escape') finish(); }
  function visibility() { if (doc.hidden) finish(); }
  function outside(event) { if (!list.contains(event.target)) pause(); }
  function outsideDrop(event) { if (!list.contains(event.target)) finish(); }
  const inside = (x, y) => {
    const rect = list.getBoundingClientRect();
    const hit = doc.elementFromPoint(x, y);
    return x >= rect.left && x <= rect.right && y >= Math.max(0, rect.top)
      && y <= Math.min(win.innerHeight, rect.bottom) && hit && list.contains(hit);
  };
  const mark = y => {
    const items = rows();
    const rects = items.map(row => row.getBoundingClientRect());
    const source = drag.ids.indexOf(drag.id);
    const target = dropIndexAtY(rects, y, source);
    clearMarkers();
    if (target !== source) {
      const before = rects.findIndex(rect => y < rect.top + rect.height / 2);
      if (before < 0) items.at(-1)?.classList.add('block-item--drop-after');
      else items[before]?.classList.add('block-item--drop-before');
    }
    return target;
  };
  const tick = time => {
    frame = null;
    if (!current() || !list.isConnected) { finish(); return; }
    if (!point || !inside(point.x, point.y)) { pause(); return; }
    const rect = list.getBoundingClientRect();
    const speed = edgeScrollSpeed(point.y, Math.max(0, rect.top), Math.min(win.innerHeight, rect.bottom));
    const elapsed = lastTime === null ? 0 : Math.min(32, time - lastTime);
    lastTime = time;
    list.scrollTop += speed * elapsed / 1000;
    mark(point.y);
    frame = win.requestAnimationFrame(tick);
  };
  list.addEventListener('dragstart', event => {
    const handle = event.target.closest('.block-drag-handle');
    if (!handle || !list.contains(handle)) return;
    finish(false);
    const row = handle.closest('.block-item');
    const ids = getBlocks().map(block => block.blockId);
    if (!row || !ids.includes(row.dataset.blockId)) { event.preventDefault(); return; }
    drag = { id: row.dataset.blockId, draftId: getDraftId(), ids };
    onStart?.();
    row.classList.add('block-item--dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', drag.id);
    }
    doc.addEventListener('dragover', outside, true);
    doc.addEventListener('drop', outsideDrop, true);
    doc.addEventListener('dragend', end, true);
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('visibilitychange', visibility);
    win.addEventListener('blur', end);
    win.addEventListener('pagehide', end);
  });
  list.addEventListener('dragover', event => {
    if (!drag) return; // Never accept an external file/text drag as a block move.
    if (!current()) { finish(); return; }
    if (!inside(event.clientX, event.clientY)) { pause(); return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    point = { x: event.clientX, y: event.clientY };
    mark(point.y);
    if (frame === null) frame = win.requestAnimationFrame(tick);
  });
  list.addEventListener('dragleave', event => {
    if (event.relatedTarget && list.contains(event.relatedTarget)) return;
    // Child-to-child transitions keep their marker; only leaving the list pauses.
    if (!inside(event.clientX, event.clientY)) pause();
  });
  list.addEventListener('drop', event => {
    if (!drag) return;
    if (!current() || !inside(event.clientX, event.clientY)) { finish(); return; }
    event.preventDefault();
    const id = drag.id;
    const target = mark(event.clientY);
    finish(false); // Stop animation before mutation triggers a synchronous render.
    onMove(id, target);
  });
  return { get active() { return Boolean(drag); }, current, cancel: () => finish(false) };
}
