/**
 * Radix-2 real FFT plus the spectral heart-rate estimate used as the
 * independent cross-check for the time-domain beat detector.
 *
 * Changes vs the original (docs/audit findings A1, A6): every sample of the
 * window is used (no truncation to fftSize), a Hann window limits leakage,
 * the transform is zero-padded so the bin spacing is fine at any camera
 * rate, the peak bin is refined by parabolic interpolation, and a
 * sub-harmonic check stops a strong second harmonic (dicrotic wave) from
 * being read as double the heart rate.
 */

function radix2FFT(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let k = 0; k < half; k++) {
        const uR = real[i + k], uI = imag[i + k];
        const xr = real[i + k + half], xi = imag[i + k + half];
        const vR = xr * curWr - xi * curWi;
        const vI = xr * curWi + xi * curWr;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + half] = uR - vR;
        imag[i + k + half] = uI - vI;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr; curWi = nextWi;
      }
    }
  }
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export interface FFTResult {
  psd: Float32Array;
  /** Actual transform length used (>= requested fftSize, >= 4x signal length). */
  fftSize: number;
  sampleRate: number;
  freqResolution: number;
}

/**
 * Windowed, zero-padded power spectrum of a real signal.
 * @param signal - input window (all samples are used)
 * @param fftSize - minimum transform length; the actual length is the next
 *   power of two at or above max(fftSize, 4 * signal.length)
 * @param sampleRate - Hz
 */
export function computeFFT(signal: ArrayLike<number>, fftSize = 256, sampleRate = 60): FFTResult {
  const n = signal.length;
  const size = nextPowerOfTwo(Math.max(fftSize, 4 * n, 2));
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  // Remove the mean before windowing so DC leakage does not swamp the
  // low end of the cardiac band.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean = n ? mean / n : 0;
  for (let i = 0; i < n; i++) {
    const w = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
    real[i] = (signal[i] - mean) * w;
  }
  radix2FFT(real, imag);
  const psd = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) psd[i] = real[i] * real[i] + imag[i] * imag[i];
  return { psd, fftSize: size, sampleRate, freqResolution: sampleRate / size };
}

export interface SNRResult {
  snr_dB: number;
  peakIdx: number;
  /** Peak frequency (Hz) after parabolic interpolation and sub-harmonic resolution. */
  peakFrequency: number;
  /** Peak frequency (Hz) of the raw maximum bin, before harmonic resolution. */
  rawPeakFrequency: number;
  /** true when the dominant bin was judged to be the 2nd harmonic and halved. */
  harmonicCorrected: boolean;
  /** Ratio of the second-largest distinct spectral peak in band to the largest (0-1). */
  peakDominance: number;
  signalPower: number;
  noisePower: number;
  totalPower: number;
}

/** Parabolic interpolation of a peak position in log-power, in bins. */
function refinePeakBin(psd: ArrayLike<number>, k: number): number {
  if (k <= 0 || k >= psd.length - 1) return k;
  const l = Math.log(psd[k - 1] + 1e-20), c = Math.log(psd[k] + 1e-20), r = Math.log(psd[k + 1] + 1e-20);
  const denom = l - 2 * c + r;
  if (denom >= 0) return k;
  const delta = 0.5 * (l - r) / denom;
  return k + Math.max(-0.5, Math.min(0.5, delta));
}

/** Max PSD value within +-halfWidth bins of a (fractional) bin position. */
function localMax(psd: ArrayLike<number>, bin: number, halfWidth: number): number {
  const lo = Math.max(0, Math.floor(bin - halfWidth));
  const hi = Math.min(psd.length - 1, Math.ceil(bin + halfWidth));
  let m = 0;
  for (let i = lo; i <= hi; i++) if (psd[i] > m) m = psd[i];
  return m;
}

/**
 * Cardiac-band SNR and spectral peak.
 *
 * Sub-harmonic rule: if the strongest bin is at f and there is a local
 * spectral peak at f/2 (inside the band) with at least `subharmonicRatio`
 * of its power, the true fundamental is almost certainly f/2 - a strong
 * dicrotic wave makes the 2nd harmonic dominant, whereas power at half the
 * true heart rate has no physiological source at rest.
 */
export function calculateSNRFromPSD(
  psd: Float32Array,
  freqResolution: number,
  cardiacBandLow = 0.75,
  cardiacBandHigh = 4.0,
  subharmonicRatio = 0.35
): SNRResult {
  const lowIdx = Math.max(1, Math.floor(cardiacBandLow / freqResolution));
  const highIdx = Math.min(psd.length - 1, Math.ceil(cardiacBandHigh / freqResolution));

  let signalPower = 0, totalPower = 0, maxPower = 0, peakIdx = 0;
  for (let i = 1; i < psd.length; i++) {
    totalPower += psd[i];
    if (i >= lowIdx && i <= highIdx) {
      signalPower += psd[i];
      if (psd[i] > maxPower) { maxPower = psd[i]; peakIdx = i; }
    }
  }
  const noisePower = totalPower - signalPower;
  const epsilon = 1e-10;
  const snr_dB = 10 * Math.log10((signalPower + epsilon) / (noisePower + epsilon));

  const rawBin = refinePeakBin(psd, peakIdx);
  const rawPeakFrequency = peakIdx > 0 ? rawBin * freqResolution : 0;
  let peakFrequency = rawPeakFrequency;
  let harmonicCorrected = false;

  if (peakIdx > 0) {
    const halfBin = rawBin / 2;
    if (halfBin * freqResolution >= cardiacBandLow) {
      // Look for a genuine local maximum near f/2 (within +-3% of f/2).
      const hw = Math.max(1, Math.round(halfBin * 0.03));
      const lo = Math.max(1, Math.floor(halfBin - hw)), hi = Math.min(psd.length - 2, Math.ceil(halfBin + hw));
      let best = -1, bestP = 0;
      for (let i = lo; i <= hi; i++) {
        if (psd[i] >= psd[i - 1] && psd[i] >= psd[i + 1] && psd[i] > bestP) { bestP = psd[i]; best = i; }
      }
      if (best > 0 && bestP >= subharmonicRatio * maxPower) {
        peakFrequency = refinePeakBin(psd, best) * freqResolution;
        harmonicCorrected = true;
      }
    }
  }

  // Dominance: how much larger the main peak is than the next distinct
  // in-band peak (excluding its own +-5% neighbourhood and harmonics of it).
  let second = 0;
  if (peakIdx > 0) {
    const excl = Math.max(2, Math.round(rawBin * 0.08));
    for (let i = lowIdx + 1; i < highIdx; i++) {
      if (Math.abs(i - rawBin) <= excl) continue;
      if (Math.abs(i - rawBin * 2) <= excl || Math.abs(i - rawBin / 2) <= excl) continue;
      if (psd[i] >= psd[i - 1] && psd[i] >= psd[i + 1] && psd[i] > second) second = psd[i];
    }
  }
  const peakDominance = maxPower > 0 ? Math.min(1, second / maxPower) : 1;
  void localMax;

  return { snr_dB, peakIdx, peakFrequency, rawPeakFrequency, harmonicCorrected, peakDominance, signalPower, noisePower, totalPower };
}
