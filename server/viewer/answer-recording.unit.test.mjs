import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerRecording, supportsAnswerRecording, selectRecordingMimeType,
  RECORDING_MIME_TYPES } from './answer-recording.js';

function harness(options = {}) {
  let clock = 1000, pendingTimer, instance, constraints;
  const tracks = [0, 0].map(() => ({ stops: 0, stop() { this.stops++; } }));
  const stream = { getTracks: () => tracks };
  class Recorder {
    static isTypeSupported(type) { return type === (options.supported ?? RECORDING_MIME_TYPES[0]); }
    constructor(value, config) {
      if (options.constructError) throw Error('constructor');
      assert.equal(value, stream);
      this.config = config;
      this.mimeType = 'audio/browser-default';
      this.state = 'inactive';
      this.stops = 0;
      instance = this;
    }
    start(...args) {
      assert.deepEqual(args, []);
      if (options.startError) throw Error('start');
      this.state = 'recording';
    }
    stop() {
      this.stops++;
      if (options.stopError) throw Error('stop');
      this.state = 'inactive';
    }
    data(value = 'fixture', type = 'audio/mp4') { this.ondataavailable?.({ data: new Blob([value], { type }) }); }
    end() { this.onstop?.(); }
  }
  const session = createAnswerRecording({ Recorder,
    mediaDevices: { getUserMedia(value) {
      constraints = value;
      return options.acquire ? options.acquire(stream) : Promise.resolve(stream);
    } },
    now: () => clock,
    setTimer(fn, delay) { pendingTimer = { fn, delay }; return pendingTimer; },
    clearTimer(id) { if (id === pendingTimer) pendingTimer = null; },
  });
  return { session, Recorder, tracks, get recorder() { return instance; },
    get constraints() { return constraints; }, get timer() { return pendingTimer; },
    advance(ms) { clock += ms; }, fire() { const fn = pendingTimer.fn; pendingTimer = null; fn(); },
    clean() { assert.ok(tracks.every((track) => track.stops === 1)); assert.equal(pendingTimer, null); } };
}

test('capabilities require microphone acquisition and MediaRecorder', async () => {
  assert.equal(supportsAnswerRecording({ mediaDevices: {}, Recorder: class {} }), false);
  assert.equal(supportsAnswerRecording({ mediaDevices: { getUserMedia() {} }, Recorder: null }), false);
  const session = createAnswerRecording({ mediaDevices: {}, Recorder: null });
  assert.equal((await session.start()).error.code, 'RECORDING_UNSUPPORTED');
  assert.equal((await session.result).error.code, 'RECORDING_UNSUPPORTED');
});

test('MIME candidates use support probes in priority order, with safe default', async () => {
  for (const supported of [...RECORDING_MIME_TYPES, 'none']) {
    const h = harness({ supported });
    assert.equal(selectRecordingMimeType(h.Recorder), supported === 'none' ? '' : supported);
    await h.session.start();
    assert.deepEqual(h.recorder.config, supported === 'none' ? undefined : { mimeType: supported });
    await h.session.cancel(); h.clean();
  }
  assert.equal(selectRecordingMimeType(class {}), '');
  assert.equal(selectRecordingMimeType({ isTypeSupported() { throw Error(); } }), '');
});

test('normal stop waits for final data and uses emitted MIME and monotonic elapsed time', async () => {
  const h = harness();
  const start = h.session.start();
  assert.equal(h.session.start(), start);
  assert.deepEqual(await start, { ok: true });
  assert.deepEqual(h.constraints, { audio: true, video: false });
  h.recorder.data('first'); h.advance(1250);
  assert.equal(h.session.elapsedSeconds, 1.25);
  const stopped = h.session.stop();
  assert.equal(h.session.stop(), stopped);
  assert.equal(h.recorder.stops, 1);
  let settled = false; stopped.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  h.advance(500); h.recorder.data('last'); h.recorder.end();
  const result = await stopped;
  assert.equal(await result.data.audioBlob.text(), 'firstlast');
  assert.equal(result.data.audioBlob.type, 'audio/mp4');
  assert.equal(result.data.durationSeconds, 1.25);
  assert.equal(await h.session.cancel(), result);
  assert.equal(await h.session.teardown(), result);
  h.clean();
});

test('recorder MIME supplies missing emitted MIME and spontaneous stop closes tracks', async () => {
  const h = harness(); await h.session.start();
  h.recorder.data('fixture', ''); h.recorder.state = 'inactive'; h.recorder.end();
  assert.equal((await h.session.result).data.audioBlob.type, 'audio/browser-default'); h.clean();
});

test('zero-byte and absent data produce EMPTY_RECORDING', async () => {
  for (const emit of [true, false]) {
    const h = harness(); await h.session.start();
    h.session.stop(); if (emit) h.recorder.data(''); h.recorder.end();
    assert.equal((await h.session.result).error.code, 'EMPTY_RECORDING'); h.clean();
  }
});

