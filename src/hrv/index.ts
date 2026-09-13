/**
 * HRV / pulse-rate-variability analysis on an array of inter-beat intervals.
 * Pure functions, no DOM. Works with intervals from this library's camera
 * pipeline, a Bluetooth chest strap, or any other RR source.
 *
 * Naming: what a camera measures is pulse rate variability (PRV). At rest
 * PRV tracks HRV closely; under posture or temperature changes the two can
 * diverge (Schafer & Vagedes 2013; Mejia-Mejia et al. 2020). The functions
 * here are named after the conventional HRV metrics because that is what
 * every reference and every consumer calls them.
 *
 * References: Task Force ESC/NASPE 1996 (definitions, TINN, triangular
 * index); Baevsky & Chernikova 2017 (stress index); Kubios HRV user guide
 * (sqrt stress index, PNS/SNS index construction); Nunan et al. 2010
 * (short-term normal values); Richman & Moorman 2000 (sample entropy);
 * Peng et al. 1995 (DFA); Esco & Flatt 2014 (ultra-short RMSSD); Plews
 * et al. 2013 (lnRMSSD rolling baseline and smallest worthwhile change);
 * Lehrer & Gevirtz 2014 (resonance/coherence biofeedback).
 */
import { computeFFT } from '../core/fft.js';
import { resampleToGrid } from '../core/filter.js';

export interface Beat {
  /** Interval ending at this beat, ms. */
  ibiMs: number;
  /** Beat time in seconds (any origin). Enables correct gap handling. */
  t?: number;
}

export type BeatInput = number[] | Beat[];

function toBeats(input: BeatInput): Beat[] {
  if (!input.length) return [];
  if (typeof input[0] === 'number') return (input as number[]).map(v => ({ ibiMs: v }));
  return (input as Beat[]).map(b => ({ ibiMs: b.ibiMs, t: b.t }));
}

/** Beat times in seconds: recorded times when present, else cumulative intervals. */
export function beatTimes(input: BeatInput): { t: number[]; ibiMs: number[] } {
  const beats = toBeats(input);
  const ibiMs = beats.map(b => b.ibiMs);
  const hasT = beats.every(b => typeof b.t === 'number' && Number.isFinite(b.t));
  const t: number[] = [];
  if (hasT) {
    for (const b of beats) t.push(b.t as number);
  } else {
    let acc = 0;
    for (const b of beats) { acc += b.ibiMs / 1000; t.push(acc); }
  }
  return { t, ibiMs };
}

// ---------------------------------------------------------------- helpers
export function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : NaN;
}
/** Sample standard deviation (n - 1). */
export function std(a: ArrayLike<number>, m = mean(a)): number {
  if (a.length < 2) return NaN;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}
export function median(a: ArrayLike<number>): number {
  if (!a.length) return NaN;
  const s = Array.from(a as ArrayLike<number>).sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ------------------------------------------------- artifact correction
export interface ArtifactCorrection {
  corrected: number[];
  flagged: boolean[];
  pctCorrected: number;
}

/**
 * Flag intervals deviating more than `threshold` (fraction) from the median
 * of their four neighbours and replace them by linear interpolation
 * between the nearest unflagged neighbours.
 */
export function correctArtifacts(ibiMs: number[], threshold = 0.2): ArtifactCorrection {
  const n = ibiMs.length;
  const flagged = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(n, i + 3);
    const window: number[] = [];
    for (let j = lo; j < hi; j++) if (j !== i) window.push(ibiMs[j]);
    if (!window.length) continue;
    const med = median(window);
    if (med > 0 && Math.abs(ibiMs[i] - med) / med > threshold) flagged[i] = true;
  }
  const corrected = ibiMs.slice();
  for (let i = 0; i < n; i++) {
    if (!flagged[i]) continue;
    let a = i - 1; while (a >= 0 && flagged[a]) a--;
    let b = i + 1; while (b < n && flagged[b]) b++;
    if (a >= 0 && b < n) corrected[i] = ibiMs[a] + ((i - a) / (b - a)) * (ibiMs[b] - ibiMs[a]);
    else if (a >= 0) corrected[i] = ibiMs[a];
    else if (b < n) corrected[i] = ibiMs[b];
  }
  const nFlagged = flagged.filter(Boolean).length;
  return { corrected, flagged, pctCorrected: n ? (100 * nFlagged) / n : 0 };
}

