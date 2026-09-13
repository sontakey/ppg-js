/**
 * Pure signal-processing building blocks (no DOM, no state): resampling,
 * zero-phase Butterworth filtering, spectral heart-rate estimation, peak
 * detection, interval validation and per-beat template quality. Use these
 * directly when you have your own capture path.
 */
export {
  Biquad, designBandpass, lowpassCoeffs, highpassCoeffs, bandpassCoeffs, magnitudeResponse, noiseGain,
  filtfilt, filtfiltPadded, filtfiltBandpass, filtfiltBandpassWithContext, resampleUniform, resampleToGrid
} from '../core/filter.js';
export type { BiquadCoeffs, BandpassDesign } from '../core/filter.js';
export { computeFFT, calculateSNRFromPSD, nextPowerOfTwo } from '../core/fft.js';
export type { FFTResult, SNRResult } from '../core/fft.js';
export {
  detectPeaks, detectPeaksDetailed, computeIBIs, heartRateFromIBIs, crossCheckHeartRate, slewLimit, rmssd,
  templateCorrelation, medianOf
} from '../core/peaks.js';
export type { DetectedPeak, IbiDetail, IbiResult, IbiRejectReason, CrossCheckResult, HeartRateSource } from '../core/peaks.js';
export { sdnn } from '../core/hrv.js';
export { detrend } from '../core/detrend.js';
export { estimateRespiration } from '../core/respiration.js';
export type { RespirationBeat, RespirationEstimate } from '../core/respiration.js';
export { evaluateQuality, DEFAULT_QUALITY } from '../core/quality.js';
export type { QualityInput, QualityResult, QualityThresholds, QualityCode } from '../core/quality.js';
export { FingerStateMachine, STATE, isFingerPresent, selectChannel, DEFAULT_FINGER_STATE, DEFAULT_PRESENCE } from '../core/fingerState.js';
export type { FingerState, FingerStateOptions, PresenceOptions } from '../core/fingerState.js';