test('auto-stop leaves a scheduling margin and rejects recordings beyond 60 seconds', async () => {
  for (const delay of [0, 200, 500, 501, 8500]) {
    const h = harness(); await h.session.start();
    assert.equal(h.timer.delay, 59500);
    h.advance(10000); h.fire(); assert.equal(h.timer.delay, 49500);
    h.advance(49500 + delay); h.fire();
    assert.equal(h.recorder.stops, 1); assert.equal(h.session.state, 'stopping');
    h.recorder.data(); h.recorder.end();
    const result = await h.session.result;
    if (delay <= 500) assert.equal(result.data.durationSeconds, 59.5 + delay / 1000);
    else {
      assert.equal(result.error.code, 'RECORDING_TOO_LONG');
      assert.equal(result.data, undefined);
    }
    h.clean();
  }
});

test('manual and spontaneous stops also reject over-limit recordings', async () => {
  for (const manual of [true, false]) {
    const h = harness(); await h.session.start(); h.advance(68000);
    if (manual) h.session.stop();
    else h.recorder.state = 'inactive';
    h.recorder.data(); h.recorder.end();
    assert.equal((await h.session.result).error.code, 'RECORDING_TOO_LONG'); h.clean();
  }
});

test('delayed final data does not inflate the duration captured at stop', async () => {
  const h = harness(); await h.session.start(); h.advance(59000); h.session.stop();
  h.advance(10000); h.recorder.data(); h.recorder.end();
  assert.equal((await h.session.result).data.durationSeconds, 59); h.clean();
});

test('cancel before start never acquires microphone', async () => {
  const h = harness({ acquire() { assert.fail('must not acquire'); } });
  await h.session.cancel();
  assert.equal((await h.session.start()).error.code, 'CANCELED');
  assert.equal(h.recorder, undefined);
});

for (const method of ['cancel', 'stop', 'teardown']) {
  test(`${method} settles start even when permission never resolves`, async () => {
    const h = harness({ acquire: () => new Promise(() => {}) });
    const starting = h.session.start();
    await h.session[method]();
    const outcome = await Promise.race([starting,
      new Promise((resolve) => setImmediate(() => resolve('still pending')))]);
    assert.equal(outcome.error?.code, 'CANCELED');
    assert.equal(await h.session.result, outcome);
    assert.equal(h.recorder, undefined);
  });
  test(`${method} during permission cleans up late streams without constructing a recorder`, async () => {
    let release;
    const h = harness({ acquire: (stream) => new Promise((resolve) => { release = () => resolve(stream); }) });
    const starting = h.session.start();
    assert.equal((await h.session[method]()).error.code, 'CANCELED');
    assert.equal((await starting).error.code, 'CANCELED');
    release(); await Promise.resolve();
    assert.equal(h.recorder, undefined); h.clean();
  });
  test(`${method} during recording is idempotent and releases every track`, async () => {
    const h = harness(); await h.session.start(); h.recorder.data();
    const result = h.session[method](); h.session[method]();
    if (method === 'stop') h.recorder.end();
    await result; assert.equal(h.recorder.stops, 1); h.clean();
  });
}

test('cancel while final data is pending discards it', async () => {
  const h = harness(); await h.session.start(); h.session.stop();
  await h.session.cancel(); h.recorder.data(); h.recorder.end();
  assert.equal((await h.session.result).error.code, 'CANCELED'); h.clean();
});

for (const [name, code] of [['NotAllowedError', 'PERMISSION_DENIED'], ['SecurityError', 'PERMISSION_DENIED'],
  ['NotFoundError', 'DEVICE_UNAVAILABLE'], ['NotReadableError', 'DEVICE_UNAVAILABLE'], ['Error', 'RECORDER_ERROR']]) {
  test(`acquisition ${name} is normalized`, async () => {
    const h = harness({ acquire() { return Promise.reject({ name }); } });
    assert.equal((await h.session.start()).error.code, code);
    assert.equal((await h.session.result).error.code, code);
    assert.equal(h.recorder, undefined); assert.equal(h.timer, null);
  });
}

for (const option of ['constructError', 'startError', 'stopError', 'eventError']) {
  test(`${option} cleans tracks and settles the result`, async () => {
    const h = harness({ [option]: true }); await h.session.start();
    if (option === 'stopError') h.session.stop();
    if (option === 'eventError') h.recorder.onerror({ error: Error('private content') });
    const result = await h.session.result;
    assert.equal(result.error.code, option === 'constructError' ? 'RECORDING_UNSUPPORTED' : 'RECORDER_ERROR');
    assert.ok(!JSON.stringify(result).includes('private content')); h.clean();
  });
}

test('late permission rejection after cancel preserves cancellation', async () => {
  let reject;
  const h = harness({ acquire: () => new Promise((_, fail) => { reject = fail; }) });
  const starting = h.session.start(); await h.session.cancel(); reject({ name: 'NotAllowedError' });
  assert.equal((await starting).error.code, 'CANCELED');
});