// ---------------------------------------------------------- time domain
export interface TimeDomainResult {
  ok: boolean;
  reason?: string;
  n: number;
  durationSec: number;
  meanRR: number;
  meanHR: number;
  sdnn: number;
  rmssd: number;
  lnRmssd: number;
  nn50: number;
  pnn50: number;
  minHR: number;
  maxHR: number;
  triangularIndex: number;
  /** Task Force TINN: base width (ms) of the least-squares triangle fitted to the 1/128 s histogram. */
  tinn: number;
  /** max - min interval, ms (what a naive "TINN" often is). */
  rrRange: number;
}

export function timeDomain(input: BeatInput, opts: { minBeats?: number } = {}): TimeDomainResult {
  const { t, ibiMs } = beatTimes(input);
  const n = ibiMs.length;
  const minBeats = opts.minBeats ?? 30;
  const durationSec = n ? (t.length > 1 ? t[n - 1] - t[0] + ibiMs[0] / 1000 : ibiMs[0] / 1000) : 0;
  const empty: TimeDomainResult = {
    ok: false, n, durationSec, meanRR: NaN, meanHR: NaN, sdnn: NaN, rmssd: NaN, lnRmssd: NaN, nn50: 0, pnn50: NaN,
    minHR: NaN, maxHR: NaN, triangularIndex: NaN, tinn: NaN, rrRange: NaN
  };
  if (n < minBeats) return { ...empty, reason: `Need at least ${minBeats} accepted beats for time-domain HRV (have ${n}).` };

  const meanRR = mean(ibiMs);
  const meanHR = 60000 / meanRR;
  const sdnnV = std(ibiMs, meanRR);
  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(ibiMs[i] - ibiMs[i - 1]);
  const rmssdV = Math.sqrt(mean(diffs.map(d => d * d)));
  const nn50 = diffs.filter(d => Math.abs(d) > 50).length;
  const pnn50 = (100 * nn50) / diffs.length;

  // 5-beat moving average of instantaneous HR for min/max.
  const hr = ibiMs.map(v => 60000 / v);
  let minHR = Infinity, maxHR = -Infinity;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(n, i + 3);
    const m = mean(hr.slice(lo, hi));
    if (m < minHR) minHR = m;
    if (m > maxHR) maxHR = m;
  }

  const { triangularIndex, tinn } = triangularMetrics(ibiMs);
  const rrRange = Math.max(...ibiMs) - Math.min(...ibiMs);

  return {
    ok: true, n, durationSec, meanRR, meanHR, sdnn: sdnnV, rmssd: rmssdV, lnRmssd: Math.log(Math.max(rmssdV, 0.01)),
    nn50, pnn50, minHR, maxHR, triangularIndex, tinn, rrRange
  };
}

/**
 * HRV triangular index and TINN from the 1/128 s (7.8125 ms) histogram.
 * TINN is the baseline width of the triangle with apex at the histogram
 * mode that minimises the squared error to the histogram (Task Force 1996).
 */
