import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundAudioController } from '../scripts/player/audio.js';

test('history restore reflects paused audio and waits for one explicit activation', () => {
  const originalAudio = globalThis.Audio;
  const originalWindow = globalThis.window;
  const lifecycle = new EventTarget();
  globalThis.window = lifecycle;
  let audio;
  globalThis.Audio = class extends EventTarget {
    constructor() { super(); audio = this; this.paused = true; this.plays = 0; }
    play() { this.paused = false; this.plays++; this.dispatchEvent(new Event('playing')); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  };
  const track = createBackgroundAudioController();
  let notifications = 0;
  track.subscribe(() => { notifications++; });
  try {
    track.play('music');
    lifecycle.dispatchEvent(new Event('pageshow'));
    assert.equal(track.isPlaybackBlocked(), false, 'Playing music stays enabled');
    audio.paused = true; // Frozen page may miss media events.
    lifecycle.dispatchEvent(new Event('pageshow'));
    assert.equal(track.isPlaybackBlocked(), true);
    assert.equal(audio.plays, 1, 'Restoration does not restart music');
    track.setMuted(false);
    track.play('music');
    assert.equal(audio.plays, 1, 'Redraw cannot bypass the interruption');
    track.play('music', { userInitiated: true });
    assert.equal(audio.plays, 2);
    assert.equal(track.isPlaybackBlocked(), false);
    audio.pause();
    assert.equal(track.isPlaybackBlocked(), true, 'Browser media pause also updates state');
    track.play('music', { userInitiated: true });
    track.suspendForCapture();
    lifecycle.dispatchEvent(new Event('pageshow'));
    track.resumeAfterCapture();
    assert.equal(audio.paused, false, 'Capture suspension still resumes previously playing music');
    track.teardown();
    const before = notifications;
    lifecycle.dispatchEvent(new Event('pageshow'));
    audio.dispatchEvent(new Event('pause'));
    assert.equal(notifications, before, 'Teardown removes lifecycle and media subscriptions');
  } finally { track.teardown(); globalThis.Audio = originalAudio; globalThis.window = originalWindow; }
});

test('background capture suspension preserves intent and ignores stale playback failures', async () => {
  const originalAudio = globalThis.Audio;
  const instances = [];
  const failures = [];
  globalThis.Audio = class {
    constructor(src) { this.src = src; this.paused = true; this.plays = 0; instances.push(this); }
    play() { this.paused = false; this.plays++; return new Promise((_, reject) => failures.push(reject)); }
    pause() { this.paused = true; }
  };
  const track = createBackgroundAudioController();
  try {
    track.play('first');
    const first = instances.at(-1);
    first.currentTime = 12;
    track.suspendForCapture();
    track.suspendForCapture(); // Permission -> recording must preserve the original snapshot.
    assert.equal(first.paused, true);
    track.play('first'); // Rendering must not bypass suspension.
    assert.equal(first.plays, 1);
    failures[0](new Error('Old play interrupted by capture'));
    await Promise.resolve();
    assert.equal(track.isPlaybackBlocked(), false);
    track.resumeAfterCapture();
    assert.equal(first.plays, 2);
    assert.equal(first.currentTime, 12);
    track.resumeAfterCapture();
    assert.equal(first.plays, 2);

    track.suspendForCapture();
    track.setMuted(true, { userInitiated: true });
    track.resumeAfterCapture();
    assert.equal(first.paused, true);
    assert.equal(instances.length, 1);

    track.suspendForCapture();
    track.setMuted(false, { userInitiated: true });
    assert.equal(instances.length, 1, 'Explicit on still waits for microphone release');
    track.play('second');
    track.resumeAfterCapture();
    assert.equal(instances.at(-1).src, 'second');
    assert.equal(instances.at(-1).paused, false);

    instances.at(-1).pause();
    track.suspendForCapture();
    track.setMuted(false); // Routine scene synchronization is not a user request.
    track.play('second');
    track.resumeAfterCapture();
    assert.equal(instances.at(-1).paused, true, 'Previously paused music stays paused');

    track.play('second');
    track.suspendForCapture();
    track.teardown();
    track.resumeAfterCapture();
    assert.equal(instances.at(-1).paused, true, 'Leaving the player never revives music');
  } finally { track.teardown(); globalThis.Audio = originalAudio; }
});

test('autoplay rejection retains a source for explicit retry', async () => {
  const originalAudio = globalThis.Audio;
  let rejectPlayback;
  let attempts = 0;
  globalThis.Audio = class {
    play() { attempts++; this.paused = false; return new Promise((_, reject) => { rejectPlayback = reject; }); }
    pause() { this.paused = true; }
  };
  const track = createBackgroundAudioController();
  let notifications = 0;
  track.subscribe(() => { notifications++; });
  try {
    track.play('music');
    rejectPlayback(new Error('Autoplay denied'));
    await Promise.resolve();
    assert.equal(track.isPlaybackBlocked(), true);
    assert.equal(notifications, 1);
    track.suspendForCapture();
    track.setMuted(false);
    track.resumeAfterCapture();
    assert.equal(attempts, 1, 'Recording does not retry music that was never playing');
    track.play('music');
    assert.equal(attempts, 2);
    assert.equal(track.isPlaybackBlocked(), false);
  } finally { track.teardown(); globalThis.Audio = originalAudio; }
});
