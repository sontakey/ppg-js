#!/usr/bin/env node
// Replay tool: pushes a recorded debug JSON (see src/core/recorder.ts schema)
// through the SAME streaming engine the browser uses (src/core/engine.ts) -
// one sample at a time, exactly as the live frame loop does - and prints the
// numbers you would otherwise need a phone in hand to see live.
//
// Usage: node tools/replay.js <path-to-debug.json>
//     or: npm run replay -- <path-to-debug.json>

import { readFileSync } from 'node:fs';
import { PpgEngine } from '../src/core/engine.js';
import { STATE } from '../src/core/fingerState.js';

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run a debug log's raw samples through the engine.
 * @param {{meta:Object,samples:Array,events:Array}} log
 * @param {Object} [engineOptions] - PpgEngine options override
 */
export function runReplay(log, engineOptions = {}) {
  const { samples, events = [] } = log;
  if (!samples || samples.length < 2) {
    throw new Error('debug log has fewer than 2 samples - nothing to replay');
  }

  // Old logs where every t is 0/identical: synthesize timing from frameRate.
  const allSameT = samples.every(s => s.t === samples[0].t);
  let reconstructed = false;
  if (allSameT) {
    reconstructed = true;
    const fps = (log.meta && log.meta.trackSettings && log.meta.trackSettings.frameRate) || 30;
    const dtMs = 1000 / fps;
    samples.forEach((s, i) => { s.t = i * dtMs; });
  }

  const times = samples.map(s => s.t / 1000);
  const dts = [];
  for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
  const meanDt = dts.reduce((a, b) => a + b, 0) / dts.length;
  const meanFps = 1 / meanDt;
  const minFps = 1 / Math.max(...dts);
  const maxFps = 1 / Math.min(...dts.filter(d => d > 0));
  const jitter = Math.sqrt(dts.reduce((a, d) => a + (d - meanDt) ** 2, 0) / dts.length);
  const durationSec = times[times.length - 1] - times[0];
  const t0 = times[0];

  const engine = new PpgEngine(engineOptions);
  const stateTimeline = [];
  const channelTimeline = [];
  const hrTimeline = [];
  const qualityTimeline = [];
  const allIbiDetails = [];
  const allPeakTimesSec = [];
  const respirationTimeline = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const tSec = times[i] - t0;
    const r = engine.push({ t: tSec, r: s.r, g: s.g, b: s.b, clipped: s.clipped, motion: s.motion });
    s._fingerState = r.state;
    if (r.stateChanged) stateTimeline.push({ t: tSec, state: r.state, reason: r.stateReason });
    const w = r.window;
    if (!w) continue;
    channelTimeline.push({ t: w.windowStartSec, redRatio: w.selectedChannel === 'red' ? w.acDcRatio : 0, greenRatio: w.selectedChannel === 'green' ? w.acDcRatio : 0, selected: w.selectedChannel, redDc: w.redDc, greenDc: w.greenDc });
    qualityTimeline.push({ t: w.windowStartSec, ...w.quality });
    hrTimeline.push({
      windowStartSec: w.windowStartSec,
      windowEndSec: w.t,
      state: w.fingerState,
      heartRate: w.heartRate,
      heartRateRaw: w.heartRateRaw,
      heartRateFFT: Math.round(w.heartRateFFT),
      heartRateSource: w.heartRateSource,
      ibiFftDisagree: w.ibiFftDisagree,
      harmonicCorrected: w.harmonicCorrected,
      rmssd: w.rmssd,
      sdnn: w.sdnn,
      rmssdFloorMs: w.rmssdFloorMs,
      timingUncertaintyMs: w.timingUncertaintyMs,
      templateSqi: w.templateSqi,
      sqi: w.sqi,
      selectedChannel: w.selectedChannel,
      acDcRatio: w.acDcRatio,
      sampleRate: w.sampleRate,
      gap: w.gap,
      quality: w.quality
    });
    allIbiDetails.push(...w.ibiDetails);
    allPeakTimesSec.push(...w.peakTimesSec);
    if (w.respiration && w.respiration.rateBpm != null) respirationTimeline.push({ t: w.t, ...w.respiration });
  }

  const overallIbis = allIbiDetails.filter(d => d.valid).map(d => d.ibiMs);
  let overallRmssd = 0;
  if (overallIbis.length >= 2) {
    let s = 0;
    for (let i = 1; i < overallIbis.length; i++) s += (overallIbis[i] - overallIbis[i - 1]) ** 2;
    overallRmssd = Math.sqrt(s / (overallIbis.length - 1));
  }

  // Compare against live-recorded peaks (if the log has them).
  const livePeakTimesSec = events.filter(e => e.type === 'peak').map(e => (e.t - samples[0].t) / 1000);
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
    if (bestIdx >= 0 && bestDiff <= MATCH_TOLERANCE_SEC) { matched++; usedLive.add(bestIdx); }
  }

  return {
    meta: log.meta || null,
    reconstructed,
    timestampAnomalies: log.timestampAnomalies || null,
    nSamples: samples.length,
    durationSec,
    fps: { mean: meanFps, min: minFps, max: maxFps, jitterSec: jitter },
    stateTimeline,
    channelTimeline,
    hrTimeline,
    qualityTimeline,
    respirationTimeline,
    summary: engine.getSessionSummary(),
    tachogram: engine.getTachogram(),
    ibiDetails: allIbiDetails,
    rmssd: overallRmssd,
    engineConfig: engine.config,
    comparisonToLive: {
      liveEventCount: livePeakTimesSec.length,
      replayPeakCount: allPeakTimesSec.length,
      matched,
      missed: livePeakTimesSec.length - matched,
      extra: allPeakTimesSec.length - matched
    }
  };
}