export function triangularMetrics(ibiMs: number[]): { triangularIndex: number; tinn: number; binWidthMs: number } {
  const binWidthMs = 1000 / 128;
  const n = ibiMs.length;
  if (n < 2) return { triangularIndex: NaN, tinn: NaN, binWidthMs };
  const minV = Math.min(...ibiMs), maxV = Math.max(...ibiMs);
  const nBins = Math.max(1, Math.ceil((maxV - minV) / binWidthMs) + 1);
  const bins = new Array<number>(nBins).fill(0);
  for (const v of ibiMs) bins[Math.min(nBins - 1, Math.floor((v - minV) / binWidthMs))]++;
  let modeIdx = 0;
  for (let i = 1; i < nBins; i++) if (bins[i] > bins[modeIdx]) modeIdx = i;
  const Y = bins[modeIdx];
  const triangularIndex = Y > 0 ? n / Y : NaN;

  // Search N (< mode) and M (> mode) minimising sum over all bins of
  // (histogram - triangle)^2, triangle = 0 outside [N, M], linear to Y at mode.
  let bestErr = Infinity, bestN = 0, bestM = nBins - 1;
  const maxSpan = nBins + 2;
  for (let N = Math.max(-maxSpan, modeIdx - maxSpan); N < modeIdx; N++) {
    for (let M = modeIdx + 1; M <= Math.min(nBins - 1 + maxSpan, modeIdx + maxSpan); M++) {
      let err = 0;
      for (let i = 0; i < nBins; i++) {
        let tri = 0;
        if (i > N && i < modeIdx) tri = (Y * (i - N)) / (modeIdx - N);
        else if (i === modeIdx) tri = Y;
        else if (i > modeIdx && i < M) tri = (Y * (M - i)) / (M - modeIdx);
        err += (bins[i] - tri) ** 2;
      }
      if (err < bestErr) { bestErr = err; bestN = N; bestM = M; }
    }
  }
  return { triangularIndex, tinn: (bestM - bestN) * binWidthMs, binWidthMs };
}

// ----------------------------------------------------- frequency domain
export const BANDS = { vlf: [0.0033, 0.04] as const, lf: [0.04, 0.15] as const, hf: [0.15, 0.4] as const };

export interface BandPower { power: number; peakFrequency: number | null; }

export interface FrequencyDomainResult {
  ok: boolean;
  reason?: string;
  durationSec: number;
  /** True when the recording is shorter than the 2 min the Task Force recommends for LF/HF. */
  ultraShort: boolean;
  fs: number;
  segmentLengthSec: number;
  segments: number;
  freqs: number[];
  psd: number[];
  /** null when the recording is shorter than 5 min (VLF is not interpretable). */
  vlf: BandPower | null;
  lf: BandPower;
  hf: BandPower;
  totalPower: number;
  lfhf: number;
  lfnu: number;
  hfnu: number;
  /** Peak HF frequency in breaths/min (respiratory sinus arrhythmia), if a peak exists. */
  respirationRateBpm: number | null;
  /** Resonance/coherence score: power within +-0.015 Hz of the 0.04-0.26 Hz peak over total 0.0033-0.4 Hz power (0-1). */
  coherence: number;
  gapFraction: number;
  /**
   * True when an independently measured breathing rate (`respirationRateBpm`
   * option) is below 9 breaths/min (0.15 Hz): respiratory sinus arrhythmia
   * then lands in the LF band, so LF, LF n.u. and LF/HF reflect breathing,
   * not sympathetic tone (Task Force 1996; Shaffer & Ginsberg 2017). null
   * when no breathing rate was supplied.
   */
  respirationInLf: boolean | null;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Welch PSD: Hann segments, 50% overlap, one-sided, units^2/Hz. */
export function welchPSD(series: ArrayLike<number>, fs: number, segLen = 256): { freqs: number[]; psd: number[]; segments: number } {
  const step = Math.floor(segLen / 2);
  const win = hann(segLen);
  let winPower = 0;
  for (let i = 0; i < segLen; i++) winPower += win[i] * win[i];
  winPower /= segLen;
  const nBins = segLen / 2 + 1;
  const acc = new Array<number>(nBins).fill(0);
  let nSegs = 0;
  for (let start = 0; start + segLen <= series.length; start += step) {
    const seg = new Float64Array(segLen);
    let m = 0;
    for (let i = 0; i < segLen; i++) m += series[start + i];
    m /= segLen;
    for (let i = 0; i < segLen; i++) seg[i] = (series[start + i] - m) * win[i];
    // computeFFT applies its own Hann + mean removal; feed a rectangular
    // fft by using the raw transform helper via a zero-padded call instead.
    const spec = rawSpectrum(seg);
    for (let k = 0; k < nBins; k++) {
      const p = spec[k] / (fs * segLen * winPower);
      acc[k] += k === 0 || k === nBins - 1 ? p : 2 * p;
    }
    nSegs++;
  }
  if (nSegs === 0) return { freqs: [], psd: [], segments: 0 };
  const psd = acc.map(v => v / nSegs);
  const freqs = psd.map((_, k) => (k * fs) / segLen);
  return { freqs, psd, segments: nSegs };
}

/** |X[k]|^2 of a real sequence (length power of two), no window. */
function rawSpectrum(x: Float64Array): Float64Array {
  const n = x.length;
  const re = Float64Array.from(x), im = new Float64Array(n);
  // in-place radix-2 (same as core/fft.ts, duplicated to keep that module's
  // windowing semantics intact)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + half], xi = im[i + k + half];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nr = cr * wr - ci * wi, ni = cr * wi + ci * wr; cr = nr; ci = ni;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

export function bandPower(freqs: number[], psd: number[], lo: number, hi: number): BandPower {
  let power = 0, peakF: number | null = null, peakP = -Infinity;
  for (let i = 1; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < lo || f > hi) continue;
    const df = freqs[i] - freqs[i - 1];
    power += psd[i] * df;
    if (psd[i] > peakP) { peakP = psd[i]; peakF = f; }
  }
  return { power, peakFrequency: peakF };
}

/**
 * Resample the RR series onto a uniform grid using real beat times. Gaps
 * (missing beats) longer than `maxGapSec` are reported; the series is
 * linearly bridged across them (the caller decides whether the gap
 * fraction is acceptable).
 */
export function resampleRR(input: BeatInput, fs = 4, maxGapSec = 2.5): { series: Float64Array; fs: number; durationSec: number; gapFraction: number } {
  const { t, ibiMs } = beatTimes(input);
  const n = t.length;
  if (n < 2) return { series: new Float64Array(0), fs, durationSec: 0, gapFraction: 0 };
  let gapSec = 0;
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > maxGapSec) gapSec += dt - ibiMs[i] / 1000;
  }
  const durationSec = t[n - 1] - t[0];
  const count = Math.floor(durationSec * fs) + 1;
  const series = resampleToGrid(t, ibiMs, t[0], 1 / fs, count);
  return { series, fs, durationSec, gapFraction: durationSec > 0 ? gapSec / durationSec : 0 };
}

