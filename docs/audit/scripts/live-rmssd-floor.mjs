// Run from repo root: node --import tsx docs/audit/scripts/live-rmssd-floor.mjs
// Evidence script for docs/audit/AUDIT-2026-09.md (finding A3). Drives the
// REAL live PPGMonitor frame path (stubbed canvas, no browser) over synthetic
// zero-HRV and known-RSA signals at several frame rates, with and without 10%
// dropped frames, and compares accepted-interval RMSSD with ground truth.
// The audit's table was measured on v0.2.0; this prints the current numbers.
import { PPGMonitor } from '../../../src/core/PPGMonitor.ts';
import { generatePpgSamples } from '../../../test/sim/ppg-sim.js';
import { runReplay } from '../../../tools/replay.js';
const ROI_W = 64, ROI_H = 48;
function live(samples) {
  let rgb = { r: 0, g: 0, b: 0 }; const img = { data: new Uint8ClampedArray(ROI_W * ROI_H * 4) };
  const fill = () => { for (let i = 0; i < ROI_W * ROI_H; i++) { img.data[i * 4] = rgb.r; img.data[i * 4 + 1] = rgb.g; img.data[i * 4 + 2] = rgb.b; img.data[i * 4 + 3] = 255; } };
  const wins = [];
  const m = new PPGMonitor(null, { onQualityUpdate: (x) => wins.push(x) });
  m.roiCtx = { drawImage() { fill(); }, getImageData: () => img }; m.roiSourceRect = { sx: 0, sy: 0, sw: 1, sh: 1 }; m.video = {}; m.recorder.start({});
  for (const s of samples) { rgb = s; m.computeFrame(s.t); }
  return { m, wins };
}
function rmssdOf(a) { if (a.length < 2) return 0; let s = 0; for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2; return Math.sqrt(s / (a.length - 1)); }
function dropFrames(samples, frac, seed = 7) { let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; return samples.filter(() => rnd() >= frac); }
console.log('fps  drop  trueRMSSD | LIVE: acceptedIBIs rmssd(acc) medIBIerr goodWin floorEst | REPLAY: acceptedIBIs rmssd(acc)');
for (const fps of [24, 30, 60]) for (const drop of [0, 0.1]) for (const rsa of [0, 5]) {
  const { samples, groundTruth } = generatePpgSamples({ durationSec: 120, hr: 70, fps, fpsJitter: 0.1, seed: 3, rsaBpm: rsa ? 6 : 0, rsaAmplitudeBpm: rsa });
  const s = drop ? dropFrames(samples, drop) : samples;
  const { m, wins } = live(s);
  const acc = m.getTachogram({ goodOnly: true }).filter(d => d.valid).map(d => d.ibiMs);
  const truthMean = groundTruth.ibisMs.reduce((a, b) => a + b, 0) / groundTruth.ibisMs.length;
  const accMed = [...acc].sort((a, b) => a - b)[acc.length >> 1] || 0;
  const good = wins.filter(w => w.quality && w.quality.good);
  const floor = good.length ? good[good.length - 1].rmssdFloorMs : 0;
  const rp = runReplay({ meta: { trackSettings: { frameRate: fps } }, samples: s.map(x => ({ ...x })), events: [] });
  const racc = rp.tachogram.filter(d => d.valid && d.good).map(d => d.ibiMs);
  console.log(`${String(fps).padStart(3)}  ${String(drop).padStart(4)}  ${groundTruth.rmssdMs.toFixed(1).padStart(9)} | ${String(acc.length).padStart(12)} ${rmssdOf(acc).toFixed(1).padStart(10)} ${(accMed - truthMean).toFixed(1).padStart(9)} ${String(good.length).padStart(7)}/${wins.length} ${floor.toFixed(1).padStart(8)} | ${String(racc.length).padStart(12)} ${rmssdOf(racc).toFixed(1).padStart(10)}`);
}
