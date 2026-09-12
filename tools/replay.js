#!/usr/bin/env node
// Replay tool: pushes a recorded debug JSON (see src/utils/recorder.js schema)
// through the SAME filter/peak/IBI pipeline the browser uses (imported
// directly from src/utils, not copied), and prints the numbers you'd
// otherwise need a phone in hand to see live.
//
// Usage: node tools/replay.js <path-to-debug.json>
//     or: npm run replay -- <path-to-debug.json>

import { readFileSync } from 'node:fs';
import { resampleUniform, filtfiltBandpass } from '../src/utils/filter.js';
import { detectPeaks, computeIBIs, heartRateFromIBIs, rmssd } from '../src/utils/peaks.js';
import { detrend } from '../src/utils/detrend.js';

const TARGET_RATE_HZ = 30; // uniform resample grid, same choice as SignalProcessor tests
const CARDIAC_LOW_HZ = 0.75;
const CARDIAC_HIGH_HZ = 4.0;
const WINDOW_SEC = 5; // matches default windowLength(300)/sampleRate(60)

/**
 * Run the full pipeline on a debug log's raw samples.
 * @param {{meta:Object,samples:Array,events:Array}} log
 */
export function replay(log) {
  const { samples, events = [] } = log;
  if (!samples || samples.length < 2) {
    throw new Error('debug log has fewer than 2 samples - nothing to replay');
  }

  // --- fps / timing stats ------------------------------------------------
  const times = samples.map(s => s.t / 1000); // seconds
  const dts = [];
  for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
  const meanDt = dts.reduce((a, b) => a + b, 0) / dts.length;
  const meanFps = 1 / meanDt;
  const minFps = 1 / Math.max(...dts);
  const maxFps = 1 / Math.min(...dts.filter(d => d > 0));
  const jitter = Math.sqrt(dts.reduce((a, d) => a + (d - meanDt) ** 2, 0) / dts.length);
  const durationSec = times[times.length - 1] - times[0];

  // --- finger-present ratio (reuse whatever the recorder captured; a
  // sample is "finger present" if it has a fingerPresent flag, else fall
  // back to a crude PI proxy from the r channel not being near-white) ----
  const fingerFlags = samples.map(s =>
    typeof s.fingerPresent === 'boolean' ? s.fingerPresent : s.r < 250
  );
  const fingerPresentRatio = fingerFlags.filter(Boolean).length / fingerFlags.length;

  // --- pipeline: same inversion PPGMonitor.js does on the red channel ----
  const xValues = samples.map(s => 1 - s.r / 255);
  const { values: uniformValues } = resampleUniform(times, xValues, TARGET_RATE_HZ);

  // Process in WINDOW_SEC windows, same cadence as the browser, so HR
  // timeline + events line up with what was recorded live.
  const windowSamples = Math.round(WINDOW_SEC * TARGET_RATE_HZ);
  const hrTimeline = [];
  const allPeakTimesSec = [];
  const allIbiDetails = [];
  const ibiHistoryMs = [];

  for (let start = 0; start + windowSamples <= uniformValues.length; start += windowSamples) {
    const windowRaw = uniformValues.slice(start, start + windowSamples);
    const detrended = detrend(Float32Array.from(windowRaw));
    const filtered = filtfiltBandpass(windowRaw, TARGET_RATE_HZ, CARDIAC_LOW_HZ, CARDIAC_HIGH_HZ);
    const peakTimesSec = detectPeaks(filtered, TARGET_RATE_HZ).map(t => t + start / TARGET_RATE_HZ);
    const { ibisMs, details } = computeIBIs(peakTimesSec);
    ibiHistoryMs.push(...ibisMs);
    if (ibiHistoryMs.length > 40) ibiHistoryMs.splice(0, ibiHistoryMs.length - 40);

    allPeakTimesSec.push(...peakTimesSec);
    allIbiDetails.push(...details);

    hrTimeline.push({
      windowStartSec: start / TARGET_RATE_HZ,
      heartRate: Math.round(heartRateFromIBIs(ibiHistoryMs) || 0),
      rmssd: rmssd(ibiHistoryMs)
    });
    void detrended; // parity with SignalProcessor's per-window detrend call; unused here
  }

  const overallIbis = computeIBIs(allPeakTimesSec).ibisMs;
  const overallRmssd = rmssd(overallIbis, overallIbis.length);

  // --- compare against live-recorded events -------------------------------
  const livePeakTimesSec = events
    .filter(e => e.type === 'peak')
    .map(e => (e.t - samples[0].t) / 1000);

  const MATCH_TOLERANCE_SEC = 0.15;
  let matched = 0;
  const usedLive = new Set();
  for (const replayedT of allPeakTimesSec) {
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < livePeakTimesSec.length; i++) {
      if (usedLive.has(i)) continue;
      const diff = Math.abs(livePeakTimesSec[i] - replayedT);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestDiff <= MATCH_TOLERANCE_SEC) {
      matched++;
      usedLive.add(bestIdx);
    }
  }
  const missed = livePeakTimesSec.length - matched; // live peaks replay didn't find
  const extra = allPeakTimesSec.length - matched; // replay peaks not seen live

  return {
    meta: log.meta || null,
    nSamples: samples.length,
    durationSec,
    fps: { mean: meanFps, min: minFps, max: maxFps, jitterSec: jitter },
    fingerPresentRatio,
    hrTimeline,
    ibiDetails: allIbiDetails,
    rmssd: overallRmssd,
    comparisonToLive: {
      liveEventCount: livePeakTimesSec.length,
      replayPeakCount: allPeakTimesSec.length,
      matched,
      missed,
      extra
    }
  };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node tools/replay.js <path-to-debug.json>');
    process.exit(1);
  }

  const log = JSON.parse(readFileSync(path, 'utf8'));
  const result = replay(log);

  const trackChanges = (log.events || []).filter(e => e.type === 'track_settings_changed').length;
  console.log(`Camera: ${result.meta ? (result.meta.chosenLabel || '(facingMode fallback, no label match)') : '(none)'}`);
  console.log(`Track setting changes mid-session: ${trackChanges}`);
  console.log(`Meta: ${result.meta ? JSON.stringify(result.meta.frameCallbackMode || result.meta) : '(none)'}`);
  console.log(`Samples: ${result.nSamples}, duration: ${result.durationSec.toFixed(1)}s`);
  console.log(
    `FPS: mean=${result.fps.mean.toFixed(2)} min=${result.fps.min.toFixed(2)} ` +
    `max=${result.fps.max.toFixed(2)} jitter=${(result.fps.jitterSec * 1000).toFixed(1)}ms`
  );
  console.log(`Finger-present ratio: ${(result.fingerPresentRatio * 100).toFixed(1)}%`);
  console.log('\nHR timeline:');
  for (const w of result.hrTimeline) {
    console.log(`  t=${w.windowStartSec.toFixed(1)}s  HR=${w.heartRate}bpm  RMSSD=${w.rmssd.toFixed(1)}ms`);
  }
  console.log(`\nIBIs (${result.ibiDetails.length} candidates):`);
  for (const d of result.ibiDetails) {
    const flag = d.valid ? '' : ` [ARTIFACT: ${d.reason}]`;
    console.log(`  t=${d.peakTimeSec.toFixed(2)}s  ibi=${d.ibiMs.toFixed(1)}ms${flag}`);
  }
  console.log(`\nOverall RMSSD: ${result.rmssd.toFixed(1)}ms`);
  console.log('\nComparison against live-recorded events:');
  console.log(`  live peaks=${result.comparisonToLive.liveEventCount} replay peaks=${result.comparisonToLive.replayPeakCount}`);
  console.log(`  matched=${result.comparisonToLive.matched} missed=${result.comparisonToLive.missed} extra=${result.comparisonToLive.extra}`);
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