/** 2nd-order polynomial detrend. */
export function detrendPoly2(series: ArrayLike<number>): Float64Array {
  const n = series.length;
  const out = new Float64Array(n);
  if (n < 3) { for (let i = 0; i < n; i++) out[i] = series[i]; return out; }
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i, y = series[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; y0 += y; y1 += x * y; y2 += x2 * y;
  }
  const A = [[s4, s3, s2], [s3, s2, s1], [s2, s1, n]];
  const B = [y2, y1, y0];
  const det3 = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(A);
  if (Math.abs(D) < 1e-12) { for (let i = 0; i < n; i++) out[i] = series[i]; return out; }
  const col = (c: number): number[][] => A.map((row, i) => row.map((v, j) => (j === c ? B[i] : v)));
  const [a, b, c] = [0, 1, 2].map(k => det3(col(k)) / D);
  for (let i = 0; i < n; i++) out[i] = series[i] - (a * i * i + b * i + c);
  return out;
}

export function frequencyDomain(input: BeatInput, opts: { minDurationSec?: number; maxGapFraction?: number; correctArtifacts?: boolean; respirationRateBpm?: number } = {}): FrequencyDomainResult {
  const respirationInLf = opts.respirationRateBpm != null && Number.isFinite(opts.respirationRateBpm) ? opts.respirationRateBpm / 60 < BANDS.hf[0] : null;
  const minDuration = opts.minDurationSec ?? 60;
  const maxGap = opts.maxGapFraction ?? 0.2;
  const beats = toBeats(input);
  const corrected = opts.correctArtifacts === false ? beats : (() => {
    const c = correctArtifacts(beats.map(b => b.ibiMs));
    return beats.map((b, i) => ({ ...b, ibiMs: c.corrected[i] }));
  })();
  const { series, fs, durationSec, gapFraction } = resampleRR(corrected);
  const base: FrequencyDomainResult = {
    ok: false, durationSec, ultraShort: durationSec < 120, fs, segmentLengthSec: 0, segments: 0, freqs: [], psd: [], vlf: null,
    lf: { power: NaN, peakFrequency: null }, hf: { power: NaN, peakFrequency: null }, totalPower: NaN, lfhf: NaN, lfnu: NaN, hfnu: NaN,
    respirationRateBpm: null, coherence: NaN, gapFraction, respirationInLf
  };
  if (durationSec < minDuration) return { ...base, reason: `Need at least ${minDuration} s of beats for frequency analysis (have ${durationSec.toFixed(0)} s).` };
  if (gapFraction > maxGap) return { ...base, reason: `Too many gaps between accepted beats (${(gapFraction * 100).toFixed(0)}% of the recording).` };
  const segLen = series.length >= 512 ? 256 : 128;
  if (series.length < segLen) return { ...base, reason: 'Not enough samples for spectral analysis.' };
  const detrended = detrendPoly2(series);
  const { freqs, psd, segments } = welchPSD(detrended, fs, segLen);
  const vlf = durationSec >= 300 ? bandPower(freqs, psd, BANDS.vlf[0], BANDS.vlf[1]) : null;
  const lf = bandPower(freqs, psd, BANDS.lf[0], BANDS.lf[1]);
  const hf = bandPower(freqs, psd, BANDS.hf[0], BANDS.hf[1]);
  const totalPower = (vlf ? vlf.power : 0) + lf.power + hf.power;
  const lfnu = (lf.power / (lf.power + hf.power || 1)) * 100;
  const hfnu = (hf.power / (lf.power + hf.power || 1)) * 100;

  // Coherence: peak in 0.04-0.26 Hz, +-0.015 Hz window, over total 0.0033-0.4 Hz power.
  const total = bandPower(freqs, psd, 0.0033, 0.4).power;
  const res = bandPower(freqs, psd, 0.04, 0.26);
  const coherence = res.peakFrequency != null && total > 0 ? bandPower(freqs, psd, res.peakFrequency - 0.015, res.peakFrequency + 0.015).power / total : NaN;

  return {
    ...base, ok: true, segmentLengthSec: segLen / fs, segments, freqs, psd, vlf, lf, hf, totalPower,
    lfhf: hf.power > 0 ? lf.power / hf.power : NaN, lfnu, hfnu,
    respirationRateBpm: hf.peakFrequency != null ? hf.peakFrequency * 60 : null,
    coherence
  };
}

