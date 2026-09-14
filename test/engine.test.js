// PpgEngine ground-truth tests: beat timing precision with and without
// dropped frames, harmonic lock, clipping/motion gates, gaps, restarts,
// good-only tachogram, respiration. Run: node --import tsx test/engine.test.js
import assert from 'node:assert/strict';
import { PpgEngine } from '../src/core/engine.js';
import { DebugRecorder } from '../src/core/recorder.js';
import { generatePpgSamples } from './sim/ppg-sim.js';
import { estimateRespiration } from '../src/core/respiration.js';

function run(samples, opts = {}, mutate = null) {
  const e = new PpgEngine(opts);
  const t0 = samples[0].t;
  const windows = [];
  for (const s of samples) {
    const sample = { t: (s.t - t0) / 1000, r: s.r, g: s.g, b: s.b };
    if (mutate) mutate(sample);
    const r = e.push(sample);
    if (r.window) windows.push(r.window);
  }
  return { engine: e, windows };
}
function rmssdOf(a) { if (a.length < 2) return 0; let s = 0; for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2; return Math.sqrt(s / (a.length - 1)); }
function dropFrames(samples, frac, seed = 7) { let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; return samples.filter(() => rnd() >= frac); }

// --- 1. Precision: zero-HRV signal at 24/30/60 fps, clean and with 10% dropped frames.
// Fractional channel means (like a real ROI average) -> RMSSD floor must stay under 15 ms;
// whole-count quantised means -> under 22 ms. Dropped frames must not raise it by more than 5 ms.
for (const fps of [24, 30, 60]) {
  for (const quantize of [false, true]) {
    const { samples, groundTruth } = generatePpgSamples({ durationSec: 120, hr: 70, fps, fpsJitter: 0.1, seed: 3, quantize });
    const clean = run(samples);
    const dropped = run(dropFrames(samples, 0.1));
    const accClean = clean.engine.getTachogram({ goodOnly: true }).filter(d => d.valid).map(d => d.ibiMs);
    const accDrop = dropped.engine.getTachogram({ goodOnly: true }).filter(d => d.valid).map(d => d.ibiMs);
    const rC = rmssdOf(accClean), rD = rmssdOf(accDrop);
    const bound = quantize ? 22 : 15;
    assert.ok(accClean.length >= 0.75 * groundTruth.ibisMs.length, `${fps}fps: accepted ${accClean.length} of ${groundTruth.ibisMs.length} beats`);
    assert.ok(rC <= bound, `${fps}fps quant=${quantize}: zero-HRV RMSSD floor ${rC.toFixed(1)} > ${bound} ms`);
    assert.ok(rD <= rC + 5, `${fps}fps quant=${quantize}: 10% dropped frames raised RMSSD from ${rC.toFixed(1)} to ${rD.toFixed(1)}`);
    const hrs = clean.windows.filter(w => w.quality.good).map(w => w.heartRate);
    assert.ok(hrs.length > 0 && hrs.every(h => Math.abs(h - 70) <= 1), `${fps}fps: HR ${hrs.join(',')} within 1 bpm`);
    console.log(`[engine precision ${fps}fps ${quantize ? 'int ' : 'frac'}] beats=${accClean.length}/${groundTruth.ibisMs.length} rmssd clean=${rC.toFixed(1)} dropped=${rD.toFixed(1)} floorEst=${clean.windows.filter(w => w.quality.good).slice(-1)[0].rmssdFloorMs.toFixed(1)}: PASS`);
  }
}

// --- 2. Harmonic lock: a dominant 2nd harmonic (strong dicrotic wave) at 50 bpm must read 50, not 100.
{
  const { samples } = generatePpgSamples({ durationSec: 90, hr: 50, fps: 30, seed: 9, harmonic2: 1.4, acAmplitude: 4 });
  const { windows } = run(samples);
  const good = windows.filter(w => w.quality.good);
  assert.ok(good.length >= 3, `harmonic case must reach good windows (got ${good.length})`);
  for (const w of good) assert.ok(Math.abs(w.heartRate - 50) <= 3, `harmonic case HR ${w.heartRate} at t=${w.t} should be ~50`);
  assert.ok(windows.some(w => w.harmonicCorrected), 'expected the spectral estimate to be sub-harmonic corrected at least once');
  console.log(`[engine harmonic] HR=${good.map(w => w.heartRate).join(',')} corrected windows=${windows.filter(w => w.harmonicCorrected).length}: PASS`);
}

