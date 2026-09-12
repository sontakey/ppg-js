#!/usr/bin/env node
// Replay tool: pushes a recorded debug JSON (see src/utils/recorder.js schema)
// through the SAME pipeline the browser uses (imported directly from
// src/utils, not copied) - finger-presence state machine, red/green channel
// selection, amplitude-aware peak detection, missed-beat rejection, and the
// FFT/IBI heart-rate cross-check - and prints the numbers you'd otherwise
// need a phone in hand to see live.
//
// Usage: node tools/replay.js <path-to-debug.json>
//     or: npm run replay -- <path-to-debug.json>

import { readFileSync } from 'node:fs';
import { resampleUniform, filtfiltBandpass, filtfiltBandpassWithContext } from '../src/core/filter.js';
import {
  detectPeaks, computeIBIs, heartRateFromIBIs, rmssd,
  crossCheckHeartRate, slewLimit
} from '../src/core/peaks.js';
import { detrend } from '../src/core/detrend.js';
import { computeFFT, calculateSNRFromPSD } from '../src/core/fft.js';
import { FingerStateMachine, STATE, selectChannel } from '../src/core/fingerState.js';
import { sdnn as computeSdnn } from '../src/core/hrv.js';
import { evaluateQuality } from '../src/core/quality.js';

const TARGET_RATE_HZ = 30; // uniform resample grid, same choice as SignalProcessor tests
const CARDIAC_LOW_HZ = 0.75;
const CARDIAC_HIGH_HZ = 4.0;
const WINDOW_SEC = 5; // matches default windowLength(300)/sampleRate(60)
const FFT_SIZE = 256;
const MIN_CHANNEL_DC = 40; // see PPGMonitor.js MIN_CHANNEL_DC doc comment

