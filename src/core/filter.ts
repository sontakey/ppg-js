/**
 * Zero-phase IIR filtering and uniform resampling. No external DSP dependency.
 *
 * The bandpass is a cascade of Butterworth high-pass and low-pass biquad
 * sections (bilinear transform, pre-warped at each corner), run forward and
 * backward so peak timing is not skewed by group delay. A cascade has a flat
 * passband and steep skirts; the single low-Q biquad it replaces was already
 * 6 dB down at its own nominal band edges (see docs/audit, finding A2).
 */

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** Direct Form I biquad, stateful. */
export class Biquad {
  readonly c: BiquadCoeffs;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  constructor(coeffs: BiquadCoeffs) {
    this.c = coeffs;
  }

  reset(): void {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Butterworth pole Q values for an even order N (one per biquad section). */
function butterworthQs(order: number): number[] {
  const n = Math.max(2, Math.round(order / 2) * 2);
  const qs: number[] = [];
  for (let k = 1; k <= n / 2; k++) {
    qs.push(1 / (2 * Math.sin(((2 * k - 1) * Math.PI) / (2 * n))));
  }
  return qs;
}

/** RBJ low-pass biquad (bilinear, pre-warped at fc). */
export function lowpassCoeffs(sampleRate: number, fc: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw0) / 2) / a0,
    b1: (1 - cosw0) / a0,
    b2: ((1 - cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0
  };
}

/** RBJ high-pass biquad (bilinear, pre-warped at fc). */
export function highpassCoeffs(sampleRate: number, fc: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw0) / 2) / a0,
    b1: (-(1 + cosw0)) / a0,
    b2: ((1 + cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0
  };
}

/**
 * Kept for API compatibility: a single RBJ constant-peak-gain bandpass
 * biquad. Not used by the pipeline any more (see designBandpass).
 */
export function bandpassCoeffs(sampleRate: number, lowHz: number, highHz: number): BiquadCoeffs {
  const f0 = Math.sqrt(lowHz * highHz);
  const bw = Math.max(highHz - lowHz, 1e-6);
  const q = f0 / bw;
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cosw0) / a0, a2: (1 - alpha) / a0 };
}

export interface BandpassDesign {
  sections: BiquadCoeffs[];
  sampleRate: number;
  lowHz: number;
  highHz: number;
  highpassOrder: number;
  lowpassOrder: number;
}

/**
 * Butterworth bandpass as a cascade: `highpassOrder`-order high-pass at
 * `lowHz` (steep, to reject respiratory baseline wander which in fingertip
 * camera PPG is routinely several times the pulse amplitude) followed by a
 * `lowpassOrder`-order low-pass at `highHz`. Corners are the -3 dB points
 * of one pass (-6 dB after filtfilt), so callers should place them just
 * outside the physiological band they want flat.
 */
export function designBandpass(
  sampleRate: number,
  lowHz: number,
  highHz: number,
  highpassOrder = 4,
  lowpassOrder = 2
): BandpassDesign {
  const nyq = sampleRate / 2;
  const lo = Math.max(1e-3, Math.min(lowHz, nyq * 0.9));
  const hi = Math.max(lo * 1.01, Math.min(highHz, nyq * 0.95));
  const sections: BiquadCoeffs[] = [];
  for (const q of butterworthQs(highpassOrder)) sections.push(highpassCoeffs(sampleRate, lo, q));
  for (const q of butterworthQs(lowpassOrder)) sections.push(lowpassCoeffs(sampleRate, hi, q));
  return { sections, sampleRate, lowHz: lo, highHz: hi, highpassOrder, lowpassOrder };
}

/** Magnitude response |H(f)| of one forward pass of a section cascade. */
export function magnitudeResponse(design: BandpassDesign, hz: number): number {
  const w = (2 * Math.PI * hz) / design.sampleRate;
  const c1 = Math.cos(-w), s1 = Math.sin(-w), c2 = Math.cos(-2 * w), s2 = Math.sin(-2 * w);
  let mag = 1;
  for (const c of design.sections) {
    const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = c.b1 * s1 + c.b2 * s2;
    const dr = 1 + c.a1 * c1 + c.a2 * c2, di = c.a1 * s1 + c.a2 * s2;
    mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return mag;
}

function runCascade(sections: BiquadCoeffs[], values: ArrayLike<number>, reverse: boolean): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const bqs = sections.map(c => new Biquad(c));
  if (!reverse) {
    for (let i = 0; i < n; i++) {
      let v = values[i];
      for (const bq of bqs) v = bq.process(v);
      out[i] = v;
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      let v = values[i];
      for (const bq of bqs) v = bq.process(v);
      out[i] = v;
    }
  }
  return out;
}

/** Forward-backward (zero-phase) pass of a section cascade. */
export function filtfilt(design: BandpassDesign, values: ArrayLike<number>): Float64Array {
  return runCascade(design.sections, runCascade(design.sections, values, false), true);
}

