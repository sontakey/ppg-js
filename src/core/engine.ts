/**
 * PpgEngine: the source-agnostic, timestamp-native streaming core.
 *
 * Feed it one sample per camera frame ({ t, r, g, b, clipped?, motion? })
 * and it runs the finger state machine every sample and the full window
 * analysis (resample -> bandpass -> spectral HR -> peaks -> IBI validation
 * -> quality gate -> HR/HRV/respiration) every `hopSec` seconds of signal
 * time. The same instance drives the live camera path (PPGMonitor) and the
 * offline replay tool, so the two cannot drift apart.
 *
 * Time handling (docs/audit findings A3, A4, A9): every window is
 * interpolated onto one absolute uniform grid derived from the sample
 * timestamps, window length is in seconds, and peak times are absolute, so
 * dropped or late frames do not shift beats and cross-window intervals are
 * exact.
 */
import { designBandpass, filtfiltPadded, noiseGain, resampleToGrid, type BandpassDesign } from './filter.js';
import { computeFFT, calculateSNRFromPSD } from './fft.js';
import {
  detectPeaksDetailed, computeIBIs, heartRateFromIBIs, rmssd, crossCheckHeartRate, slewLimit,
  templateCorrelation, medianOf, type IbiDetail, type HeartRateSource
} from './peaks.js';
import { sdnn } from './hrv.js';
import { evaluateQuality, DEFAULT_QUALITY, type QualityResult, type QualityThresholds } from './quality.js';
import { FingerStateMachine, STATE, selectChannel, DEFAULT_FINGER_STATE, type FingerState, type FingerStateOptions } from './fingerState.js';
import { estimateRespiration, type RespirationBeat, type RespirationEstimate } from './respiration.js';
import { getQualityStatus } from './helpers.js';

export interface EngineSample {
  /** Seconds, monotonic, any origin (the engine only uses differences). */
  t: number;
  r: number;
  g: number;
  b: number;
  /** Fraction of ROI pixels at/near saturation in the red channel (0-1). */
  clipped?: number;
  /** Device motion magnitude (m/s^2 deviation from 1 g), if a motion source is attached. */
  motion?: number;
}

export interface EngineOptions {
  /** Analysis window length, seconds. */
  windowSec: number;
  /** Interval between window analyses, seconds (defaults to windowSec). */
  hopSec: number;
  /** Seconds of signal before the window fed to the filter as warm-up context. */
  contextSec: number;
  /** Uniform analysis grid rate, Hz. */
  gridHz: number;
  /** Heart-rate search band, Hz. */
  cardiacBandLow: number;
  cardiacBandHigh: number;
  /** Minimum channel DC (0-255) for a channel to be eligible. */
  minChannelDc: number;
  /** Beats within this many seconds of the window end are deferred to the next window (filter edge). */
  edgeGuardSec: number;
  /** Max displayed HR change per window, bpm. */
  hrSlewPerWindow: number;
  fingerState: Partial<FingerStateOptions>;
  quality: Partial<QualityThresholds>;
  /** Minimum FFT size hint (actual size is auto-padded). */
  fftSize: number;
  /** Compute the per-beat template SQI (cheap, on by default). */
  templateSqi: boolean;
  /** Estimate respiration from the pulse train (needs >= 40 s of accepted beats). */
  respiration: boolean;
  /** When an interval is ~2x the recent median, look for a weaker beat inside the gap
   *  (a beat whose amplitude dipped under the adaptive threshold) before rejecting it. */
  recoverMissedBeats: boolean;
  /** Optional hook receiving per-window internals (detections, acceptance bounds) for tooling. */
  onDebug?: (info: EngineDebugInfo) => void;
}

export interface EngineDebugInfo {
  windowEnd: number;
  segStart: number;
  gridStart: number;
  detectedSec: number[];
  acceptFrom: number;
  acceptUntil: number;
  acceptedSec: number[];
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  windowSec: 5,
  hopSec: 5,
  contextSec: 3,
  gridHz: 60,
  cardiacBandLow: 0.75,
  cardiacBandHigh: 4.0,
  minChannelDc: 40,
  edgeGuardSec: 1.2,
  hrSlewPerWindow: 8,
  fingerState: {},
  quality: {},
  fftSize: 256,
  templateSqi: true,
  respiration: true,
  recoverMissedBeats: true
};

export interface TachogramPoint {
  /** Absolute time (seconds, engine clock) of the beat ending the interval. */
  t: number;
  ibiMs: number;
  valid: boolean;
  reason: string | null;
  /** true when the window that produced this point passed the quality gate. */
  good: boolean;
  /** true when either end of the interval is a recovered weak beat: fine for
   *  heart rate and beat counting, too imprecise for variability metrics. */
  lowSnr: boolean;
}

