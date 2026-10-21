// Unit tests for _resumeCamera()/_forceReapplyTorch() (src/core/PPGMonitor.ts):
// (drives the real monitor against stubbed navigator/document; no browser needed)
// survive iOS backgrounding (screenshot, app switch) that ends or mutes the
// live MediaStreamTrack without ever telling the app cleanly. Drives the
// real PPGMonitor against a stubbed navigator.mediaDevices/document so no
// browser is needed. Run with: node --import tsx test/camera-resume.test.js
import assert from 'node:assert/strict';
import { PPGMonitor } from '../src/core/PPGMonitor.js';
import { STATE } from '../src/core/fingerState.js';

// --- Minimal DOM/BOM stub -------------------------------------------------
// PPGMonitor headless-creates <video>/<canvas> via document.createElement
// and listens on document/window - stub just enough for start()/resume to
// run without a real browser.
function makeVideoStub() {
  return {
    setAttribute() {}, play() { return Promise.resolve(); }, pause() {},
    videoWidth: 640, videoHeight: 480,
    set srcObject(s) { this._stream = s; },
    get srcObject() { return this._stream; },
    _onloadedmetadata: null,
    set onloadedmetadata(fn) { this._onloadedmetadata = fn; if (fn) queueMicrotask(fn); },
    get onloadedmetadata() { return this._onloadedmetadata; },
    requestVideoFrameCallback: undefined // force the rAF fallback path in tests (no real rVFC)
  };
}

/** Node defines a read-only global `navigator` getter (undici) - override
 * it with defineProperty rather than plain assignment, which throws. */
function setNavigator(nav) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, writable: true, configurable: true });
}

function installGlobals() {
  const docListeners = {};
  const winListeners = {};
  globalThis.document = {
    createElement: (tag) => tag === 'video' ? makeVideoStub() : { getContext: () => ({}) },
    addEventListener: (ev, fn) => { docListeners[ev] = fn; },
    removeEventListener: (ev, fn) => { if (docListeners[ev] === fn) delete docListeners[ev]; },
    visibilityState: 'visible'
  };
  globalThis.window = {
    addEventListener: (ev, fn) => { winListeners[ev] = fn; },
    removeEventListener: () => {}, devicePixelRatio: 1
  };
  globalThis.screen = { width: 0, height: 0 };
  globalThis.localStorage = { setItem() {}, getItem() { return null; } };
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = () => 0;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = () => {};
  return { docListeners, winListeners };
}

/** Fake MediaStreamTrack: getSettings/getCapabilities/applyConstraints/stop,
 * settable onended/onmute/onunmute, and a `torch` that can be forced to lie
 * (report true in getSettings() while physically off - the iOS 26 bug). */
function makeFakeTrack({ torchCapable = true } = {}) {
  const track = {
    readyState: 'live',
    _torchOn: false,
    _lieAboutTorch: false, // when true, getSettings always reports torch:true
    onended: null, onmute: null, onunmute: null,
    getSettings() { return { deviceId: 'dev1', torch: this._lieAboutTorch ? true : this._torchOn }; },
    getCapabilities() { return torchCapable ? { torch: true } : {}; },
    async applyConstraints(c) {
      track.applyConstraintsCalls.push(c);
      if (c && c.advanced && c.advanced[0] && 'torch' in c.advanced[0]) {
        track._torchOn = c.advanced[0].torch;
      }
    },
    stop() { track.stopped = true; track.readyState = 'ended'; },
    applyConstraintsCalls: [],
    stopped: false
  };
  return track;
}

function makeFakeMediaDevices(trackFactory) {
  const tracks = [];
  const getUserMedia = async () => {
    const track = trackFactory();
    tracks.push(track);
    return { getVideoTracks: () => [track], getTracks: () => [track] };
  };
  return {
    mediaDevices: { getUserMedia, enumerateDevices: async () => [] },
    tracks
  };
}

// --- Test 1: track ended while page hidden, visibilitychange->visible resumes ---
{
  const { docListeners } = installGlobals();
  const fake = makeFakeMediaDevices(makeFakeTrack);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices, clipboard: { writeText: async () => {} } });

  const m = new PPGMonitor(null, { ui: { enabled: false } });
  await m.start();
  const firstTrack = fake.tracks[0];
  assert.equal(fake.tracks.length, 1, 'start() acquired one track');

  // Simulate the field bug: page backgrounded, iOS ends the track, no
  // onended fires (observed behavior on some sessions) - only
  // visibilitychange->visible tells us anything happened.
  firstTrack.readyState = 'ended';
  docListeners.visibilitychange();
  // _resumeCamera is async; flush microtasks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(fake.tracks.length, 2, 'getUserMedia called again on resume');
  const secondTrack = fake.tracks[1];
  assert.ok(secondTrack.applyConstraintsCalls.some(c => c.advanced && c.advanced[0] && c.advanced[0].torch === true),
    'torch re-applied on the new track after resume');
  assert.equal(m.engine.state, STATE.NO_FINGER, 'state machine reset to NO_FINGER after resume');

  const events = m.getDebugLog().events;
  assert.ok(events.some(e => e.type === 'camera_resumed' && e.ok === true), 'camera_resumed logged with ok:true');
  assert.ok(Array.isArray(m.getDebugLog().meta.resumes) && m.getDebugLog().meta.resumes.length === 1,
    'meta.resumes has one entry with the new track settings');
  m.stop();
  console.log('[camera-resume] ended track + visibilitychange -> resume: PASS');
}

