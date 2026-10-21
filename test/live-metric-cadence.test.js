// The demo's one-second hop uses real overlapping analysis windows, not a UI
// timer or interpolated values. Keep beat acceptance unique and quality-gated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PpgEngine, DEFAULT_ENGINE_OPTIONS } from '../src/core/engine.js';
import { generatePpgSamples } from './sim/ppg-sim.js';

assert.equal(DEFAULT_ENGINE_OPTIONS.hopSec, 5, 'library default cadence remains compatible');
for (const fixture of ['iphone-200s.json', 'iphone-63s-noisy-onset.json']) {
  const log = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'));
  const engine = new PpgEngine({ ...log.meta?.engineConfig?.engine, hopSec: 1 });
  const windows = [];
  const first = log.samples[0].t;
  for (const sample of log.samples) {
    const result = engine.push({ ...sample, t: (sample.t - first) / 1000 });
    if (!result.window) continue;
    const window = result.window;
    windows.push(window);
    assert.ok(Math.abs(window.t - window.windowStartSec - 5) < 1e-8, 'five-second quality/analysis window is retained');
    assert.ok(window.peakTimesSec.every(t => t <= window.t - engine.opts.edgeGuardSec + 1e-8), 'new beats retain the filter-edge validation delay');
    if (window.quality.good) {
      assert.ok(window.quality.ibiCount >= engine.config.quality.minIbiCount60s, 'readouts wait for enough accepted intervals');
      assert.ok(window.heartRate > 0 && Number.isFinite(window.rmssd) && Number.isFinite(window.sdnn));
    } else {
      assert.equal(window.heartRate, 0); assert.equal(window.rmssd, 0); assert.equal(window.sdnn, 0);
    }
  }
  const good = windows.filter(window => window.quality.good);
  assert.ok(good.length > 20, `${fixture}: actual quality-gated computed estimates are produced`);
  const adjacent = good.slice(1).filter((window, i) => Math.abs(window.t - good[i].t - 1) < 1e-8);
  assert.ok(adjacent.length >= good.length * 0.7, `${fixture}: reliable signal yields one-second updates`);
  const beats = engine.getTachogram();
  assert.equal(new Set(beats.map(beat => beat.t)).size, beats.length, 'overlapping windows do not publish duplicate beats');
  assert.ok(beats.slice(1).every((beat, i) => beat.t > beats[i].t), 'accepted intervals stay chronological');
  console.log(`${fixture}: ${windows.length} analyses, ${good.length} quality-gated estimates, ${beats.length} unique intervals`);
}
// Same modulated ground-truth signal and 15ms RMSSD tolerance as sim.test.js.
{
  const { samples, groundTruth } = generatePpgSamples({ durationSec: 90, hr: 70, fps: 30, rsaBpm: 6, rsaAmplitudeBpm: 5, seed: 11 });
  const engine = new PpgEngine({ hopSec: 1 });
  for (const sample of samples) engine.push({ ...sample, t: (sample.t - samples[0].t) / 1000 });
  const window = engine.lastWindow;
  assert.ok(window.quality.good, 'one-second cadence reaches reliable estimates on the known RSA signal');
  assert.ok(Math.abs(window.rmssd - groundTruth.rmssdMs) <= 15, 'one-second cadence retains the established RMSSD accuracy tolerance');
  console.log(`1s hop RSA: RMSSD=${window.rmssd.toFixed(1)}ms, truth=${groundTruth.rmssdMs.toFixed(1)}ms`);
}
console.log('Live metric cadence: PASS');
