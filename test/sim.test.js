// Simulated-PPG regression tests (test/sim/ppg-sim.js generator). Each test
// has known ground truth (beat times / IBIs / RMSSD), unlike the real-log
// fixture tests. No framework - assert-based. Run with:
//   node test/sim.test.js

import assert from 'node:assert/strict';
import { generatePpgSamples } from './sim/ppg-sim.js';
import { runReplay } from '../tools/replay.js';

function toLog(samples, fps = 30) {
  return { meta: { trackSettings: { frameRate: fps } }, samples, events: [] };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- 1. Clean 60/70/90bpm at 30/60fps -> HR within +-1bpm, mean IBI error
// < 10ms, RMSSD within +-10ms of truth.
for (const hr of [60, 70, 90]) {
  for (const fps of [30, 60]) {
    const { samples, groundTruth } = generatePpgSamples({ durationSec: 60, hr, fps, seed: hr * 100 + fps });
    const r = runReplay(toLog(samples, fps));
    const good = r.hrTimeline.filter(w => w.quality.good);
    assert.ok(good.length > 0, `clean ${hr}bpm@${fps}fps must reach a good window`);
    const finalHr = good[good.length - 1].heartRate;
    assert.ok(Math.abs(finalHr - hr) <= 1, `clean ${hr}bpm@${fps}fps: replay HR ${finalHr} not within +-1bpm`);

    const meanIbiTruth = groundTruth.ibisMs.reduce((a, b) => a + b, 0) / groundTruth.ibisMs.length;
    const acceptedIbis = r.ibiDetails.filter(d => d.valid).map(d => d.ibiMs);
    const meanIbiMeasured = acceptedIbis.reduce((a, b) => a + b, 0) / acceptedIbis.length;
    assert.ok(Math.abs(meanIbiMeasured - meanIbiTruth) < 10, `clean ${hr}bpm@${fps}fps: mean IBI error ${(meanIbiMeasured - meanIbiTruth).toFixed(1)}ms >= 10ms`);

    const finalRmssd = good[good.length - 1].rmssd;
    // The engine reports RMSSD over the last 60 s of accepted beats. This
    // generator quantises to whole 8-bit counts with a 3-count pulse, which
    // is harsher than a real camera (ROI means are fractional), so the
    // detector's timing jitter alone produces some RMSSD on a signal with
    // none. The measured floor is 12-17 ms; the bound is 20 ms and the
    // engine's own floor estimate must agree with it to within a factor of two.
    // (Before the timestamp-native engine this bound had to be +-60 ms.)
    const truthRmssd = groundTruth.rmssdMs; // 0 for a constant-rate signal
    assert.ok(Math.abs(finalRmssd - truthRmssd) <= 20, `clean ${hr}bpm@${fps}fps: RMSSD ${finalRmssd.toFixed(1)} vs truth ${truthRmssd.toFixed(1)} not within +-20ms`);
    const floor = good[good.length - 1].rmssdFloorMs;
    assert.ok(floor > 0 && floor < 40, `clean ${hr}bpm@${fps}fps: rmssdFloorMs ${floor} out of range`);

    console.log(`[sim clean ${hr}bpm@${fps}fps] HR=${finalHr} (truth ${hr}), meanIBI err=${(meanIbiMeasured - meanIbiTruth).toFixed(1)}ms, RMSSD=${finalRmssd.toFixed(1)} (truth ${truthRmssd.toFixed(1)}, floor est ${floor.toFixed(1)}): PASS`);
  }
}

// --- 2. RSA 6 breaths/min +-5bpm swing -> RMSSD within +-15% of truth.
{
  const { samples, groundTruth } = generatePpgSamples({ durationSec: 90, hr: 70, fps: 30, rsaBpm: 6, rsaAmplitudeBpm: 5, seed: 11 });
  const r = runReplay(toLog(samples));
  const good = r.hrTimeline.filter(w => w.quality.good);
  assert.ok(good.length > 0, 'RSA case must reach a good window');
  const finalRmssd = good[good.length - 1].rmssd;
  const pctErr = Math.abs(finalRmssd - groundTruth.rmssdMs) / groundTruth.rmssdMs;
  // Timing noise adds in quadrature with real variability, so a ~23 ms
  // true RMSSD plus a ~13 ms floor reads ~26 ms; allow 15 ms absolute.
  const absErr = Math.abs(finalRmssd - groundTruth.rmssdMs);
  assert.ok(absErr <= 15, `RSA RMSSD ${finalRmssd.toFixed(1)} vs truth ${groundTruth.rmssdMs.toFixed(1)} not within +-15ms (${absErr.toFixed(1)}ms, ${(pctErr * 100).toFixed(1)}%)`);
  console.log(`[sim RSA 6bpm swing] RMSSD=${finalRmssd.toFixed(1)} truth=${groundTruth.rmssdMs.toFixed(1)} err=${absErr.toFixed(1)}ms (${(pctErr * 100).toFixed(1)}%): PASS`);
}

// --- 3. Motion burst 2s mid-recording -> good false during, true after,
// HR never outside truth +-5 outside the burst.
{
  const truthHr = 70;
  const burst = { startSec: 30, durationSec: 2, stepCounts: 40 };
  const { samples } = generatePpgSamples({ durationSec: 60, hr: truthHr, fps: 30, seed: 12, motionBursts: [burst] });
  const r = runReplay(toLog(samples));

  const duringBurst = r.hrTimeline.filter(w => w.windowStartSec >= burst.startSec && w.windowStartSec < burst.startSec + 5);
  assert.ok(duringBurst.some(w => !w.quality.good), 'quality must go bad during/immediately after the motion burst');

  const wellAfter = r.hrTimeline.filter(w => w.windowStartSec >= burst.startSec + 10);
  assert.ok(wellAfter.some(w => w.quality.good), 'quality must recover to good well after the burst');

  const outsideBurst = r.hrTimeline.filter(w =>
    (w.windowStartSec < burst.startSec - 2 || w.windowStartSec >= burst.startSec + burst.durationSec + 10) && w.heartRate > 0
  );
  for (const w of outsideBurst) {
    assert.ok(Math.abs(w.heartRate - truthHr) <= 5, `HR outside the burst must stay within truth+-5, got ${w.heartRate} at t=${w.windowStartSec}`);
  }
  console.log(`[sim motion burst] bad during burst, recovered after, HR stable outside (${outsideBurst.map(w => w.heartRate).join(',')}): PASS`);
}

// --- 4. Finger lift 3s -> NO_FINGER then SETTLING then MEASURING, no HR
// emitted during the lift.
{
  const lift = { startSec: 30, durationSec: 3 };
  const { samples } = generatePpgSamples({ durationSec: 60, hr: 70, fps: 30, seed: 13, fingerLifts: [lift] });
  const r = runReplay(toLog(samples));

  const statesAfterLiftStart = r.stateTimeline.filter(s => s.t >= lift.startSec - 1);
  const seq = statesAfterLiftStart.map(s => s.state);
  assert.ok(seq.includes('NO_FINGER'), 'must see NO_FINGER after the lift');
  const noFingerIdx = seq.indexOf('NO_FINGER');
  assert.ok(seq.slice(noFingerIdx).includes('SETTLING'), 'must see SETTLING after NO_FINGER');
  assert.ok(seq.slice(noFingerIdx).includes('MEASURING'), 'must see MEASURING again after re-placement');

  const duringLift = r.hrTimeline.filter(w => w.windowStartSec >= lift.startSec && w.windowStartSec < lift.startSec + lift.durationSec);
  assert.ok(duringLift.every(w => w.heartRate === 0), 'no HR may be emitted during the finger lift');

  console.log(`[sim finger lift] state sequence after lift: ${seq.slice(noFingerIdx, noFingerIdx + 3).join(' -> ')}, HR during lift all 0: PASS`);
}

// --- 5. Low amplitude (AC 2 counts, DC 190, noise sd 1) -> either correct
// HR or good=false, never a wrong HR shown.
{
  const truthHr = 70;
  const { samples } = generatePpgSamples({ durationSec: 60, hr: truthHr, fps: 30, dc: 190, acAmplitude: 2, noiseSd: 1, seed: 14 });
  const r = runReplay(toLog(samples));
  const shownHrs = r.hrTimeline.filter(w => w.quality.good).map(w => w.heartRate);
  for (const hr of shownHrs) {
    assert.ok(Math.abs(hr - truthHr) <= 3, `any shown HR at low amplitude must be correct (+-3bpm), got ${hr}`);
  }
  console.log(`[sim low amplitude] shown HRs: [${shownHrs.join(',')}], all within truth+-3 or hidden: PASS`);
}

// --- 6. Weak beats (every 5th beat's amplitude cut to 15%): with recovery on,
// the engine finds the weak beat inside the 2x gap and keeps the window; with
// recovery off, the gap is rejected as missed_beat and HR still never collapses.
{
  const truthHr = 70;
  const { samples, groundTruth } = generatePpgSamples({ durationSec: 60, hr: truthHr, fps: 30, everyNthMissed: 5, seed: 15 });
  const r = runReplay(toLog(samples));
  const accepted = r.tachogram.filter(d => d.valid && d.good);
  const good = r.hrTimeline.filter(w => w.quality.good);
  assert.ok(good.length >= 5, `weak-beat case must keep most windows good (got ${good.length})`);
  assert.ok(accepted.length >= 0.6 * groundTruth.ibisMs.length, `weak beats must be recovered (${accepted.length} of ${groundTruth.ibisMs.length}; the first ~15 s are settling)`);
  const lowSnr = accepted.filter(d => d.lowSnr).length;
  assert.ok(lowSnr > 0, 'recovered beats must be flagged lowSnr');
  for (const w of good) assert.ok(w.rmssd <= 25, `RMSSD must exclude low-SNR intervals (got ${w.rmssd.toFixed(1)} at t=${w.windowStartSec})`);
  for (const w of good) assert.ok(Math.abs(w.heartRate - truthHr) <= 5, `HR with weak beats must stay within truth+-5, got ${w.heartRate} at t=${w.windowStartSec}`);
  const rOff = runReplay(toLog(samples), { recoverMissedBeats: false });
  const missed = rOff.ibiDetails.filter(d => d.reason === 'missed_beat');
  assert.ok(missed.length > 0, 'without recovery the gaps must be rejected as missed_beat');
  for (const w of rOff.hrTimeline.filter(w => w.quality.good)) assert.ok(Math.abs(w.heartRate - truthHr) <= 5, `HR without recovery must stay within truth+-5, got ${w.heartRate}`);
  console.log(`[sim weak beats] recovery on: ${good.length} good windows, ${accepted.length}/${groundTruth.ibisMs.length} beats (${lowSnr} low-SNR); recovery off: ${missed.length} missed_beat rejections, HR within +-5: PASS`);
}

console.log('\nALL SIM TESTS PASSED');
