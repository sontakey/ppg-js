// DSP building blocks + BLE packet parser. Run: node --import tsx test/dsp.test.js
import assert from 'node:assert/strict';
import { designBandpass, magnitudeResponse, filtfiltPadded, resampleToGrid } from '../src/core/filter.js';
import { computeFFT, calculateSNRFromPSD } from '../src/core/fft.js';
import { templateCorrelation, detectPeaksDetailed, computeIBIs, crossCheckHeartRate } from '../src/core/peaks.js';
import { parseHeartRateMeasurement } from '../src/sources/ble.js';
import { coachingMessage } from '../src/core/coaching.js';
import { isFingerPresent } from '../src/core/fingerState.js';

const db = (g) => 40 * Math.log10(g); // filtfilt = magnitude squared

// --- filter shape
for (const fs of [30, 60]) {
  const d = designBandpass(fs, 0.6, 4.6);
  for (const f of [0.75, 1, 1.5, 2, 3]) assert.ok(db(magnitudeResponse(d, f)) > -2, `${fs}fps: ${f} Hz must be within 2 dB (got ${db(magnitudeResponse(d, f)).toFixed(1)})`);
  assert.ok(db(magnitudeResponse(d, 0.3)) < -40, `${fs}fps: 0.3 Hz breathing must be > 40 dB down`);
  assert.ok(db(magnitudeResponse(d, 8)) < -15, `${fs}fps: 8 Hz must be > 15 dB down`);
}
console.log('[dsp filter] passband flat within 2 dB over 45-180 bpm, breathing > 40 dB down: PASS');

// --- padded filtfilt has no start-up transient on a stepped input
{
  const fs = 60, n = 600; const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = -190 + 3 * Math.sin(2 * Math.PI * 1.2 * i / fs);
  const y = filtfiltPadded(designBandpass(fs, 0.6, 4.6), x, 120);
  let maxHead = 0; for (let i = 0; i < 60; i++) maxHead = Math.max(maxHead, Math.abs(y[i]));
  assert.ok(maxHead < 4.5, `first second must not ring (max |y| ${maxHead.toFixed(1)})`);
  console.log('[dsp padded filtfilt] no start-up transient: PASS');
}

// --- FFT resolution + harmonic guard
{
  for (const fs of [24, 30, 60]) {
    const est = [];
    for (const bpm of [60, 64, 68, 72]) {
      const n = Math.round(5 * fs); const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.01 * Math.sin(2 * Math.PI * (bpm / 60) * i / fs);
      const f = computeFFT(x, 256, fs); est.push(calculateSNRFromPSD(f.psd, f.freqResolution).peakFrequency * 60);
    }
    est.forEach((e, i) => assert.ok(Math.abs(e - [60, 64, 68, 72][i]) < 0.5, `${fs}fps: ${[60, 64, 68, 72][i]} bpm read as ${e.toFixed(1)}`));
  }
  const fs = 30, n = 150; const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * (55 / 60) * i / fs; x[i] = 0.006 * Math.sin(ph) + 0.009 * Math.sin(2 * ph + 0.7); }
  const f = computeFFT(x, 256, fs); const s = calculateSNRFromPSD(f.psd, f.freqResolution);
  assert.ok(s.harmonicCorrected && Math.abs(s.peakFrequency * 60 - 55) < 1, `dominant 2nd harmonic resolved to 55 (got ${(s.peakFrequency * 60).toFixed(1)})`);
  console.log('[dsp fft] < 0.5 bpm resolution at 24/30/60 fps, sub-harmonic guard: PASS');
}

// --- template correlation flags a malformed beat
{
  const fs = 60, n = 600; const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1.2 * i / fs) + 0.15 * Math.sin(2 * Math.PI * 2.4 * i / fs + 0.5);
  for (let i = 250; i < 290; i++) x[i] *= 1 + 1.5 * Math.sin(2 * Math.PI * 7 * i / fs); // one beat with a garbled shape
  const peaks = detectPeaksDetailed(x, fs, 0.5, 2.0, 0.3);
  const tc = templateCorrelation(x, fs, peaks.map(p => p.refined));
  assert.ok(tc.median > 0.95, `median template correlation ${tc.median.toFixed(2)}`);
  const bad = peaks.map((p, i) => [p.refined / fs, tc.perBeat[i]]).filter(([t]) => t > 4.1 && t < 4.9);
  assert.ok(bad.length === 0 || bad.some(([, c]) => Number.isNaN(c) || c < 0.8), `garbled beat must correlate poorly or be dropped (${bad.map(([t, c]) => t.toFixed(2) + ':' + (c || NaN).toFixed(2))})`);
  const goodBeats = peaks.map((p, i) => [p.refined / fs, tc.perBeat[i]]).filter(([t, c]) => (t < 4 || t > 5) && !Number.isNaN(c));
  assert.ok(goodBeats.every(([, c]) => c > 0.9), 'undistorted beats correlate > 0.9');
  console.log(`[dsp template] median=${tc.median.toFixed(2)}, garbled beat flagged: PASS`);
}

