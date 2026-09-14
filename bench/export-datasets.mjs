// Export benchmark datasets: real fixtures + simulator scenarios with ground
// truth, each with ppg-js's own result, as JSON for the Python comparison
// against HeartPy / vital_sqi (bench/compare.py).
//   node --import tsx bench/export-datasets.mjs bench/out
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PpgEngine } from '../src/core/engine.js';
import { generatePpgSamples } from '../test/sim/ppg-sim.js';

const outDir = process.argv[2] || 'bench/out';
mkdirSync(outDir, { recursive: true });

function runEngine(samples) {
  const e = new PpgEngine();
  const t0 = samples[0].t;
  const windows = [];
  for (const s of samples) {
    const r = e.push({ t: (s.t - t0) / 1000, r: s.r, g: s.g, b: s.b, clipped: s.clipped, motion: s.motion });
    if (r.window) windows.push({ t: r.window.t, start: r.window.windowStartSec, state: r.window.fingerState, good: r.window.quality.good, reason: r.window.quality.reason, hr: r.window.heartRate, rmssd: r.window.rmssd, floor: r.window.rmssdFloorMs, sqi: r.window.templateSqi, acdc: r.window.acDcRatio });
  }
  const tach = e.getTachogram();
  return {
    windows,
    beats: tach.map(p => ({ t: p.t, ibiMs: p.ibiMs, valid: p.valid, good: p.good, lowSnr: p.lowSnr, reason: p.reason })),
    summary: e.getSessionSummary()
  };
}

function dropFrames(samples, frac, seed = 7) { let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; return samples.filter(() => rnd() >= frac); }

const datasets = [];
for (const f of ['iphone-200s', 'iphone-cros-66s', 'iphone-cros-160s-mute', 'iphone-52s']) {
  const log = JSON.parse(readFileSync(`test/fixtures/${f}.json`, 'utf8'));
  let samples = log.samples;
  if (samples.every(s => s.t === samples[0].t)) { const fps = log.meta?.trackSettings?.frameRate || 30; samples = samples.map((s, i) => ({ ...s, t: i * 1000 / fps })); }
  datasets.push({ name: f, kind: 'real', samples: samples.map(s => ({ t: s.t, r: s.r, g: s.g, b: s.b })), truth: null });
}
const sims = [
  { name: 'sim-clean-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 3 } },
  { name: 'sim-clean-70-60fps', o: { durationSec: 120, hr: 70, fps: 60, seed: 3 } },
  { name: 'sim-clean-70-30fps-frac', o: { durationSec: 120, hr: 70, fps: 30, seed: 3, quantize: false } },
  { name: 'sim-drop10-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 3 }, drop: 0.1 },
  { name: 'sim-rsa-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 11, rsaBpm: 6, rsaAmplitudeBpm: 5, rsaAmplitudeModFraction: 0.2, rsaBaselineCounts: 1 } },
  { name: 'sim-lowamp-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 14, dc: 190, acAmplitude: 2, noiseSd: 1 } },
  { name: 'sim-motion-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 12, motionBursts: [{ startSec: 40, durationSec: 2, stepCounts: 40 }, { startSec: 80, durationSec: 3, stepCounts: -30 }] } },
  { name: 'sim-droppedbeats-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 15, everyNthMissed: 5 } },
  { name: 'sim-dicrotic-50-30fps', o: { durationSec: 120, hr: 50, fps: 30, seed: 9, harmonic2: 1.4, acAmplitude: 4 } },
  { name: 'sim-fast-110-30fps', o: { durationSec: 120, hr: 110, fps: 30, seed: 5 } },
  { name: 'sim-lift-70-30fps', o: { durationSec: 120, hr: 70, fps: 30, seed: 13, fingerLifts: [{ startSec: 50, durationSec: 4 }] } }
];
for (const s of sims) {
  const { samples, groundTruth } = generatePpgSamples(s.o);
  const used = s.drop ? dropFrames(samples, s.drop) : samples;
  datasets.push({ name: s.name, kind: 'sim', options: s.o, samples: used, truth: { beatTimesSec: groundTruth.beatTimesSec, ibisMs: groundTruth.ibisMs, rmssdMs: groundTruth.rmssdMs, hr: s.o.hr } });
}
for (const d of datasets) {
  d.ppgjs = runEngine(d.samples);
  writeFileSync(path.join(outDir, `${d.name}.json`), JSON.stringify(d));
  console.log(`${d.name}: samples=${d.samples.length} windows=${d.ppgjs.windows.length} good=${d.ppgjs.windows.filter(w => w.good).length} beats(valid,good)=${d.ppgjs.beats.filter(b => b.valid && b.good).length}`);
}