export interface EngineWindow {
  /** Window end, seconds (engine clock). */
  t: number;
  windowStartSec: number;
  fingerState: FingerState;
  selectedChannel: 'red' | 'green';
  /** Measured camera sample rate over the window, Hz. */
  sampleRate: number;
  sampleCount: number;
  gridHz: number;
  redDc: number;
  greenDc: number;
  clippedFraction: number;
  motion: number;
  /** Pulsatile amplitude / DC of the selected channel (median per-beat, bandpassed). */
  acDcRatio: number;
  /** Raw peak-to-peak / DC over the window - a motion/drift indicator, not pulse. */
  rawRangeRatio: number;
  perfusionIndex: number;
  snr_dB: number;
  heartRate: number;
  heartRateRaw: number;
  heartRateFFT: number;
  heartRateIBI: number;
  heartRateSource: HeartRateSource;
  ibiFftDisagree: boolean;
  harmonicCorrected: boolean;
  ibi: number;
  rmssd: number;
  sdnn: number;
  artifactRatio: number;
  templateSqi: number;
  /** Median 1-sigma beat timing uncertainty from the vertex fits, ms. */
  timingUncertaintyMs: number;
  /** RMSSD that pure timing noise of that size would produce (2 sigma), ms. */
  rmssdFloorMs: number;
  signalStability: number;
  qualityStatus: string;
  qualityScore: number;
  guidanceMessage: string;
  settleRemainingSec: number;
  quality: QualityResult;
  /** Absolute peak times (seconds) newly accepted in this window. */
  peakTimesSec: number[];
  /** IBIs newly produced in this window, with the window's good flag. */
  ibiDetails: Array<IbiDetail & { good: boolean; lowSnr: boolean }>;
  respiration: RespirationEstimate | null;
  /** Filtered (bandpassed) signal of the window on the grid, oldest first. */
  filtered: Float64Array;
  /** Skipped because too few samples arrived (gap); other fields are zero. */
  gap: boolean;
}

export interface PushResult {
  state: FingerState;
  stateChanged: boolean;
  stateReason: string | null;
  present: boolean;
  /** Real-time display waveform sample (baseline-removed, inverted red). */
  waveform: number;
  window: EngineWindow | null;
}

const TIMING_SIGMA_CALIBRATION = 4.7;

interface StoredPeak { t: number; sigma: number; amplitude: number; baseline: number; valid: boolean; lowSnr?: boolean; }

export class PpgEngine {
  readonly opts: EngineOptions;
  readonly fingerState: FingerStateMachine;
  private readonly quality: QualityThresholds;

  // Raw sample store (bounded to what a window + context needs).
  private ts: number[] = [];
  private rs: number[] = [];
  private gs: number[] = [];
  private bs: number[] = [];
  private cl: number[] = [];
  private mo: number[] = [];

  private firstT: number | null = null;
  private nextWindowEnd: number | null = null;
  private analysisResetAt = -Infinity;
  private selectedChannel: 'red' | 'green' = 'red';
  private lastAcDcRatio = 0;
  private peaks: StoredPeak[] = [];
  private lastPeakT = -Infinity;
  private lastReportedPeakT = -Infinity;
  private displayedHr = 0;
  private previousVariance = 0;
  private design: BandpassDesign | null = null;
  private designNoiseGain = 1;
  private wfBaseline: number | null = null;
  private wfLastT: number | null = null;
  private lastWindowValue: EngineWindow | null = null;

  /** Session-long tachogram (every candidate IBI, tagged valid/good). */
  readonly tachogram: TachogramPoint[] = [];
  /** Per-window good/HR/HRV log for session summaries. */
  readonly windows: Array<{ t: number; good: boolean; heartRate: number; rmssd: number; sdnn: number }> = [];