/**
 * filtfilt with the mean removed and both ends extended by odd (point)
 * reflection of `padLen` samples, so the start-up transients of both passes
 * land in the padding rather than in the data (the same idea as SciPy's
 * `padtype='odd'`). A hard step from zero into a steep high-pass otherwise
 * rings for seconds at many times the pulse amplitude.
 */
export function filtfiltPadded(design: BandpassDesign, values: ArrayLike<number>, padLen: number): Float64Array {
  const n = values.length;
  if (n < 3) return new Float64Array(n);
  const pad = Math.max(0, Math.min(n - 1, Math.floor(padLen)));
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  const ext = new Float64Array(n + 2 * pad);
  const first = values[0] - mean, last = values[n - 1] - mean;
  for (let i = 0; i < pad; i++) ext[i] = 2 * first - (values[pad - i] - mean);
  for (let i = 0; i < n; i++) ext[pad + i] = values[i] - mean;
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * last - (values[n - 2 - i] - mean);
  return filtfilt(design, ext).slice(pad, pad + n);
}

/**
 * Noise gain of the zero-phase cascade: the RMS output for unit-variance
 * white input, from the energy of the effective impulse response.
 */
export function noiseGain(design: BandpassDesign, lengthSamples = 4096): number {
  const impulse = new Float64Array(lengthSamples);
  impulse[Math.floor(lengthSamples / 2)] = 1;
  const h = filtfilt(design, impulse);
  let e = 0;
  for (let i = 0; i < h.length; i++) e += h[i] * h[i];
  return Math.sqrt(e);
}

/**
 * Zero-phase Butterworth bandpass of a whole array. `lowHz`/`highHz` are
 * the cascade's corner frequencies.
 */
export function filtfiltBandpass(
  values: ArrayLike<number>,
  sampleRate: number,
  lowHz: number,
  highHz: number
): Float64Array {
  return filtfilt(designBandpass(sampleRate, lowHz, highHz), values);
}

/**
 * filtfiltBandpass on a window, warmed up with raw samples that precede it
 * (so the forward pass's start-up transient lands in the discarded context)
 * and mirror-padded on the right (so the backward pass's transient lands in
 * padding derived only from the window itself - no future samples, so this
 * is identical live and offline).
 */
export function filtfiltBandpassWithContext(
  contextValues: ArrayLike<number> | null | undefined,
  values: ArrayLike<number>,
  sampleRate: number,
  lowHz: number,
  highHz: number,
  padSec = 2
): Float64Array {
  const n = values.length;
  if (n === 0) return new Float64Array(0);
  const padLen = Math.max(0, Math.min(n - 1, Math.round(sampleRate * padSec)));
  const leftLen = contextValues ? contextValues.length : 0;
  const extended = new Float64Array(leftLen + n + padLen);
  if (contextValues && leftLen) extended.set(Array.from(contextValues as ArrayLike<number>), 0);
  for (let i = 0; i < n; i++) extended[leftLen + i] = values[i];
  // Mirror about the last sample so the padded segment is continuous in
  // value and slope.
  const last = values[n - 1];
  for (let i = 0; i < padLen; i++) extended[leftLen + n + i] = 2 * last - values[n - 2 - i];
  const filtered = filtfiltPadded(designBandpass(sampleRate, lowHz, highHz), extended, Math.round(sampleRate * padSec));
  return filtered.slice(leftLen, leftLen + n);
}

/**
 * Resample irregular (timestamp, value) samples onto a uniform time grid by
 * linear interpolation. Grid starts at `times[0]`.
 */
export function resampleUniform(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  targetRate: number
): { times: Float64Array; values: Float64Array } {
  const n = times.length;
  if (n < 2) return { times: Float64Array.from(times as ArrayLike<number>), values: Float64Array.from(values as ArrayLike<number>) };
  const t0 = times[0];
  const t1 = times[n - 1];
  const dt = 1 / targetRate;
  const count = Math.max(2, Math.floor((t1 - t0) / dt) + 1);
  const out = resampleToGrid(times, values, t0, dt, count);
  const outTimes = new Float64Array(count);
  for (let i = 0; i < count; i++) outTimes[i] = t0 + i * dt;
  return { times: outTimes, values: out };
}

/**
 * Linear interpolation of (times, values) onto an explicit grid
 * `gridStart + k * dt`, k = 0..count-1. Grid points before the first or
 * after the last sample hold the edge value. Used by the streaming engine
 * so consecutive windows share one absolute time grid.
 */
export function resampleToGrid(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  gridStart: number,
  dt: number,
  count: number
): Float64Array {
  const n = times.length;
  const out = new Float64Array(count);
  if (n === 0) return out;
  if (n === 1) { out.fill(values[0]); return out; }
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = gridStart + i * dt;
    while (j < n - 2 && times[j + 1] < t) j++;
    const ta = times[j], tb = times[j + 1];
    const va = values[j], vb = values[j + 1];
    if (t <= ta) { out[i] = va; continue; }
    if (t >= tb) { out[i] = vb; continue; }
    const frac = (t - ta) / (tb - ta);
    out[i] = va + (vb - va) * frac;
  }
  return out;
}
