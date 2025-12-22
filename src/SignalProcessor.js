import { computeFFT, calculateSNRFromPSD } from './utils/fft.js';
import { getQualityStatus, generateGuidance } from './utils/helpers.js';

/**
 * Signal Processor for PPG signal quality analysis
 * Performs FFT-based SNR calculation, Perfusion Index calculation,
 * and generates quality metrics and user guidance
 */
export class SignalProcessor {
  /**
   * Create a Signal Processor
   * @param {Object} options - Signal processing options
   * @param {number} options.windowLength - Window length in samples
   * @param {number} options.sampleRate - Sample rate in Hz
   * @param {number} options.cardiacBandLow - Lower cardiac frequency (Hz)
   * @param {number} options.cardiacBandHigh - Upper cardiac frequency (Hz)
   * @param {number} options.fftSize - FFT size (power of 2)
   */
  constructor(options = {}) {
    this.windowLength = options.windowLength || 300;
    this.sampleRate = options.sampleRate || 60;
    this.cardiacBandLow = options.cardiacBandLow || 0.75;
    this.cardiacBandHigh = options.cardiacBandHigh || 4.0;
    this.fftSize = options.fftSize || 256;

    this.previousVariance = 0;
    this.qualityFrameCount = 0;
  }

  /**
   * Process signal and calculate quality metrics
   *
   * @param {Float32Array} rawSignal - Raw PPG signal window
   * @param {Float32Array} detrendedSignal - Detrended PPG signal window
   * @returns {Object} Signal quality metrics
   */
  process(rawSignal, detrendedSignal) {
    // Compute FFT and PSD
    const fftResult = computeFFT(detrendedSignal, this.fftSize, this.sampleRate);

    // Calculate SNR from PSD
    const snrResult = calculateSNRFromPSD(
      fftResult.psd,
      fftResult.freqResolution,
      this.cardiacBandLow,
      this.cardiacBandHigh
    );

    // Calculate heart rate from peak frequency (Hz to BPM)
    const heartRate = snrResult.peakFrequency * 60;

    // Calculate IBI (Inter-Beat Interval) from heart rate
    let ibi = 0;
    if (heartRate > 0 && heartRate < 300) {
      ibi = Math.round(60000 / heartRate); // Convert BPM to milliseconds
    }

    // Calculate Perfusion Index
    const piResult = this.calculatePerfusionIndex(rawSignal, detrendedSignal);

    // Calculate signal stability
    const stability = this.calculateStability(piResult.variance);

    // Update quality status
    const qualityStatus = getQualityStatus(snrResult.snr_dB);

    // Generate guidance message
    const guidanceMessage = generateGuidance(snrResult.snr_dB, piResult.pi, stability);

    // Update quality frame counter
    if (snrResult.snr_dB >= 5) {
      this.qualityFrameCount += this.windowLength;
    }

    return {
      snr_dB: snrResult.snr_dB,
      perfusionIndex: piResult.pi,
      heartRate: Math.round(heartRate),
      ibi,
      signalStability: stability,
      qualityStatus,
      guidanceMessage,
      qualityFrameCount: this.qualityFrameCount,
      // Additional debug info
      signalPower: snrResult.signalPower,
      noisePower: snrResult.noisePower,
      peakFrequency: snrResult.peakFrequency
    };
  }

  /**
   * Calculate Perfusion Index
   * PI = (AC / DC) × 100%
   *
   * @param {Float32Array} rawSignal - Raw signal (DC component)
   * @param {Float32Array} detrendedSignal - Detrended signal (AC component)
   * @returns {Object} { pi, variance }
   */
  calculatePerfusionIndex(rawSignal, detrendedSignal) {
    const n = rawSignal.length;

    // DC component (mean of raw signal)
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rawSignal[i];
    }
    const dc = sum / n;

    // AC component (standard deviation of detrended signal)
    let variance = 0;
    for (let i = 0; i < n; i++) {
      variance += detrendedSignal[i] * detrendedSignal[i];
    }
    variance = variance / n;
    const ac = Math.sqrt(variance);

    // Perfusion Index as percentage
    const pi = (ac / (dc + 1e-10)) * 100;

    return { pi, variance };
  }

  /**
   * Calculate signal stability by comparing variance across windows
   *
   * @param {number} currentVariance - Current window variance
   * @returns {number} Stability ratio (0-1)
   */
  calculateStability(currentVariance) {
    if (this.previousVariance === 0) {
      this.previousVariance = currentVariance;
      return 1.0;
    }

    const varianceRatio = Math.min(currentVariance, this.previousVariance) /
                         (Math.max(currentVariance, this.previousVariance) + 1e-10);

    this.previousVariance = currentVariance;

    return varianceRatio;
  }

  /**
   * Reset processor state
   */
  reset() {
    this.previousVariance = 0;
    this.qualityFrameCount = 0;
  }
}
