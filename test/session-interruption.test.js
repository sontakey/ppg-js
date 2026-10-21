// Exercise the app's actual clock and canvas renderer without camera/GPU access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { analyzeHRV } from '../src/hrv/index.ts';

const app = readFileSync(new URL('../examples/app/app.js', import.meta.url), 'utf8');
const slice = (start, end) => {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return app.slice(a, b);
};
let now = 0;
const listeners = {}, label = { textContent: '' };
const document = {
  visibilityState: 'visible', getElementById: () => label,
  addEventListener: (type, listener) => { listeners[type] = listener; },
};
const clock = vm.createContext({
  performance: { now: () => now }, document, SESSION_SEC: 180, measuringStartedAt: 0,
  stopCalls: 0,
});
vm.runInContext('function stopSession() { stopCalls++; measuringStartedAt = null; }\n' +
  slice('function fmtCountdown(sec)', '\nfunction renderSummary()'), clock);
const run = code => vm.runInContext(code, clock);
const elapsed = () => run('elapsedMeasuringMs');
const frame = (t, processing = true, deliveryMs = 20) => {
  now += deliveryMs;
  run(`advanceSessionClock(${t}, ${processing})`);
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
frame(0);
for (let i = 1; i <= 50; i++) frame(i / 50);
close(elapsed(), 1000);
// Zero frames, stale MEASURING, and an arbitrarily long interval cannot finish.
for (let i = 0; i < 200; i++) { now += 1000; run('tickSessionCountdown()'); }
close(elapsed(), 1000);
assert.equal(clock.stopCalls, 0);
assert.equal(label.textContent, '2:59');
// A stalled delivery with a small source-time delta must not earn time either.
frame(1.02, true, 0);
close(elapsed(), 1000);
frame(1.04); close(elapsed(), 1020);
frame(1.04); frame(0.8); // duplicate and out-of-order data
frame(1.06); close(elapsed(), 1040);
// A timestamp discontinuity cannot catch up the missing interval.
frame(10); close(elapsed(), 1040);
frame(10.02); close(elapsed(), 1060);
// Visibility resets both boundaries, even if a browser delivers frames hidden.
document.visibilityState = 'hidden'; listeners.visibilitychange();
frame(10.04); frame(10.06); close(elapsed(), 1060);
document.visibilityState = 'visible'; listeners.visibilitychange();
frame(10.08); close(elapsed(), 1060);
frame(10.1); close(elapsed(), 1080);
frame(10.12, false); frame(10.14); close(elapsed(), 1080);
frame(10.16); close(elapsed(), 1100);
// Artwork pause has no role in the clock. Continuous valid frames finish once.
run('elapsedMeasuringMs = 0; lastMeasuringFrame = null;');
frame(0);
for (let i = 1; i <= 9001; i++) frame(i / 50);
run('tickSessionCountdown(); tickSessionCountdown();');
assert.equal(clock.stopCalls, 1);
assert.ok(elapsed() >= 180000 && elapsed() < 180021);

const strokes = [], labels = [];
let path = [];
const ctx = {
  setTransform() {}, clearRect() {}, fillRect() {}, setLineDash() {},
  measureText: text => ({ width: String(text).length * 7 }),
  fillText(text) { labels.push(String(text)); },
  beginPath() { path = []; },
  moveTo(x, y) { path.push({ op: 'moveTo', x, y }); },
  lineTo(x, y) { path.push({ op: 'lineTo', x, y }); },
  arc(x, y) { path.push({ op: 'arc', x, y }); },
  stroke() { strokes.push({ style: this.strokeStyle, points: [...path] }); },
};
const canvas = { clientWidth: 342, parentElement: { clientWidth: 342 }, style: {}, getContext: () => ctx };
const chart = vm.createContext({ window: { devicePixelRatio: 3 }, canvas });
vm.runInContext(slice('function setupHiDPICanvas(canvas)', 'function powerLabel(') +
  slice('function drawReportTachogram(', '// Builds the full scrollable report'), chart);
// Nonzero time origin; sixty seconds without accepted beats must stay blank.
chart.beats = Array.from({ length: 120 }, (_, i) => ({ t: 100 + i + 1 + (i >= 60 ? 60 : 0), ibiMs: 1000 }));
chart.flagged = chart.beats.map((_, i) => i === 60);
const analysis = analyzeHRV(chart.beats);
assert.equal(analysis.meta.durationSec, 180);
vm.runInContext('drawReportTachogram(canvas, beats, flagged, beats.map(() => 1000))', chart);
assert.equal(labels.filter(x => /^\d+:\d\d$/.test(x)).at(-1), '3:00');
const raw = strokes.find(x => x.style === '#2855ff').points;
assert.equal(raw.length, 120);
assert.equal(raw.filter(x => x.op === 'moveTo').length, 2);
const step = raw[59].x - raw[58].x, gap = raw[60].x - raw[59].x;
close(gap / step, 61);
const artifact = strokes.find(x => x.style === '#b46a26').points[0];
close(artifact.x, raw[60].x);
const correction = strokes.find(x => x.style === 'rgba(167,173,186,0.8)').points[0];
close(correction.x, raw[60].x);
// Plain intervals retain their cumulative timing; real slow beats are connected.
strokes.length = 0; labels.length = 0;
chart.beats = [1000, 2000, 1000];
vm.runInContext('drawReportTachogram(canvas, beats, [], [])', chart);
assert.equal(labels.filter(x => /^\d+:\d\d$/.test(x)).at(-1), '0:04');
assert.equal(strokes.find(x => x.style === '#2855ff').points.filter(x => x.op === 'moveTo').length, 1);
strokes.length = 0;
chart.beats = [{ t: 1, ibiMs: 1000 }, { t: 3, ibiMs: 2000 }, { t: 4, ibiMs: 1000 }];
vm.runInContext('drawReportTachogram(canvas, beats, [], [])', chart);
assert.equal(strokes.find(x => x.style === '#2855ff').points.filter(x => x.op === 'moveTo').length, 1);
// All report redraw paths retain beats, rather than throwing away timestamps.
assert.doesNotMatch(app, /drawReportTachogram\([^\n]*,\s*acceptedIbiMs/);
console.log('Session clock interruption/recovery and report gap regressions passed.');
