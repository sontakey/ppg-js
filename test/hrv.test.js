// HRV module tests against known values. Run: node --import tsx test/hrv.test.js
import assert from 'node:assert/strict';
import * as hrv from '../src/hrv/index.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// --- time domain on constructed series
{
  const constant = new Array(120).fill(800);
  const td = hrv.timeDomain(constant);
  assert.ok(td.ok);
  assert.equal(td.sdnn, 0); assert.equal(td.rmssd, 0); assert.equal(td.pnn50, 0);
  close(td.meanHR, 75, 1e-9, 'meanHR');
  assert.equal(td.triangularIndex, 1, 'all beats in one bin -> triangular index 1');

  const alt = Array.from({ length: 100 }, (_, i) => (i % 2 ? 820 : 780));
  const t2 = hrv.timeDomain(alt);
  close(t2.rmssd, 40, 1e-9, 'alternating 780/820 RMSSD');
  close(t2.sdnn, Math.sqrt((100 * 400) / 99), 1e-9, 'sample SDNN');
  assert.equal(t2.pnn50, 0);
  const alt2 = Array.from({ length: 100 }, (_, i) => (i % 2 ? 840 : 760));
  assert.equal(hrv.timeDomain(alt2).pnn50, 100, 'all diffs 80 ms -> pNN50 100%');
  console.log('[hrv time-domain] constant / alternating series: PASS');
}

// --- TINN: a triangular histogram 700..1000 ms has TINN ~300 ms; a single far outlier barely moves it while rrRange jumps
{
  const rr = [];
  for (let k = 0; k <= 38; k++) { const v = 700 + k * 7.8125; const h = k <= 19 ? k + 1 : 39 - k; for (let j = 0; j < h; j++) rr.push(v); }
  const td = hrv.timeDomain(rr);
  close(td.tinn, 300, 25, 'TINN of a triangle with 300 ms base');
  const td2 = hrv.timeDomain([...rr, 1400]);
  close(td2.tinn, td.tinn, 30, 'TINN robust to one outlier');
  assert.ok(td2.rrRange > 650, 'rrRange follows the outlier');
  console.log(`[hrv TINN] triangle=${td.tinn.toFixed(0)}ms with outlier=${td2.tinn.toFixed(0)}ms rrRange=${td2.rrRange.toFixed(0)}: PASS`);
}

// --- stress index (Baevsky): 50 ms bins from 810 -> mode bin [910,960) centre 935 ms, AMo 40%, MxDMn 290 ms
{
  const ibis = [...new Array(40).fill(910), ...new Array(30).fill(810), ...new Array(30).fill(1100)];
  const si = hrv.stressIndex(ibis);
  close(si.modeMs, 935, 1e-9, 'mode');
  close(si.amoPercent, 40, 1e-9, 'AMo');
  close(si.mxdmnMs, 290, 1e-9, 'MxDMn');
  close(si.baevsky, 40 / (2 * 0.935 * 0.29), 1e-6, 'Baevsky SI');
  close(si.sqrt, Math.sqrt(si.baevsky), 1e-9, 'sqrt SI');
  console.log(`[hrv stress index] SI=${si.baevsky.toFixed(1)} sqrt=${si.sqrt.toFixed(2)}: PASS`);
}

// --- Poincare / RMSSD relationship and sample entropy / DFA sanity
{
  const alt = Array.from({ length: 100 }, (_, i) => (i % 2 ? 820 : 780));
  const pc = hrv.poincare(alt);
  close(pc.sd1, 40 / Math.SQRT2, 1e-9, 'SD1 = RMSSD/sqrt(2) (population)');
  assert.ok(Number.isNaN(hrv.sampleEntropy(new Array(200).fill(800))), 'constant -> NaN');
  close(hrv.sampleEntropy(alt, 2, 5), 0, 1e-9, 'perfectly periodic -> SampEn 0');
  let x = 12345; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff - 0.5; };
  const white = Array.from({ length: 400 }, () => 850 + 60 * rnd());
  const walk = []; let acc = 850; for (let i = 0; i < 400; i++) { acc += 10 * rnd(); walk.push(acc); }
  const aW = hrv.dfaAlpha1(white), aR = hrv.dfaAlpha1(walk);
  assert.ok(aW > 0.3 && aW < 0.75, `DFA alpha1 of white noise ${aW.toFixed(2)} ~0.5`);
  assert.ok(aR > 1.2 && aR < 1.8, `DFA alpha1 of a random walk ${aR.toFixed(2)} ~1.5`);
  const se = hrv.sampleEntropy(white);
  assert.ok(se > 1.2, `SampEn of white noise ${se.toFixed(2)} should be high`);
  console.log(`[hrv nonlinear] SD1 ok, SampEn white=${se.toFixed(2)}, DFA white=${aW.toFixed(2)} walk=${aR.toFixed(2)}: PASS`);
}