// --- 3. Clipping and motion gates.
{
  const { samples } = generatePpgSamples({ durationSec: 60, hr: 70, fps: 30, seed: 4 });
  const clipped = run(samples, {}, s => { if (s.t > 30 && s.t < 40) s.clipped = 0.2; });
  const during = clipped.windows.filter(w => w.t > 35 && w.t <= 40 && w.fingerState === 'MEASURING');
  assert.ok(during.length && during.every(w => w.quality.code === 'saturated'), `clipped windows must be gated as saturated (${during.map(w => w.quality.code)})`);
  const motion = run(samples, {}, s => { if (s.t > 30 && s.t < 40) s.motion = 3; });
  const duringM = motion.windows.filter(w => w.t > 35 && w.t <= 40 && w.fingerState === 'MEASURING');
  assert.ok(duringM.length && duringM.every(w => w.quality.code === 'motion'), `motion windows must be gated as motion (${duringM.map(w => w.quality.code)})`);
  console.log('[engine gates] clipping -> saturated, motion -> motion: PASS');
}

// --- 4. Gap: 6 s of missing samples must not crash, must be flagged, and measurement must resume.
{
  const { samples } = generatePpgSamples({ durationSec: 90, hr: 70, fps: 30, seed: 5 });
  const gapped = samples.filter(s => !(s.t > 40000 && s.t < 46000));
  const { windows } = run(gapped);
  assert.ok(windows.some(w => w.gap), 'a window covering the gap must be flagged gap=true');
  const after = windows.filter(w => w.t > 60 && w.quality.good);
  assert.ok(after.length > 0, 'measurement must resume after the gap');
  const bogus = windows.flatMap(w => w.ibiDetails).filter(d => d.valid && (d.ibiMs > 2000 || d.ibiMs < 300));
  assert.equal(bogus.length, 0, 'no accepted interval may span the gap');
  console.log(`[engine gap] gap windows=${windows.filter(w => w.gap).length}, good after=${after.length}: PASS`);
}

// --- 5. Tachogram good flags follow the window gate; goodOnly filter works.
{
  const { samples } = generatePpgSamples({ durationSec: 60, hr: 70, fps: 30, seed: 12, motionBursts: [{ startSec: 30, durationSec: 2, stepCounts: 40 }] });
  const { engine } = run(samples);
  const all = engine.getTachogram();
  const good = engine.getTachogram({ goodOnly: true });
  assert.ok(all.length > good.length, 'some beats must come from not-good windows around the burst');
  assert.ok(good.every(p => p.good), 'goodOnly must only return good-window beats');
  console.log(`[engine tachogram] all=${all.length} goodOnly=${good.length}: PASS`);
}

// --- 6. reset() gives a fresh placement; the recorder clears on start().
{
  const { samples } = generatePpgSamples({ durationSec: 40, hr: 70, fps: 30, seed: 2 });
  const e = new PpgEngine();
  const t0 = samples[0].t;
  for (const s of samples) e.push({ t: (s.t - t0) / 1000, r: s.r, g: s.g, b: s.b });
  assert.equal(e.state, 'MEASURING');
  e.reset();
  assert.equal(e.state, 'NO_FINGER', 'reset returns to NO_FINGER');
  assert.equal(e.lastWindow, null);
  const rec = new DebugRecorder();
  rec.start({}); rec.pushSample({ t: 1000, r: 1, g: 1, b: 1 }); rec.pushSample({ t: 1033, r: 1, g: 1, b: 1 });
  rec.start({}); rec.pushSample({ t: 500, r: 2, g: 2, b: 2 });
  assert.equal(rec.toJSON().samples.length, 1, 'recorder.start() must clear the previous session');
  console.log('[engine reset] engine reset + recorder restart: PASS');
}