export const replay = runReplay;

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node tools/replay.js <path-to-debug.json>');
    process.exit(1);
  }
  const log = JSON.parse(readFileSync(path, 'utf8'));
  const result = runReplay(log);

  if (result.reconstructed) {
    console.log('*** RECONSTRUCTED TIMING: all recorded sample timestamps were 0/identical ***');
    console.log('*** timing was synthesized from meta.trackSettings.frameRate ***\n');
  }
  if (result.timestampAnomalies) {
    const a = result.timestampAnomalies;
    if (a.zero || a.nonMonotonic || a.nonFinite) {
      console.log(`Timestamp anomalies (repaired at record time): zero=${a.zero} nonMonotonic=${a.nonMonotonic} nonFinite=${a.nonFinite}\n`);
    }
  }
  console.log(`Camera: ${result.meta ? (result.meta.chosenLabel || '(facingMode fallback, no label match)') : '(none)'}`);
  console.log(`Track setting changes mid-session: ${(log.events || []).filter(e => e.type === 'track_settings_changed').length}`);
  console.log(`Samples: ${result.nSamples}, duration: ${result.durationSec.toFixed(1)}s`);
  console.log(`FPS: mean=${result.fps.mean.toFixed(2)} min=${result.fps.min.toFixed(2)} max=${result.fps.max.toFixed(2)} jitter=${(result.fps.jitterSec * 1000).toFixed(1)}ms`);

  console.log('\nState timeline:');
  for (const s of result.stateTimeline) console.log(`  t=${s.t.toFixed(1)}s  -> ${s.state}  (${s.reason})`);

  console.log('\nPer-window quality:');
  for (const q of result.qualityTimeline) {
    console.log(`  t=${q.t.toFixed(1)}s  state=${q.state}  acdc=${(q.acdc * 100).toFixed(2)}%  artifactRatio=${q.artifactRatio.toFixed(2)}  ibiCount(60s)=${q.ibiCount}  fftAgree=${q.fftAgree}  good=${q.good}${q.good ? '' : `  reason="${q.reason}"`}`);
  }

  console.log('\nHR timeline:');
  for (const w of result.hrTimeline) {
    const flag = w.ibiFftDisagree ? ' [ibi_fft_disagree]' : '';
    const harm = w.harmonicCorrected ? ' [harmonic_corrected]' : '';
    console.log(`  t=${w.windowStartSec.toFixed(1)}s  state=${w.state}  good=${w.quality.good}  HR=${w.quality.good ? w.heartRate + 'bpm' : '--'}  (raw=${w.heartRateRaw} fft=${w.heartRateFFT} src=${w.heartRateSource})${flag}${harm}  RMSSD=${w.quality.good ? w.rmssd.toFixed(1) : '--'}ms (floor ${w.rmssdFloorMs.toFixed(1)})  SDNN=${w.quality.good ? w.sdnn.toFixed(1) : '--'}ms  sqi=${w.sqi ? w.sqi.score.toFixed(2) : '--'}  ch=${w.selectedChannel}  fps=${w.sampleRate.toFixed(1)}`);
  }

  console.log(`\nIBIs (${result.ibiDetails.length} candidates):`);
  for (const d of result.ibiDetails) console.log(`  t=${d.peakTimeSec.toFixed(2)}s  ibi=${d.ibiMs.toFixed(1)}ms${d.valid ? '' : `  [ARTIFACT: ${d.reason}]`}${d.good ? '' : '  (window not good)'}`);

  if (result.respirationTimeline.length) {
    console.log('\nRespiration:');
    for (const r of result.respirationTimeline) console.log(`  t=${r.t.toFixed(0)}s  ${r.rateBpm.toFixed(1)} br/min  confidence=${r.confidence.toFixed(2)}`);
  }

  console.log(`\nOverall RMSSD (all accepted beats): ${result.rmssd.toFixed(1)}ms`);
  console.log('\nComparison against live-recorded events:');
  console.log(`  live peaks=${result.comparisonToLive.liveEventCount} replay peaks=${result.comparisonToLive.replayPeakCount}`);
  console.log(`  matched=${result.comparisonToLive.matched} missed=${result.comparisonToLive.missed} extra=${result.comparisonToLive.extra}`);

  console.log('\nSession summary (GOOD windows only):');
  console.log(`  ${result.summary.goodWindows}/${result.summary.totalWindows} windows good (${(result.summary.goodFraction * 100).toFixed(1)}% of session)`);
  if (result.summary.hr) console.log(`  HR: min=${result.summary.hr.min} median=${result.summary.hr.median} max=${result.summary.hr.max} bpm`);
  else console.log('  HR: no good windows');
  if (result.summary.rmssd) console.log(`  RMSSD: min=${result.summary.rmssd.min.toFixed(1)} median=${result.summary.rmssd.median.toFixed(1)} max=${result.summary.rmssd.max.toFixed(1)} ms`);
  if (result.summary.sdnn) console.log(`  SDNN: min=${result.summary.sdnn.min.toFixed(1)} median=${result.summary.sdnn.median.toFixed(1)} max=${result.summary.sdnn.max.toFixed(1)} ms`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
