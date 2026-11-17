import { attachBlockDragReorder } from './block-drag-reorder.js';
import { worksheetTextToPlain } from '../app/worksheet-text.js';
import { isFillInBlanks } from '../app/fill-in-blanks.js';
import { passageToPrompt } from './question-type-conversion.js';

// Owns block-list presentation and gestures. Session mutations stay with callbacks.
export function createBlockNavigation({
  blockList, dialogHost, getState, onSelect, onMove, onDelete, requestRefresh,
  t, createEditorIcon, getBlockKindLabel,
}) {
  let destroyed = false;
  let activePositionDialog = null;
  let closeActiveBlockReorderMenu = null;
  let activeBlockReorderAnchor = null;
  const reorderStatus = document.createElement('span');
  reorderStatus.className = 'editor-reorder-status';
  reorderStatus.setAttribute('role', 'status');
  dialogHost.append(reorderStatus);
  const orderedBlocks = () => (getState().blocks || []).slice().sort((a, b) => a.position - b.position);
  const focusMovedBlock = (blockId, selector = '.block-reorder-trigger', reveal = true) => {
    if (destroyed) return;
    const row = Array.from(blockList.children).find(node => node.dataset.blockId === blockId);
    row?.querySelector(selector)?.focus({ preventScroll: true });
    if (row && reveal) {
      const bounds = blockList.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      if (rect.top < bounds.top) blockList.scrollTop -= bounds.top - rect.top;
      else if (rect.bottom > bounds.bottom) blockList.scrollTop += rect.bottom - bounds.bottom;
    }
  };
  const moveBlock = (blockId, targetIndex, selector) => {
    const scrollTop = blockList.scrollTop;
    if (destroyed) return;
    onMove(blockId, targetIndex);
    blockList.scrollTop = scrollTop;
    focusMovedBlock(blockId, selector);
    const blocks = orderedBlocks();
    const index = blocks.findIndex(block => block.blockId === blockId);
    if (index >= 0) reorderStatus.textContent = t('editor.reorder.moved', { index: index + 1, total: blocks.length });
  };
  const onListKeyDown = event => {
    if (destroyed) return;
    if (event.isComposing || event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey)
      || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    const row = event.target.closest('.block-item');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const index = orderedBlocks().findIndex(block => block.blockId === row.dataset.blockId);
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (index < 0 || target < 0 || target >= orderedBlocks().length) return;
    const selector = event.target.closest('.block-drag-handle') ? '.block-drag-handle'
      : event.target.closest('.block-select') ? '.block-select' : '.block-reorder-trigger';
    moveBlock(row.dataset.blockId, target, selector);
  };
  blockList.addEventListener('keydown', onListKeyDown);
  const openBlockPositionDialog = (blockId) => {
    if (destroyed) return;
    const draftId = getState().draftId;
    const blocks = orderedBlocks();
    const index = blocks.findIndex(block => block.blockId === blockId);
    if (index < 0) return;
    const dialog = document.createElement('dialog');
    activePositionDialog = dialog;
    dialog.className = 'confirm-modal editor-block-position-dialog';
    dialog.setAttribute('aria-labelledby', 'editor-block-position-title');
    const form = document.createElement('form');
    const title = document.createElement('h3');
    title.id = 'editor-block-position-title';
    title.textContent = t('editor.reorder.positionTitle', { index: index + 1 });
    const label = document.createElement('label');
    label.className = 'editor-block-position-field';
    label.textContent = t('editor.reorder.positionLabel');
    const select = document.createElement('select');
    select.className = 'control';
    select.setAttribute('aria-describedby', 'editor-block-position-help');
    blocks.forEach((_, position) => {
      const option = document.createElement('option');
      option.value = String(position);
      option.textContent = String(position + 1);
      select.append(option);
    });
    select.value = String(index);
    label.append(select);
    const help = document.createElement('p');
    help.id = 'editor-block-position-help';
    help.className = 'muted';
    help.textContent = t('editor.reorder.positionHelp');
    const actions = document.createElement('div');
    actions.className = 'confirm-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-modal__btn';
    cancel.textContent = t('common.actions.cancel');
    cancel.addEventListener('click', () => dialog.close());
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'confirm-modal__btn';
    submit.textContent = t('editor.reorder.move');
    actions.append(cancel, submit);
    form.append(title, label, help, actions);
    dialog.append(form);
    dialogHost.append(dialog);
    let moved = false;
    form.addEventListener('submit', event => {
      event.preventDefault();
      // A replaced worksheet or changed block sequence invalidates this destination.
      const current = orderedBlocks();
      if (destroyed || getState().draftId !== draftId
        || current.length !== blocks.length
        || current.some((block, i) => block.blockId !== blocks[i].blockId)) {
        dialog.close();
        return;
      }
      moved = true;
      const targetIndex = Number(select.value);
      dialog.close();
      moveBlock(blockId, targetIndex);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (activePositionDialog === dialog) activePositionDialog = null;
      if (!moved) focusMovedBlock(blockId, '.block-reorder-trigger', false);
    }, { once: true });
    dialog.showModal();
    select.focus();
  };
  const blockDrag = attachBlockDragReorder(blockList, {
    getBlocks: orderedBlocks,
    getDraftId: () => getState().draftId,
    onMove: (id, index) => moveBlock(id, index, '.block-drag-handle'),
    onFinish: () => { if (!destroyed) requestRefresh(); },
    onStart: () => closeBlockReorderMenu(),
  });
  const closeBlockReorderMenu = () => {
    if (typeof closeActiveBlockReorderMenu === 'function') {
      closeActiveBlockReorderMenu();
      closeActiveBlockReorderMenu = null;
    }
    if (activeBlockReorderAnchor) {
      activeBlockReorderAnchor.setAttribute('aria-expanded', 'false');
      activeBlockReorderAnchor = null;
    }
  };
  const positionBlockReorderMenu = (menu, anchor) => {
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const belowTop = anchorRect.bottom + 6;
    const aboveTop = anchorRect.top - menuRect.height - 6;
    const hasRoomBelow = belowTop + menuRect.height <= window.innerHeight - viewportPadding;
    const top = hasRoomBelow ? belowTop : Math.max(viewportPadding, aboveTop);
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - viewportPadding)
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  const openBlockReorderMenu = ({ anchor, block, displayIndex, isFirst, isLast }) => {
    if (destroyed) return;
    closeBlockReorderMenu();
    const menu = document.createElement('div');
    menu.className = 'block-reorder-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('editor.reorder.menuAriaLabel', { index: displayIndex }));

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'block-reorder-menu__item';
    moveUpBtn.title = t('editor.reorder.moveUpTitle', { index: displayIndex });
    moveUpBtn.textContent = t('editor.reorder.moveUp');
    moveUpBtn.disabled = isFirst;
    moveUpBtn.setAttribute('role', 'menuitem');
    moveUpBtn.addEventListener('click', () => {
      closeBlockReorderMenu();
      moveBlock(block.blockId, orderedBlocks().findIndex(entry => entry.blockId === block.blockId) - 1);
    });

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'block-reorder-menu__item';
    moveDownBtn.title = t('editor.reorder.moveDownTitle', { index: displayIndex });
    moveDownBtn.textContent = t('editor.reorder.moveDown');
    moveDownBtn.disabled = isLast;
    moveDownBtn.setAttribute('role', 'menuitem');
    moveDownBtn.addEventListener('click', () => {
      closeBlockReorderMenu();
      moveBlock(block.blockId, orderedBlocks().findIndex(entry => entry.blockId === block.blockId) + 1);
    });

    const body = document.createElement('div');
    body.className = 'block-reorder-menu__body';
    body.append(moveUpBtn, moveDownBtn);
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
    moveUpBtn.textContent += ` (${modifier}+Shift+↑)`;
    moveDownBtn.textContent += ` (${modifier}+Shift+↓)`;
    for (const [key, disabled, action] of [
      ['beginning', isFirst, () => moveBlock(block.blockId, 0)],
      ['end', isLast, () => moveBlock(block.blockId, orderedBlocks().length - 1)],
      ['position', isFirst && isLast, () => openBlockPositionDialog(block.blockId)],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'block-reorder-menu__item';
      button.setAttribute('role', 'menuitem');
      button.textContent = t(`editor.reorder.${key}`);
      button.disabled = disabled;
      button.addEventListener('click', () => { closeBlockReorderMenu(); action(); });
      body.append(button);
    }
    menu.appendChild(body);
    document.body.appendChild(menu);
    activeBlockReorderAnchor = anchor;
    positionBlockReorderMenu(menu, anchor);

    const onPointerDown = (event) => {
      if (menu.contains(event.target) || anchor.contains(event.target)) return;
      closeBlockReorderMenu();
    };
    const onKeyDown = (event) => {
      // With one block all actions are disabled and focus stays on the trigger.
      if (!menu.contains(event.target) && !anchor.contains(event.target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBlockReorderMenu();
        anchor.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') { closeBlockReorderMenu(); anchor.focus({ preventScroll: true }); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(body.querySelectorAll('button:not(:disabled)'));
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    const onScrollOrResize = event => {
      if (event.type === 'scroll' && menu.contains(event.target)) return;
      const rect = anchor.getBoundingClientRect();
      const listRect = blockList.getBoundingClientRect();
      if (!anchor.isConnected || rect.bottom <= Math.max(0, listRect.top)
        || rect.top >= Math.min(window.innerHeight, listRect.bottom)) {
        closeBlockReorderMenu();
      } else {
        positionBlockReorderMenu(menu, anchor);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    closeActiveBlockReorderMenu = () => {
      menu.remove();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
    body.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  };

  let blockListStructureSignature = null;
  const blockPreview = block => {
    const source = worksheetTextToPlain(block.kind === 'question'
      ? (isFillInBlanks(block.responseConfig) ? passageToPrompt(block) : block.prompt) : block.content);
    return String(source || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '—';
  };
  const update = () => {
    if (destroyed) return;
    // Autosave/status updates must not remove the native drag source. A real
    // worksheet/order change cancels the gesture rather than applying a stale drop.
    if (blockDrag.active && blockDrag.current()) return;
    blockDrag.cancel();
    const feedbackSelected = getState().feedbackSelected;
    const blocks = (getState().blocks || []).slice().sort((a, b) => a.position - b.position);
    // Typing, selection and autosave keep the same row controls mounted. Only
    // structural changes need new rows and their position-dependent handlers.
    const signature = JSON.stringify([getState().draftId, blocks.map(block => [block.blockId, block.kind])]);
    if (signature === blockListStructureSignature) {
      blocks.forEach((block, index) => {
        const item = blockList.children[index];
        const selected = !feedbackSelected && block.blockId === getState().selectedBlockId;
        if (item.classList.contains('selected') !== selected) item.classList.toggle('selected', selected);
        const title = item.querySelector('.block-select__title');
        const preview = blockPreview(block);
        if (title.textContent !== preview) title.textContent = preview;
      });
      return;
    }
    // The menu lives under document.body, not blockList. Capture its owning
    // trigger before structural changes so removing rows cannot strand focus.
    const focused = blockList.contains(document.activeElement) ? document.activeElement
      : activeBlockReorderAnchor && document.activeElement?.closest('.block-reorder-menu')
        ? activeBlockReorderAnchor : null;
    const focusedId = focused?.closest('.block-item')?.dataset.blockId;
    const focusedClass = focused?.classList.contains('block-drag-handle') ? '.block-drag-handle'
      : focused?.classList.contains('block-select') ? '.block-select'
      : focused?.classList.contains('danger') ? '.danger' : '.block-reorder-trigger';
    const previousScrollTop = blockList.scrollTop;
    closeBlockReorderMenu();
    blockList.innerHTML = '';
    blocks.forEach((block, index) => {
      const isFirst = index === 0;
      const isLast = index === blocks.length - 1;
      const item = document.createElement('li');
      item.className = `block-item ${!feedbackSelected && block.blockId === getState().selectedBlockId ? 'selected' : ''}`;
      item.dataset.blockId = block.blockId;
      item.dataset.blockIndex = String(index);
      const row = document.createElement('div');
      row.className = 'block-item-row';
      const dragHandle = document.createElement('button');
      dragHandle.type = 'button';
      dragHandle.className = 'block-drag-handle';
      dragHandle.title = t('editor.reorder.dragHandleTitle', { index: index + 1 });
      dragHandle.setAttribute('aria-label', t('editor.reorder.dragHandleAriaLabel', { index: index + 1 }));
      dragHandle.setAttribute('draggable', 'true');
      dragHandle.innerHTML = createEditorIcon('grip');
      dragHandle.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'block-select';
      const displayIndex = index + 1;
      const preview = blockPreview(block);
      const blockIndex = document.createElement('span');
      blockIndex.className = 'block-select__index';
      blockIndex.textContent = `${displayIndex}.`;
      const blockTitle = document.createElement('span');
      blockTitle.className = 'block-select__title';
      blockTitle.textContent = preview;
      const blockBadge = document.createElement('span');
      blockBadge.className = `block-kind-badge block-kind-badge--${block.kind}`;
      blockBadge.textContent = getBlockKindLabel(block.kind);
      button.append(blockIndex, blockTitle, blockBadge);
      button.addEventListener('click', () => {
        if (!destroyed) onSelect(block.blockId);
      });
      const actions = document.createElement('div');
      actions.className = 'block-item-actions';
      const reorderMenuBtn = document.createElement('button');
      reorderMenuBtn.type = 'button';
      reorderMenuBtn.className = 'icon-btn block-reorder-trigger';
      reorderMenuBtn.title = t('editor.reorder.moreActionsTitle', { index: displayIndex });
      reorderMenuBtn.setAttribute('aria-label', t('editor.reorder.moreActionsAriaLabel', { index: displayIndex }));
      reorderMenuBtn.setAttribute('aria-haspopup', 'menu');
      reorderMenuBtn.setAttribute('aria-expanded', 'false');
      reorderMenuBtn.innerHTML = createEditorIcon('moreHorizontal');
      reorderMenuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpenForThisButton = activeBlockReorderAnchor === reorderMenuBtn;
        closeBlockReorderMenu();
        if (!isOpenForThisButton) {
          reorderMenuBtn.setAttribute('aria-expanded', 'true');
          openBlockReorderMenu({ anchor: reorderMenuBtn, block, displayIndex, isFirst, isLast });
        }
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'icon-btn danger';
      deleteBtn.title = t('editor.block.deleteThisBlock');
      deleteBtn.setAttribute('aria-label', t('editor.block.deleteBlockAriaLabel', { index: displayIndex }));
      deleteBtn.innerHTML = createEditorIcon('trash');
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!destroyed) onDelete(block.blockId, displayIndex);
      });
      actions.append(reorderMenuBtn, deleteBtn);
      row.append(dragHandle, button, actions);
      item.appendChild(row);
      blockList.appendChild(item);
    });
    blockList.scrollTop = previousScrollTop;
    if (focusedId) focusMovedBlock(focusedId, focusedClass, false);
    blockListStructureSignature = signature;
  };

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    blockDrag.destroy();
    closeBlockReorderMenu();
    blockList.removeEventListener('keydown', onListKeyDown);
    if (activePositionDialog) {
      activePositionDialog.close();
      activePositionDialog.remove();
      activePositionDialog = null;
    }
    reorderStatus.remove();
  }

  return { update, destroy };
}
