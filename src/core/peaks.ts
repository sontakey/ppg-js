/**
 * Time-domain peak detection + IBI validation + HR/RMSSD from a filtered,
 * uniformly sampled PPG signal (systolic peaks as maxima).
 */

export interface DetectedPeak {
  /** Integer sample index of the local maximum. */
  idx: number;
  /** Sub-sample refined position (samples). */
  refined: number;
  /** Refined time in seconds (refined / sampleRate). */
  timeSec: number;
  /** 1-sigma uncertainty of the refined position, in seconds, from the
   *  least-squares vertex fit (noise residual / curvature). */
  sigmaSec: number;
  /** Peak amplitude in the filtered signal (value at the maximum). */
  amplitude: number;
  /** Quadratic coefficient of the vertex fit (signal units per sample^2, negative at a maximum). */
  curvature: number;
  /** Sum of squared fit abscissae (samples^2) - with a noise estimate s, sigma_x = s / (2|a| sqrt(sxx)). */
  sxx: number;
}

interface VertexFit { offset: number; sigma: number; a: number; sxx: number; }

/**
 * Least-squares quadratic vertex fit over 2*halfWidth+1 samples centered on
 * index i. Symmetric x makes the normal equations separable. Also returns
 * the 1-sigma uncertainty of the vertex from the fit residual: with
 * x = -b/(2a), var(b) = s^2 / Sxx, so sigma_x ~= s / (2|a| sqrt(Sxx)).
 */
function refineVertex(signal: ArrayLike<number>, i: number, halfWidth: number): VertexFit {
  if (halfWidth < 1) return { offset: 0, sigma: 0.5, a: 0, sxx: 0 };
  let sx2 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let k = -halfWidth; k <= halfWidth; k++) {
    const x = k, y = signal[i + k];
    const x2 = x * x;
    sx2 += x2; sx4 += x2 * x2; sy += y; sxy += x * y; sx2y += x2 * y;
  }
  const n = 2 * halfWidth + 1;
  const det = n * sx4 - sx2 * sx2;
  if (det === 0 || sx2 === 0) return { offset: 0, sigma: 0.5, a: 0, sxx: sx2 };
  const b = sxy / sx2;
  const a = (n * sx2y - sx2 * sy) / det;
  const c = (sy - a * sx2) / n;
  if (a >= 0) return { offset: 0, sigma: 0.5, a, sxx: sx2 };
  // Residual standard deviation of the fit.
  let ss = 0;
  for (let k = -halfWidth; k <= halfWidth; k++) {
    const r = signal[i + k] - (a * k * k + b * k + c);
    ss += r * r;
  }
  const dof = Math.max(1, n - 3);
  const s = Math.sqrt(ss / dof);
  const vertexX = -b / (2 * a);
  const sigma = s / (2 * Math.abs(a) * Math.sqrt(sx2));
  return {
    offset: Math.max(-halfWidth, Math.min(halfWidth, vertexX)),
    sigma: Math.min(halfWidth, sigma),
    a,
    sxx: sx2
  };
}

/**
 * Amplitude-aware adaptive threshold (0.4 x causal rolling max envelope,
 * ~2 s) plus a refractory period, with least-squares vertex refinement.
 *
 * @param signal - filtered signal, peaks = maxima
 * @param sampleRate - Hz (uniform grid)
 * @param minRefractorySec - min time between peaks (default 0.3 s = 200 bpm)
 * @param envelopeWindowSec - rolling max envelope window
 */
export function detectPeaksDetailed(
  signal: ArrayLike<number>,
  sampleRate: number,
  minRefractorySec = 0.3,
  envelopeWindowSec = 2.0,
  fitHalfWidthSec = 0.3
): DetectedPeak[] {
  const n = signal.length;
  if (n < 3) return [];
  const envelopeWindowSamples = Math.max(1, Math.round(envelopeWindowSec * sampleRate));

  // Causal rolling max of |signal| via a monotonic deque (O(n)).
  const envelope = new Float64Array(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.abs(signal[i]);
    while (dq.length && Math.abs(signal[dq[dq.length - 1]]) <= v) dq.pop();
    dq.push(i);
    while (dq[0] <= i - envelopeWindowSamples) dq.shift();
    envelope[i] = Math.abs(signal[dq[0]]);
  }

  const minRefractorySamples = minRefractorySec * sampleRate;
  // Vertex-fit half-width. A wide fit (~300 ms either side, i.e. most of
  // the systolic hump) averages over far more of the peak's shape than a
  // 3-point parabola and cuts beat-timing jitter several-fold on 8-bit
  // camera signals; its shape bias is constant per waveform and cancels in
  // successive differences. Callers cap it below ~0.35 x the expected IBI
  // so neighbouring beats stay out of the fit.
  const halfWidthTarget = Math.max(2, Math.round(fitHalfWidthSec * sampleRate));
  const peaks: DetectedPeak[] = [];
  let lastPeakIdx = -Infinity;

  for (let i = 1; i < n - 1; i++) {
    const threshold = 0.4 * envelope[i];
    if (
      signal[i] > threshold &&
      signal[i] > signal[i - 1] &&
      signal[i] >= signal[i + 1] &&
      i - lastPeakIdx >= minRefractorySamples
    ) {
      const hw = Math.min(halfWidthTarget, i, n - 1 - i);
      const fit = refineVertex(signal, i, hw);
      const refined = i + fit.offset;
      peaks.push({ idx: i, refined, timeSec: refined / sampleRate, sigmaSec: fit.sigma / sampleRate, amplitude: signal[i], curvature: fit.a, sxx: fit.sxx });
      lastPeakIdx = i;
    }
  }
  return peaks;
}

