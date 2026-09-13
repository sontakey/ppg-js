/**
 * @sontakey/ppg-js - camera PPG in the browser: heart rate, pulse-rate
 * variability, respiration and signal quality from a fingertip on the
 * rear camera. Zero dependencies, no UI.
 *
 * Layers:
 *   PPG / PPGMonitor  - camera capture + engine + typed events (this file)
 *   PpgEngine         - source-agnostic streaming core (also `./engine`)
 *   dsp               - pure DSP building blocks (also `@sontakey/ppg-js/dsp`)
 *   hrv               - IBI array -> HRV metrics (also `@sontakey/ppg-js/hrv`)
 *   sources           - BLE chest strap, array replay (also `@sontakey/ppg-js/sources`)
 */
import { PPG } from './core/PPG.js';
import { PPGMonitor } from './core/PPGMonitor.js';
import { PpgEngine, DEFAULT_ENGINE_OPTIONS } from './core/engine.js';
import { PPGError } from './core/errors.js';
import { STATE } from './core/fingerState.js';
import * as dsp from './dsp/index.js';
import * as hrv from './hrv/index.js';
import * as sources from './sources/index.js';

export { PPG, PPGMonitor, PpgEngine, DEFAULT_ENGINE_OPTIONS, PPGError, STATE, dsp, hrv, sources };
export default PPG;

export type { PPGOptions, PPGMetrics, PPGCapabilities, PPGState, PPGEvent, PPGEventMap, PPGBeat } from './core/PPG.js';
export type { EngineOptions, EngineSample, EngineWindow, PushResult, TachogramPoint, SessionSummary } from './core/engine.js';
export type { PPGErrorCode } from './core/errors.js';
export type { MonitorOptions, MonitorUserOptions, CameraOptions, RoiOptions, DebugOptions, ReadyInfo } from './core/helpers.js';
export type { DebugLog, RecordedSample, RecordedEvent } from './core/recorder.js';
export type { QualityResult, QualityThresholds, QualityCode } from './core/quality.js';
export type { FingerState, FingerStateOptions, PresenceOptions } from './core/fingerState.js';
export type { RespirationEstimate } from './core/respiration.js';

// Commonly used DSP helpers re-exported at the root for convenience.
export { computeFFT, calculateSNRFromPSD } from './core/fft.js';
export { detrend } from './core/detrend.js';
export { filtfiltBandpass, resampleUniform } from './core/filter.js';
export { detectPeaks, computeIBIs, heartRateFromIBIs, rmssd, crossCheckHeartRate } from './core/peaks.js';
export { sdnn } from './core/hrv.js';
export { evaluateQuality } from './core/quality.js';
export { coachingMessage, qualityScore } from './core/coaching.js';