// ------------------------------------------------------------- nonlinear
export interface PoincareResult { sd1: number; sd2: number; ratio: number; points: Array<[number, number]>; }

export function poincare(ibiMs: number[]): PoincareResult | null {
  const n = ibiMs.length;
  if (n < 2) return null;
  const x = ibiMs.slice(0, n - 1), y = ibiMs.slice(1);
  const diffs = x.map((v, i) => y[i] - v);
  const sd1 = Math.sqrt(mean(diffs.map(d => d * d)) / 2);
  const sdnnAll = std(ibiMs);
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnnAll * sdnnAll - sd1 * sd1));
  return { sd1, sd2, ratio: sd2 > 0 ? sd1 / sd2 : NaN, points: x.map((v, i) => [v, y[i]] as [number, number]) };
}

/** Sample entropy SampEn(m, r) (Richman & Moorman 2000): N - m templates for both lengths. */
export function sampleEntropy(series: ArrayLike<number>, m = 2, r?: number): number {
  const n = series.length;
  const tol = r ?? 0.2 * std(series);
  if (n <= m + 1 || !(tol > 0)) return NaN;
  let B = 0, A = 0;
  const templates = n - m;
  for (let i = 0; i < templates; i++) {
    for (let j = i + 1; j < templates; j++) {
      let match = true;
      for (let k = 0; k < m; k++) if (Math.abs(series[i + k] - series[j + k]) > tol) { match = false; break; }
      if (!match) continue;
      B++;
      if (Math.abs(series[i + m] - series[j + m]) <= tol) A++;
    }
  }
  if (B === 0 || A === 0) return NaN;
  return -Math.log(A / B);
}

