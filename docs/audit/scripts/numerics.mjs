// Run from repo root: node --import tsx docs/audit/scripts/numerics.mjs
// Evidence script for docs/audit/AUDIT-2026-09.md (findings A1, A2, B8, B10).
// Originally measured the v0.2.0 code; now measures the current code so the
// numbers can be compared with the tables in the audit. Read-only.
import { designBandpass, magnitudeResponse } from '../../../src/core/filter.ts';
import { computeFFT, calculateSNRFromPSD } from '../../../src/core/fft.ts';
import { DebugRecorder } from '../../../src/core/recorder.ts';
import { coachingMessage } from '../../../src/core/coaching.ts';

for (const fs of [30, 60]) {
  const d = designBandpass(fs, 0.6, 4.6);
  console.log(`\n[filter fs=${fs}] cascade HP4@0.6Hz + LP2@4.6Hz, |H|^2 (filtfilt) in dB:`);
  for (const f of [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.17, 1.73, 2.5, 4.0, 6.0, 8.0]) console.log(`   f=${f}Hz -> ${(40 * Math.log10(magnitudeResponse(d, f))).toFixed(1)} dB`);
}
for (const fs of [24, 30, 60]) {
  const out = [];
  for (const bpm of [60, 64, 68, 72, 76, 80]) {
    const n = Math.round(5 * fs); const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 + 0.01 * Math.sin(2 * Math.PI * (bpm / 60) * i / fs);
    const f = computeFFT(x, 256, fs); const s = calculateSNRFromPSD(f.psd, f.freqResolution, 0.75, 4.0);
    out.push(`${bpm}->${(s.peakFrequency * 60).toFixed(1)}`);
  }
  console.log(`[fft fs=${fs}] windowSec=5, Hann + zero-pad + parabolic; true->fftHR: ${out.join(' ')}`);
}
{
  const r = new DebugRecorder();
  r.start({}); r.pushSample({ t: 1000, r: 1, g: 1, b: 1 }); r.pushSample({ t: 1033, r: 1, g: 1, b: 1 });
  r.start({}); r.pushSample({ t: 500, r: 2, g: 2, b: 2 });
  console.log(`\n[recorder restart] samples after second start(): ${r.toJSON().samples.length} (expected 1)`);
}
console.log(`\n[coaching] torchSupported=false + MEASURING good signal => "${coachingMessage({ state: 'MEASURING', torchSupported: false, redMean: 200, greenMean: 30, blueMean: 30, acDcRatio: 0.02, qualityCode: null })}"`);