// --- Test 2: onended fires directly (no visibilitychange) ----------------
{
  installGlobals();
  const fake = makeFakeMediaDevices(makeFakeTrack);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices, clipboard: { writeText: async () => {} } });

  const m = new PPGMonitor(null, { ui: { enabled: false } });
  await m.start();
  fake.tracks[0].onended();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(fake.tracks.length, 2, 'onended alone triggers a resume');
  m.stop();
  console.log('[camera-resume] track.onended triggers resume: PASS');
}

// --- Test 3: iOS 26/Chrome mute-then-lie - getSettings().torch stays true
// even though the flash is physically off; unmute must force a re-apply
// regardless of what settings claims. ------------------------------------
{
  installGlobals();
  const fake = makeFakeMediaDevices(makeFakeTrack);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices, clipboard: { writeText: async () => {} } });

  const m = new PPGMonitor(null, { ui: { enabled: false } });
  await m.start();
  const track = fake.tracks[0];
  track._torchOn = true;
  track._lieAboutTorch = true; // getSettings().torch === true from here on, always
  const callsBeforeMute = track.applyConstraintsCalls.length;

  track.onmute();
  track.onunmute();
  await new Promise((r) => setTimeout(r, 0));

  const torchCallsAfterUnmute = track.applyConstraintsCalls.slice(callsBeforeMute)
    .filter(c => c.advanced && c.advanced[0] && c.advanced[0].torch === true);
  assert.ok(torchCallsAfterUnmute.length >= 1,
    'applyConstraints({torch:true}) called again on unmute even though getSettings claims torch is already on');
  assert.ok(m.getDebugLog().events.some(e => e.type === 'torch_reapplied' && e.forced === true),
    'forced torch_reapplied event logged for the unmute path');
  m.stop();
  console.log('[camera-resume] unmute force-reapplies torch despite getSettings lying torch:true: PASS');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeDeferredCamera(delayedCalls) {
  const tracks = [];
  const pending = new Map();
  const mediaDevices = {
    enumerateDevices: async () => [],
    getUserMedia() {
      const call = tracks.length + 1;
      const track = makeFakeTrack();
      tracks.push(track);
      const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
      if (!delayedCalls.includes(call)) return Promise.resolve(stream);
      const wait = deferred();
      pending.set(call, { ...wait, resolve: () => wait.resolve(stream) });
      return wait.promise;
    }
  };
  return { tracks, pending, mediaDevices };
}

// A late camera permission result must be discarded before applying the torch
// or attaching the stream, whether the user stopped or destroyed the monitor.
for (const action of ['stop', 'destroy']) {
  installGlobals();
  const fake = makeDeferredCamera([2]);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices });
  const errors = [];
  const m = new PPGMonitor(null, { ui: { enabled: false }, onError: err => errors.push(err) });
  await m.start();
  const video = m.video;
  const recovery = m._resumeCamera('delayed-permission');
  assert.ok(fake.pending.has(2), 'resume is waiting for getUserMedia');
  m[action]();
  fake.pending.get(2).resolve();
  await recovery;
  assert.equal(fake.tracks[1].readyState, 'ended', 'late acquired track is released');
  assert.equal(fake.tracks[1].applyConstraintsCalls.length, 0, 'late track never enables the torch');
  assert.equal(m.stream, null, 'cancelled recovery cannot adopt a stream');
  assert.equal(video.srcObject, null, 'cancelled recovery cannot attach to the video');
  assert.equal(m.running, false);
  assert.equal(m._resuming, false);
  assert.equal(errors.length, 0, 'cancellation does not surface a camera error');
  m.destroy();
  console.log(`[camera-resume] delayed acquisition after ${action} is released: PASS`);
}

