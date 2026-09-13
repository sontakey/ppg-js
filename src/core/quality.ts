/**
 * Strict per-window quality gate. `good` must be true before HR/RMSSD/SDNN
 * are shown or a tachogram point counts. Checks run in a fixed priority
 * order so `reason` is the single worst failing reason.
 */

export interface QualityThresholds {
  /** Min pulsatile AC/DC ratio of the selected channel (bandpassed per-beat amplitude / DC). */
  minAcDc: number;
  /** Max fraction of candidate IBIs rejected in the last 60 s. */
  maxArtifactRatio: number;
  /** Min accepted IBIs in the last 60 s. */
  minIbiCount60s: number;
  /** Max fraction of clipped (saturated) pixels in the ROI. */
  maxClippedFraction: number;
  /** Max device-motion magnitude (m/s^2 deviation from gravity) averaged over the window. */
  maxMotion: number;
  /** Min median per-beat template correlation (0-1); NaN/undefined input is not checked. */
  minTemplateSqi: number;
}

export const DEFAULT_QUALITY: QualityThresholds = {
  minAcDc: 0.002,
  maxArtifactRatio: 0.2,
  minIbiCount60s: 8,
  maxClippedFraction: 0.05,
  maxMotion: 1.5,
  minTemplateSqi: 0.6
};

export interface QualityInput {
  state: string;
  acdc: number;
  artifactRatio: number;
  ibiCount: number;
  fftAgree: boolean;
  /** 'double' | 'half' | 'other' | null - see crossCheckHeartRate. */
  disagreeKind?: 'double' | 'half' | 'other' | null;
  clippedFraction?: number;
  motion?: number;
  templateSqi?: number;
}

export interface QualityResult extends QualityInput {
  good: boolean;
  reason: string | null;
  /** Stable machine-readable code for `reason`. */
  code: QualityCode | null;
}

export type QualityCode =
  | 'no_finger' | 'settling' | 'saturated' | 'motion' | 'weak_pulse'
  | 'irregular' | 'collecting' | 'morphology' | 'double_count' | 'missed_beats' | 'fft_disagree';

export function evaluateQuality(p: QualityInput, thresholds: Partial<QualityThresholds> = {}): QualityResult {
  const t = { ...DEFAULT_QUALITY, ...thresholds };
  let reason: string | null = null;
  let code: QualityCode | null = null;

  if (p.state !== 'MEASURING') {
    code = p.state === 'NO_FINGER' ? 'no_finger' : 'settling';
    reason = p.state === 'NO_FINGER' ? 'No finger detected' : 'Settling';
  } else if (typeof p.clippedFraction === 'number' && p.clippedFraction > t.maxClippedFraction) {
    code = 'saturated'; reason = 'Too bright, ease off the flash';
  } else if (typeof p.motion === 'number' && p.motion > t.maxMotion) {
    code = 'motion'; reason = 'Hold the phone still';
  } else if (p.acdc < t.minAcDc) {
    code = 'weak_pulse'; reason = 'Weak pulse';
  } else if (p.artifactRatio > t.maxArtifactRatio) {
    code = 'irregular'; reason = 'Irregular beats detected, hold still';
  } else if (p.ibiCount < t.minIbiCount60s) {
    code = 'collecting'; reason = `Collecting beats ${p.ibiCount}/${t.minIbiCount60s}`;
  } else if (typeof p.templateSqi === 'number' && !Number.isNaN(p.templateSqi) && p.templateSqi < t.minTemplateSqi) {
    code = 'morphology'; reason = 'Pulse shape unstable, hold still';
  } else if (!p.fftAgree) {
    if (p.disagreeKind === 'double') { code = 'double_count'; reason = 'Beats double-counted, adjust pressure'; }
    else if (p.disagreeKind === 'half') { code = 'missed_beats'; reason = 'Beats missed, adjust pressure'; }
    else { code = 'fft_disagree'; reason = 'Irregular beats detected, hold still'; }
  }

  return { ...p, good: reason === null, reason, code };
}
