// PpgEngine ground-truth tests: beat timing precision with and without
// dropped frames, harmonic lock, clipping/motion gates, gaps, restarts,
// good-only tachogram, respiration. Run: node --import tsx test/engine.test.js
import assert from 'node:assert/strict';
import { PpgEngine } from '../src/core/engine.js';
import { DebugRecorder } from '../src/core/recorder.js';
import { generatePpgSamples } from './sim/ppg-sim.js';

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
