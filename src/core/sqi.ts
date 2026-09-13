/**
 * Signal-quality indices for a PPG window, following the definitions used
 * in the SQI literature so results can be compared with other toolkits:
 *
 * - skewness / kurtosis of the bandpassed pulse (Elgendi 2016 found skewness
 *   the single most useful index for PPG; a clean pulse with systole as the
 *   maximum is positively skewed and lightly peaked)
 * - perfusion: pulsatile amplitude over DC, in percent
 * - relative power: cardiac-band spectral power over total power (the SNR
 *   in dB is the same information on a log scale)
 * - zero-crossing rate of the bandpassed pulse (about 2 per beat when clean;
 *   higher with noise, lower with wander)
 * - template correlation: median correlation of each beat with the mean
 *   beat (Orphanidou et al. 2015)
 * - detector agreement: interval-based vs spectral heart rate (the idea
 *   behind vital_sqi's MSQ, with two independent estimators)
 * - artifact ratio, clipped-pixel fraction and device motion from the gate
 *
 * `compositeSqi` folds these into one 0-1 score. It is deliberately simple
 * and documented (geometric mean of bounded sub-scores) so a consumer can
 * see why a window scored what it did; the hard accept/reject decision
 * stays with the quality gate.
 */

export interface WindowSqi {
  /** 0-1 composite (geometric mean of the bounded sub-scores below). */
  score: number;
  skewness: number;
  kurtosis: number;
  /** AC/DC in percent. */
  perfusion: number;
  /** Cardiac-band power / total power, 0-1. */
  relativePower: number;
  snrDb: number;
  /** Zero crossings per second of the bandpassed pulse. */
  zeroCrossingRate: number;
  /** Median per-beat template correlation, NaN if fewer than 3 beats. */
  templateCorrelation: number;
  /** 1 - |HR_ibi - HR_fft| / HR_fft, clamped to 0-1; NaN when either is missing. */
  detectorAgreement: number;
  artifactRatio: number;
  clippedFraction: number;
  /** Device motion (m/s^2 deviation from 1 g), NaN when no motion source. */
  motion: number;
  /** The bounded sub-scores that make up `score`, for explanation UIs. */
  components: Record<string, number>;
}

export function skewnessSqi(x: ArrayLike<number>): number {
  const n = x.length;
  if (n < 3) return NaN;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let s2 = 0, s3 = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - m; s2 += d * d; s3 += d * d * d; }
  const sd = Math.sqrt(s2 / n);
  return sd > 0 ? (s3 / n) / (sd * sd * sd) : 0;
}

/** Excess kurtosis (0 for a Gaussian). */
export function kurtosisSqi(x: ArrayLike<number>): number {
  const n = x.length;
  if (n < 4) return NaN;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let s2 = 0, s4 = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - m; const d2 = d * d; s2 += d2; s4 += d2 * d2; }
  const v = s2 / n;
  return v > 0 ? (s4 / n) / (v * v) - 3 : 0;
}

export function zeroCrossingRateSqi(x: ArrayLike<number>, sampleRate: number): number {
  const n = x.length;
  if (n < 2 || !(sampleRate > 0)) return NaN;
  let c = 0;
  for (let i = 1; i < n; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) c++;
  return c / (n / sampleRate);
}

/** Cardiac-band power over total (DC excluded), 0-1. */
export function relativePowerSqi(psd: ArrayLike<number>, freqResolution: number, lowHz: number, highHz: number): number {
  let band = 0, total = 0;
  for (let i = 1; i < psd.length; i++) {
    const f = i * freqResolution;
    total += psd[i];
    if (f >= lowHz && f <= highHz) band += psd[i];
  }
  return total > 0 ? band / total : NaN;
}

export function detectorAgreementSqi(hrIbi: number, hrFft: number): number {
  if (!(hrIbi > 0) || !(hrFft > 0)) return NaN;
  return Math.max(0, Math.min(1, 1 - Math.abs(hrIbi - hrFft) / hrFft));
}

const clamp01 = (v: number): number => (Number.isNaN(v) ? NaN : Math.max(0, Math.min(1, v)));

export interface CompositeInput {
  templateCorrelation: number;
  artifactRatio: number;
  acDcRatio: number;
  minAcDc: number;
  snrDb: number;
  clippedFraction: number;
  motion: number;
  detectorAgreement: number;
}

/**
 * Bounded sub-scores (each 0-1, NaN when not measurable) and their geometric
 * mean. Thresholds: template 0.5 -> 0 and 0.95 -> 1; artifact ratio 0.3 -> 0;
 * amplitude 3x the gate floor -> 1; SNR -5 dB -> 0 and 10 dB -> 1; clipping
 * 10% -> 0; motion 3 m/s^2 -> 0; detector agreement is used as is.
 */
export function compositeSqi(p: CompositeInput): { score: number; components: Record<string, number> } {
  const components: Record<string, number> = {
    template: clamp01((p.templateCorrelation - 0.5) / 0.45),
    artifacts: clamp01(1 - p.artifactRatio / 0.3),
    amplitude: clamp01(p.acDcRatio / (3 * Math.max(1e-6, p.minAcDc))),
    snr: clamp01((p.snrDb + 5) / 15),
    clipping: clamp01(1 - p.clippedFraction / 0.1),
    motion: clamp01(1 - p.motion / 3),
    agreement: clamp01(p.detectorAgreement)
  };
  let logSum = 0, count = 0;
  for (const v of Object.values(components)) {
    if (Number.isNaN(v)) continue;
    logSum += Math.log(Math.max(1e-3, v));
    count++;
  }
  const score = count ? Math.exp(logSum / count) : 0;
  return { score: Math.round(score * 1000) / 1000, components };
}