function peakToPeak(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  return max - min;
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run the full pipeline on a debug log's raw samples. Mirrors PPGMonitor.js's
 * single interleaved frame loop (not two separate passes): the finger-state
 * gate for a window uses the AC/DC ratio computed by the PRECEDING window,
 * exactly like the live per-frame gate does, since the ratio for the
 * in-progress window isn't known until it finishes.
 * @param {{meta:Object,samples:Array,events:Array}} log
 */
export function runReplay(log) {
  const { samples, events = [] } = log;
  if (!samples || samples.length < 2) {
    throw new Error('debug log has fewer than 2 samples - nothing to replay');
  }

  // --- reconstruct timing for old logs where every t is 0/identical -------
  const allSameT = samples.every(s => s.t === samples[0].t);
  let reconstructed = false;
  if (allSameT) {
    reconstructed = true;
    const fps = (log.meta && log.meta.trackSettings && log.meta.trackSettings.frameRate) || 30;
    const dtMs = 1000 / fps;
    samples.forEach((s, i) => { s.t = i * dtMs; });
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
  const t0 = times[0];

  // --- pipeline inputs: same inversion PPGMonitor.js does per channel -----
  const rValues = samples.map(s => 1 - s.r / 255);
  const gValues = samples.map(s => 1 - s.g / 255);
  const { values: uniformR } = resampleUniform(times, rValues, TARGET_RATE_HZ);
  const { values: uniformG } = resampleUniform(times, gValues, TARGET_RATE_HZ);
  const rawR = samples.map(s => s.r);
  const rawG = samples.map(s => s.g);
  const rawB = samples.map(s => s.b);
  const { values: uniformRawR } = resampleUniform(times, rawR, TARGET_RATE_HZ);
  const { values: uniformRawG } = resampleUniform(times, rawG, TARGET_RATE_HZ);
  const { values: uniformRawB } = resampleUniform(times, rawB, TARGET_RATE_HZ);

  // --- single interleaved pass: finger-state gate + windowed processing ---
  const fsm = new FingerStateMachine();
  const stateTimeline = []; // {t, state, reason}
  const windowSamples = Math.round(WINDOW_SEC * TARGET_RATE_HZ);
  const hrTimeline = [];
  const qualityTimeline = []; // {t, acdc, artifactRatio, ibiCount, fftAgree, state, good, reason}
  const allPeakTimesSec = [];
  const allIbiDetails = [];
  const ibiHistoryMs = []; // accepted IBIs (for HR/RMSSD/SDNN), across windows
  const channelTimeline = [];
  let selectedChannel = 'red';
  let lastAcDcRatio = 0; // updated only at window boundaries, like production
  let displayedHr = 0;

  // Drive the state machine at native sample cadence (matches production:
  // the gate runs every frame, not just at window boundaries), but consult
  // uniform-grid window results computed below for the AC/DC ratio.
  let uniformIdx = 0; // index into uniform-rate arrays, advanced as native time passes it
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const tSec = times[i] - t0;
    const { state, changed, reason } = fsm.update({
      tSec, redMean: s.r, greenMean: s.g, blueMean: s.b, acDcRatio: lastAcDcRatio
    });
    s._fingerState = state;
    if (changed) stateTimeline.push({ t: tSec, state, reason });
    if (changed && state === STATE.SETTLING) {
      // Mirror PPGMonitor.js's signalProcessor.reset() on a lift/large-drift/
      // fresh-placement transition: stale pre-transition peaks must not
      // poison computeIBIs' rolling median forever (a contaminated median
      // that nothing can pass locks out every later, genuinely valid IBI
      // as "jump_vs_median" - confirmed on the 52s real log).
      allPeakTimesSec.length = 0;
      ibiHistoryMs.length = 0;
    }

    // When native time crosses a window boundary on the uniform grid,
    // process that window now (same cadence PPGMonitor.js uses) so
    // lastAcDcRatio/selectedChannel are current for the NEXT native samples,
    // matching the live per-frame gate exactly.
    const targetUniformIdx = Math.floor(tSec * TARGET_RATE_HZ);
    while (uniformIdx + windowSamples <= targetUniformIdx + 1 && uniformIdx + windowSamples <= uniformR.length) {
      const start = uniformIdx;
      const windowStartSec = start / TARGET_RATE_HZ;
      const windowState = state; // finger state as of this window's completion

      const redDc = mean(uniformRawR.slice(start, start + windowSamples));
      const greenDc = mean(uniformRawG.slice(start, start + windowSamples));
      const redAc = peakToPeak(uniformRawR.slice(start, start + windowSamples)) / (redDc || 1);
      const greenAc = peakToPeak(uniformRawG.slice(start, start + windowSamples)) / (greenDc || 1);
      const redEligible = redDc > MIN_CHANNEL_DC;
      const greenEligible = greenDc > MIN_CHANNEL_DC;
      const redRatio = redEligible ? redAc : 0;
      const greenRatio = greenEligible ? greenAc : 0;
      selectedChannel = (redEligible || greenEligible)
        ? selectChannel(selectedChannel, redRatio, greenRatio)
        : 'red';
      const acDcRatio = selectedChannel === 'green' ? greenRatio : redRatio;
      lastAcDcRatio = acDcRatio;
      channelTimeline.push({ t: windowStartSec, redRatio, greenRatio, selected: selectedChannel, redDc, greenDc });

      const windowRaw = (selectedChannel === 'green' ? uniformG : uniformR).slice(start, start + windowSamples);
      const detrended = detrend(Float32Array.from(windowRaw));

      const fftResult = computeFFT(detrended, FFT_SIZE, TARGET_RATE_HZ);
      const snrResult = calculateSNRFromPSD(fftResult.psd, fftResult.freqResolution, CARDIAC_LOW_HZ, CARDIAC_HIGH_HZ);
      const heartRateFFT = snrResult.peakFrequency * 60;
      const expectedIbiSec = heartRateFFT > 0 ? 60 / heartRateFFT : 0;
      const refractorySec = expectedIbiSec > 0 ? Math.max(0.3, Math.min(1.0, 0.6 * expectedIbiSec)) : 0.3;

      const filtered = filtfiltBandpassWithContext(
        (selectedChannel === 'green' ? uniformG : uniformR).slice(Math.max(0, start - windowSamples), start),
        windowRaw, TARGET_RATE_HZ, CARDIAC_LOW_HZ, CARDIAC_HIGH_HZ
      );
      const peakTimesSec = detectPeaks(filtered, TARGET_RATE_HZ, refractorySec).map(t => t + windowStartSec);

      for (const t of peakTimesSec) {
        if (!allPeakTimesSec.length || t > allPeakTimesSec[allPeakTimesSec.length - 1]) {
          allPeakTimesSec.push(t);
        }
      }
      const nowSec = windowStartSec + WINDOW_SEC;
      // Continuous stream (see SignalProcessor.js process()): IBIs computed
      // over the whole peak history, not per-window, so the first/last
      // peak of a window is never spuriously flagged for "missing" a
      // predecessor that's actually one window back.
      const continuous = computeIBIs(allPeakTimesSec);
      const windowDetails = continuous.details.filter(d => d.peakTimeSec >= windowStartSec && d.peakTimeSec < nowSec);
      const last60sDetails = continuous.details.filter(d => nowSec - d.peakTimeSec <= 60);
      const artifactCount = last60sDetails.filter(d => !d.valid).length;
      const totalCount = last60sDetails.length;
      ibiHistoryMs.length = 0;
      ibiHistoryMs.push(...continuous.ibisMs.slice(-40));
      allIbiDetails.push(...windowDetails);

      const heartRateIBI = heartRateFromIBIs(ibiHistoryMs);
      const { heartRate: crossCheckedHr, source: heartRateSource, disagree: ibiFftDisagree } =
        crossCheckHeartRate(heartRateIBI, heartRateFFT);
      const rawHr = crossCheckedHr || heartRateFFT;

      const gated = windowState === STATE.MEASURING;
      displayedHr = gated ? slewLimit(displayedHr, rawHr) : 0;

      // last 60s of accepted IBIs, for quality gating + tachogram/summary
      const last60sIbis = ibiHistoryMs; // already the continuous last-40 accepted
      const artifactRatio = totalCount > 0 ? artifactCount / totalCount : 0;
      const ibiCount60s = last60sDetails.filter(d => d.valid).length;
      const quality = evaluateQuality({
        state: windowState,
        acdc: acDcRatio,
        artifactRatio,
        ibiCount: ibiCount60s,
        fftAgree: !ibiFftDisagree
      });
      qualityTimeline.push({ t: windowStartSec, ...quality });

      hrTimeline.push({
        windowStartSec,
        state: windowState,
        heartRate: (gated && quality.good) ? Math.round(displayedHr) : 0,
        heartRateRaw: Math.round(rawHr),
        heartRateFFT: Math.round(heartRateFFT),
        heartRateSource,
        ibiFftDisagree,
        rmssd: quality.good ? rmssd(ibiHistoryMs) : 0,
        sdnn: quality.good ? computeSdnn(ibiHistoryMs) : 0,
        selectedChannel,
        acDcRatio,
        quality
      });

      uniformIdx += windowSamples;
    }
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

  // --- session summary: min/median/max HR, RMSSD, SDNN over GOOD windows --
  const goodWindows = hrTimeline.filter(w => w.quality.good);
  const goodHrs = goodWindows.map(w => w.heartRate).filter(hr => hr > 0);
  const goodRmssds = goodWindows.map(w => w.rmssd).filter(v => v > 0);
  const goodSdnns = goodWindows.map(w => w.sdnn).filter(v => v > 0);
  const summary = {
    totalWindows: hrTimeline.length,
    goodWindows: goodWindows.length,
    goodFraction: hrTimeline.length ? goodWindows.length / hrTimeline.length : 0,
    hr: goodHrs.length ? { min: Math.min(...goodHrs), median: median(goodHrs), max: Math.max(...goodHrs) } : null,
    rmssd: goodRmssds.length ? { min: Math.min(...goodRmssds), median: median(goodRmssds), max: Math.max(...goodRmssds) } : null,
    sdnn: goodSdnns.length ? { min: Math.min(...goodSdnns), median: median(goodSdnns), max: Math.max(...goodSdnns) } : null
  };

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
    summary,
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

// Back-compat alias (test/replay.test.js and earlier tooling import `replay`).
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
    console.log('*** (old log format or an rVFC mediaTime=0 bug) - timing was synthesized from frameRate ***\n');
  }
  if (result.timestampAnomalies) {
    const a = result.timestampAnomalies;
    if (a.zero || a.nonMonotonic || a.nonFinite) {
      console.log(`Timestamp anomalies (repaired at record time): zero=${a.zero} nonMonotonic=${a.nonMonotonic} nonFinite=${a.nonFinite}\n`);
    }
  }
  console.log(`Camera: ${result.meta ? (result.meta.chosenLabel || '(facingMode fallback, no label match)') : '(none)'}`);
  const trackChanges = (log.events || []).filter(e => e.type === 'track_settings_changed').length;
  console.log(`Track setting changes mid-session: ${trackChanges}`);
  console.log(`Meta: ${result.meta ? JSON.stringify(result.meta.frameCallbackMode || result.meta) : '(none)'}`);
  console.log(`Samples: ${result.nSamples}, duration: ${result.durationSec.toFixed(1)}s`);
  console.log(
    `FPS: mean=${result.fps.mean.toFixed(2)} min=${result.fps.min.toFixed(2)} ` +
    `max=${result.fps.max.toFixed(2)} jitter=${(result.fps.jitterSec * 1000).toFixed(1)}ms`
  );

  console.log('\nState timeline:');
  for (const s of result.stateTimeline) {
    console.log(`  t=${s.t.toFixed(1)}s  -> ${s.state}  (${s.reason})`);
  }

  console.log('\nChannel selection (per 5s window):');
  for (const c of result.channelTimeline) {
    console.log(
      `  t=${c.t.toFixed(1)}s  red AC/DC=${(c.redRatio * 100).toFixed(2)}% (DC=${c.redDc.toFixed(0)})  ` +
      `green AC/DC=${(c.greenRatio * 100).toFixed(2)}% (DC=${c.greenDc.toFixed(0)})  -> selected=${c.selected}`
    );
  }

  console.log('\nPer-window quality:');
  for (const q of result.qualityTimeline) {
    console.log(
      `  t=${q.t.toFixed(1)}s  state=${q.state}  acdc=${(q.acdc * 100).toFixed(2)}%  ` +
      `artifactRatio=${q.artifactRatio.toFixed(2)}  ibiCount(60s)=${q.ibiCount}  fftAgree=${q.fftAgree}  ` +
      `good=${q.good}${q.good ? '' : `  reason="${q.reason}"`}`
    );
  }

  console.log('\nHR timeline:');
  for (const w of result.hrTimeline) {
    const disagreeFlag = w.ibiFftDisagree ? ' [ibi_fft_disagree]' : '';
    console.log(
      `  t=${w.windowStartSec.toFixed(1)}s  state=${w.state}  good=${w.quality.good}  ` +
      `HR=${w.quality.good ? w.heartRate + 'bpm' : '--'}  ` +
      `(raw=${w.heartRateRaw}bpm fft=${w.heartRateFFT}bpm src=${w.heartRateSource})${disagreeFlag}  ` +
      `RMSSD=${w.quality.good ? w.rmssd.toFixed(1) : '--'}ms  SDNN=${w.quality.good ? w.sdnn.toFixed(1) : '--'}ms  channel=${w.selectedChannel}`
    );
  }

  console.log(`\nIBIs (${result.ibiDetails.length} candidates):`);
  for (const d of result.ibiDetails) {
    const flag = d.valid ? '' : ` [ARTIFACT: ${d.reason}]`;
    console.log(`  t=${d.peakTimeSec.toFixed(2)}s  ibi=${d.ibiMs.toFixed(1)}ms${flag}`);
  }
  const missedBeats = result.ibiDetails.filter(d => d.reason === 'missed_beat');
  console.log(`\nMissed-beat rejections (${missedBeats.length}):`);
  for (const d of missedBeats) {
    console.log(`  t=${d.peakTimeSec.toFixed(2)}s  ibi=${d.ibiMs.toFixed(1)}ms`);
  }

  console.log(`\nOverall RMSSD: ${result.rmssd.toFixed(1)}ms`);
  console.log('\nComparison against live-recorded events:');
  console.log(`  live peaks=${result.comparisonToLive.liveEventCount} replay peaks=${result.comparisonToLive.replayPeakCount}`);
  console.log(`  matched=${result.comparisonToLive.matched} missed=${result.comparisonToLive.missed} extra=${result.comparisonToLive.extra}`);

  console.log('\nSession summary (GOOD windows only):');
  console.log(`  ${result.summary.goodWindows}/${result.summary.totalWindows} windows good (${(result.summary.goodFraction * 100).toFixed(1)}% of session)`);
  if (result.summary.hr) {
    console.log(`  HR: min=${result.summary.hr.min} median=${result.summary.hr.median} max=${result.summary.hr.max} bpm`);
  } else {
    console.log('  HR: no good windows');
  }
  if (result.summary.rmssd) {
    console.log(`  RMSSD: min=${result.summary.rmssd.min.toFixed(1)} median=${result.summary.rmssd.median.toFixed(1)} max=${result.summary.rmssd.max.toFixed(1)} ms`);
  }
  if (result.summary.sdnn) {
    console.log(`  SDNN: min=${result.summary.sdnn.min.toFixed(1)} median=${result.summary.sdnn.median.toFixed(1)} max=${result.summary.sdnn.max.toFixed(1)} ms`);
  }
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
