// Live-vs-replay parity: drive the REAL PPGMonitor frame path (stubbed
// canvas/video, no browser) over real iPhone fixtures and require it to
// produce exactly the same windows as tools/replay.js on the same samples.
// Both run the same PpgEngine, so any difference means the monitor's frame
// path is feeding the engine something other than the recorded samples.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PPGMonitor } from '../src/core/PPGMonitor.js';
import { runReplay } from '../tools/replay.js';

const FIXTURES = ['test/fixtures/iphone-200s.json', 'test/fixtures/iphone-cros-66s.json'];
const ROI_W = 64, ROI_H = 48;

function liveWindows(log) {
  const { samples } = log;
  let rgb = { r: 0, g: 0, b: 0 };
  const img = { data: new Uint8ClampedArray(ROI_W * ROI_H * 4) };
  const fill = () => { for (let i = 0; i < ROI_W * ROI_H; i++) { img.data[i * 4] = rgb.r; img.data[i * 4 + 1] = rgb.g; img.data[i * 4 + 2] = rgb.b; img.data[i * 4 + 3] = 255; } };
  const out = [];
  const m = new PPGMonitor(null, { onQualityUpdate: (mx) => out.push({ t: mx.t, artifactRatio: mx.artifactRatio, hr: mx.heartRate, good: mx.quality.good, state: mx.fingerState }) });
  m.roiCtx = { drawImage() { fill(); }, getImageData: () => img };
  m.roiSourceRect = { sx: 0, sy: 0, sw: 1, sh: 1 };
  m.video = {};
  m.recorder.start({});
  for (const s of samples) { rgb = s; m.computeFrame(s.t); }
  return out;
}

for (const f of FIXTURES) {
  const log = JSON.parse(readFileSync(f, 'utf8'));
  // Uint8ClampedArray rounds the fixture's fractional means to whole
  // counts on the way in; give replay the same rounded samples.
  const rounded = { ...log, samples: log.samples.map(s => ({ ...s, r: Math.round(s.r), g: Math.round(s.g), b: Math.round(s.b) })) };
  const live = liveWindows(rounded);
  const rp = runReplay(JSON.parse(JSON.stringify(rounded)));
  const replay = rp.hrTimeline.map((w, i) => ({ t: w.windowEndSec, artifactRatio: rp.qualityTimeline[i].artifactRatio, hr: w.heartRate, good: w.quality.good, state: w.state }));
  assert.equal(live.length, replay.length, `${f}: same number of windows (live ${live.length}, replay ${replay.length})`);
  let mismatches = 0;
  for (let i = 0; i < live.length; i++) {
    const l = live[i], r = replay[i];
    if (Math.abs(l.t - r.t) > 1e-6 || l.good !== r.good || l.hr !== r.hr || Math.abs(l.artifactRatio - r.artifactRatio) > 1e-9 || l.state !== r.state) {
      mismatches++;
      console.log(`  mismatch @${i}: live t=${l.t} hr=${l.hr} good=${l.good} ar=${l.artifactRatio} ${l.state} | replay t=${r.t} hr=${r.hr} good=${r.good} ar=${r.artifactRatio} ${r.state}`);
    }
  }
  const liveGood = live.filter(w => w.good).length;
  console.log(`${f}: windows=${live.length} good=${liveGood} mismatches=${mismatches}`);
  assert.equal(mismatches, 0, `${f}: live and replay must agree window for window`);
  assert.ok(liveGood >= 5, `${f}: expected at least 5 good windows`);
}
console.log('live-parity: PASS');
