// Web Locks survive background throttling and are released when a tab crashes.
// A short navigation hold bridges reloads; auth redirects reserve 15 minutes.
const PREFIX = 'worksheet:active-attempt:';
const MUTEX = 'worksheet:attempt-lifecycle';
const HOLDS = 'worksheetLauncher:attemptNavigationHolds';
export const RETIRED_KEY = 'worksheetLauncher:retiredAttempts';
export function readLocalJson(key, fallback) {
  try { return JSON.parse(globalThis.localStorage?.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
export function writeLocalJson(key, value) { globalThis.localStorage?.setItem(key, JSON.stringify(value)); }
export function withAttemptLock(task) {
  return globalThis.navigator?.locks?.request ? navigator.locks.request(MUTEX, task) : Promise.resolve().then(task);
}
export function reserveAttempt(id, duration = 60_000) {
  if (!id) return;
  const now = Date.now();
  const holds = Object.fromEntries(Object.entries(readLocalJson(HOLDS, {})).filter(([, expires]) => expires > now));
  holds[id] = Math.max(holds[id] || 0, now + duration);
  writeLocalJson(HOLDS, holds);
}
export async function protectedAttempts() {
  // Without reliable cross-tab ownership, preserve data instead of guessing.
  if (!globalThis.navigator?.locks?.query) return null;
  const locks = await navigator.locks.query();
  const ids = new Set((locks.held || []).filter(lock => lock.name.startsWith(PREFIX)).map(lock => lock.name.slice(PREFIX.length)));
  for (const [id, expires] of Object.entries(readLocalJson(HOLDS, {}))) if (expires > Date.now()) ids.add(id);
  return [...ids];
}
export async function holdAttempt(id) {
  if (!globalThis.navigator?.locks?.request) return () => {};
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let ready, failed;
  const acquired = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const operation = navigator.locks.request(PREFIX + id, { mode: 'shared' }, () => { ready(); return held; });
  operation.catch(failed);
  await acquired;
  return release;
}
export function retireAttempt(id) {
  if (id) writeLocalJson(RETIRED_KEY, [...new Set([...readLocalJson(RETIRED_KEY, []), id])]);
}