// --- 7. Respiration from RSA + amplitude + baseline modulation at 6 breaths/min.
{
  const { samples } = generatePpgSamples({ durationSec: 120, hr: 70, fps: 30, seed: 21, rsaBpm: 6, rsaAmplitudeBpm: 4, rsaAmplitudeModFraction: 0.25, rsaBaselineCounts: 1.5 });
  const { windows } = run(samples);
  const resp = windows.filter(w => w.respiration && w.respiration.rateBpm != null);
  assert.ok(resp.length > 0, 'respiration must be estimated once 40 s of beats exist');
  const last = resp[resp.length - 1].respiration;
  assert.ok(Math.abs(last.rateBpm - 6) <= 1, `respiration ${last.rateBpm.toFixed(1)} br/min should be ~6`);
  assert.ok(last.confidence >= 0.5, `respiration confidence ${last.confidence}`);
  console.log(`[engine respiration] ${last.rateBpm.toFixed(1)} br/min conf=${last.confidence.toFixed(2)} (interval=${last.fromInterval?.toFixed(1)} amp=${last.fromAmplitude?.toFixed(1)} base=${last.fromBaseline?.toFixed(1)}): PASS`);
}

// --- 8. Relative finger presence: an orange-pink Android-style fingertip (high green) is present.
{
  const { samples } = generatePpgSamples({ durationSec: 40, hr: 70, fps: 30, seed: 8 });
  const { engine } = run(samples, {}, s => { s.g = 110; s.b = 60; s.r = Math.min(255, s.r + 30); });
  assert.equal(engine.state, 'MEASURING', 'a fingertip with green ~110 must still be detected as present');
  console.log('[engine presence] high-green fingertip reaches MEASURING: PASS');
}

console.log('\nALL ENGINE TESTS PASSED');

// --- 9. Window SQI and per-beat SQI.
{
  const { samples } = generatePpgSamples({ durationSec: 90, hr: 70, fps: 30, seed: 31 });
  const clean = run(samples);
  const cleanGood = clean.windows.filter(w => w.quality.good);
  assert.ok(cleanGood.length > 5 && cleanGood.every(w => w.sqi && w.sqi.score >= 0.75), `clean windows score >= 0.75 (${cleanGood.map(w => w.sqi && w.sqi.score.toFixed(2)).join(',')})`);
  assert.ok(cleanGood.every(w => Number.isFinite(w.sqi.skewness) && Number.isFinite(w.sqi.kurtosis) && w.sqi.relativePower > 0.5), 'indices are finite and cardiac power dominates (the simulator pulse is near-sinusoidal, so skewness is ~0 here)');
  const clipped = run(samples, {}, s => { if (s.t > 40 && s.t < 55) s.clipped = 0.2; });
  const during = clipped.windows.filter(w => w.t > 45 && w.t <= 55 && w.sqi);
  assert.ok(during.length && during.every(w => w.sqi.score < 0.5), `clipped windows score low (${during.map(w => w.sqi.score.toFixed(2)).join(',')})`);
  const beats = clean.engine.getTachogram({ goodOnly: true }).filter(b => b.valid);
  const withSqi = beats.filter(b => typeof b.sqi === 'number');
  assert.ok(withSqi.length >= 0.9 * beats.length && withSqi.every(b => b.sqi > 0.8), `per-beat SQI present and high on a clean signal (${withSqi.length}/${beats.length})`);
  console.log(`[engine sqi] clean score median=${cleanGood.map(w => w.sqi.score).sort()[cleanGood.length >> 1].toFixed(2)}, clipped=${during[0].sqi.score.toFixed(2)}, beats with sqi=${withSqi.length}/${beats.length}: PASS`);
}

