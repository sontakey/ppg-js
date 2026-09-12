// Live-vs-replay parity: drive the REAL PPGMonitor (stubbed video/canvas)
// over real iPhone fixtures and require it to agree with tools/replay.js on
// the same samples. Guards against the class of bug where the live per-frame
// path and the offline replay path drift apart (2026-09-12: live windows were
// bandpassed from a cold filter, replay with previous-window context; every
// window boundary produced a fake beat and the app never showed HR).
import { readFileSync } from 'node:fs';
import { PPGMonitor } from '../src/core/PPGMonitor.js';
import { runReplay } from '../tools/replay.js';

const FIXTURES = ['test/fixtures/iphone-200s.json', 'test/fixtures/iphone-cros-66s.json'];
const ROI_W = 64, ROI_H = 48;

function liveWindows(log) {
  const { samples } = log;
  let nowMs = samples[0].t;
  const realNow = Date.now;
  Date.now = () => nowMs;
  let rgb = { r: 0, g: 0, b: 0 };
  const img = { data: new Uint8ClampedArray(ROI_W * ROI_H * 4) };
  const fill = () => { for (let i = 0; i < ROI_W * ROI_H; i++) { img.data[i * 4] = rgb.r; img.data[i * 4 + 1] = rgb.g; img.data[i * 4 + 2] = rgb.b; img.data[i * 4 + 3] = 255; } };
  const m = new PPGMonitor(null, { signal: { windowLength: 300, sampleRate: 60, cardiacBandLow: 0.75, cardiacBandHigh: 4.0, fftSize: 256 } });
  m.roiCtx = { drawImage() { fill(); }, getImageData: () => img };
  m.roiSourceRect = { sx: 0, sy: 0, sw: 1, sh: 1 };
  m.video = { requestVideoFrameCallback: () => 0, cancelVideoFrameCallback() {}, currentTime: 0 };
  m.recorder.start({});
  m.initTime = new Date(samples[0].t);
  const out = [];
  const orig = m.signalProcessor.process.bind(m.signalProcessor);
  m.signalProcessor.process = (...a) => { const r = orig(...a); out.push({ t: (nowMs - samples[0].t) / 1000, artifactRatio: r.artifactRatio, hr: r.heartRate, good: r.quality.good }); return r; };
  m.nFrame = 101;
  try { for (const s of samples) { nowMs = s.t; rgb = s; m.computeFrame(s.t); } } finally { Date.now = realNow; }
  return out;
}

let failed = 0;
for (const f of FIXTURES) {
  const log = JSON.parse(readFileSync(f, 'utf8'));
  const live = liveWindows(log);
  const rp = runReplay(log);
  const replay = rp.hrTimeline.map((w, i) => ({ t: w.windowStartSec, artifactRatio: rp.qualityTimeline[i].artifactRatio, hr: w.heartRate, good: w.quality.good, state: w.state }))
    .filter(w => w.state === 'MEASURING');
  // Pair each live MEASURING window with the replay window covering its end time.
  // Live windows end ~4 s after replay's fixed 5 s grid, so per-pair HR can
  // differ by a few bpm legitimately; the assertions target gross divergence.
  const pairs = live.map(l => [l, replay.find(r => l.t > r.t && l.t <= r.t + 5.5)]).filter(([, r]) => r);
  const goodAgree = pairs.filter(([l, r]) => l.good === r.good).length / pairs.length;
  const hrBad = pairs.filter(([l, r]) => l.good && r.good && Math.abs(l.hr - r.hr) > 8);
  const arBad = pairs.filter(([l, r]) => Math.abs(l.artifactRatio - r.artifactRatio) > 0.1);
  const liveGood = live.filter(w => w.good).length;
  console.log(`${f}: live windows=${live.length} good=${liveGood} | paired=${pairs.length} goodAgree=${(goodAgree * 100).toFixed(0)}% hrMismatch=${hrBad.length} arMismatch=${arBad.length}`);
  const ok = pairs.length >= 5 && goodAgree >= 0.7 && hrBad.length === 0 && arBad.length <= Math.ceil(pairs.length * 0.15) && liveGood >= Math.floor(pairs.length * 0.6);
  if (!ok) { failed++; for (const [l, r] of pairs) console.log(`  live t=${l.t.toFixed(1)} ar=${l.artifactRatio.toFixed(2)} hr=${l.hr} good=${l.good} | replay t=${r.t} ar=${r.artifactRatio.toFixed(2)} hr=${r.hr} good=${r.good}`); }
}
if (failed) { console.error(`live-parity: ${failed} fixture(s) FAILED`); process.exit(1); }
console.log('live-parity: PASS');
