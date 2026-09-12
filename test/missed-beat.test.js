// Missed-beat regression: a run of undetected beats (peak detector skips
// one cycle) must never make the reported HR collapse to roughly half the
// true rate. Exercises computeIBIs' missed_beat rejection AND the
// FFT/IBI cross-check fallback (utils/peaks.js) together, on the exact
// peak sequence recorded from a real log where this bug was first seen.
//
// Run with: node test/missed-beat.test.js

import assert from 'node:assert/strict';
import { computeIBIs, heartRateFromIBIs, crossCheckHeartRate } from '../src/utils/peaks.js';

// --- 1. Warm up a stable 70bpm rhythm (0.85s IBI truncated to ~70bpm-ish),
// then feed the exact peak sequence that previously produced a 39bpm read.
{
  const peakTimes = [];
  let t = 0;
  for (let i = 0; i < 30; i++) {
    t += 0.85;
    peakTimes.push(t);
  }
  const realPeaks = [120.44, 122.23, 124.75, 125.41, 126.6, 127.45, 129.14, 130.55, 131.33, 131.9, 132.83, 133.71, 134.66];
  // Bridge the warm-up stream to the real peak sequence's own clock.
  const offset = t - realPeaks[0] + 0.85;
  for (const p of realPeaks) peakTimes.push(p + offset);

  const { ibisMs, details } = computeIBIs(peakTimes);
  const fftPriorBpm = 70;

  // Replay HR at every point once at least 8 IBIs have accumulated -
  // reported HR must never dip below 55bpm even across the irregular
  // stretch (real IBIs there are ~0.6-1.8s, i.e. a mix of fast/missed beats).
  let minReportedHr = Infinity;
  for (let i = 8; i <= ibisMs.length; i++) {
    const window = ibisMs.slice(0, i);
    const ibiHr = heartRateFromIBIs(window);
    const { heartRate } = crossCheckHeartRate(ibiHr, fftPriorBpm);
    if (heartRate > 0) minReportedHr = Math.min(minReportedHr, heartRate);
  }

  console.log(`[missed-beat] ${details.filter(d => d.reason === 'missed_beat').length} missed_beat rejections, min reported HR=${minReportedHr.toFixed(1)}bpm`);
  assert.ok(minReportedHr >= 55, `reported HR must never drop below 55bpm (got ${minReportedHr.toFixed(1)})`);
}

console.log('\nALL MISSED-BEAT TESTS PASSED');