// --- cross-check kinds and morphology rejection
{
  assert.equal(crossCheckHeartRate(140, 70).disagreeKind, 'double');
  assert.equal(crossCheckHeartRate(35, 70).disagreeKind, 'half');
  assert.equal(crossCheckHeartRate(72, 70).disagree, false);
  const peaks = [0, 0.85, 1.7, 2.55, 3.4, 4.25, 5.1];
  const r = computeIBIs(peaks, 300, 2000, 0.3, [true, true, true, false, true, true, true]);
  assert.equal(r.details[2].reason, 'morphology'); assert.equal(r.details[3].reason, 'morphology');
  console.log('[dsp ibi] cross-check kinds + morphology rejection: PASS');
}

// --- computeIBIs must not deadlock on a reference seeded by a noisy onset,
// and must follow a real sustained rate change, while still rejecting a
// lone ectopic-looking jump.
{
  const times = (ibis) => ibis.reduce((acc, ibi) => (acc.push(acc[acc.length - 1] + ibi / 1000), acc), [0]);
  // Three junk intervals from the onset, then a steady 780 ms rhythm.
  const onset = computeIBIs(times([1480, 1590, 650, 780, 790, 770, 785, 775, 780, 790, 780]));
  const tail = onset.details.slice(3);
  assert.ok(tail.every(x => x.valid), `steady rhythm accepted after a bad seed (${tail.map(x => x.reason).join(',')})`);
  assert.ok(onset.details.slice(0, 2).every(x => !x.valid && x.reason === 'jump_vs_median'), 'cold-start seeds that disagree with the rhythm are dropped');
  assert.ok(onset.details[2].valid, 'a seed within the jump limit of the real rhythm (650 vs 780 ms) is kept');
  // A real change from 1000 ms to 650 ms (60 -> 92 bpm) is followed after
  // four consistent beats, and the earlier beats stay accepted.
  const change = computeIBIs(times([1000, 990, 1010, 1000, 995, 1005, 1000, 990, 650, 660, 640, 655, 650, 645]));
  assert.ok(change.details.slice(0, 8).every(x => x.valid), 'earlier beats at the old rate stay valid');
  assert.ok(change.details.slice(8).every(x => x.valid), `new rate accepted (${change.details.slice(8).map(x => x.reason).join(',')})`);
  // One premature beat plus its compensatory pause is still rejected.
  const ectopic = computeIBIs(times([800, 810, 790, 800, 500, 1100, 805, 795, 800]));
  assert.equal(ectopic.details[4].reason, 'jump_vs_median'); assert.equal(ectopic.details[5].reason, 'jump_vs_median');
  assert.ok(ectopic.details.slice(6).every(x => x.valid), 'rhythm resumes after the ectopic pair');
  console.log('[dsp ibi] re-seed after bad onset, follow real rate change, reject lone ectopic: PASS');
}

// --- resampleToGrid edge handling
{
  const out = resampleToGrid([1, 2, 3], [10, 20, 30], 0, 0.5, 9);
  assert.deepEqual(Array.from(out), [10, 10, 10, 15, 20, 25, 30, 30, 30]);
  console.log('[dsp resample] linear interior, held edges: PASS');
}