  constructor(options: Partial<EngineOptions> = {}) {
    this.opts = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...options,
      fingerState: { ...(options.fingerState || {}) },
      quality: { ...(options.quality || {}) }
    };
    if (options.hopSec === undefined) this.opts.hopSec = this.opts.windowSec;
    this.quality = { ...DEFAULT_QUALITY, ...this.opts.quality };
    const fsOpts: Partial<FingerStateOptions> = { minAcDcRatio: this.quality.minAcDc, ...this.opts.fingerState };
    this.fingerState = new FingerStateMachine(fsOpts);
  }

  /** Effective thresholds, for the debug log. */
  get config(): { engine: EngineOptions; quality: QualityThresholds; fingerState: FingerStateOptions } {
    return { engine: this.opts, quality: this.quality, fingerState: this.fingerState.opts };
  }

  get lastWindow(): EngineWindow | null { return this.lastWindowValue; }
  get state(): FingerState { return this.fingerState.state; }
  get channel(): 'red' | 'green' { return this.selectedChannel; }

  /** Drop all signal state (a new placement or a camera re-acquire). Keeps the tachogram. */
  reset(): void {
    this.ts = []; this.rs = []; this.gs = []; this.bs = []; this.cl = []; this.mo = [];
    this.firstT = null; this.nextWindowEnd = null; this.analysisResetAt = -Infinity;
    this.peaks = []; this.lastPeakT = -Infinity; this.lastReportedPeakT = -Infinity;
    this.displayedHr = 0; this.previousVariance = 0; this.wfBaseline = null; this.wfLastT = null;
    this.lastAcDcRatio = 0; this.lastWindowValue = null;
    (this as { fingerState: FingerStateMachine }).fingerState = new FingerStateMachine({ minAcDcRatio: this.quality.minAcDc, ...this.opts.fingerState });
  }

  /** Reset only the analysis (peaks/filter state) - used on a SETTLING entry. */
  private resetAnalysis(t: number): void {
    this.analysisResetAt = t;
    this.peaks = []; this.lastPeakT = -Infinity; this.lastReportedPeakT = -Infinity;
    this.displayedHr = 0; this.previousVariance = 0;
    this.nextWindowEnd = t + this.opts.windowSec;
    this.lastAcDcRatio = 0;
  }

  push(sample: EngineSample): PushResult {
    const t = sample.t;
    if (this.firstT === null) {
      this.firstT = t;
      this.nextWindowEnd = t + this.opts.windowSec;
    }
    // Non-monotonic input (clock repair upstream failed): ignore the sample.
    if (this.ts.length && t <= this.ts[this.ts.length - 1]) {
      return { state: this.fingerState.state, stateChanged: false, stateReason: null, present: false, waveform: 0, window: null };
    }
    this.ts.push(t); this.rs.push(sample.r); this.gs.push(sample.g); this.bs.push(sample.b);
    this.cl.push(sample.clipped ?? 0); this.mo.push(sample.motion ?? 0);
    const keepSec = this.opts.windowSec + this.opts.contextSec + this.opts.hopSec + 1;
    while (this.ts.length && t - this.ts[0] > keepSec) {
      this.ts.shift(); this.rs.shift(); this.gs.shift(); this.bs.shift(); this.cl.shift(); this.mo.shift();
    }

    // Real-time display waveform: inverted red with a slow baseline removed
    // (1st-order high-pass, ~0.5 s time constant). Not used for analysis.
    const x = 1 - sample.r / 255;
    if (this.wfBaseline === null || this.wfLastT === null) { this.wfBaseline = x; }
    else {
      const dt = Math.max(1e-3, Math.min(0.2, t - this.wfLastT));
      const alpha = dt / (0.5 + dt);
      this.wfBaseline += alpha * (x - this.wfBaseline);
    }
    this.wfLastT = t;
    const waveform = x - this.wfBaseline;

    const fs = this.fingerState.update({ tSec: t, redMean: sample.r, greenMean: sample.g, blueMean: sample.b, acDcRatio: this.lastAcDcRatio });
    if (fs.changed && fs.state === STATE.SETTLING) this.resetAnalysis(t);

    let window: EngineWindow | null = null;
    if (this.nextWindowEnd !== null && t >= this.nextWindowEnd) {
      const end = this.nextWindowEnd;
      window = this.analyzeWindow(end, fs.state);
      // Advance; if we fell far behind (a long gap), realign to now.
      this.nextWindowEnd = end + this.opts.hopSec;
      if (t - this.nextWindowEnd > this.opts.hopSec) this.nextWindowEnd = t + this.opts.hopSec;
      this.lastWindowValue = window;
    }
    return { state: fs.state, stateChanged: fs.changed, stateReason: fs.reason, present: fs.present, waveform, window };
  }

  private designFor(gridHz: number): BandpassDesign {
    if (!this.design || this.design.sampleRate !== gridHz) {
      // Corners just outside the HR search band so the band itself is flat.
      this.design = designBandpass(gridHz, this.opts.cardiacBandLow * 0.8, this.opts.cardiacBandHigh * 1.15, 4, 2);
      this.designNoiseGain = noiseGain(this.design);
    }
    return this.design;
  }

  private emptyWindow(end: number, state: FingerState, sampleRate: number, sampleCount: number, gap: boolean): EngineWindow {
    const q = evaluateQuality({ state, acdc: 0, artifactRatio: 0, ibiCount: 0, fftAgree: true }, this.quality);
    const settleRemainingSec = state === STATE.SETTLING ? Math.max(0, this.fingerState.settleSec - this.fingerState.timeInState(end)) : 0;
    return {
      t: end, windowStartSec: end - this.opts.windowSec, fingerState: state, selectedChannel: this.selectedChannel,
      sampleRate, sampleCount, gridHz: this.opts.gridHz, redDc: 0, greenDc: 0, clippedFraction: 0, motion: 0,
      acDcRatio: 0, rawRangeRatio: 0, perfusionIndex: 0, snr_dB: 0, heartRate: 0, heartRateRaw: 0, heartRateFFT: 0, heartRateIBI: 0,
      heartRateSource: 'none', ibiFftDisagree: false, harmonicCorrected: false, ibi: 0, rmssd: 0, sdnn: 0, artifactRatio: 0,
      templateSqi: NaN, timingUncertaintyMs: 0, rmssdFloorMs: 0, signalStability: 0, qualityStatus: 'Initializing',
      qualityScore: 0, guidanceMessage: q.reason || '', settleRemainingSec, quality: q, peakTimesSec: [], ibiDetails: [],
      respiration: null, filtered: new Float64Array(0), gap
    };
  }

  private analyzeWindow(end: number, state: FingerState): EngineWindow {
    const o = this.opts;
    const winStart = end - o.windowSec;
    const segStart = Math.max(this.analysisResetAt, winStart - o.contextSec, this.ts.length ? this.ts[0] : -Infinity);

    // Window-portion sample stats.
    let n = 0, tFirst = Infinity, tLast = -Infinity, rSum = 0, gSum = 0, cSum = 0, mMax = 0, rMin = Infinity, rMax = -Infinity;
    for (let i = 0; i < this.ts.length; i++) {
      const t = this.ts[i];
      if (t < winStart || t > end) continue;
      n++; if (t < tFirst) tFirst = t; if (t > tLast) tLast = t;
      rSum += this.rs[i]; gSum += this.gs[i]; cSum += this.cl[i];
      if (this.mo[i] > mMax) mMax = this.mo[i];
      if (this.rs[i] < rMin) rMin = this.rs[i]; if (this.rs[i] > rMax) rMax = this.rs[i];
    }
    const sampleRate = n > 1 && tLast > tFirst ? (n - 1) / (tLast - tFirst) : 0;
    // A window with less than ~40% of its expected samples (relative to the
    // rate the rest of the session shows) is a gap: skip it.
    const expected = sampleRate > 0 ? sampleRate * o.windowSec : 0;
    if (n < 10 || (expected > 0 && n < 0.4 * expected)) {
      const w = this.emptyWindow(end, state, sampleRate, n, true);
      this.windows.push({ t: end, good: false, heartRate: 0, rmssd: 0, sdnn: 0 });
      return w;
    }
    const redDc = rSum / n, greenDc = gSum / n, clippedFraction = cSum / n;

    if (state !== STATE.MEASURING) {
      // Still compute channel amplitude so the state machine's acdc streak can be satisfied.
      const amp = this.channelAmplitudes(segStart, winStart, end, redDc, greenDc);
      this.lastAcDcRatio = amp.acDcRatio;
      this.selectedChannel = amp.channel;
      const w = this.emptyWindow(end, state, sampleRate, n, false);
      w.redDc = redDc; w.greenDc = greenDc; w.clippedFraction = clippedFraction; w.motion = mMax;
      w.acDcRatio = amp.acDcRatio; w.rawRangeRatio = redDc > 0 ? (rMax - rMin) / redDc : 0; w.selectedChannel = amp.channel;
      w.filtered = amp.filtered;
      this.windows.push({ t: end, good: false, heartRate: 0, rmssd: 0, sdnn: 0 });
      return w;
    }

    // ---- Grid + filter over [segStart, end] ------------------------------
    const gridHz = o.gridHz;
    const dt = 1 / gridHz;
    const gridStart = Math.ceil(segStart * gridHz) / gridHz;
    const count = Math.max(2, Math.floor((end - gridStart) * gridHz) + 1);
    const idx0 = this.ts.findIndex(t => t >= segStart - dt);
    const tSeg = this.ts.slice(Math.max(0, idx0));
    const redSeg = this.rs.slice(Math.max(0, idx0));
    const greenSeg = this.gs.slice(Math.max(0, idx0));
    const redGrid = resampleToGrid(tSeg, redSeg, gridStart, dt, count);
    const greenGrid = resampleToGrid(tSeg, greenSeg, gridStart, dt, count);
    const design = this.designFor(gridHz);
    const padLen = Math.min(count - 1, Math.round(2 * gridHz));
    const filterChannel = (grid: Float64Array): Float64Array => {
      // Inverted so systole (more absorption, less light) is a maximum;
      // mean-removed and reflection-padded at both ends so neither pass's
      // start-up transient lands inside the segment.
      const inv = new Float64Array(count);
      for (let i = 0; i < count; i++) inv[i] = -grid[i];
      return filtfiltPadded(design, inv, padLen);
    };
    const redF = filterChannel(redGrid);
    const greenF = filterChannel(greenGrid);
    const winIdx0 = Math.max(0, Math.round((winStart - gridStart) * gridHz));

    // ---- Channel selection by pulsatile amplitude -----------------------
    const spread = (f: Float64Array): number => {
      const arr = Array.from(f.subarray(winIdx0)).sort((a, b) => a - b);
      if (arr.length < 4) return 0;
      return arr[Math.floor(arr.length * 0.95)] - arr[Math.floor(arr.length * 0.05)];
    };
    const redEligible = redDc > o.minChannelDc, greenEligible = greenDc > o.minChannelDc;
    const redRatio = redEligible ? spread(redF) / redDc : 0;
    const greenRatio = greenEligible ? spread(greenF) / greenDc : 0;
    this.selectedChannel = (redEligible || greenEligible) ? selectChannel(this.selectedChannel, redRatio, greenRatio) : 'red';
    const filtered = this.selectedChannel === 'green' ? greenF : redF;
    const rawGrid = this.selectedChannel === 'green' ? greenGrid : redGrid;
    const dc = this.selectedChannel === 'green' ? greenDc : redDc;

    // ---- Spectral HR + SNR on the linearly detrended raw window ----------
    const rawWin = rawGrid.subarray(winIdx0);
    const detr = linearDetrend(rawWin);
    for (let i = 0; i < detr.length; i++) detr[i] = -detr[i];
    const fft = computeFFT(detr, o.fftSize, gridHz);
    const snr = calculateSNRFromPSD(fft.psd, fft.freqResolution, o.cardiacBandLow, o.cardiacBandHigh);
    const heartRateFFT = snr.peakFrequency * 60;
    const expectedIbiSec = heartRateFFT > 0 ? 60 / heartRateFFT : 0;
    const refractorySec = expectedIbiSec > 0 ? Math.max(0.3, Math.min(1.0, 0.6 * expectedIbiSec)) : 0.3;

    // ---- Peaks (absolute times) -------------------------------------------
    const fitHalfWidthSec = Math.min(0.3, 0.35 * (expectedIbiSec || 0.8));
    const detected = detectPeaksDetailed(filtered, gridHz, refractorySec, 2.0, fitHalfWidthSec);
    // Independent noise estimate for the timing uncertainty: MAD of the
    // second difference of the raw native samples in the window (white
    // noise gives std * sqrt(6)), scaled by the filter's noise gain. The
    // fit residual cannot be used because interpolation onto the grid
    // makes the noise smooth and the residual optimistic.
    const rawNoise = Math.max(0.1, secondDifferenceNoise(this.rs, this.ts, winStart, end));
    const filteredNoise = rawNoise * this.designNoiseGain;
    const peakSamples = detected.map(p => p.refined);
    const tc = o.templateSqi ? templateCorrelation(filtered, gridHz, peakSamples) : { perBeat: detected.map(() => NaN), median: NaN };
    const acceptUntil = end - o.edgeGuardSec;
    const acceptFrom = Math.max(this.lastPeakT + 0.25, this.analysisResetAt + 0.8);
    const newPeaks: StoredPeak[] = [];
    detected.forEach((p, i) => {
      const t = gridStart + p.refined * dt;
      if (t <= acceptFrom || t > acceptUntil) return;
      // Per-beat amplitude: peak minus the minimum in the preceding 60% of an expected IBI.
      const back = Math.round(Math.max(3, (expectedIbiSec || 0.8) * 0.6 * gridHz));
      let trough = p.amplitude;
      for (let k = Math.max(0, p.idx - back); k < p.idx; k++) if (filtered[k] < trough) trough = filtered[k];
      const corr = tc.perBeat[i];
      const valid = !(typeof corr === 'number' && !Number.isNaN(corr) && corr < this.quality.minTemplateSqi);
      const gi = Math.min(count - 1, Math.max(0, p.idx));
      // Vertex uncertainty for white noise is s / (2|a| sqrt(Sxx)). The
      // interpolated grid, 8-bit quantisation and the parabola's mismatch
      // to a real pulse all make that optimistic; TIMING_SIGMA_CALIBRATION
      // is the median ratio of measured to theoretical error over 54
      // simulator conditions (24-60 fps, noise 0.3-1.2 counts, amplitude
      // 2-5 counts, quantised and not), accurate to roughly +-50%.
      const sigmaSamples = p.curvature < 0 && p.sxx > 0
        ? TIMING_SIGMA_CALIBRATION * filteredNoise / (2 * Math.abs(p.curvature) * Math.sqrt(p.sxx))
        : p.sigmaSec * gridHz;
      newPeaks.push({ t, sigma: Math.min(0.1, sigmaSamples * dt), amplitude: p.amplitude - trough, baseline: rawGrid[gi], valid });
    });
    if (o.recoverMissedBeats) this.recoverMissedBeats(newPeaks, filtered, gridStart, dt, rawGrid, acceptFrom, acceptUntil);
    for (const p of newPeaks) { this.peaks.push(p); this.lastPeakT = p.t; }
    if (o.onDebug) o.onDebug({ windowEnd: end, segStart, gridStart, detectedSec: detected.map(p => gridStart + p.refined * dt), acceptFrom, acceptUntil, acceptedSec: newPeaks.map(p => p.t) });
    this.peaks = this.peaks.filter(p => end - p.t <= 70);

    // ---- IBIs over the continuous peak stream -----------------------------
    const cont = computeIBIs(this.peaks.map(p => p.t), 300, 2000, 0.3, this.peaks.map(p => p.valid));
    // An interval is low-SNR when either of its peaks was a recovered weak beat.
    const lowSnrAt = new Map<number, boolean>();
    for (let i = 1; i < this.peaks.length; i++) lowSnrAt.set(this.peaks[i].t, !!(this.peaks[i].lowSnr || this.peaks[i - 1].lowSnr));
    const withSnr = cont.details.map(d => ({ ...d, lowSnr: lowSnrAt.get(d.peakTimeSec) === true }));
    const newDetails = withSnr.filter(d => d.peakTimeSec > this.lastReportedPeakT);
    if (newPeaks.length) this.lastReportedPeakT = newPeaks[newPeaks.length - 1].t;
    const last60 = withSnr.filter(d => end - d.peakTimeSec <= 60);
    // Heart rate and the beat count use every accepted interval; variability
    // metrics use only intervals between confidently timed beats.
    const accepted60 = last60.filter(d => d.valid).map(d => d.ibiMs);
    const hrv60 = last60.filter(d => d.valid && !d.lowSnr).map(d => d.ibiMs);
    const artifactRatio = last60.length ? last60.filter(d => !d.valid).length / last60.length : 0;

    // Pulsatile amplitude from accepted beats in the window (median per-beat), fall back to the spread.
    const winBeats = newPeaks.filter(p => p.valid);
    const beatAmp = winBeats.length >= 2 ? medianOf(winBeats.map(p => p.amplitude)) : spread(filtered);
    const acDcRatio = dc > 0 ? beatAmp / dc : 0;
    this.lastAcDcRatio = acDcRatio;

    // ---- HR ---------------------------------------------------------------
    const heartRateIBI = heartRateFromIBIs(cont.ibisMs.slice(-40));
    const xc = crossCheckHeartRate(heartRateIBI, heartRateFFT);
    const heartRateRaw = xc.heartRate || heartRateFFT;
    this.displayedHr = slewLimit(this.displayedHr, heartRateRaw, o.hrSlewPerWindow);

    // ---- Timing uncertainty / RMSSD floor ---------------------------------
    const sig = this.peaks.filter(p => end - p.t <= 60).map(p => p.sigma);
    const timingUncertaintyMs = sig.length ? medianOf(sig) * 1000 : 0;
    const rmssdFloorMs = 2 * timingUncertaintyMs;

    // ---- Quality gate -----------------------------------------------------
    const quality = evaluateQuality({
      state, acdc: acDcRatio, artifactRatio, ibiCount: accepted60.length, fftAgree: !xc.disagree,
      disagreeKind: xc.disagreeKind, clippedFraction, motion: mMax, templateSqi: tc.median
    }, this.quality);

    const rmssdMs = rmssd(hrv60);
    const sdnnMs = sdnn(hrv60);
    const ibi = cont.ibisMs.length ? Math.round(cont.ibisMs[cont.ibisMs.length - 1]) : 0;

    // ---- Respiration ------------------------------------------------------
    let respiration: RespirationEstimate | null = null;
    if (o.respiration) {
      const validPeaks = this.peaks.filter(p => p.valid && end - p.t <= 60);
      if (validPeaks.length >= 30 && validPeaks[validPeaks.length - 1].t - validPeaks[0].t >= 40) {
        const beats: RespirationBeat[] = [];
        for (let i = 1; i < validPeaks.length; i++) {
          const ibiMs = (validPeaks[i].t - validPeaks[i - 1].t) * 1000;
          if (ibiMs < 300 || ibiMs > 2000) continue;
          beats.push({ t: validPeaks[i].t, ibiMs, amplitude: validPeaks[i].amplitude, baseline: validPeaks[i].baseline });
        }
        respiration = estimateRespiration(beats);
      }
    }

    // ---- Perfusion / stability / legacy status ----------------------------
    const filteredWin = filtered.subarray(winIdx0);
    let varSum = 0;
    for (let i = 0; i < filteredWin.length; i++) varSum += filteredWin[i] * filteredWin[i];
    const variance = filteredWin.length ? varSum / filteredWin.length : 0;
    const signalStability = this.stability(variance);
    const perfusionIndex = acDcRatio * 100;
    const qualityStatus = getQualityStatus(snr.snr_dB);
    const qualityScore = quality.good ? scoreFrom(acDcRatio, artifactRatio, this.quality.minAcDc) : 0;

    const ibiDetails = newDetails.map(d => ({ ...d, good: quality.good }));
    for (const d of ibiDetails) this.tachogram.push({ t: d.peakTimeSec, ibiMs: d.ibiMs, valid: d.valid, reason: d.reason, good: quality.good, lowSnr: d.lowSnr });
    const heartRate = quality.good ? Math.round(this.displayedHr) : 0;
    this.windows.push({ t: end, good: quality.good, heartRate, rmssd: quality.good ? rmssdMs : 0, sdnn: quality.good ? sdnnMs : 0 });

    return {
      t: end, windowStartSec: winStart, fingerState: state, selectedChannel: this.selectedChannel,
      sampleRate, sampleCount: n, gridHz, redDc, greenDc, clippedFraction, motion: mMax,
      acDcRatio, rawRangeRatio: redDc > 0 ? (rMax - rMin) / redDc : 0, perfusionIndex, snr_dB: snr.snr_dB,
      heartRate, heartRateRaw: Math.round(heartRateRaw), heartRateFFT: Math.round(heartRateFFT * 10) / 10,
      heartRateIBI: Math.round(heartRateIBI * 10) / 10, heartRateSource: xc.source, ibiFftDisagree: xc.disagree,
      harmonicCorrected: snr.harmonicCorrected, ibi, rmssd: quality.good ? rmssdMs : 0, sdnn: quality.good ? sdnnMs : 0,
      artifactRatio, templateSqi: tc.median, timingUncertaintyMs, rmssdFloorMs, signalStability, qualityStatus,
      qualityScore, guidanceMessage: quality.reason || '', settleRemainingSec: 0, quality,
      peakTimesSec: newPeaks.map(p => p.t), ibiDetails, respiration, filtered: Float64Array.from(filteredWin), gap: false
    };
  }

  /**
   * Missed-beat recovery: when the interval between two candidate peaks is
   * 1.6-2.4x the recent interval, a beat whose amplitude fell under the
   * 0.4 x envelope threshold probably sits in the middle. Accept the
   * largest local maximum in the middle 30-70% of the gap if it is at least
   * 12% of the neighbouring peaks' amplitude and clearly above the local
   * noise. HeartPy's adaptive threshold recovers these; without this step a
   * signal with one weak beat in five loses whole windows to the artifact
   * ratio. Mutates `newPeaks` in place (kept sorted).
   */
  private recoverMissedBeats(newPeaks: StoredPeak[], filtered: Float64Array, gridStart: number, dt: number, rawGrid: Float64Array, acceptFrom: number, acceptUntil: number): void {
    const prevTail = this.peaks.slice(-6).map(p => p.t);
    const seq = [...prevTail, ...newPeaks.map(p => p.t)].sort((a, b) => a - b);
    const ibis: number[] = [];
    for (let i = 1; i < seq.length; i++) ibis.push(seq[i] - seq[i - 1]);
    if (ibis.length < 3) return;
    const medIbi = medianOf(ibis.filter(v => v > 0.3 && v < 2.0));
    if (!(medIbi > 0.3)) return;
    const inserted: StoredPeak[] = [];
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i];
      const ratio = (b - a) / medIbi;
      if (ratio < 1.6 || ratio > 2.4) continue;
      const lo = Math.round((a + 0.3 * (b - a) - gridStart) / dt), hi = Math.round((a + 0.7 * (b - a) - gridStart) / dt);
      if (lo < 2 || hi > filtered.length - 3) continue;
      let best = -1, bestV = -Infinity;
      for (let k = lo; k <= hi; k++) {
        if (filtered[k] > filtered[k - 1] && filtered[k] >= filtered[k + 1] && filtered[k] > bestV) { bestV = filtered[k]; best = k; }
      }
      if (best < 0) continue;
      const ia = Math.round((a - gridStart) / dt), ib = Math.round((b - gridStart) / dt);
      const neighbourAmp = Math.max(ia >= 0 && ia < filtered.length ? filtered[ia] : 0, ib >= 0 && ib < filtered.length ? filtered[ib] : 0);
      if (!(neighbourAmp > 0) || bestV < 0.12 * neighbourAmp) continue;
      // Local prominence: the candidate must rise above the trough before it.
      let trough = bestV;
      for (let k = Math.max(0, best - Math.round(0.3 * medIbi / dt)); k < best; k++) if (filtered[k] < trough) trough = filtered[k];
      if (bestV - trough < 0.08 * neighbourAmp) continue;
      const t = gridStart + best * dt;
      if (t <= acceptFrom || t > acceptUntil) continue;
      inserted.push({ t, sigma: 0.02, amplitude: bestV - trough, baseline: rawGrid[best], valid: true, lowSnr: true });
    }
    if (!inserted.length) return;
    newPeaks.push(...inserted);
    newPeaks.sort((x, y) => x.t - y.t);
  }

  /** Channel pulsatile amplitude while not MEASURING (drives the settle gate). */
  private channelAmplitudes(segStart: number, winStart: number, end: number, redDc: number, greenDc: number): { acDcRatio: number; channel: 'red' | 'green'; filtered: Float64Array } {
    const o = this.opts;
    const gridHz = o.gridHz, dt = 1 / gridHz;
    const gridStart = Math.ceil(segStart * gridHz) / gridHz;
    const count = Math.max(2, Math.floor((end - gridStart) * gridHz) + 1);
    const idx0 = Math.max(0, this.ts.findIndex(t => t >= segStart - dt));
    const tSeg = this.ts.slice(idx0);
    const design = this.designFor(gridHz);
    const winIdx0 = Math.max(0, Math.round((winStart - gridStart) * gridHz));
    const padLen = Math.min(count - 1, Math.round(2 * gridHz));
    const amp = (vals: number[]): { ratio: number; f: Float64Array } => {
      const grid = resampleToGrid(tSeg, vals, gridStart, dt, count);
      const inv = new Float64Array(count);
      for (let i = 0; i < count; i++) inv[i] = -grid[i];
      const f = filtfiltPadded(design, inv, padLen);
      const arr = Array.from(f.subarray(winIdx0)).sort((a, b) => a - b);
      const sp = arr.length >= 4 ? arr[Math.floor(arr.length * 0.95)] - arr[Math.floor(arr.length * 0.05)] : 0;
      return { ratio: sp, f: f.slice(winIdx0) };
    };
    const r = amp(this.rs.slice(idx0)), g = amp(this.gs.slice(idx0));
    const redRatio = redDc > o.minChannelDc ? r.ratio / redDc : 0;
    const greenRatio = greenDc > o.minChannelDc ? g.ratio / greenDc : 0;
    const channel = (redDc > o.minChannelDc || greenDc > o.minChannelDc) ? selectChannel(this.selectedChannel, redRatio, greenRatio) : 'red';
    // The spread of a bandpassed pulse is roughly the beat amplitude; scale
    // to match the per-beat median used while MEASURING (spread ~ 1.2x).
    const ratio = (channel === 'green' ? greenRatio : redRatio) / 1.2;
    return { acDcRatio: ratio, channel, filtered: channel === 'green' ? g.f : r.f };
  }

  private stability(currentVariance: number): number {
    if (this.previousVariance === 0) { this.previousVariance = currentVariance; return 1; }
    const ratio = Math.min(currentVariance, this.previousVariance) / (Math.max(currentVariance, this.previousVariance) + 1e-20);
    this.previousVariance = currentVariance;
    return ratio;
  }

  /** Session summary over GOOD windows only. */
  getSessionSummary(): SessionSummary {
    const good = this.windows.filter(w => w.good);
    const stats = (arr: number[]): { min: number; median: number; max: number } | null =>
      arr.length ? { min: Math.min(...arr), median: medianOf(arr), max: Math.max(...arr) } : null;
    return {
      totalWindows: this.windows.length,
      goodWindows: good.length,
      goodFraction: this.windows.length ? good.length / this.windows.length : 0,
      hr: stats(good.map(w => w.heartRate).filter(v => v > 0)),
      rmssd: stats(good.map(w => w.rmssd).filter(v => v > 0)),
      sdnn: stats(good.map(w => w.sdnn).filter(v => v > 0))
    };
  }

  /** Tachogram; `goodOnly` keeps beats from good windows, `hrvOnly` also drops low-SNR (recovered) intervals. */
  getTachogram(opts: { goodOnly?: boolean; hrvOnly?: boolean } = {}): TachogramPoint[] {
    return this.tachogram.filter(p => (!opts.goodOnly || p.good) && (!opts.hrvOnly || !p.lowSnr));
  }
}