function linearFit(xs: number[], ys: number[]): [number, number] {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : 0;
  return [slope, my - slope * mx];
}

/** DFA short-term scaling exponent alpha1 (boxes of 4-16 beats). */
export function dfaAlpha1(ibiMs: number[]): number {
  const n = ibiMs.length;
  if (n < 64) return NaN;
  const m = mean(ibiMs);
  const integrated: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += ibiMs[i] - m; integrated.push(acc); }
  const boxSizes = [4, 5, 6, 7, 8, 10, 12, 14, 16].filter(s => s <= Math.floor(n / 4));
  if (boxSizes.length < 3) return NaN;
  const logN: number[] = [], logF: number[] = [];
  for (const s of boxSizes) {
    const nBoxes = Math.floor(n / s);
    let ss = 0, count = 0;
    for (let b = 0; b < nBoxes; b++) {
      const seg = integrated.slice(b * s, (b + 1) * s);
      const xs = seg.map((_, i) => i);
      const [slope, icpt] = linearFit(xs, seg);
      for (let i = 0; i < s; i++) { ss += (seg[i] - (slope * i + icpt)) ** 2; count++; }
    }
    logN.push(Math.log(s));
    logF.push(Math.log(Math.sqrt(ss / count)));
  }
  return linearFit(logN, logF)[0];
}

export interface NonlinearResult {
  ok: boolean;
  n: number;
  sd1: number;
  sd2: number;
  sd1sd2Ratio: number;
  poincarePoints: Array<[number, number]>;
  sampleEntropy: number;
  dfaAlpha1: number;
  note?: string;
}

export function nonlinear(ibiMs: number[]): NonlinearResult {
  const pc = poincare(ibiMs);
  if (!pc) return { ok: false, n: ibiMs.length, sd1: NaN, sd2: NaN, sd1sd2Ratio: NaN, poincarePoints: [], sampleEntropy: NaN, dfaAlpha1: NaN, note: 'Need at least 2 beats.' };
  const out: NonlinearResult = { ok: true, n: ibiMs.length, sd1: pc.sd1, sd2: pc.sd2, sd1sd2Ratio: pc.ratio, poincarePoints: pc.points, sampleEntropy: NaN, dfaAlpha1: NaN };
  if (ibiMs.length >= 100) {
    out.sampleEntropy = sampleEntropy(ibiMs, 2, 0.2 * std(ibiMs));
    out.dfaAlpha1 = dfaAlpha1(ibiMs);
  } else {
    out.note = 'Sample entropy and DFA alpha1 need at least 100 beats.';
  }
  return out;
}

// ----------------------------------------------------- Baevsky stress idx
export interface StressIndexResult {
  /** Baevsky SI = AMo(%) / (2 * Mo(s) * MxDMn(s)). */
  baevsky: number;
  /** sqrt(SI), the transformed form Kubios reports (normal roughly 7-12). */
  sqrt: number;
  modeMs: number;
  amoPercent: number;
  mxdmnMs: number;
}

