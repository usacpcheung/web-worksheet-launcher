import { worksheetTextToPlain } from '../app/worksheet-text.js';

// Viewer-only presentation. All destinations go through the existing section controller.
const bookIcon = '<svg class="viewer-book-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15"/></svg>';
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const button = (className, text) => {
  const node = make('button', className, text);
  node.type = 'button';
  return node;
};
export function isAnsweredValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
export function describeSections(blocks, t) {
  let question = 0, reading = 0;
  return blocks.map(block => {
    const isQuestion = block.kind === 'question';
    const number = isQuestion ? ++question : ++reading;
    return { id: block.blockId, isQuestion, number,
      label: t(isQuestion ? 'viewer.navigation.question' : 'viewer.navigation.reading', { number }),
      title: worksheetTextToPlain(isQuestion ? block.prompt : block.content).trim().split(/\n/)[0],
    };
  });
}

export function createWorksheetNavigation({ t, actions, navigate, signal }) {
  const root = make('div', 'viewer-navigation');
  const panel = make('aside', 'viewer-action-panel');
  panel.setAttribute('aria-label', t('viewer.navigation.actions'));
  const ring = button('viewer-progress-ring');
  const ringLabel = make('span', 'viewer-progress-ring__label');
  const ringValue = make('strong', 'viewer-progress-ring__value');
  ring.append(ringLabel, ringValue);
  const progress = make('p', 'viewer-progress-count');
  const browse = button('viewer-browse', t('viewer.navigation.browse'));
  const context = make('p', 'viewer-current-section');
  const nav = make('div', 'viewer-section-actions');
  nav.append(actions.previous, actions.next);
  const primary = make('div', 'viewer-primary-actions');
  primary.append(actions.save, actions.submit, actions.check);
  panel.append(ring, progress, browse, context, nav, primary);
  const launcher = button('viewer-actions-launcher');
  launcher.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  const launcherValue = make('span', 'viewer-launcher-value');
  launcherValue.setAttribute('aria-hidden', 'true');
  launcher.append(launcherValue);
  const drawer = make('dialog', 'viewer-actions-drawer');
  drawer.id = 'viewer-actions-drawer';
  drawer.setAttribute('aria-label', t('viewer.navigation.actions'));
  const drawerClose = button('viewer-drawer-close', t('common.actions.close'));
  drawer.append(drawerClose);
  launcher.setAttribute('aria-controls', drawer.id);
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-expanded', 'false');
  const chooser = make('dialog', 'viewer-chooser');
  chooser.id = 'viewer-chooser';
  chooser.setAttribute('aria-labelledby', 'viewer-chooser-title');
  const head = make('div', 'viewer-chooser__header');
  const title = make('h2', '', t('viewer.navigation.browse'));
  title.id = 'viewer-chooser-title';
  const close = button('viewer-chooser__close', '×');
  close.setAttribute('aria-label', t('common.actions.close'));
  head.append(title, close);
  const location = make('p', 'viewer-chooser__location');
  const list = make('div', 'viewer-chooser__list');
  const footer = make('div', 'viewer-chooser__footer');
  const previousPage = button('viewer-chooser__previous', '‹');
  const nextPage = button('viewer-chooser__next', '›');
  previousPage.setAttribute('aria-label', t('viewer.navigation.previousPage'));
  nextPage.setAttribute('aria-label', t('viewer.navigation.nextPage'));
  const pageLabel = make('span', 'viewer-chooser__page');
  pageLabel.tabIndex = -1;
  pageLabel.setAttribute('aria-live', 'polite');
  footer.append(previousPage, pageLabel, nextPage);
  chooser.append(head, location, list, footer);
  root.append(panel, launcher, drawer, chooser);
  for (const opener of [ring, browse]) {
    opener.setAttribute('aria-haspopup', 'dialog');
    opener.setAttribute('aria-controls', chooser.id);
    opener.setAttribute('aria-expanded', 'false');
  }
  const narrow = matchMedia('(max-width: 900px), (max-height: 650px)');
  let entries = [], rows = [], current = 0, page = 0, capacity = 6, returnFocus;
  let fitting = false, frame;
  const closeDrawer = (restore = true) => {
    if (!drawer.open) return;
    drawer.close();
    launcher.setAttribute('aria-expanded', 'false');
    if (restore) launcher.focus({ preventScroll: true });
  };
  const closeChooser = (restore = true) => {
    if (!chooser.open) return;
    chooser.close();
    for (const opener of [ring, browse]) opener.setAttribute('aria-expanded', 'false');
    if (restore) (narrow.matches ? launcher : returnFocus)?.focus({ preventScroll: true });
  };
  const drawPage = () => {
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / capacity) - 1));
    rows.forEach((row, index) => { row.hidden = index < page * capacity || index >= (page + 1) * capacity; });
    previousPage.disabled = page === 0;
    nextPage.disabled = (page + 1) * capacity >= rows.length;
    pageLabel.textContent = t('viewer.navigation.page', { page: page + 1, total: Math.max(1, Math.ceil(rows.length / capacity)) });
  };
  // Measure actual translated/font-scaled rows, not a fixed pixel guess. No list scrollbox.
  const fit = (anchor = page * capacity, preserveFocus = true) => {
    if (!chooser.open || fitting) return;
    fitting = true;
    const focused = rows.indexOf(document.activeElement);
    if (preserveFocus && focused >= 0) anchor = focused;
    const height = window.visualViewport?.height || innerHeight;
    // Use the tallest real row so moving between pages cannot change capacity
    // and accidentally skip a section. Rows stay mounted throughout measurement.
    rows.forEach(row => { row.hidden = false; });
    const rowHeight = Math.max(44, ...rows.map(row => row.getBoundingClientRect().height));
    const listStyle = getComputedStyle(list);
    const gap = parseFloat(listStyle.rowGap) || 0;
    const chrome = chooser.getBoundingClientRect().height - list.getBoundingClientRect().height;
    capacity = Math.max(1, Math.min(6, Math.floor((height - 16 - chrome + gap) / (rowHeight + gap))));
    page = Math.floor(anchor / capacity);
    drawPage();
    fitting = false;
  };
  const scheduleFit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!signal.aborted) fit(); });
  };
  const openChooser = () => {
    returnFocus = document.activeElement;
    closeDrawer(false);
    chooser.showModal();
    for (const opener of [ring, browse]) opener.setAttribute('aria-expanded', 'true');
    fit(current, false);
    rows[current]?.focus({ preventScroll: true });
  };
  ring.addEventListener('click', openChooser, { signal });
  browse.addEventListener('click', openChooser, { signal });
  close.addEventListener('click', () => closeChooser(), { signal });
  chooser.addEventListener('cancel', event => { event.preventDefault(); closeChooser(); }, { signal });
  launcher.addEventListener('click', () => {
    drawer.showModal();
    launcher.setAttribute('aria-expanded', 'true');
    drawerClose.focus({ preventScroll: true });
  }, { signal });
  drawerClose.addEventListener('click', () => closeDrawer(), { signal });
  drawer.addEventListener('cancel', event => { event.preventDefault(); closeDrawer(); }, { signal });
  for (const [control, direction] of [[previousPage, -1], [nextPage, 1]]) {
    control.addEventListener('click', () => {
      page += direction;
      drawPage();
      // Keep a keyboard anchor even when the pressed page button becomes disabled.
      pageLabel.focus({ preventScroll: true });
      fit();
    }, { signal });
  }
  for (const control of Object.values(actions)) {
    // Release the modal top layer before existing submit/check/save flows run.
    control.addEventListener('click', () => closeDrawer(), { capture: true, signal });
  }
  const adapt = () => {
    const active = document.activeElement;
    closeDrawer(false);
    if (narrow.matches) drawer.append(panel);
    else root.prepend(panel);
    if (panel.contains(active) || active === drawerClose || (!narrow.matches && active === launcher)) {
      (narrow.matches ? launcher : browse).focus({ preventScroll: true });
    }
    scheduleFit();
  };
  narrow.addEventListener('change', adapt, { signal });
  window.addEventListener('resize', scheduleFit, { signal });
  window.visualViewport?.addEventListener('resize', scheduleFit, { signal });
  document.fonts?.ready.then(() => { if (!signal.aborted) scheduleFit(); });
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(head); observer.observe(footer);
  adapt();
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame); observer.disconnect(); closeChooser(false); closeDrawer(false);
  }, { once: true });
  const update = (blocks, activeIndex, answers, summary) => {
    const next = describeSections(blocks, t);
    if (JSON.stringify(entries) !== JSON.stringify(next)) {
      entries = next;
      rows = entries.map((entry, index) => {
        const row = button('viewer-chooser__item');
        row.dataset.sectionIndex = index;
        row.classList.toggle('viewer-chooser__item--reading', !entry.isQuestion);
        const mark = make('span', 'viewer-chooser__mark', entry.isQuestion ? entry.number : '');
        if (!entry.isQuestion) mark.innerHTML = bookIcon;
        mark.setAttribute('aria-hidden', 'true');
        const words = make('span', 'viewer-chooser__words');
        words.append(make('span', 'viewer-chooser__title', entry.title || entry.label), make('span', 'viewer-chooser__kind', entry.label));
        const state = make('span', 'viewer-chooser__state');
        state.setAttribute('aria-hidden', 'true');
        row.append(mark, words, state);
        row.addEventListener('click', () => { closeChooser(false); navigate(index); }, { signal });
        return row;
      });
      list.replaceChildren(...rows);
      drawPage();
    }
    current = activeIndex;
    const entry = entries[current];
    if (!entry) return;
    setText(ringLabel, t(entry.isQuestion ? 'viewer.navigation.currentQuestion' : 'viewer.navigation.currentReading'));
    if (entry.isQuestion) setText(ringValue, String(entry.number));
    else if (!ringValue.firstElementChild) ringValue.innerHTML = bookIcon;
    ring.style.setProperty('--answered-angle', `${summary.total ? summary.answered / summary.total * 360 : 0}deg`);
    setText(progress, t('viewer.summary.answered', summary));
    ring.setAttribute('aria-label', `${entry.label}. ${progress.textContent}. ${t('viewer.navigation.browse')}`);
    setText(context, entry.label);
    setText(location, t('viewer.navigation.location', { section: entry.label }));
    launcher.setAttribute('aria-label', `${t('viewer.navigation.actions')}. ${entry.label}`);
    if (entry.isQuestion) setText(launcherValue, String(entry.number));
    else if (!launcherValue.firstElementChild) launcherValue.innerHTML = bookIcon;
    rows.forEach((row, index) => {
      const item = entries[index];
      const answered = item.isQuestion && isAnsweredValue(answers?.[item.id]?.value);
      if (row.dataset.answered === String(answered) && row.classList.contains('is-current') === (index === current)) return;
      row.classList.toggle('is-current', index === current);
      if (index === current) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
      row.dataset.answered = String(answered);
      row.lastElementChild.textContent = answered ? '✓' : '';
      row.setAttribute('aria-label', `${item.label}: ${item.title || item.label}${item.isQuestion ? `. ${t(answered ? 'viewer.navigation.answered' : 'viewer.navigation.unanswered')}` : ''}`);
    });
  };
  return { root, update, launcher, panel };
}
