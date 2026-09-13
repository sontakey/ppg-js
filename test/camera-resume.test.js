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

console.log('\nALL CAMERA-RESUME TESTS PASSED');
