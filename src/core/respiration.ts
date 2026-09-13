/**
 * Respiratory rate from the pulse train (no extra sensor): breathing
 * modulates beat timing (RIFV, respiratory sinus arrhythmia), pulse
 * amplitude (RIAV) and baseline intensity (RIIV). Each series is resampled
 * to 4 Hz, high-passed at 0.06 Hz (zero-phase, so slow drift cannot leak
 * into the band and pose as a breath) and Fourier-analysed in 0.067-0.5 Hz
 * (4-30 breaths/min, which covers slow and resonance breathing at 5-7/min). The three estimates are
 * fused when they agree (Karlen et al. 2013 "Smart Fusion"; Charlton et al.
 * 2016 benchmark); a single clear estimate is published as provisional at
 * low confidence, and a previously firm rate is held for a short time when
 * one estimate still tracks it.
 */
import { computeFFT } from './fft.js';
import { designBandpass, filtfiltPadded, resampleToGrid, type BandpassDesign } from './filter.js';

export interface RespirationBeat {
  /** Beat time, seconds. */
  t: number;
  /** Inter-beat interval ending at this beat, ms. */
  ibiMs: number;
  /** Pulse amplitude of this beat (filtered peak-to-trough). */
  amplitude: number;
  /** Baseline (DC) intensity around this beat. */
  baseline: number;
}

export type RespirationBasis = 'agreement' | 'single' | 'held';

export interface RespirationEstimate {
  rateBpm: number | null;
  /**
   * 0-1. >= 0.6: at least two clear estimates agree (1 = all three within
   * 2 br/min); 0.5: an agreeing pair where one estimate was weak; 0.3: one
   * clear estimate on its own (provisional); 0.4: previous firm rate held
   * because one estimate still tracks it.
   */
  confidence: number;
  /** How the rate was obtained; null when no rate. */
  basis: RespirationBasis | null;
  fromInterval: number | null;
  fromAmplitude: number | null;
  fromBaseline: number | null;
}

export interface RespirationOptions {
  /** Estimates within this many br/min count as agreeing (default 4). */
  agreeToleranceBpm?: number;
  /** Last firm rate; held when one estimate stays within `holdToleranceBpm` of it. */
  previousRateBpm?: number | null;
  /** Default 1.5 br/min. */
  holdToleranceBpm?: number;
}

/** A rate this close to twice the previous firm rate is read as its harmonic. */
const HARMONIC_TOLERANCE = 0.15;

/** Search band, Hz (4-30 breaths/min). */
export const RESPIRATION_BAND_HZ: readonly [number, number] = [0.067, 0.5];
/** Peak main-lobe share of in-band power for a clear estimate. */
const CLEAR_SHARE = 0.35;
/** Below this the estimate is ignored entirely. */
const WEAK_SHARE = 0.2;

interface SourceEstimate { rateBpm: number; share: number; }

const RESP_FS = 4;
let respDesign: BandpassDesign | null = null;
/** Zero-phase 2nd-order Butterworth high-pass at 0.06 Hz (plus a 0.8 Hz low-pass against resample noise). */
function highpass(y: Float64Array): Float64Array {
  respDesign ??= designBandpass(RESP_FS, 0.06, 0.8, 2, 2);
  return filtfiltPadded(respDesign, y, y.length - 1);
}

function dominantRate(times: number[], values: number[], loHz = RESPIRATION_BAND_HZ[0], hiHz = RESPIRATION_BAND_HZ[1]): SourceEstimate | null {
  if (times.length < 8) return null;
  const fs = RESP_FS;
  const t0 = times[0], t1 = times[times.length - 1];
  const count = Math.floor((t1 - t0) * fs) + 1;
  if (count < 32) return null;
  const det = highpass(resampleToGrid(times, values, t0, 1 / fs, count));
  const f = computeFFT(det, 512, fs);
  const lo = Math.max(1, Math.floor(loHz / f.freqResolution)), hi = Math.min(f.psd.length - 2, Math.ceil(hiHz / f.freqResolution));
  const hw = Math.max(1, Math.round(0.02 / f.freqResolution));
  // The band maximum must sit a full half-lobe above the lower edge. When
  // the strongest thing in the band is on the edge, residual drift is
  // leaking in and no breath rises above it, so this source has nothing to
  // say. This puts the lowest reportable rate near 0.09 Hz (5.5 breaths/min).
  let best = -1, bestP = 0, total = 0;
  for (let i = lo; i <= hi; i++) { total += f.psd[i]; if (f.psd[i] > bestP) { bestP = f.psd[i]; best = i; } }
  if (best < lo + hw) return null;
  if (best < 0 || total <= 0) return null;
  // Share of in-band power inside the peak's main lobe (+-0.02 Hz on the
  // zero-padded spectrum): how clearly this modulation shows one rhythm.
  let peakBand = 0;
  for (let i = Math.max(lo, best - hw); i <= Math.min(hi, best + hw); i++) peakBand += f.psd[i];
  const l = Math.log(f.psd[best - 1] + 1e-20), c = Math.log(f.psd[best] + 1e-20), r = Math.log(f.psd[best + 1] + 1e-20);
  const dnm = l - 2 * c + r;
  const delta = dnm < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / dnm)) : 0;
  return { rateBpm: (best + delta) * f.freqResolution * 60, share: peakBand / total };
}

