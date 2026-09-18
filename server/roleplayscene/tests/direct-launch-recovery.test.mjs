import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
function load(context, first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}

for (const confirmed of [true, false]) {
  test(`direct exit ${confirmed ? 'clears confirmed text before navigation' : 'preserves text when canceled'}`, async () => {
    let text = 'Synthetic discussion';
    let navigations = 0;
    let confirm;
    const context = vm.createContext({
      publishedPlay: { source: 'direct' },
      discussionSession: { hasAnyText: () => Boolean(text), clear: () => { text = ''; } },
      confirmDiscardDiscussion: () => new Promise(resolve => { confirm = resolve; }),
      returnToRolePlaySceneEditor() {
        assert.equal(text, '', 'beforeunload must no longer detect discussion text');
        navigations++;
      },
    });
    load(context, 'async function ensureDiscussionCanBeDiscarded()', 'async function showUploadConflictModal');
    load(context, 'async function exitPublishedPlay()', 'async function openPublishedRolePlaySceneById(');
    const exiting = context.exitPublishedPlay();
    assert.equal(text, 'Synthetic discussion');
    assert.equal(navigations, 0);
    confirm(confirmed);
    await exiting;
    assert.equal(navigations, confirmed ? 1 : 0);
    assert.equal(text, confirmed ? '' : 'Synthetic discussion');
  });
}

for (const blocked of [true, false]) {
  test(`sign-in callbacks preserve ${blocked ? 'blocked popup recovery' : 'normal pending authentication'}`, () => {
    let callbacks;
    const states = [];
    const context = vm.createContext({
      activeAuthFlow: null, apiClient: {}, directLaunch: { active: true },
      AUTH_POPUP_FLOW_DEFAULTS: {}, showMessage() {},
      setDirectLaunchState: state => states.push(state),
      startAuthPopupFlow(options) { callbacks = options; return {}; },
    });
    load(context, 'function startServerSignIn()', 'function getUploadWarnings');
    context.startServerSignIn();
    if (blocked) callbacks.onPopupBlocked();
    callbacks.onStatusMessage();
    callbacks.onSessionNotReady({ waitingForCallback: true });
    assert.deepEqual(states, [blocked ? 'authentication-required' : 'authentication-pending']);
  });
}
