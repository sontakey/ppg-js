import FFT from 'fft.js';

/**
 * Compute FFT and Power Spectral Density
 *
 * @param {Array|Float32Array} signal - Input signal
 * @param {number} fftSize - FFT size (must be power of 2)
 * @returns {Object} { psd, peakIdx, peakFrequency, sampleRate }
 */
export function computeFFT(signal, fftSize = 256, sampleRate = 60) {
  const n = signal.length;

  // Pad signal to FFT size
  const paddedSignal = new Float32Array(fftSize);
  for (let i = 0; i < Math.min(n, fftSize); i++) {
    paddedSignal[i] = signal[i];
  }

  // Compute FFT using FFT.js library
  const fft = new FFT(fftSize);
  const out = fft.createComplexArray();
  const input = fft.toComplexArray(paddedSignal);
  fft.transform(out, input);

  // Calculate Power Spectral Density (magnitude squared)
  const psd = new Float32Array(fftSize / 2);
  for (let i = 0; i < fftSize / 2; i++) {
    const real = out[2 * i];
    const imag = out[2 * i + 1];
    psd[i] = real * real + imag * imag;
  }

  return {
    psd,
    fftSize,
    sampleRate,
    freqResolution: sampleRate / fftSize
  };
}

/**
 * Calculate SNR from Power Spectral Density
 *
 * @param {Float32Array} psd - Power spectral density array
 * @param {number} freqResolution - Frequency resolution (Hz per bin)
 * @param {number} cardiacBandLow - Lower cardiac frequency (Hz)
 * @param {number} cardiacBandHigh - Upper cardiac frequency (Hz)
 * @returns {Object} { snr_dB, peakIdx, peakFrequency }
 */
export function calculateSNRFromPSD(psd, freqResolution, cardiacBandLow = 0.75, cardiacBandHigh = 4.0) {
  // Define frequency bands
  const signalBandIdx = {
    low: Math.floor(cardiacBandLow / freqResolution),
    high: Math.ceil(cardiacBandHigh / freqResolution)
  };

  // Calculate power in signal and total bands
  let signalPower = 0;
  let totalPower = 0;
  let maxPower = 0;
  let peakIdx = 0;

  for (let i = 1; i < psd.length; i++) { // Skip DC component (i=0)
    totalPower += psd[i];

    if (i >= signalBandIdx.low && i <= signalBandIdx.high) {
      signalPower += psd[i];

      // Track peak for heart rate estimation
      if (psd[i] > maxPower) {
        maxPower = psd[i];
        peakIdx = i;
      }
    }
  }

  // Calculate noise power
  const noisePower = totalPower - signalPower;

  // Calculate SNR in dB (add small epsilon to avoid log(0))
  const epsilon = 1e-10;
  const snr_dB = 10 * Math.log10((signalPower + epsilon) / (noisePower + epsilon));

  // Extract peak frequency
  const peakFrequency = peakIdx * freqResolution;

  return {
    snr_dB,
    peakIdx,
    peakFrequency,
    signalPower,
    noisePower,
    totalPower
  };
}