export function stressIndex(ibiMs: number[], binWidthMs = 50): StressIndexResult {
  const n = ibiMs.length;
  const nan = { baevsky: NaN, sqrt: NaN, modeMs: NaN, amoPercent: NaN, mxdmnMs: NaN };
  if (n < 2) return nan;
  const minV = Math.min(...ibiMs), maxV = Math.max(...ibiMs);
  const nBins = Math.max(1, Math.ceil((maxV - minV) / binWidthMs) + 1);
  const bins = new Array<number>(nBins).fill(0);
  for (const v of ibiMs) bins[Math.min(nBins - 1, Math.floor((v - minV) / binWidthMs))]++;
  let modeIdx = 0;
  for (let i = 1; i < nBins; i++) if (bins[i] > bins[modeIdx]) modeIdx = i;
  const modeMs = minV + (modeIdx + 0.5) * binWidthMs;
  const amoPercent = (100 * bins[modeIdx]) / n;
  const mxdmnMs = maxV - minV;
  if (!(mxdmnMs > 0) || !(modeMs > 0)) return { ...nan, modeMs, amoPercent, mxdmnMs };
  const baevsky = amoPercent / (2 * (modeMs / 1000) * (mxdmnMs / 1000));
  return { baevsky, sqrt: Math.sqrt(baevsky), modeMs, amoPercent, mxdmnMs };
}

// -------------------------------------------------------------- ANS indices
export interface ReferenceStat { mean: number; sd: number; source: string; }

/**
 * Short-term (5 min, healthy adults) reference values used for the
 * experimental PNS/SNS indices. Each entry names its source; the SDs for
 * meanRR/RMSSD/HR are derived from the inter-quartile ranges reported by
 * Nunan et al. 2010 (IQR / 1.35), and sqrt(SI) from the 7-12 normal range
 * quoted by Kubios. These are population references, not diagnostics.
 */
export const REFERENCE: Record<'meanRR' | 'rmssd' | 'meanHR' | 'sqrtStressIndex', ReferenceStat> = {
  meanRR: { mean: 926, sd: 90, source: 'Nunan et al. 2010' },
  rmssd: { mean: 42, sd: 24, source: 'Nunan et al. 2010 (IQR 19-75 ms)' },
  meanHR: { mean: 65, sd: 8, source: 'Nunan et al. 2010' },
  sqrtStressIndex: { mean: 9.5, sd: 1.5, source: 'Kubios HRV user guide (normal 7-12)' }
};

export interface AnsResult {
  ok: boolean;
  reason?: string;
  experimental: true;
  /** Mean z-score of (mean RR, RMSSD) vs the reference: > 0 = more parasympathetic than average. */
  pnsIndex: number;
  /** Mean z-score of (mean HR, sqrt stress index): > 0 = more sympathetic than average. */
  snsIndex: number;
  stressIndex: StressIndexResult;
  reference: typeof REFERENCE;
}

export function ansIndices(td: TimeDomainResult, si: StressIndexResult, reference = REFERENCE): AnsResult {
  const base = { experimental: true as const, stressIndex: si, reference };
  if (!td.ok) return { ...base, ok: false, reason: 'Time-domain metrics required for ANS indices.', pnsIndex: NaN, snsIndex: NaN };
  const z = (v: number, r: ReferenceStat): number => (v - r.mean) / r.sd;
  const pnsIndex = mean([z(td.meanRR, reference.meanRR), z(td.rmssd, reference.rmssd)]);
  const snsParts = [z(td.meanHR, reference.meanHR)];
  if (Number.isFinite(si.sqrt)) snsParts.push(z(si.sqrt, reference.sqrtStressIndex));
  return { ...base, ok: true, pnsIndex, snsIndex: mean(snsParts) };
}

// ----------------------------------------------------- ultra-short & baseline
/** RMSSD over the last `windowSec` seconds of beats (Esco & Flatt 2014: 60 s at rest tracks 5 min). */
export function ultraShortRmssd(input: BeatInput, windowSec = 60): { rmssd: number; lnRmssd: number; n: number; durationSec: number } {
  const { t, ibiMs } = beatTimes(input);
  const n = t.length;
  if (!n) return { rmssd: NaN, lnRmssd: NaN, n: 0, durationSec: 0 };
  const tEnd = t[n - 1];
  const sel: number[] = [];
  for (let i = 0; i < n; i++) if (tEnd - t[i] <= windowSec) sel.push(ibiMs[i]);
  if (sel.length < 2) return { rmssd: NaN, lnRmssd: NaN, n: sel.length, durationSec: 0 };
  let s = 0;
  for (let i = 1; i < sel.length; i++) s += (sel[i] - sel[i - 1]) ** 2;
  const r = Math.sqrt(s / (sel.length - 1));
  return { rmssd: r, lnRmssd: Math.log(Math.max(r, 0.01)), n: sel.length, durationSec: Math.min(windowSec, tEnd - t[n - sel.length]) };
}

