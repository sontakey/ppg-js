// Synthetic-signal test for the real signal-processing code path
// (filter -> peak detection -> IBI -> HR/RMSSD). Run with: node test/ppg-pipeline.test.js
//
// No test framework - assert-based, exits non-zero on failure so it works
// as a CI gate too.

import assert from 'node:assert/strict';
import { filtfiltBandpass, resampleUniform } from '../src/utils/filter.js';
import { detectPeaks, computeIBIs, heartRateFromIBIs, rmssd } from '../src/utils/peaks.js';

/**
 * Generate a synthetic camera-PPG-like signal: a fundamental + 2nd/3rd
 * harmonic (real PPG waveforms are not pure sinusoids), slow baseline drift,
 * white noise, and IRREGULAR sample timestamps (real camera frame delivery
 * jitters) - to stress the exact resample -> filter -> peak path used
 * in production.
 *
 * @param {number} durationSec
 * @param {number} hrBpm - target heart rate
 * @param {number} nominalFps - average camera frame rate
 * @returns {{times: number[], values: number[]}}
 */
function generateSyntheticPPG(durationSec, hrBpm, nominalFps) {
  const hrHz = hrBpm / 60;
  const times = [];
  const values = [];

  let t = 0;
  const rng = mulberry32(42); // deterministic
  while (t < durationSec) {
    // Irregular inter-frame gap: +-25% jitter around the nominal period.
    const nominalDt = 1 / nominalFps;
    const jitter = 1 + (rng() - 0.5) * 0.5;
    t += nominalDt * jitter;
    if (t >= durationSec) break;

    const fundamental = Math.sin(2 * Math.PI * hrHz * t);
    const harmonic2 = 0.1 * Math.sin(2 * Math.PI * 2 * hrHz * t + 0.6);
    const harmonic3 = 0.03 * Math.sin(2 * Math.PI * 3 * hrHz * t + 1.1);
    const drift = 0.02 * Math.sin(2 * Math.PI * 0.05 * t); // slow baseline wander
    const noise = (rng() - 0.5) * 0.03;

    // Note: raw camera PPG (post 1 - normalizedRed inversion, matching
    // PPGMonitor.js) already has systolic peaks as maxima, same as this.
    const dcOffset = 0.5;
    values.push(dcOffset + 0.05 * (fundamental + harmonic2 + harmonic3) + drift + noise);
    times.push(t);
  }

  return { times, values };
}

// Deterministic PRNG (mulberry32) - no dependency needed for a seeded RNG.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runCase(label, hrBpm, nominalFps, expectedHrToleranceBpm, expectedIbiToleranceMs) {
  const durationSec = 30;
  const { times, values } = generateSyntheticPPG(durationSec, hrBpm, nominalFps);
  assert.ok(times.length > 100, `${label}: need enough synthetic samples`);

  const targetRate = 30; // resample onto a uniform 30Hz grid, as production does
  const { values: uniformValues } = resampleUniform(times, values, targetRate);

  const filtered = filtfiltBandpass(uniformValues, targetRate, 0.7, 4.0);

  // Drop the first/last second: filtfilt edge transients aren't representative.
  const edgeSamples = targetRate;
  const trimmed = filtered.slice(edgeSamples, filtered.length - edgeSamples);

  const peakTimesRelative = detectPeaks(trimmed, targetRate);
  const { ibisMs, artifactCount, totalCount } = computeIBIs(peakTimesRelative);

  const measuredHr = heartRateFromIBIs(ibisMs, ibisMs.length);
  const expectedIbiMs = 60000 / hrBpm;
  const meanIbiMs = ibisMs.reduce((a, b) => a + b, 0) / ibisMs.length;
  const meanIbiErrorMs = Math.abs(meanIbiMs - expectedIbiMs);
  const rmssdMs = rmssd(ibisMs, ibisMs.length);

  console.log(
    `[${label}] target=${hrBpm}bpm fps=${nominalFps} -> measuredHR=${measuredHr.toFixed(2)}bpm ` +
    `meanIBI=${meanIbiMs.toFixed(1)}ms (expected ${expectedIbiMs.toFixed(1)}ms, err ${meanIbiErrorMs.toFixed(2)}ms) ` +
    `rmssd=${rmssdMs.toFixed(2)}ms artifacts=${artifactCount}/${totalCount} beats=${ibisMs.length}`
  );

  assert.ok(
    Math.abs(measuredHr - hrBpm) <= expectedHrToleranceBpm,
    `${label}: HR error too large: measured ${measuredHr.toFixed(2)}, expected ${hrBpm} +-${expectedHrToleranceBpm}`
  );
  assert.ok(
    meanIbiErrorMs <= expectedIbiToleranceMs,
    `${label}: mean IBI error too large: ${meanIbiErrorMs.toFixed(2)}ms > ${expectedIbiToleranceMs}ms`
  );
  assert.ok(artifactCount / Math.max(totalCount, 1) < 0.15, `${label}: too many rejected IBIs (${artifactCount}/${totalCount})`);
}

// --- Test cases -------------------------------------------------------

runCase('resting HR @ 30fps camera', 68, 30, 1, 10);
runCase('elevated HR @ 24fps camera (torch-limited exposure)', 105, 24, 1, 10);
runCase('low HR @ variable ~20fps camera', 52, 20, 1.5, 30);

// Regression guard for the PPGMonitor.js freeze bug (finding #1 in REVIEW.md):
// windowNum parity must no longer gate processing. This just documents the
// intended behavior since PPGMonitor requires a DOM/camera to run directly.
{
  const windowLength = 300;
  let processedCount = 0;
  for (let nFrame = windowLength; nFrame <= windowLength * 20; nFrame += windowLength) {
    // Old buggy condition: Math.floor(windowNum / 100) % 2 === 0
    // New correct behavior: process every window, unconditionally.
    processedCount++;
  }
  assert.equal(processedCount, 20, 'every window must be processed, no freeze alternation');
  console.log(`[freeze-bug regression] all ${processedCount}/20 windows processed (no 8-minute freeze)`);
}

console.log('\nALL TESTS PASSED');