// --- 10. Respiration fusion rules on synthetic beat trains.
{
  // 60 s of beats at ~70 bpm. Each modulation series is a sum of sinusoids
  // (rate in br/min -> amplitude) so a source can be made clear, weak
  // (two rhythms of equal power) or flat.
  const beats = (mods) => {
    const out = [];
    let t = 0;
    const wave = (comps, tt) => comps.reduce((a, [bpm, amp]) => a + amp * Math.sin(2 * Math.PI * (bpm / 60) * tt), 0);
    while (t < 60) {
      const ibi = 857 + wave(mods.interval || [], t);
      t += ibi / 1000;
      out.push({ t, ibiMs: ibi, amplitude: 3 + wave(mods.amplitude || [], t), baseline: 200 + wave(mods.baseline || [], t) });
    }
    return out;
  };
  const near = (a, b, tol, msg) => assert.ok(a != null && Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

  // Slow breathing at 5.8 br/min (below the old 6/min floor) on all three sources.
  const slow = estimateRespiration(beats({ interval: [[5.8, 40]], amplitude: [[5.8, 0.5]], baseline: [[5.8, 1.5]] }));
  near(slow.rateBpm, 5.8, 0.6, 'slow breathing detected');
  assert.equal(slow.basis, 'agreement'); assert.ok(slow.confidence >= 0.6, `confidence ${slow.confidence}`);

  // Typical 15 br/min still works.
  const normal = estimateRespiration(beats({ interval: [[15, 30]], amplitude: [[15, 0.4]], baseline: [[15, 1]] }));
  near(normal.rateBpm, 15, 0.8, '15 br/min detected'); assert.ok(normal.confidence >= 0.6);

  // Only the interval series carries a rhythm: provisional single-source rate.
  const single = estimateRespiration(beats({ interval: [[12, 40]] }));
  near(single.rateBpm, 12, 0.8, 'single clear source publishes'); assert.equal(single.basis, 'single'); assert.equal(single.confidence, 0.3);

  // One rhythm barely leading three others in a single source: weak (peak
  // share ~25%), so nothing without history...
  const weak = { interval: [[6.5, 34], [10, 30], [14, 30], [19, 30]] };
  const cold = estimateRespiration(beats(weak));
  assert.equal(cold.rateBpm, null, `weak source alone yields nothing (got ${cold.rateBpm}, basis ${cold.basis})`);
  // ...but a recent firm rate is held when the weak source still tracks it.
  const held = estimateRespiration(beats(weak), { previousRateBpm: 6.7 });
  assert.equal(held.basis, 'held'); near(held.rateBpm, 6.6, 0.5, 'held near previous'); assert.equal(held.confidence, 0.4);
  assert.equal(estimateRespiration(beats(weak), { previousRateBpm: 20 }).rateBpm, null, 'no hold when nothing tracks the previous rate');

  // A clear rate at twice the previous one while a weak source tracks the previous: harmonic, so hold.
  const harm = estimateRespiration(beats({ interval: [[13.4, 40]], amplitude: [[6.6, 0.34], [10, 0.3], [15, 0.3], [20, 0.3]] }), { previousRateBpm: 6.7 });
  assert.equal(harm.basis, 'held', `harmonic guard (got ${harm.basis} ${harm.rateBpm})`); near(harm.rateBpm, 6.65, 0.5, 'held at the fundamental');
  assert.equal(estimateRespiration(beats({ interval: [[13.4, 40]] })).basis, 'single', 'same rate without history is just a single source');

  // Drift alone (one slow ramp per minute) is not a breath.
  const drift = estimateRespiration(beats({ baseline: [[1, 20]], amplitude: [[1, 2]], interval: [[1, 60]] }));
  assert.equal(drift.rateBpm, null, `drift must not read as breathing (got ${drift.rateBpm})`);
  console.log(`[engine respiration rules] slow=${slow.rateBpm.toFixed(1)} normal=${normal.rateBpm.toFixed(1)} single=${single.rateBpm.toFixed(1)} held=${held.rateBpm.toFixed(1)} harmonic->${harm.rateBpm.toFixed(1)}: PASS`);
}
console.log('ALL ENGINE TESTS PASSED (incl. SQI, respiration rules)');
