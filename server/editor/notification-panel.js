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
export function createNotificationPanel({ t, requestRefresh }) {
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
  toastContainer.className = 'notification-toast-container';
  let visibleActivityCount = ACTIVITY_VISIBLE_INITIAL;
  let activityLog = [];
  let destroyed = false;
  const dismissedToastIds = new Set();
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

    const activeNotificationIds = new Set(notifications.map((item) => item?.id).filter(Boolean));
    Array.from(toastTimers.keys()).forEach((notificationId) => {
      if (!activeNotificationIds.has(notificationId)) {
        window.clearTimeout(toastTimers.get(notificationId));
        toastTimers.delete(notificationId);
        dismissedToastIds.delete(notificationId);
      }
    });
    const toastNowMs = Date.now();
    const toastNotifications = notifications
      .map((notification) => ({
        notification,
        remainingMs: getNotificationToastRemainingMs(notification, toastNowMs),
      }))
      .filter(({ notification, remainingMs }) => notification?.id
        && remainingMs > 0
        && !dismissedToastIds.has(notification.id))
      .slice(-4);
    toastContainer.innerHTML = '';
    toastNotifications.forEach(({ notification, remainingMs }) => {
      if (!toastTimers.has(notification.id)) {
        const timerHandle = window.setTimeout(() => {
          if (destroyed) return;
          dismissedToastIds.add(notification.id);
          toastTimers.delete(notification.id);
          requestRefresh();
        }, remainingMs);
        toastTimers.set(notification.id, timerHandle);
      }
      toastContainer.appendChild(renderNotificationCard(notification, 'notification-toast'));
    });
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
    dismissedToastIds.clear();
    loadOlderActivityBtn.removeEventListener('click', loadOlderActivity);
    activityLog = [];
  }

  return { activityRoot: activityFeedToggle, toastRoot: toastContainer, update, destroy };
}
