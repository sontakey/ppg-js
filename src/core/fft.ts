// Own minimal radix-2 Cooley-Tukey FFT (real input) - replaces the fft.js
// dependency. fftSize must be a power of 2 (caller controls this; SignalProcessor
// always passes 256). In-place iterative implementation, no allocation per call
// beyond the working real/imag arrays.
function radix2FFT(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  // Iterative Cooley-Tukey butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = real[i + k], uI = imag[i + k];
        const vR = real[i + k + len / 2] * curWr - imag[i + k + len / 2] * curWi;
        const vI = real[i + k + len / 2] * curWi + imag[i + k + len / 2] * curWr;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + len / 2] = uR - vR;
        imag[i + k + len / 2] = uI - vI;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr; curWi = nextWi;
      }
    }
  }
}

export interface FFTResult {
  psd: Float32Array;
  fftSize: number;
  sampleRate: number;
  freqResolution: number;
}

/**
 * Compute FFT and Power Spectral Density
 * @param signal - Input signal
 * @param fftSize - FFT size (must be power of 2)
 */
export function computeFFT(signal: ArrayLike<number>, fftSize = 256, sampleRate = 60): FFTResult {
  const n = signal.length;

  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  for (let i = 0; i < Math.min(n, fftSize); i++) {
    real[i] = signal[i];
  }

  radix2FFT(real, imag);

  const psd = new Float32Array(fftSize / 2);
  for (let i = 0; i < fftSize / 2; i++) {
    psd[i] = real[i] * real[i] + imag[i] * imag[i];
  }

  return {
    psd,
    fftSize,
    sampleRate,
    freqResolution: sampleRate / fftSize
  };
}

export interface SNRResult {
  snr_dB: number;
  peakIdx: number;
  peakFrequency: number;
  signalPower: number;
  noisePower: number;
  totalPower: number;
}

/**
 * Calculate SNR from Power Spectral Density
 */
export function calculateSNRFromPSD(
  psd: Float32Array,
  freqResolution: number,
  cardiacBandLow = 0.75,
  cardiacBandHigh = 4.0
): SNRResult {
  const signalBandIdx = {
    low: Math.floor(cardiacBandLow / freqResolution),
    high: Math.ceil(cardiacBandHigh / freqResolution)
  };

  let signalPower = 0;
  let totalPower = 0;
  let maxPower = 0;
  let peakIdx = 0;

  for (let i = 1; i < psd.length; i++) { // Skip DC component (i=0)
    totalPower += psd[i];

    if (i >= signalBandIdx.low && i <= signalBandIdx.high) {
      signalPower += psd[i];
      if (psd[i] > maxPower) {
        maxPower = psd[i];
        peakIdx = i;
      }
    }
  }

  const noisePower = totalPower - signalPower;
  const epsilon = 1e-10;
  const snr_dB = 10 * Math.log10((signalPower + epsilon) / (noisePower + epsilon));
  const peakFrequency = peakIdx * freqResolution;

  return { snr_dB, peakIdx, peakFrequency, signalPower, noisePower, totalPower };
}
