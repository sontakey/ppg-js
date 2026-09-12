// Regression tests for the iOS rVFC mediaTime=0 bug: the recorder must
// never store a zero/non-monotonic/non-finite timestamp, and replay must
// be able to reconstruct plausible timing from an old log that has none.
// No framework - assert-based, exits non-zero on failure. Run with:
//   node test/timestamps.test.js

import assert from 'node:assert/strict';
import { DebugRecorder } from '../src/core/recorder.js';
import { replay } from '../tools/replay.js';

// jsdom-less environments don't have performance.now(); Node does globally.

// --- (a) rVFC mediaTime=0 with a real nowMs -> recorded t is monotonic, > 0
{
  const rec = new DebugRecorder();
  rec.start({ chosenLabel: 'Back Camera' });

  // Simulate the PPGMonitor.js rVFC callback logic: mediaTime is always 0
  // on iOS live camera streams, so the fix must use nowMs/expectedDisplayTime
  // instead. Here we push what the FIXED PPGMonitor.js would compute.
  let nowMs = 1000;
  for (let i = 0; i < 20; i++) {
    nowMs += 16.6; // ~60fps
    const metadata = { mediaTime: 0, expectedDisplayTime: 0 }; // iOS bug: both 0
    const edt = metadata.expectedDisplayTime;
    const t = (typeof edt === 'number' && isFinite(edt) && edt > 0) ? edt : nowMs;
    rec.pushSample({ t, r: 128, g: 128, b: 128 });
  }
  const samples = rec.toJSON().samples;
  assert.equal(samples.length, 20, 'all 20 samples recorded');
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].t > samples[i - 1].t, `sample ${i} t must be strictly increasing`);
  }
  assert.ok(samples[0].t > 0, 'first sample t must be > 0');
  console.log('[a] rVFC mediaTime=0 -> recorded timestamps are monotonic and > 0: PASS');
}

// --- (b) recorder anomaly counters increment on zero/duplicate t, stored t repaired
{
  const rec = new DebugRecorder();
  rec.start({});
  rec.pushSample({ t: 100, r: 1, g: 1, b: 1 }); // first sample, fine
  rec.pushSample({ t: 200, r: 1, g: 1, b: 1 }); // second sample, fine
  rec.pushSample({ t: 150, r: 3, g: 3, b: 3 }); // non-monotonic (t < lastT) -> anomaly
  rec.pushSample({ t: 0, r: 2, g: 2, b: 2 }); // zero after first -> anomaly
  rec.pushSample({ t: NaN, r: 4, g: 4, b: 4 }); // non-finite -> anomaly

  const json = rec.toJSON();
  assert.equal(json.timestampAnomalies.zero, 1, 'one zero anomaly');
  assert.equal(json.timestampAnomalies.nonMonotonic, 1, 'one non-monotonic anomaly');
  assert.equal(json.timestampAnomalies.nonFinite, 1, 'one non-finite anomaly');
  for (const s of json.samples) {
    assert.ok(Number.isFinite(s.t) && s.t > 0, 'every stored sample has a repaired finite t > 0');
  }
  // Strictly increasing across the whole repaired stream.
  for (let i = 1; i < json.samples.length; i++) {
    assert.ok(json.samples[i].t > json.samples[i - 1].t, 'repaired stream stays monotonic');
  }
  console.log('[b] recorder anomaly counters + repaired timestamps: PASS');
}

// --- (c) replay reconstructs timing for an all-zero-t file, recovers ~70bpm
{
  const targetHr = 70;
  const fps = 30;
  const n = 30 * fps; // 30s
  const hrHz = targetHr / 60;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const tSec = i / fps; // true capture time, NOT stored (simulating the bug)
    // Realistic camera-PPG amplitude (see replay.test.js's generator doc
    // comment): DC ~200, AC ~1.5% of DC. A big swing (previously 20/128,
    // ~16%) crosses the isFingerPresent red>120 threshold every cycle and
    // never settles - real fingertip PPG never swings that far.
    const dcRed = 200;
    const acAmplitude = 3;
    const red = dcRed - acAmplitude * Math.sin(2 * Math.PI * hrHz * tSec);
    // green/blue low so isFingerPresent (utils/fingerState.js) passes -
    // a real covered fingertip reads high red, low green/blue.
    samples.push({ t: 0, r: red, g: 30, b: 30 }); // all-zero, as an old bad log
  }
  const log = { meta: { trackSettings: { frameRate: fps } }, samples, events: [] };
  const result = replay(log);
  assert.ok(result.reconstructed, 'replay must flag reconstructed timing');
  assert.ok(result.durationSec > 25, 'reconstructed duration should be close to 30s');

  const measuringWindows = result.hrTimeline.filter(w => w.state === 'MEASURING');
  assert.ok(measuringWindows.length > 0, 'must reach MEASURING within 30s');
  const measuredHr = measuringWindows[measuringWindows.length - 1].heartRate;
  assert.ok(
    Math.abs(measuredHr - targetHr) <= 1,
    `reconstructed HR ${measuredHr} should be within 1bpm of ${targetHr}`
  );
  console.log(`[c] replay timing reconstruction recovers HR=${measuredHr}bpm (target ${targetHr}bpm): PASS`);
}

console.log('\nAll timestamp tests passed.');
