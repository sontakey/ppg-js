/**
 * Minimal IIR bandpass filter (RBJ biquad, "constant 0 dB peak gain" form)
 * and uniform-rate resampling. No external DSP dependency.
 */

/**
 * Compute a single bandpass biquad section.
 * @param {number} sampleRate - Hz
 * @param {number} lowHz - low cutoff (Hz)
 * @param {number} highHz - high cutoff (Hz)
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}} normalized coefficients (a0 = 1)
 */
export function bandpassCoeffs(sampleRate, lowHz, highHz) {
  const f0 = Math.sqrt(lowHz * highHz);
  const bw = Math.max(highHz - lowHz, 1e-6);
  const q = f0 / bw;

  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);

  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0
  };
}

/** Direct Form I biquad, stateful. */
export class Biquad {
  constructor(coeffs) {
    this.c = coeffs;
    this.reset();
  }

  reset() {
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * Zero-phase bandpass filter (forward-backward biquad pass) so peak timing
 * isn't skewed by filter group delay.
 *
 * @param {Array|Float32Array|Float64Array} values
 * @param {number} sampleRate - Hz
 * @param {number} lowHz
 * @param {number} highHz
 * @returns {Float64Array}
 */
export function filtfiltBandpass(values, sampleRate, lowHz, highHz) {
  const coeffs = bandpassCoeffs(sampleRate, lowHz, highHz);
  const n = values.length;

  const forward = new Float64Array(n);
  const bq1 = new Biquad(coeffs);
  for (let i = 0; i < n; i++) forward[i] = bq1.process(values[i]);

  const backward = new Float64Array(n);
  const bq2 = new Biquad(coeffs);
  for (let i = n - 1; i >= 0; i--) backward[i] = bq2.process(forward[i]);

  return backward;
}

/**
 * Resample irregular (timestamp, value) samples onto a uniform time grid
 * via linear interpolation. Camera frame delivery is never perfectly
 * periodic, so filtering/peak-timing should happen on a uniform grid.
 *
 * @param {Array<number>} times - seconds, strictly increasing
 * @param {Array<number>} values
 * @param {number} targetRate - Hz
 * @returns {{times: Float64Array, values: Float64Array}}
 */
export function resampleUniform(times, values, targetRate) {
  const n = times.length;
  if (n < 2) return { times: Float64Array.from(times), values: Float64Array.from(values) };

  const t0 = times[0];
  const t1 = times[n - 1];
  const dt = 1 / targetRate;
  const count = Math.max(2, Math.floor((t1 - t0) / dt) + 1);

  const outTimes = new Float64Array(count);
  const outValues = new Float64Array(count);

  let srcIdx = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i * dt;
    while (srcIdx < n - 2 && times[srcIdx + 1] < t) srcIdx++;
    const ta = times[srcIdx];
    const tb = times[srcIdx + 1];
    const va = values[srcIdx];
    const vb = values[srcIdx + 1];
    const frac = tb > ta ? (t - ta) / (tb - ta) : 0;
    outTimes[i] = t;
    outValues[i] = va + (vb - va) * frac;
  }

  return { times: outTimes, values: outValues };
}
