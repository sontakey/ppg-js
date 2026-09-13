/**
 * Respiratory rate from the pulse train (no extra sensor): breathing
 * modulates beat timing (RIFV, respiratory sinus arrhythmia), pulse
 * amplitude (RIAV) and baseline intensity (RIIV). Each series is resampled
 * to 4 Hz, detrended and Fourier-analysed in 0.1-0.5 Hz (6-30 breaths/min);
 * the three estimates are fused only when they agree (Karlen et al. 2013
 * "Smart Fusion"; Charlton et al. 2016 benchmark).
 */
import { computeFFT } from './fft.js';
import { resampleToGrid } from './filter.js';

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

export interface RespirationEstimate {
  rateBpm: number | null;
  /** 0-1: agreement of the three modulation estimates (1 = all within 2 br/min). */
  confidence: number;
  fromInterval: number | null;
  fromAmplitude: number | null;
  fromBaseline: number | null;
}

function dominantRate(times: number[], values: number[], loHz = 0.1, hiHz = 0.5): number | null {
  if (times.length < 8) return null;
  const fs = 4;
  const t0 = times[0], t1 = times[times.length - 1];
  const count = Math.floor((t1 - t0) * fs) + 1;
  if (count < 32) return null;
  const grid = resampleToGrid(times, values, t0, 1 / fs, count);
  // Linear detrend.
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < count; i++) { sx += i; sy += grid[i]; sxy += i * grid[i]; sxx += i * i; }
  const den = count * sxx - sx * sx;
  const slope = den ? (count * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / count;
  const det = new Float64Array(count);
  for (let i = 0; i < count; i++) det[i] = grid[i] - (icpt + slope * i);
  const f = computeFFT(det, 512, fs);
  const lo = Math.max(1, Math.floor(loHz / f.freqResolution)), hi = Math.min(f.psd.length - 2, Math.ceil(hiHz / f.freqResolution));
  let best = -1, bestP = 0, total = 0;
  for (let i = lo; i <= hi; i++) { total += f.psd[i]; if (f.psd[i] > bestP) { bestP = f.psd[i]; best = i; } }
  if (best < 0 || total <= 0) return null;
  // Require the peak (+-0.02 Hz, i.e. its main lobe on the zero-padded
  // spectrum) to hold at least 35% of the in-band power - otherwise there
  // is no clear breathing rhythm in this modulation.
  const hw = Math.max(1, Math.round(0.02 / f.freqResolution));
  let peakBand = 0;
  for (let i = Math.max(lo, best - hw); i <= Math.min(hi, best + hw); i++) peakBand += f.psd[i];
  if (peakBand / total < 0.35) return null;
  const l = Math.log(f.psd[best - 1] + 1e-20), c = Math.log(f.psd[best] + 1e-20), r = Math.log(f.psd[best + 1] + 1e-20);
  const dnm = l - 2 * c + r;
  const delta = dnm < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / dnm)) : 0;
  return (best + delta) * f.freqResolution * 60;
}

export function estimateRespiration(beats: RespirationBeat[], agreeToleranceBpm = 4): RespirationEstimate {
  const t = beats.map(b => b.t);
  const fromInterval = dominantRate(t, beats.map(b => b.ibiMs));
  const fromAmplitude = dominantRate(t, beats.map(b => b.amplitude));
  const fromBaseline = dominantRate(t, beats.map(b => b.baseline));
  const est = [fromInterval, fromAmplitude, fromBaseline].filter((v): v is number => v != null);
  if (est.length < 2) return { rateBpm: null, confidence: 0, fromInterval, fromAmplitude, fromBaseline };
  const sorted = [...est].sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  if (spread > agreeToleranceBpm) {
    // Try the closest pair.
    let bestPair: [number, number] | null = null;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (bestPair === null || sorted[i + 1] - sorted[i] < bestPair[1] - bestPair[0]) bestPair = [sorted[i], sorted[i + 1]];
    }
    if (bestPair && bestPair[1] - bestPair[0] <= agreeToleranceBpm) {
      return { rateBpm: (bestPair[0] + bestPair[1]) / 2, confidence: 0.5, fromInterval, fromAmplitude, fromBaseline };
    }
    return { rateBpm: null, confidence: 0, fromInterval, fromAmplitude, fromBaseline };
  }
  const mean = est.reduce((a, b) => a + b, 0) / est.length;
  const confidence = est.length === 3 ? Math.max(0.6, 1 - spread / (2 * agreeToleranceBpm)) : 0.6;
  return { rateBpm: mean, confidence, fromInterval, fromAmplitude, fromBaseline };
}
