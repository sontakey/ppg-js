import { computeFFT, calculateSNRFromPSD } from './utils/fft.js';
import { getQualityStatus, generateGuidance } from './utils/helpers.js';
import { filtfiltBandpass } from './utils/filter.js';
import { detectPeaks, computeIBIs, heartRateFromIBIs, rmssd, crossCheckHeartRate, slewLimit } from './utils/peaks.js';
import { sdnn } from './utils/hrv.js';
import { evaluateQuality } from './utils/quality.js';

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

    // Rolling IBI history across windows, for HR/RMSSD smoothing.
    this.ibiHistoryMs = [];
    // Same accepted IBIs, each tagged with absolute session time, so
    // "accepted beats in the last 60s" (quality gate ibiCount) can be
    // computed without assuming a fixed window cadence.
    this.ibiHistoryTimed = [];
    // Continuous (non-overlapping-window) peak-time stream in absolute
    // session seconds. IBIs are computed over this whole stream, not
    // per-window, so the first/last peak of every 5s window isn't
    // spuriously flagged for "missing" a predecessor that's actually one
    // window back (see utils/peaks.js computeIBIs doc comment).
    this.peakHistorySec = [];

    // Slew-limited displayed heart rate (see utils/peaks.js slewLimit) -
    // survives across windows so a single glitchy window can't jump the
    // number the user sees by more than the cap.
    this.displayedHeartRate = 0;
  }

  /**
   * Process signal and calculate quality metrics
   *
   * @param {Float32Array} rawSignal - Raw PPG signal window
   * @param {Float32Array} detrendedSignal - Detrended PPG signal window
   * @param {number} [sampleRate] - actual measured sample rate for this
   *   window (falls back to this.sampleRate if not given, e.g. in tests
   *   that don't track timestamps)
   * @param {Object} [opts]
   * @param {string} [opts.fingerState='MEASURING'] - NO_FINGER/SETTLING/MEASURING
   *   (see utils/fingerState.js); only 'MEASURING' can produce a `good` window.
   * @param {number} [opts.nowSec] - absolute session time (seconds) at the
   *   end of this window, for the "beats in the last 60s" quality check.
   *   Defaults to the window's own duration if omitted (single-window tests).
   * @returns {Object} Signal quality metrics
   */
  process(rawSignal, detrendedSignal, sampleRate = this.sampleRate, opts = {}) {
    // Compute FFT and PSD (kept: coarse frequency-domain SNR/quality signal)
    const fftResult = computeFFT(detrendedSignal, this.fftSize, sampleRate);

    // Calculate SNR from PSD
    const snrResult = calculateSNRFromPSD(
      fftResult.psd,
      fftResult.freqResolution,
      this.cardiacBandLow,
      this.cardiacBandHigh
    );

    // Calculate heart rate from peak frequency (Hz to BPM) — coarse FFT estimate
    const heartRateFFT = snrResult.peakFrequency * 60;

    // FFT prior informs the peak detector's refractory period: expected IBI
    // from the dominant frequency, refractory = 0.6 * expected IBI (allows
    // faster beats through while still rejecting double-counts), clamped to
    // a sane 0.3-1.0s so a noisy/absent FFT peak can't produce a useless
    // refractory.
    const expectedIbiSec = heartRateFFT > 0 ? 60 / heartRateFFT : 0;
    const refractorySec = expectedIbiSec > 0
      ? Math.max(0.3, Math.min(1.0, 0.6 * expectedIbiSec))
      : 0.3;

    // Time-domain peak detection: bandpass the raw (non-detrended) signal so
    // filter zero-phase padding effects don't compound with the linear
    // detrend, then find systolic peaks and derive real per-beat IBI/HR/RMSSD.
    const filtered = filtfiltBandpass(rawSignal, sampleRate, this.cardiacBandLow, this.cardiacBandHigh);
    const windowDurationSec = rawSignal.length / sampleRate;
    const nowSec = opts.nowSec ?? windowDurationSec;
    const windowStartSec = nowSec - windowDurationSec;
    const peakTimes = detectPeaks(filtered, sampleRate, refractorySec);
    const absolutePeakTimes = peakTimes.map(t => windowStartSec + t);

    // Windows are contiguous/non-overlapping (caller advances nowSec by
    // windowDurationSec each call), so appending is safe without dedupe
    // beyond "later than the last one we have".
    for (const t of absolutePeakTimes) {
      if (!this.peakHistorySec.length || t > this.peakHistorySec[this.peakHistorySec.length - 1]) {
        this.peakHistorySec.push(t);
      }
    }
    // Keep a little more than 60s so computeIBIs' rolling-median rejection
    // has history at the start of the retained window too.
    this.peakHistorySec = this.peakHistorySec.filter(t => nowSec - t <= 70);

    const continuous = computeIBIs(this.peakHistorySec);
    const ibiDetails = continuous.details.filter(d => d.peakTimeSec >= windowStartSec);
    this.ibiHistoryMs = continuous.ibisMs.slice(-40);
    this.ibiHistoryTimed = continuous.details
      .filter(d => d.valid && nowSec - d.peakTimeSec <= 60)
      .map(d => ({ ms: d.ibiMs, t: d.peakTimeSec }));

    const last60sDetails = continuous.details.filter(d => nowSec - d.peakTimeSec <= 60);
    const artifactCount = last60sDetails.filter(d => !d.valid).length;
    const totalCount = last60sDetails.length;

    const heartRateIBI = heartRateFromIBIs(this.ibiHistoryMs);
    // Cross-check the IBI-median HR against the independent FFT estimate -
    // catches a run of missed beats that computeIBIs' own median-based
    // rejection can't see because the median has already drifted with them
    // (see utils/peaks.js crossCheckHeartRate doc comment).
    const { heartRate: crossCheckedHr, source: heartRateSource, disagree: ibiFftDisagree } =
      crossCheckHeartRate(heartRateIBI, heartRateFFT);
    const heartRate = crossCheckedHr || heartRateFFT;

    // Slew-limit what's actually displayed so one glitchy window can't jump
    // the number by more than 8bpm; callers that want the raw value use
    // `heartRate` above (also returned) while `heartRate` returned to the
    // UI is the slewed one - see displayedHeartRate below.
    this.displayedHeartRate = slewLimit(this.displayedHeartRate, heartRate);

    const ibi = this.ibiHistoryMs.length ? Math.round(this.ibiHistoryMs[this.ibiHistoryMs.length - 1]) : 0;
    const rmssdMs = rmssd(this.ibiHistoryMs);
    const sdnnMs = sdnn(this.ibiHistoryTimed.map(e => e.ms));
    const artifactRatio = totalCount > 0 ? artifactCount / totalCount : 0;

    // Strict per-window quality gate (see utils/quality.js) - HR/RMSSD/SDNN
    // and tachogram points are only trustworthy when `good` is true.
    const fingerState = opts.fingerState || 'MEASURING';
    const quality = evaluateQuality({
      state: fingerState,
      acdc: opts.acDcRatio ?? 0,
      artifactRatio,
      ibiCount: this.ibiHistoryTimed.length,
      fftAgree: !ibiFftDisagree
    });

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
      heartRate: quality.good ? Math.round(this.displayedHeartRate) : 0,
      heartRateRaw: Math.round(heartRate),
      heartRateSource,
      ibiFftDisagree,
      ibi,
      rmssd: quality.good ? rmssdMs : 0,
      sdnn: quality.good ? sdnnMs : 0,
      artifactRatio,
      sampleRate,
      signalStability: stability,
      qualityStatus,
      guidanceMessage,
      qualityFrameCount: this.qualityFrameCount,
      quality,
      // Additional debug info
      signalPower: snrResult.signalPower,
      noisePower: snrResult.noisePower,
      peakFrequency: snrResult.peakFrequency,
      heartRateFFT: Math.round(heartRateFFT),
      // Raw per-window detections, for the debug recorder / replay
      // comparison (see utils/recorder.js, tools/replay.js). Not used by
      // the UI.
      peakTimesSec: peakTimes,
      ibiDetails
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
    this.ibiHistoryMs = [];
    this.ibiHistoryTimed = [];
    this.peakHistorySec = [];
    this.displayedHeartRate = 0;
  }
}