// --- BLE Heart Rate Measurement parser
{
  const buf = new Uint8Array([0x10, 70, 0x66, 0x03, 0x40, 0x03]); // flags: RR present; HR 70; RR 870/1024 s, 832/1024 s
  const m = parseHeartRateMeasurement(new DataView(buf.buffer));
  assert.equal(m.heartRate, 70);
  assert.equal(m.rrIntervalsMs.length, 2);
  assert.ok(Math.abs(m.rrIntervalsMs[0] - 849.6) < 0.1 && Math.abs(m.rrIntervalsMs[1] - 812.5) < 0.1);
  const buf16 = new Uint8Array([0x1f, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x04]); // 16-bit HR 300, contact supported+detected, energy 16, RR 1024/1024
  const m2 = parseHeartRateMeasurement(new DataView(buf16.buffer));
  assert.equal(m2.heartRate, 300); assert.equal(m2.contactDetected, true); assert.equal(m2.energyExpendedKj, 16); assert.equal(m2.rrIntervalsMs[0], 1000);
  console.log('[ble] heart rate measurement parser: PASS');
}

// --- coaching precedence + relative presence
{
  assert.equal(coachingMessage({ state: 'MEASURING', torchSupported: false, redMean: 200, greenMean: 30, blueMean: 30, acDcRatio: 0.02, qualityCode: null }), 'Good signal - hold steady');
  assert.ok(/flashlight|lamp/i.test(coachingMessage({ state: 'NO_FINGER', torchSupported: false })));
  assert.equal(isFingerPresent({ redMean: 230, greenMean: 110, blueMean: 60 }), true, 'orange-pink Android fingertip');
  assert.equal(isFingerPresent({ redMean: 120, greenMean: 110, blueMean: 100 }), false, 'a room');
  assert.equal(isFingerPresent({ redMean: 5, greenMean: 5, blueMean: 5 }), false, 'dark');
  console.log('[coaching/presence] torch hint only when no finger; relative presence: PASS');
}

console.log('\nALL DSP TESTS PASSED');

// --- signal-quality indices (appended after the SQI module landed)
{
  const { skewnessSqi, kurtosisSqi, zeroCrossingRateSqi, relativePowerSqi, detectorAgreementSqi, compositeSqi } = await import('../src/core/sqi.js');
  const fs = 60, n = 600;
  const sine = new Float64Array(n); for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 1.2 * i / fs);
  assert.ok(Math.abs(skewnessSqi(sine)) < 0.05, 'a sinusoid has ~0 skewness');
  assert.ok(Math.abs(kurtosisSqi(sine) + 1.5) < 0.1, `a sinusoid has excess kurtosis -1.5 (got ${kurtosisSqi(sine).toFixed(2)})`);
  const pulse = new Float64Array(n); for (let i = 0; i < n; i++) { const ph = (i / fs * 1.2) % 1; pulse[i] = Math.exp(-((ph - 0.2) ** 2) / 0.006) - 0.2; }
  assert.ok(skewnessSqi(pulse) > 0.8, `a sharp systolic pulse is positively skewed (got ${skewnessSqi(pulse).toFixed(2)})`);
  assert.ok(Math.abs(zeroCrossingRateSqi(sine, fs) - 2.4) < 0.3, `zero-crossing rate of 1.2 Hz sine ~2.4/s (got ${zeroCrossingRateSqi(sine, fs).toFixed(2)})`);
  const f = computeFFT(sine, 256, fs);
  assert.ok(relativePowerSqi(f.psd, f.freqResolution, 0.75, 4) > 0.95, 'nearly all power of a 1.2 Hz sine is in the cardiac band');
  assert.equal(detectorAgreementSqi(70, 70), 1); assert.ok(Math.abs(detectorAgreementSqi(63, 70) - 0.9) < 1e-9); assert.ok(Number.isNaN(detectorAgreementSqi(0, 70)));
  const good = compositeSqi({ templateCorrelation: 0.98, artifactRatio: 0.02, acDcRatio: 0.01, minAcDc: 0.002, snrDb: 12, clippedFraction: 0, motion: NaN, detectorAgreement: 0.99 });
  const bad = compositeSqi({ templateCorrelation: 0.6, artifactRatio: 0.25, acDcRatio: 0.002, minAcDc: 0.002, snrDb: -3, clippedFraction: 0.08, motion: 2.5, detectorAgreement: 0.6 });
  assert.ok(good.score > 0.9 && bad.score < 0.3, `composite separates clean (${good.score}) from poor (${bad.score})`);
  assert.ok(Number.isNaN(good.components.motion), 'motion component is NaN without a motion source');
  console.log(`[sqi] skew/kurtosis/zero-crossing/relative power/agreement/composite (good=${good.score}, bad=${bad.score}): PASS`);
}
console.log('ALL DSP TESTS PASSED (incl. SQI)');