export interface BaselinePoint { date: string; lnRmssd: number; }
export interface BaselineResult {
  ok: boolean;
  reason?: string;
  days: number;
  mean: number;
  sd: number;
  /** Coefficient of variation of lnRMSSD over the window, %. */
  cv: number;
  /** Normal band: mean +- swcFactor * sd (smallest worthwhile change, Plews et al. 2013). */
  lower: number;
  upper: number;
  status: 'within' | 'above' | 'below' | null;
}

/**
 * Rolling lnRMSSD baseline from daily readings (most recent last). Uses
 * the previous `days` readings before `today` when it is given.
 */
export function lnRmssdBaseline(history: BaselinePoint[], today?: BaselinePoint, days = 7, swcFactor = 0.5): BaselineResult {
  const window = history.slice(-days).map(p => p.lnRmssd).filter(v => Number.isFinite(v));
  if (window.length < 3) return { ok: false, reason: `Need at least 3 daily readings (have ${window.length}).`, days: window.length, mean: NaN, sd: NaN, cv: NaN, lower: NaN, upper: NaN, status: null };
  const m = mean(window), s = std(window);
  const lower = m - swcFactor * s, upper = m + swcFactor * s;
  let status: BaselineResult['status'] = null;
  if (today && Number.isFinite(today.lnRmssd)) status = today.lnRmssd < lower ? 'below' : today.lnRmssd > upper ? 'above' : 'within';
  return { ok: true, days: window.length, mean: m, sd: s, cv: m !== 0 ? (100 * s) / m : NaN, lower, upper, status };
}

// ---------------------------------------------------------------- runner
export interface HrvAnalysis {
  meta: { nBeats: number; durationSec: number; pctCorrected: number; flagged: boolean[]; rmssdFloorMs?: number };
  timeDomain: TimeDomainResult;
  frequencyDomain: FrequencyDomainResult;
  nonlinear: NonlinearResult;
  stressIndex: StressIndexResult;
  ans: AnsResult;
  ultraShort: ReturnType<typeof ultraShortRmssd>;
}

/**
 * Full analysis of accepted beats. Pass beats with timestamps (`{ibiMs, t}`)
 * whenever you have them so gaps between accepted beats are handled
 * correctly. `rmssdFloorMs`, if known (the camera engine reports it), is
 * passed through so consumers can show it next to RMSSD. `respirationRateBpm`
 * (from the engine's pulse-train fusion or any other independent source)
 * sets `frequencyDomain.respirationInLf` when breathing is slow enough to
 * move RSA into the LF band.
 */
export function analyzeHRV(input: BeatInput, opts: { rmssdFloorMs?: number; respirationRateBpm?: number } = {}): HrvAnalysis {
  const beats = toBeats(input);
  const ibiMs = beats.map(b => b.ibiMs);
  const { t } = beatTimes(beats);
  const durationSec = t.length ? t[t.length - 1] - t[0] + (ibiMs[0] || 0) / 1000 : 0;
  const { flagged, pctCorrected } = correctArtifacts(ibiMs);
  const td = timeDomain(beats);
  const fd = frequencyDomain(beats, { respirationRateBpm: opts.respirationRateBpm });
  const nl = nonlinear(ibiMs);
  const si = ibiMs.length >= 30 ? stressIndex(ibiMs) : stressIndex([]);
  const ans = ansIndices(td, si);
  return {
    meta: { nBeats: ibiMs.length, durationSec, pctCorrected, flagged, rmssdFloorMs: opts.rmssdFloorMs },
    timeDomain: td, frequencyDomain: fd, nonlinear: nl, stressIndex: si, ans,
    ultraShort: ultraShortRmssd(beats)
  };
}

export { computeFFT as _fftForTests };
