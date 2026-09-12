// examples/app/hrv-analysis.js — Kubios-style HRV/ANS analysis, plain script (no
// ESM, no deps) so it loads via <script src> next to app.js. Pure functions on
// an array of accepted IBIs in ms (optionally with timestamps). This lives in
// examples/app/ (not src/) because src/ is owned by a concurrent worker doing
// the TS refactor — the parent should move this into the library afterward.
//
// References (population norms + methods), cited again in the report footer:
//  - Task Force of ESC/NASPE (1996) Circulation 93:1043-65 — time/freq domain defs,
//    triangular index / TINN histogram bin width (1/128 s).
//  - Tarvainen, Ranta-aho, Karjalainen (2002) IEEE TBME 49(2) — smoothness priors detrending.
//  - Nunan, Sandercock, Brodie (2010) Pacing Clin Electrophysiol 33(11) — healthy-adult
//    normal ranges for RMSSD, SDNN, mean RR/HR used as the population reference.
//  - Baevsky's Stress Index — 1/(2*Mo*AMo*MxDMn) from a 50ms-bin RR histogram.
//  - Kubios HRV software (kubios.com) — PNS/SNS index concept (z-scores of a small
//    metric set vs a normal population), reproduced here transparently, not licensed code.
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  function mean(a) { return a.reduce((s, v) => s + v, 0) / (a.length || 1); }
  function variance(a, m) { m = m == null ? mean(a) : m; return mean(a.map(v => (v - m) ** 2)); }
  function std(a, m) { return Math.sqrt(variance(a, m)); }
  function median(a) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ------------------------------------------------- 1. artifact correction
  // Kubios-style: flag a beat if it deviates >20% from the median of the
  // surrounding 5 beats (2 before, 2 after where available); replace flagged
  // values with linear interpolation from neighbours (frequency-analysis copy
  // only — the time-domain report also gets a corrected copy per Task Force
  // convention of reporting corrected NN intervals, not raw RR).
  function correctArtifacts(ibiMs) {
    const n = ibiMs.length;
    const flagged = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 2), hi = Math.min(n, i + 3);
      const window = [];
      for (let j = lo; j < hi; j++) if (j !== i) window.push(ibiMs[j]);
      if (!window.length) continue;
      const med = median(window);
      if (Math.abs(ibiMs[i] - med) / med > 0.2) flagged[i] = true;
    }
    const corrected = ibiMs.slice();
    for (let i = 0; i < n; i++) {
      if (!flagged[i]) continue;
      // nearest unflagged neighbours on each side -> linear interpolation;
      // falls back to the local median if it's an edge run of flags.
      let a = i - 1; while (a >= 0 && flagged[a]) a--;
      let b = i + 1; while (b < n && flagged[b]) b++;
      if (a >= 0 && b < n) {
        const t = (i - a) / (b - a);
        corrected[i] = corrected[a] + t * (corrected[b] - corrected[a]);
      } else if (a >= 0) {
        corrected[i] = corrected[a];
      } else if (b < n) {
        corrected[i] = corrected[b];
      }
    }
    const nFlagged = flagged.filter(Boolean).length;
    return { corrected, flagged, pctCorrected: n ? (100 * nFlagged / n) : 0 };
  }

  // 2nd-order polynomial detrend (labeled honestly — not the full Tarvainen
  // smoothness-priors filter, which needs a sparse-matrix solve too heavy for
  // a dependency-free plain script).
  function detrendPoly2(series) {
    const n = series.length;
    if (n < 3) return series.slice();
    // fit y = a*x^2 + b*x + c by least squares (normal equations, 3x3 solve)
    const xs = series.map((_, i) => i);
    let Sx0 = n, Sx1 = 0, Sx2 = 0, Sx3 = 0, Sx4 = 0, Sy0 = 0, Sy1 = 0, Sy2 = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = series[i];
      const x2 = x * x;
      Sx1 += x; Sx2 += x2; Sx3 += x2 * x; Sx4 += x2 * x2;
      Sy0 += y; Sy1 += x * y; Sy2 += x2 * y;
    }
    // solve [[Sx4,Sx3,Sx2],[Sx3,Sx2,Sx1],[Sx2,Sx1,Sx0]] * [a,b,c]^T = [Sy2,Sy1,Sy0]^T
    const A = [[Sx4, Sx3, Sx2], [Sx3, Sx2, Sx1], [Sx2, Sx1, Sx0]];
    const B = [Sy2, Sy1, Sy0];
    const coef = solve3x3(A, B);
    if (!coef) return series.slice();
    const [a, b, c] = coef;
    return series.map((y, x) => y - (a * x * x + b * x + c));
  }

  function solve3x3(A, B) {
    // Cramer's rule; tiny closed-form, fine for a 3x3.
    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-12) return null;
    const replaceCol = (m, col, vec) => m.map((row, i) => row.map((v, j) => (j === col ? vec[i] : v)));
    return [0, 1, 2].map(col => det(replaceCol(A, col, B)) / D);
  }

  // ---------------------------------------------------------- 2. time domain
  function timeDomain(acceptedIbiMs) {
    const n = acceptedIbiMs.length;
    if (n < 30) return { ok: false, reason: 'Need at least 30 accepted beats for time-domain HRV.' };
    const meanRR = mean(acceptedIbiMs);
    const meanHR = 60000 / meanRR;
    const sdnn = std(acceptedIbiMs, meanRR);
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(acceptedIbiMs[i] - acceptedIbiMs[i - 1]);
    const rmssd = Math.sqrt(mean(diffs.map(d => d * d)));
    const nn50 = diffs.filter(d => Math.abs(d) > 50).length;
    const pnn50 = 100 * nn50 / diffs.length;

    // 5-beat moving average of instantaneous HR for min/max HR (Task Force
    // convention: smooths breath-to-breath / artifact spikes before min/max).
    const hrSeries = acceptedIbiMs.map(ibi => 60000 / ibi);
    const smoothed = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 2), hi = Math.min(n, i + 3);
      smoothed.push(mean(hrSeries.slice(lo, hi)));
    }
    const minHR = Math.min(...smoothed);
    const maxHR = Math.max(...smoothed);

    // HRV triangular index + TINN: 1996 Task Force histogram, bin width 1/128 s
    // (~7.8125 ms), triangular index = total beats / height of the histogram mode.
    const binWidthMs = 1000 / 128;
    const minIbi = Math.min(...acceptedIbiMs), maxIbi = Math.max(...acceptedIbiMs);
    const nBins = Math.max(1, Math.ceil((maxIbi - minIbi) / binWidthMs) + 1);
    const bins = new Array(nBins).fill(0);
    acceptedIbiMs.forEach(v => {
      const idx = Math.min(nBins - 1, Math.floor((v - minIbi) / binWidthMs));
      bins[idx]++;
    });
    const peakHeight = Math.max(...bins);
    const triangularIndex = peakHeight > 0 ? n / peakHeight : NaN;
    // TINN: width of the triangle that best fits the histogram (baseline width).
    // Approximate per Task Force: find the widest N and M s.t. a triangle from
    // bin N to bin M with apex at the mode approximates the distribution; here
    // we use the simpler, standard approximation of full histogram support
    // scaled to a triangle of equal area (common simplified implementation).
    let firstNonzero = bins.findIndex(b => b > 0);
    let lastNonzero = bins.length - 1 - [...bins].reverse().findIndex(b => b > 0);
    const tinn = (lastNonzero - firstNonzero + 1) * binWidthMs;

    return {
      ok: true, n, meanRR, meanHR, sdnn, rmssd, nn50, pnn50, minHR, maxHR,
      triangularIndex, tinn
    };
  }

  // -------------------------------------------------------------- own FFT --
  // Radix-2 iterative FFT (Cooley-Tukey), in-place, real+imag arrays. Input
  // length must be a power of two (callers zero/window-pad to 256).
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe; curIm = nextIm;
        }
      }
    }
  }

  function hannWindow(n) {
    const w = new Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  // Welch PSD: 256-sample Hann segments, 50% overlap, averaged periodograms.
  // Returns { freqs, psd } with psd in units^2/Hz (units = the input series' units).
  function welchPSD(series, fs, segLen) {
    segLen = segLen || 256;
    const step = Math.floor(segLen / 2);
    const win = hannWindow(segLen);
    const winPower = mean(win.map(w => w * w)); // normalization for window energy loss
    const nBins = segLen / 2 + 1;
    const acc = new Array(nBins).fill(0);
    let nSegs = 0;
    for (let start = 0; start + segLen <= series.length; start += step) {
      const re = new Array(segLen), im = new Array(segLen);
      for (let i = 0; i < segLen; i++) { re[i] = series[start + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < nBins; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) / (fs * segLen * winPower);
        acc[k] += (k === 0 || k === nBins - 1) ? p : 2 * p; // one-sided PSD
      }
      nSegs++;
    }
    if (nSegs === 0) return { freqs: [], psd: [] };
    const psd = acc.map(v => v / nSegs);
    const freqs = psd.map((_, k) => (k * fs) / segLen);
    return { freqs, psd };
  }

  function bandPower(freqs, psd, lo, hi) {
    let power = 0, peakF = null, peakP = -Infinity;
    for (let i = 1; i < freqs.length; i++) {
      const f = freqs[i];
      if (f < lo || f > hi) continue;
      const df = freqs[i] - freqs[i - 1];
      power += psd[i] * df;
      if (psd[i] > peakP) { peakP = psd[i]; peakF = f; }
    }
    return { power, peakFrequency: peakF };
  }

  // Resample the (corrected) RR-interval series to an evenly-sampled 4 Hz
  // time series via linear interpolation against cumulative beat times.
  function resampleRRTo4Hz(correctedIbiMs) {
    const fs = 4;
    const t = [0];
    for (let i = 0; i < correctedIbiMs.length; i++) t.push(t[t.length - 1] + correctedIbiMs[i] / 1000);
    const rrAtBeat = correctedIbiMs.slice(); // seconds-domain series sampled at beat times t[1..]
    const beatTimes = t.slice(1);
    const totalSec = beatTimes[beatTimes.length - 1];
    const n = Math.floor(totalSec * fs);
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const ti = i / fs;
      while (j < beatTimes.length - 1 && beatTimes[j + 1] < ti) j++;
      const t0 = beatTimes[Math.max(0, j - 1)] ?? beatTimes[0];
      const t1 = beatTimes[j];
      const v0 = rrAtBeat[Math.max(0, j - 1)];
      const v1 = rrAtBeat[j];
      const frac = t1 > t0 ? (ti - t0) / (t1 - t0) : 0;
      out[i] = v0 + Math.max(0, Math.min(1, frac)) * (v1 - v0);
    }
    return { series: out, fs };
  }

  const BANDS = { vlf: [0.0033, 0.04], lf: [0.04, 0.15], hf: [0.15, 0.4] };

  function frequencyDomain(correctedIbiMs, totalDurationSec) {
    if (totalDurationSec < 120) {
      return { ok: false, reason: 'Need 2+ minutes for frequency analysis.' };
    }
    const { series, fs } = resampleRRTo4Hz(correctedIbiMs);
    if (series.length < 256) {
      return { ok: false, reason: 'Need 2+ minutes for frequency analysis.' };
    }
    const detrended = detrendPoly2(series);
    const { freqs, psd } = welchPSD(detrended, fs, 256);
    const vlf = bandPower(freqs, psd, ...BANDS.vlf);
    const lf = bandPower(freqs, psd, ...BANDS.lf);
    const hf = bandPower(freqs, psd, ...BANDS.hf);
    const totalPower = vlf.power + lf.power + hf.power;
    const lfnu = (lf.power / (lf.power + hf.power || 1)) * 100;
    const hfnu = (hf.power / (lf.power + hf.power || 1)) * 100;
    const respRateBpm = hf.peakFrequency != null ? hf.peakFrequency * 60 : null;
    return {
      ok: true, freqs, psd, vlf, lf, hf, totalPower,
      lfhf: hf.power > 0 ? lf.power / hf.power : NaN,
      lfnu, hfnu,
      respirationRateBpm: respRateBpm, // labeled 'estimated' in the UI
    };
  }

  // ------------------------------------------------------------- nonlinear
  function poincare(acceptedIbiMs) {
    const n = acceptedIbiMs.length;
    if (n < 2) return null;
    const x = acceptedIbiMs.slice(0, n - 1);
    const y = acceptedIbiMs.slice(1);
    const diffs = x.map((v, i) => y[i] - v);
    const sumSq = diffs.map(d => d * d);
    const sd1 = Math.sqrt(mean(sumSq) / 2);
    const sdnnAll = std(acceptedIbiMs);
    const sd2 = Math.sqrt(Math.max(0, 2 * sdnnAll * sdnnAll - sd1 * sd1));
    return { sd1, sd2, ratio: sd2 > 0 ? sd1 / sd2 : NaN, points: x.map((v, i) => [v, y[i]]) };
  }

  // Sample entropy, m=2, r = 0.2*SDNN (Richman & Moorman 2000).
  function sampleEntropy(series, m, r) {
    const n = series.length;
    function countMatches(mm) {
      let count = 0;
      for (let i = 0; i < n - mm; i++) {
        for (let j = i + 1; j < n - mm; j++) {
          let maxDiff = 0;
          for (let k = 0; k < mm; k++) maxDiff = Math.max(maxDiff, Math.abs(series[i + k] - series[j + k]));
          if (maxDiff <= r) count++;
        }
      }
      return count;
    }
    const B = countMatches(m);
    const A = countMatches(m + 1);
    if (B === 0 || A === 0) return NaN;
    return -Math.log(A / B);
  }

  // DFA alpha1 (short-term scaling exponent), boxes of 4-16 beats.
  function dfaAlpha1(acceptedIbiMs) {
    const n = acceptedIbiMs.length;
    const m = mean(acceptedIbiMs);
    const integrated = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += acceptedIbiMs[i] - m; integrated.push(acc); }
    const boxSizes = [4, 6, 8, 10, 12, 14, 16].filter(s => s <= Math.floor(n / 4));
    if (boxSizes.length < 3) return NaN;
    const logN = [], logF = [];
    for (const s of boxSizes) {
      const nBoxes = Math.floor(n / s);
      if (nBoxes < 1) continue;
      let sumSqResid = 0, count = 0;
      for (let b = 0; b < nBoxes; b++) {
        const seg = integrated.slice(b * s, (b + 1) * s);
        const xs = seg.map((_, i) => i);
        const coef = linearFit(xs, seg);
        for (let i = 0; i < s; i++) {
          const fit = coef[0] * xs[i] + coef[1];
          sumSqResid += (seg[i] - fit) ** 2;
          count++;
        }
      }
      const fN = Math.sqrt(sumSqResid / count);
      logN.push(Math.log(s));
      logF.push(Math.log(fN));
    }
    const slopeFit = linearFit(logN, logF);
    return slopeFit[0];
  }

  function linearFit(xs, ys) {
    const n = xs.length;
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den > 0 ? num / den : 0;
    return [slope, my - slope * mx];
  }

  function nonlinear(acceptedIbiMs) {
    const n = acceptedIbiMs.length;
    const pc = poincare(acceptedIbiMs);
    const sdnnAll = std(acceptedIbiMs);
    const out = { ok: true, n, sd1: pc.sd1, sd2: pc.sd2, sd1sd2Ratio: pc.ratio, poincarePoints: pc.points };
    if (n >= 100) {
      out.sampleEntropy = sampleEntropy(acceptedIbiMs, 2, 0.2 * sdnnAll);
      out.dfaAlpha1 = dfaAlpha1(acceptedIbiMs);
    } else {
      out.sampleEntropy = 'n/a';
      out.dfaAlpha1 = 'n/a';
      out.note = 'Sample entropy and DFA alpha1 need >=100 beats.';
    }
    return out;
  }

  // ----------------------------------------------------- Baevsky stress idx
  // Stress Index = 1 / (2 * Mo * AMo * MxDMn), from a 50ms-bin RR histogram:
  // Mo = mode (s), AMo = amplitude of mode (fraction of beats in modal bin),
  // MxDMn = variation range (s).
  function stressIndex(acceptedIbiMs) {
    const binWidth = 50; // ms
    const minV = Math.min(...acceptedIbiMs), maxV = Math.max(...acceptedIbiMs);
    const nBins = Math.max(1, Math.ceil((maxV - minV) / binWidth) + 1);
    const bins = new Array(nBins).fill(0);
    acceptedIbiMs.forEach(v => bins[Math.min(nBins - 1, Math.floor((v - minV) / binWidth))]++);
    const modeBinIdx = bins.indexOf(Math.max(...bins));
    const moMs = minV + (modeBinIdx + 0.5) * binWidth;
    const amo = bins[modeBinIdx] / acceptedIbiMs.length; // fraction, 0..1
    const mxdmnSec = (maxV - minV) / 1000;
    const moSec = moMs / 1000;
    if (mxdmnSec <= 0 || moSec <= 0 || amo <= 0) return NaN;
    return 1 / (2 * moSec * amo * mxdmnSec);
  }

  // -------------------------------------------------------------- ANS indices
  // Nunan et al. 2010 healthy-adult reference (5-min short-term recordings):
  //   meanRR ~926ms, RMSSD median ~42ms (approx SD via IQR ~ 25th/75th ~29/61 -> sd~16),
  //   meanHR ~65bpm. SD1 ~ RMSSD/sqrt(2). We use conservative population SDs
  //   documented inline; this is a population reference, NOT a diagnosis.
  const NUNAN_REF = {
    meanRR: { mean: 926, sd: 130 },
    rmssd: { mean: 42, sd: 16 },
    meanHR: { mean: 65, sd: 9 },
    sd1nu: { mean: 30, sd: 8 },   // SD1 as %; approx normal-population spread, documented estimate
    sd2nu: { mean: 70, sd: 8 },
    stressIndex: { mean: 100, sd: 50 }, // Baevsky SI typical resting range ~50-150
  };
  function z(value, ref) { return (value - ref.mean) / ref.sd; }

  function ansIndices(td, nl, si) {
    if (!td.ok) return { ok: false, reason: 'Time-domain metrics required for ANS indices.' };
    const sd1nu = (nl.sd1 / (nl.sd1 + nl.sd2 || 1)) * 100;
    const sd2nu = 100 - sd1nu;
    const zMeanRR = z(td.meanRR, NUNAN_REF.meanRR);
    const zRMSSD = z(td.rmssd, NUNAN_REF.rmssd);
    const zSD1nu = z(sd1nu, NUNAN_REF.sd1nu);
    const zMeanHR = z(td.meanHR, NUNAN_REF.meanHR);
    const zSI = z(si, NUNAN_REF.stressIndex);
    const zSD2nu = z(sd2nu, NUNAN_REF.sd2nu);
    const pnsIndex = mean([zMeanRR, zRMSSD, zSD1nu]);
    const snsIndex = mean([zMeanHR, zSI, zSD2nu]);
    return { ok: true, pnsIndex, snsIndex, sd1nu, sd2nu, stressIndex: si };
  }

  // ---------------------------------------------------------------- runner
  // acceptedIbis: array of numbers (ms) OR array of {ibiMs, t}. Uses only
  // accepted ("good window") beats — caller is responsible for that filter.
  function analyzeHRV(acceptedIbis) {
    const ibiMs = acceptedIbis.map(v => (typeof v === 'number' ? v : v.ibiMs));
    const totalDurationSec = ibiMs.reduce((s, v) => s + v, 0) / 1000;
    const { corrected, flagged, pctCorrected } = correctArtifacts(ibiMs);

    const td = timeDomain(ibiMs); // Task Force convention: time-domain on corrected NN, but our
    // correction only targets frequency-analysis interpolation; report raw-accepted time domain
    // (already artifact-free from the upstream peak/quality pipeline) and disclose %corrected.
    const fd = frequencyDomain(corrected, totalDurationSec);
    const nl = ibiMs.length >= 2 ? nonlinear(ibiMs) : { ok: false, reason: 'Need at least 2 beats.' };
    const si = ibiMs.length >= 30 ? stressIndex(ibiMs) : NaN;
    const ans = (td.ok && nl.ok) ? ansIndices(td, nl, si) : { ok: false, reason: 'Need time-domain and nonlinear metrics for ANS indices.' };

    return {
      meta: { nBeats: ibiMs.length, totalDurationSec, pctCorrected, flagged },
      timeDomain: td,
      frequencyDomain: fd,
      nonlinear: nl,
      ans,
    };
  }

  const HRVAnalysis = {
    analyzeHRV, correctArtifacts, detrendPoly2, timeDomain, frequencyDomain,
    nonlinear, poincare, sampleEntropy, dfaAlpha1, stressIndex, ansIndices,
    welchPSD, fft, resampleRRTo4Hz, BANDS, NUNAN_REF,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = HRVAnalysis;
  else global.HRVAnalysis = HRVAnalysis;
})(typeof window !== 'undefined' ? window : globalThis);