// Stop must also release a stream acquired before an asynchronous torch
// constraint completes, not wait until the rest of camera setup resolves.
{
  installGlobals();
  const constraint = deferred(), entered = deferred();
  let count = 0;
  const fake = makeFakeMediaDevices(() => {
    const track = makeFakeTrack();
    if (++count === 2) {
      const apply = track.applyConstraints.bind(track);
      track.applyConstraints = async c => { await apply(c); entered.resolve(); await constraint.promise; };
    }
    return track;
  });
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices });
  const errors = [];
  const m = new PPGMonitor(null, { onError: err => errors.push(err) });
  await m.start();
  const recovery = m._resumeCamera('delayed-torch-constraint');
  await entered.promise;
  m.stop();
  assert.equal(fake.tracks[1].readyState, 'ended', 'stop releases a camera still inside async setup immediately');
  constraint.resolve();
  await recovery;
  assert.equal(m.stream, null);
  assert.equal(errors.length, 0);
  m.destroy();
  console.log('[camera-resume] stop during pending torch setup releases track: PASS');
}

// An old recovery finishing after restart must not clear the new recovery's
// in-flight flag, reset its engine, replace its video, or write to its log.
{
  installGlobals();
  const fake = makeDeferredCamera([2, 4]);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices });
  const errors = [];
  const m = new PPGMonitor(null, { onError: err => errors.push(err) });
  await m.start();
  const oldTrack = fake.tracks[0];
  const oldRecovery = m._resumeCamera('old-recovery');
  m.stop();
  await m.start();
  const newVideo = m.video;
  const newStream = m.stream;
  m.engine.fingerState.state = STATE.MEASURING;
  const newRecovery = m._resumeCamera('new-recovery');
  fake.pending.get(2).resolve();
  await oldRecovery;
  assert.equal(fake.tracks[1].readyState, 'ended');
  assert.equal(fake.tracks[1].applyConstraintsCalls.length, 0);
  assert.equal(m.video, newVideo);
  assert.equal(m.stream, newStream, 'old recovery cannot replace the newer session stream');
  assert.equal(m.engine.state, STATE.MEASURING, 'old recovery cannot reset the new engine');
  assert.equal(m._resuming, true, 'old finally cannot clear the current recovery flag');
  assert.ok(!m.getDebugLog().events.some(e => e.type === 'camera_resumed' && e.trigger === 'old-recovery'));
  oldTrack.onended();
  oldTrack.onmute();
  oldTrack.onunmute();
  assert.equal(fake.tracks.length, 4, 'events from old tracks cannot start another recovery');
  fake.pending.get(4).resolve();
  await newRecovery;
  assert.equal(m.stream.getVideoTracks()[0], fake.tracks[3]);
  assert.equal(m._resuming, false);
  assert.equal(m.running, true);
  assert.equal(errors.length, 0);
  assert.ok(m.getDebugLog().events.some(e => e.type === 'camera_resumed' && e.trigger === 'new-recovery' && e.ok));
  m.destroy();
  console.log('[camera-resume] stale recovery cannot interfere with restarted recovery: PASS');
}

// A denied old permission prompt should not tear down or show an error over
// the new session, and a transient failure should not retry after Stop.
for (const errorName of ['NotAllowedError', 'NotReadableError']) {
  installGlobals();
  const fake = makeDeferredCamera([2]);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices });
  const errors = [];
  const m = new PPGMonitor(null, { onError: err => errors.push(err) });
  await m.start();
  const oldRecovery = m._resumeCamera('old-rejected-recovery');
  m.stop();
  await m.start();
  const current = m.stream;
  fake.pending.get(2).reject(Object.assign(new Error('old camera operation failed'), { name: errorName }));
  await oldRecovery;
  assert.equal(fake.tracks.length, 3, 'stale error never starts a retry');
  assert.equal(m.stream, current);
  assert.equal(m.running, true);
  assert.equal(errors.length, 0, 'stale error is not reported to the new session');
  assert.ok(!m.getDebugLog().events.some(e => e.type === 'camera_resumed'));
  m.destroy();
  console.log(`[camera-resume] stale ${errorName} does not disturb restart: PASS`);
}

// Initial acquisition uses the same lifecycle boundary. Cancellation while
// waiting for the first permission result cannot resurrect capture either.
{
  installGlobals();
  const fake = makeDeferredCamera([1]);
  setNavigator({ userAgent: 'test', mediaDevices: fake.mediaDevices });
  const errors = [];
  const m = new PPGMonitor(null, { onError: err => errors.push(err) });
  const starting = m.start();
  m.destroy();
  fake.pending.get(1).resolve();
  await starting;
  assert.equal(fake.tracks[0].readyState, 'ended');
  assert.equal(fake.tracks[0].applyConstraintsCalls.length, 0);
  assert.equal(m.running, false);
  assert.equal(m.stream, null);
  assert.equal(m.video, null);
  assert.equal(errors.length, 0);
  console.log('[camera-resume] initial acquisition respects cancellation: PASS');
}

console.log('\nALL CAMERA-RESUME TESTS PASSED');