/** Peak times in seconds (see detectPeaksDetailed). */
export function detectPeaks(
  signal: ArrayLike<number>,
  sampleRate: number,
  minRefractorySec = 0.3,
  envelopeWindowSec = 2.0
): number[] {
  return detectPeaksDetailed(signal, sampleRate, minRefractorySec, envelopeWindowSec).map(p => p.timeSec);
}

export type IbiRejectReason = 'out_of_range' | 'missed_beat' | 'jump_vs_median' | 'morphology' | null;

export interface IbiDetail {
  /** Time of the peak that ends this interval (seconds). */
  peakTimeSec: number;
  ibiMs: number;
  valid: boolean;
  reason: IbiRejectReason;
}

export interface IbiResult {
  ibisMs: number[];
  artifactCount: number;
  totalCount: number;
  details: IbiDetail[];
}

/**
 * Validate the intervals between consecutive peaks: physiological range,
 * missed-beat multiples (~2x/3x the recent median, not folded into the
 * median so a run of misses can't drag it), sudden jumps vs the median of
 * the last 5 accepted, and (optionally) peaks whose pulse shape failed the
 * template check (`peakValid[i] === false`).
 */
export function computeIBIs(
  peakTimes: ArrayLike<number>,
  minIbiMs = 300,
  maxIbiMs = 2000,
  maxJumpFraction = 0.3,
  peakValid?: ArrayLike<boolean>
): IbiResult {
  const ibisMs: number[] = [];
  const details: IbiDetail[] = [];
  let artifactCount = 0;
  const recent: number[] = [];

  for (let i = 1; i < peakTimes.length; i++) {
    const ibi = (peakTimes[i] - peakTimes[i - 1]) * 1000;
    let valid = ibi >= minIbiMs && ibi <= maxIbiMs;
    let reason: IbiRejectReason = valid ? null : 'out_of_range';

    if (valid && peakValid && (peakValid[i] === false || peakValid[i - 1] === false)) {
      valid = false;
      reason = 'morphology';
    }

    if (valid && recent.length >= 3) {
      const median = medianOf(recent.slice(-5));
      const ratio = ibi / median;
      const isMissedBeatMultiple = [2, 3].some(k => ratio >= k * 0.8 && ratio <= k * 1.2);
      if (isMissedBeatMultiple) {
        valid = false;
        reason = 'missed_beat';
      } else if (Math.abs(ibi - median) / median > maxJumpFraction) {
        valid = false;
        reason = 'jump_vs_median';
      }
    }

    if (valid) {
      ibisMs.push(ibi);
      recent.push(ibi);
    } else {
      artifactCount++;
    }
    details.push({ peakTimeSec: peakTimes[i], ibiMs: ibi, valid, reason });
  }

  return { ibisMs, artifactCount, totalCount: Math.max(0, peakTimes.length - 1), details };
}