export interface SessionSummary {
  totalWindows: number;
  goodWindows: number;
  goodFraction: number;
  hr: { min: number; median: number; max: number } | null;
  rmssd: { min: number; median: number; max: number } | null;
  sdnn: { min: number; median: number; max: number } | null;
}

/** Robust white-noise sigma of raw samples in [t0, t1] from their second differences. */
function secondDifferenceNoise(values: number[], times: number[], t0: number, t1: number): number {
  const d: number[] = [];
  for (let i = 2; i < values.length; i++) {
    if (times[i] < t0 || times[i] > t1) continue;
    d.push(Math.abs(values[i] - 2 * values[i - 1] + values[i - 2]));
  }
  if (d.length < 8) return 0;
  d.sort((a, b) => a - b);
  const mad = d[Math.floor(d.length / 2)];
  return (mad / 0.6745) / Math.sqrt(6);
}

function linearDetrend(y: ArrayLike<number>): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) out[i] = y[i] - (icpt + slope * i);
  return out;
}

/** 0-100 from pulsatile amplitude (floor -> 0, 6x floor -> 100) minus artifact penalty. */
function scoreFrom(acDcRatio: number, artifactRatio: number, floor: number): number {
  const span = Math.max(1e-6, floor * 5);
  const ratioScore = Math.max(0, Math.min(100, ((acDcRatio - floor) / span) * 100));
  const penalty = Math.min(50, artifactRatio * 100);
  return Math.round(Math.max(0, Math.min(100, ratioScore - penalty)));
}