// --- frequency domain: RSA at 0.25 Hz -> HF peak at 0.25, respiration 15/min; 0.1 Hz -> LF, coherence high
function modulated(fHz, ampMs, durationSec, meanMs = 850) {
  const beats = []; let t = 0;
  while (t < durationSec) { const ibi = meanMs + ampMs * Math.sin(2 * Math.PI * fHz * t); t += ibi / 1000; beats.push({ t, ibiMs: ibi }); }
  return beats;
}
{
  const fd = hrv.frequencyDomain(modulated(0.25, 50, 180));
  assert.ok(fd.ok, fd.reason);
  close(fd.hf.peakFrequency, 0.25, 0.02, 'HF peak');
  assert.ok(fd.hfnu > 75, `HF nu ${fd.hfnu.toFixed(0)} should dominate`);
  close(fd.respirationRateBpm, 15, 1.2, 'respiration from HF');
  assert.equal(fd.vlf, null, 'VLF hidden below 5 min');
  const lfCase = hrv.frequencyDomain(modulated(0.1, 50, 180));
  assert.ok(lfCase.lfnu > 75, `LF nu ${lfCase.lfnu.toFixed(0)} should dominate`);
  assert.ok(lfCase.coherence > 0.5, `coherence ${lfCase.coherence.toFixed(2)} high for a single 0.1 Hz rhythm`);
  const rs = hrv.resampleRR(modulated(0.25, 50, 60));
  assert.ok(new Set(Array.from(rs.series).map(v => v.toFixed(4))).size > rs.series.length * 0.8, 'resampled series is interpolated, not sample-and-hold');
  // gap: 30 s hole in 100 s -> refuse
  const gapped = modulated(0.25, 30, 100).filter(b => !(b.t > 40 && b.t < 70));
  const fg = hrv.frequencyDomain(gapped);
  assert.equal(fg.ok, false); assert.ok(/gaps/i.test(fg.reason), fg.reason);
  console.log(`[hrv frequency] HF peak ${fd.hf.peakFrequency.toFixed(3)}Hz hfnu=${fd.hfnu.toFixed(0)} resp=${fd.respirationRateBpm.toFixed(1)}; LF coherence=${lfCase.coherence.toFixed(2)}; gap refused: PASS`);
}

// --- artifact correction, ultra-short, baseline
{
  const rr = new Array(30).fill(800); rr[10] = 1300;
  const c = hrv.correctArtifacts(rr);
  assert.ok(c.flagged[10] && !c.flagged[9]); close(c.corrected[10], 800, 1e-9, 'interpolated');
  const beats = []; for (let i = 0; i < 150; i++) beats.push({ t: i * 0.8, ibiMs: 800 + (i >= 60 ? 40 * (i % 2 ? 1 : -1) : 0) });
  const us = hrv.ultraShortRmssd(beats, 60);
  assert.ok(us.n >= 74 && us.n <= 76, `last 60 s holds ~75 beats (${us.n})`);
  close(us.rmssd, 80, 1e-6, 'ultra-short RMSSD of the alternating tail');
  const hist = [3.9, 4.0, 4.1, 3.95, 4.05, 4.0, 3.9].map((v, i) => ({ date: `d${i}`, lnRmssd: v }));
  const b = hrv.lnRmssdBaseline(hist, { date: 'today', lnRmssd: 3.6 });
  assert.ok(b.ok && b.status === 'below', `today below baseline (${b.status})`);
  assert.equal(hrv.lnRmssdBaseline(hist, { date: 'today', lnRmssd: 4.0 }).status, 'within');
  const full = hrv.analyzeHRV(modulated(0.25, 40, 200), { rmssdFloorMs: 10 });
  assert.ok(full.timeDomain.ok && full.frequencyDomain.ok && full.ans.ok && full.ans.experimental === true);
  assert.equal(full.meta.rmssdFloorMs, 10);
  console.log('[hrv misc] artifact correction, ultra-short, baseline, analyzeHRV: PASS');
}

console.log('\nALL HRV TESTS PASSED');