export function medianOf(arr: ArrayLike<number>): number {
  const sorted = Array.from(arr as ArrayLike<number>).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Heart rate (bpm) from the median of the most recent N valid IBIs; 0 if none. */
export function heartRateFromIBIs(ibisMs: ArrayLike<number>, windowSize = 8): number {
  if (ibisMs.length === 0) return 0;
  const window = Array.from(ibisMs as ArrayLike<number>).slice(-windowSize);
  const medianIbi = medianOf(window);
  return medianIbi > 0 ? 60000 / medianIbi : 0;
}

export type HeartRateSource = 'ibi' | 'fft' | 'none';

export interface CrossCheckResult {
  heartRate: number;
  source: HeartRateSource;
  disagree: boolean;
  /** 'double' when IBI HR ~ 2x FFT HR (detector double-counting), 'half'
   *  when IBI HR ~ 0.5x FFT HR (missed beats), 'other' for any other
   *  disagreement, null when they agree. */
  disagreeKind: 'double' | 'half' | 'other' | null;
}

/**
 * Compare the time-domain (IBI-median) heart rate with the independent
 * spectral estimate. Agreement within `maxDisagreeFraction` returns the
 * IBI value; a 2:1 or 1:2 relationship is reported specifically because
 * it points at the detector (double count / missed beats) rather than the
 * heart.
 */
export function crossCheckHeartRate(ibiHrBpm: number, fftHrBpm: number, maxDisagreeFraction = 0.25): CrossCheckResult {
  if (!ibiHrBpm && !fftHrBpm) return { heartRate: 0, source: 'none', disagree: false, disagreeKind: null };
  if (!ibiHrBpm) return { heartRate: fftHrBpm, source: 'fft', disagree: false, disagreeKind: null };
  if (!fftHrBpm) return { heartRate: ibiHrBpm, source: 'ibi', disagree: false, disagreeKind: null };

  const ratio = ibiHrBpm / fftHrBpm;
  if (Math.abs(ratio - 1) <= maxDisagreeFraction) {
    return { heartRate: ibiHrBpm, source: 'ibi', disagree: false, disagreeKind: null };
  }
  let kind: CrossCheckResult['disagreeKind'] = 'other';
  if (ratio > 1.7 && ratio < 2.3) kind = 'double';
  else if (ratio > 0.43 && ratio < 0.6) kind = 'half';
  return { heartRate: fftHrBpm, source: 'fft', disagree: true, disagreeKind: kind };
}

/** Slew-limit a displayed value (0 previous value snaps to target). */
export function slewLimit(prevDisplayed: number, target: number, maxDeltaPerStep = 8): number {
  if (!prevDisplayed || !target) return target;
  const delta = target - prevDisplayed;
  if (Math.abs(delta) <= maxDeltaPerStep) return target;
  return prevDisplayed + Math.sign(delta) * maxDeltaPerStep;
}

/** RMSSD over the last `windowSize` IBIs (default: all given). 0 if < 2. */
export function rmssd(ibisMs: ArrayLike<number>, windowSize = Infinity): number {
  const arr = Array.from(ibisMs as ArrayLike<number>);
  const window = Number.isFinite(windowSize) ? arr.slice(-windowSize) : arr;
  if (window.length < 2) return 0;
  let sumSq = 0;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (window.length - 1));
}

/**
 * Per-beat pulse-shape quality: each beat (from 30% of the local IBI before
 * the peak to 50% after) is resampled to `points` samples and correlated
 * with the mean template of all beats in the window (Orphanidou et al.
 * 2015). Returns one correlation per peak (NaN where the beat could not be
 * extracted) and the median.
 */
export function templateCorrelation(
  signal: ArrayLike<number>,
  sampleRate: number,
  peakSamples: ArrayLike<number>,
  points = 40
): { perBeat: number[]; median: number } {
  const n = peakSamples.length;
  const perBeat = new Array<number>(n).fill(NaN);
  if (n < 3) return { perBeat, median: NaN };
  const beats: Float64Array[] = [];
  const beatIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? peakSamples[i - 1] : null;
    const next = i < n - 1 ? peakSamples[i + 1] : null;
    const ibi = prev != null && next != null ? (next - prev) / 2 : prev != null ? peakSamples[i] - prev : next != null ? next - peakSamples[i] : 0;
    if (!(ibi > 0)) continue;
    const start = peakSamples[i] - 0.3 * ibi;
    const end = peakSamples[i] + 0.5 * ibi;
    if (start < 0 || end > signal.length - 1) continue;
    const beat = new Float64Array(points);
    let mean = 0;
    for (let k = 0; k < points; k++) {
      const pos = start + ((end - start) * k) / (points - 1);
      const i0 = Math.floor(pos), frac = pos - i0;
      const v = signal[i0] + (signal[Math.min(signal.length - 1, i0 + 1)] - signal[i0]) * frac;
      beat[k] = v; mean += v;
    }
    mean /= points;
    let norm = 0;
    for (let k = 0; k < points; k++) { beat[k] -= mean; norm += beat[k] * beat[k]; }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < points; k++) beat[k] /= norm;
    beats.push(beat); beatIdx.push(i);
  }
  if (beats.length < 3) return { perBeat, median: NaN };
  const template = new Float64Array(points);
  for (const b of beats) for (let k = 0; k < points; k++) template[k] += b[k];
  let tn = 0;
  for (let k = 0; k < points; k++) tn += template[k] * template[k];
  tn = Math.sqrt(tn) || 1;
  for (let k = 0; k < points; k++) template[k] /= tn;
  const vals: number[] = [];
  beats.forEach((b, j) => {
    let c = 0;
    for (let k = 0; k < points; k++) c += b[k] * template[k];
    perBeat[beatIdx[j]] = c;
    vals.push(c);
  });
  return { perBeat, median: medianOf(vals) };
}
