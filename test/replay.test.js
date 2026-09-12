// Tests for the debug recorder (schema + ring-buffer cap) and the replay
// tool (recovers HR from a synthetic recorded session, matching the
// synthetic-signal generator already used in ppg-pipeline.test.js).
//
// Run with: node test/replay.test.js

import assert from 'node:assert/strict';
import { DebugRecorder } from '../src/utils/recorder.js';
import { replay } from '../tools/replay.js';

// --- 1. Recorder cap holds -------------------------------------------------
{
  const cap = 100;
  const rec = new DebugRecorder(cap);
  rec.start({ userAgent: 'test' });
  for (let i = 0; i < cap * 3; i++) {
    rec.pushSample({ t: i * 33, r: 100, g: 100, b: 100 });
  }
  const log = rec.toJSON();
  assert.equal(log.samples.length, cap, 'ring buffer must hold exactly `cap` samples after overflow');
  // Chronological order preserved: oldest surviving sample is the (3*cap - cap)th pushed.
  assert.equal(log.samples[0].t, (cap * 3 - cap) * 33, 'oldest surviving sample must be in chronological order');
  assert.equal(log.samples[cap - 1].t, (cap * 3 - 1) * 33, 'newest sample must be last');
  console.log(`[recorder cap] pushed ${cap * 3} samples, buffer holds ${log.samples.length} (cap=${cap}) - OK`);
}

// --- 2. Schema sanity -------------------------------------------------------
{
  const rec = new DebugRecorder();
  rec.start({ userAgent: 'x', screen: { width: 1, height: 2 } });
  rec.pushSample({ t: 0, r: 1, g: 2, b: 3 });
  rec.pushEvent({ t: 0, type: 'peak' });
  const log = rec.toJSON();
  assert.ok(log.meta && log.meta.startTime, 'meta.startTime must be set');
  assert.ok(Array.isArray(log.samples), 'samples must be an array');
  assert.ok(Array.isArray(log.events), 'events must be an array');
  console.log('[recorder schema] {meta, samples, events} present - OK');
}

// --- 3. Replay recovers HR from a synthetic recorded session --------------
// Deterministic PRNG (mulberry32), same as ppg-pipeline.test.js.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a debug log using the recorder's exact schema, with raw red-channel
 * values synthesized so that after PPGMonitor's `1 - r/255` inversion the
 * signal matches a target-HR PPG waveform.
 */
function generateSyntheticDebugLog(durationSec, hrBpm, nominalFps) {
  const rec = new DebugRecorder();
  rec.start({ userAgent: 'synthetic-test', frameCallbackMode: 'requestVideoFrameCallback' });

  const hrHz = hrBpm / 60;
  const rng = mulberry32(7);
  let t = 0;
  while (t < durationSec) {
    const nominalDt = 1 / nominalFps;
    const jitter = 1 + (rng() - 0.5) * 0.5;
    t += nominalDt * jitter;
    if (t >= durationSec) break;

    const fundamental = Math.sin(2 * Math.PI * hrHz * t);
    const harmonic2 = 0.1 * Math.sin(2 * Math.PI * 2 * hrHz * t + 0.6);
    const drift = 0.02 * Math.sin(2 * Math.PI * 0.05 * t);
    const noise = (rng() - 0.5) * 0.03;
    // Realistic camera-PPG amplitude: DC ~200/255, AC ~1.5% of DC (matches
    // the real iPhone log this whole change is built from) - not the 10%
    // amplitude used elsewhere in this file for filter/peak-detector
    // stress-testing, which would swing red below the isFingerPresent
    // threshold (utils/fingerState.js) and falsely flicker NO_FINGER.
    const dcRed = 200;
    const acAmplitude = 3; // ~1.5% of 200
    const r = dcRed - acAmplitude * (fundamental + harmonic2) + drift * 20 + noise * 20;

    // Finger-present heuristic (see utils/fingerState.js isFingerPresent)
    // needs red high, green/blue low - a well-covered fingertip pad reads
    // this way (skin+blood absorb green/blue, transmit/reflect red).
    rec.pushSample({ t: t * 1000, r, g: 30, b: 30 });
  }

  return rec.toJSON();
}

{
  const targetHr = 72;
  const log = generateSyntheticDebugLog(60, targetHr, 30);
  const result = replay(log);

  const measuringWindows = result.hrTimeline.filter(w => w.state === 'MEASURING' && w.heartRate > 0);
  assert.ok(measuringWindows.length > 0, 'replay must reach MEASURING and produce at least one non-zero HR window');
  const finalHr = measuringWindows[measuringWindows.length - 1].heartRate;

  console.log(`[replay HR recovery] target=${targetHr}bpm replay(final)=${finalHr}bpm`);
  assert.ok(
    Math.abs(finalHr - targetHr) <= 1,
    `replay HR ${finalHr} not within +-1bpm of target ${targetHr}`
  );
}

console.log('\nALL REPLAY TESTS PASSED');
