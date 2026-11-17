// Editor-only notification presentation. The session owns records and their policy.
const ACTIVITY_VISIBLE_INITIAL = 30;
const DEFAULT_NOTIFICATION_TOAST_TTL_MS = 5000;
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

export function getNotificationToastRemainingMs(notification, nowMs = Date.now()) {
  if (!notification || notification.showToast === false) return 0;
  const durationMs = Number.isFinite(Number(notification.ttlMs)) && Number(notification.ttlMs) > 0
    ? Number(notification.ttlMs)
    : DEFAULT_NOTIFICATION_TOAST_TTL_MS;
  const createdAtMs = new Date(notification.createdAt || '').getTime();
  const currentMs = Number(nowMs);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(currentMs)) return 0;
  return Math.max(0, Math.min(durationMs, createdAtMs + durationMs - currentMs));
}

/** Owns activity/toast DOM and timers, never worksheet or session state. */
export function createNotificationPanel({ t, requestRefresh, presentation = { dismissedIds: new Set() } }) {
  const activityFeed = document.createElement('section');
  activityFeed.className = 'notification-feed';
  const activityFeedToggle = document.createElement('details');
  activityFeedToggle.className = 'editor-activity-panel';
  const activityFeedHeading = document.createElement('summary');
  activityFeedHeading.className = 'editor-activity-panel__summary';
  activityFeedHeading.textContent = t('common.sections.activity');
  const activityFeedList = document.createElement('div');
  activityFeedList.className = 'notification-feed__list';
  const activityFeedSummary = document.createElement('p');
  activityFeedSummary.className = 'muted';
  const loadOlderActivityBtn = document.createElement('button');
  loadOlderActivityBtn.type = 'button';
  loadOlderActivityBtn.textContent = t('editor.activity.loadOlder');
  activityFeed.append(activityFeedSummary, activityFeedList, loadOlderActivityBtn);
  activityFeedToggle.append(activityFeedHeading, activityFeed);
  const toastContainer = document.createElement('div');
  toastContainer.className = 'editor-header-notification';
  toastContainer.hidden = true;
  let visibleActivityCount = ACTIVITY_VISIBLE_INITIAL;
  let activityLog = [];
  let destroyed = false;
  const dismissedToastIds = presentation.dismissedIds;
  let currentToastId = null, historySignature = "";
  const toastTimers = new Map();

  const getNotificationAriaLive = (kind) => (kind === 'error' ? 'assertive' : 'polite');
  const getNotificationRole = (kind) => (kind === 'error' ? 'alert' : 'status');
  const formatNotificationTimestamp = (isoValue) => {
    if (!isNonEmptyString(isoValue)) return '';
    const parsed = new Date(isoValue);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  const renderNotificationCard = (notification, className, { announce = true } = {}) => {
    const item = document.createElement('article');
    const severity = ['success', 'info', 'warn', 'error'].includes(notification?.kind) ? notification.kind : 'info';
    item.className = `${className} ${className}--${severity}`;
    if (announce) {
      item.setAttribute('aria-live', getNotificationAriaLive(severity));
      item.setAttribute('role', getNotificationRole(severity));
    } else {
      item.setAttribute('aria-live', 'off');
    }
    const message = document.createElement('div');
    message.className = `${className}__text`;
    message.textContent = notification?.text || '';
    const meta = document.createElement('div');
    meta.className = `${className}__meta`;
    const timestamp = document.createElement('time');
    timestamp.className = `${className}__time`;
    timestamp.dateTime = notification?.createdAt || '';
    timestamp.textContent = formatNotificationTimestamp(notification?.createdAt) || 'just now';
    meta.appendChild(timestamp);
    if (isNonEmptyString(notification?.actionLabel)) {
      const action = document.createElement('span');
      action.className = `${className}__action`;
      action.textContent = notification.actionLabel.trim();
      meta.appendChild(action);
    }
    item.append(message, meta);
    return item;
  };

  function update({ activityLog: nextActivityLog, notifications }) {
    if (destroyed) return;
    activityLog = Array.isArray(nextActivityLog) ? nextActivityLog : [];
    const totalActivity = activityLog.length;
    visibleActivityCount = Math.min(
      Math.max(ACTIVITY_VISIBLE_INITIAL, visibleActivityCount),
      Math.max(totalActivity, ACTIVITY_VISIBLE_INITIAL)
    );
    const feedNotifications = activityLog
      .slice(-visibleActivityCount)
      .reverse();
    const nextHistorySignature = JSON.stringify([visibleActivityCount, activityLog]);
    if (nextHistorySignature !== historySignature) {
      historySignature = nextHistorySignature;
      activityFeedList.innerHTML = '';
      activityFeedSummary.textContent = totalActivity > 0
        ? `Showing ${Math.min(visibleActivityCount, totalActivity)} of ${totalActivity} recent activities.`
        : 'Showing 0 of 0 recent activities.';
      if (feedNotifications.length === 0) {
        const emptyFeed = document.createElement('p');
        emptyFeed.className = 'muted';
        emptyFeed.textContent = t('common.activity.empty');
        activityFeedList.appendChild(emptyFeed);
      } else {
        feedNotifications.forEach((notification) => {
          activityFeedList.appendChild(renderNotificationCard(notification, 'notification-feed-item', { announce: false }));
        });
      }
      const hasOlderActivity = totalActivity > visibleActivityCount;
      loadOlderActivityBtn.hidden = !hasOlderActivity;
      loadOlderActivityBtn.disabled = !hasOlderActivity;
    }

    const activeNotificationIds = new Set(notifications.map((item) => item?.id).filter(Boolean));
    Array.from(toastTimers.keys()).forEach((notificationId) => {
      if (!activeNotificationIds.has(notificationId)) {
        window.clearTimeout(toastTimers.get(notificationId));
        toastTimers.delete(notificationId);
        dismissedToastIds.delete(notificationId);
      }
    });
    for (const id of dismissedToastIds) if (!activeNotificationIds.has(id)) dismissedToastIds.delete(id);
    const candidates = notifications.filter(item => item?.id && item.showToast !== false);
    const latest = candidates.at(-1);
    // Superseded messages must not reappear after a newer message expires or is cleared.
    candidates.slice(0, -1).forEach(item => dismissedToastIds.add(item.id));
    const remainingMs = getNotificationToastRemainingMs(latest);
    const notification = latest && remainingMs > 0 && !dismissedToastIds.has(latest.id) ? latest : null;
    if (!notification) {
      if (currentToastId) { toastContainer.replaceChildren(); currentToastId = null; }
      toastContainer.hidden = true;
      return;
    }
    if (!toastTimers.has(notification.id)) {
      toastTimers.set(notification.id, window.setTimeout(() => {
        if (destroyed) return;
        dismissedToastIds.add(notification.id);
        toastTimers.delete(notification.id);
        requestRefresh();
      }, remainingMs));
    }
    if (currentToastId === notification.id) return;
    currentToastId = notification.id;
    toastContainer.hidden = false;
    const display = notification.source === 'save.manual' && notification.kind === 'success'
      ? { ...notification, text: t('editor.notifications.save.savedLocalDraft') } : notification;
    const card = renderNotificationCard(display, 'notification-toast');
    const meta = card.querySelector('.notification-toast__meta');
    meta.replaceChildren();
    const history = document.createElement('button'); history.type = 'button';
    history.className = 'editor-status-link'; history.textContent = t('editorStatus.viewActivity');
    history.onclick = () => {
      if (destroyed || !history.isConnected) return;
      activityFeedToggle.open = true;
      activityFeedToggle.scrollIntoView({ block: 'center' });
      activityFeedHeading.focus({ preventScroll: true });
    };
    const dismiss = document.createElement('button'); dismiss.type = 'button';
    dismiss.className = 'editor-notification-dismiss'; dismiss.setAttribute('aria-label', t('editorStatus.dismiss'));
    dismiss.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    dismiss.onclick = () => {
      if (destroyed || !dismiss.isConnected) return;
      dismissedToastIds.add(notification.id); requestRefresh();
      toastContainer.closest('.editor-topbar')?.querySelector('.editor-status-badge')?.focus({ preventScroll: true });
    };
    meta.append(history, dismiss);
    toastContainer.replaceChildren(card);
  }

  function loadOlderActivity() {
    if (destroyed) return;
    visibleActivityCount = Math.min(activityLog.length, visibleActivityCount + ACTIVITY_VISIBLE_INITIAL);
    requestRefresh();
  }
  loadOlderActivityBtn.addEventListener('click', loadOlderActivity);

  function destroy() {
    destroyed = true;
    toastTimers.forEach(handle => window.clearTimeout(handle));
    toastTimers.clear();

    loadOlderActivityBtn.removeEventListener('click', loadOlderActivity);
    activityLog = [];
  }

  return { activityRoot: activityFeedToggle, headerRoot: toastContainer, update, destroy };
}