export function estimateRespiration(beats: RespirationBeat[], opts: RespirationOptions = {}): RespirationEstimate {
  const tol = opts.agreeToleranceBpm ?? 4;
  const holdTol = opts.holdToleranceBpm ?? 1.5;
  const t = beats.map(b => b.t);
  const sources = [
    dominantRate(t, beats.map(b => b.ibiMs)),
    dominantRate(t, beats.map(b => b.amplitude)),
    dominantRate(t, beats.map(b => b.baseline))
  ];
  const usable = sources.map(s => (s && s.share >= WEAK_SHARE ? s : null));
  const [fromInterval, fromAmplitude, fromBaseline] = usable.map(s => (s ? s.rateBpm : null));
  const none = (basis: RespirationBasis | null = null, rateBpm: number | null = null, confidence = 0): RespirationEstimate =>
    ({ rateBpm, confidence, basis, fromInterval, fromAmplitude, fromBaseline });

  const cands = usable.filter((s): s is SourceEstimate => s != null).sort((a, b) => a.rateBpm - b.rateBpm);
  const clear = cands.filter(s => s.share >= CLEAR_SHARE);

  // 1. Agreement: the tightest group of >= 2 candidates within `tol` that
  //    contains at least one clear estimate.
  let best: SourceEstimate[] | null = null;
  for (let i = 0; i < cands.length; i++) {
    for (let j = cands.length - 1; j > i; j--) {
      if (cands[j].rateBpm - cands[i].rateBpm > tol) continue;
      const group = cands.slice(i, j + 1);
      if (!group.some(s => s.share >= CLEAR_SHARE)) continue;
      if (!best || group.length > best.length || (group.length === best.length && group[group.length - 1].rateBpm - group[0].rateBpm < best[best.length - 1].rateBpm - best[0].rateBpm)) best = group;
    }
  }
  const prev = opts.previousRateBpm != null && Number.isFinite(opts.previousRateBpm) ? opts.previousRateBpm : null;
  const tracking = prev == null ? undefined : cands.filter(s => Math.abs(s.rateBpm - prev) <= holdTol).sort((a, b) => b.share - a.share)[0];
  const held = prev != null && tracking ? none('held', (prev + tracking.rateBpm) / 2, 0.4) : null;
  // A candidate at twice the recent firm rate while another still tracks it
  // is the first harmonic of the breath (two pulses of modulation per cycle).
  const isHarmonic = (rate: number): boolean => held != null && prev != null && Math.abs(rate / (2 * prev) - 1) <= HARMONIC_TOLERANCE;

  if (best) {
    const spread = best[best.length - 1].rateBpm - best[0].rateBpm;
    const mean = best.reduce((a, s) => a + s.rateBpm, 0) / best.length;
    if (!isHarmonic(mean)) {
      const allClear = best.every(s => s.share >= CLEAR_SHARE);
      const confidence = best.length === 3 && allClear ? Math.max(0.6, 1 - spread / (2 * tol)) : allClear ? 0.6 : 0.5;
      return none('agreement', mean, confidence);
    }
  }
  // 2. One clear estimate on its own: provisional.
  if (clear.length === 1 && !isHarmonic(clear[0].rateBpm)) return none('single', clear[0].rateBpm, 0.3);
  // 3. Hold a recent firm rate while any usable estimate still tracks it.
  return held ?? none();
}
