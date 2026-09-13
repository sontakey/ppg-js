/**
 * User-facing coaching copy derived from state-machine state, channel
 * stats and the quality gate. State is checked first; the torch hint is
 * only shown while no finger is detected on a device without a torch
 * (docs/audit finding B8).
 */
import type { QualityCode } from './quality.js';

export interface CoachingInput {
  state: string;
  torchSupported?: boolean;
  redMean?: number;
  greenMean?: number;
  blueMean?: number;
  settleRemainingSec?: number;
  acDcRatio?: number;
  /** Quality gate code of the last window (null when good). */
  qualityCode?: QualityCode | null;
  clippedFraction?: number;
}

export function coachingMessage(p: CoachingInput): string {
  const { state, torchSupported, redMean, greenMean, blueMean, settleRemainingSec, qualityCode } = p;

  if (state === 'NO_FINGER') {
    if (torchSupported === false) {
      return 'No flash on this camera: turn on the flashlight (or use a bright lamp), then cover the lens with your fingertip';
    }
    return 'Cover the rear camera lens and the flash with your fingertip pad';
  }

  if (typeof p.clippedFraction === 'number' && p.clippedFraction > 0.05) {
    return 'Too bright: ease off the pressure or move your finger slightly off the flash';
  }
  if (typeof redMean === 'number' && redMean > 250) {
    return 'Ease off the pressure a little';
  }
  if (typeof redMean === 'number' && redMean < 100) {
    return 'Press a little more or cover the flash too';
  }
  if (
    typeof redMean === 'number' && typeof greenMean === 'number' && typeof blueMean === 'number' &&
    redMean >= 100 && greenMean + blueMean > redMean
  ) {
    return 'Flash is uncovered, slide your finger to cover it';
  }

  if (state === 'SETTLING') {
    const s = Math.max(0, Math.ceil(settleRemainingSec ?? 0));
    return `Hold still... ${s}s`;
  }

  switch (qualityCode) {
    case 'weak_pulse': return 'Weak pulse. Lighten your grip or warm your hand';
    case 'motion': return 'Hold the phone still';
    case 'saturated': return 'Too bright: ease off the flash';
    case 'irregular': return 'Irregular beats detected, hold still';
    case 'morphology': return 'Pulse shape unstable, hold still';
    case 'double_count': return 'Beats double-counted, adjust pressure slightly';
    case 'missed_beats': return 'Beats missed, adjust pressure slightly';
    case 'fft_disagree': return 'Irregular beats detected, hold still';
    case 'collecting': return 'Collecting beats, hold steady';
    default: break;
  }
  return 'Good signal - hold steady';
}

/**
 * 0-100 score from pulsatile amplitude (AC/DC ratio) and beat-rejection
 * rate: the gate floor scores 0, six times the floor scores 100.
 */
export function qualityScore(acDcRatio: number, artifactRatio = 0, floor = 0.002): number {
  const span = Math.max(1e-6, floor * 5);
  const ratioScore = Math.max(0, Math.min(100, ((acDcRatio - floor) / span) * 100));
  const penalty = Math.min(50, artifactRatio * 100);
  return Math.round(Math.max(0, Math.min(100, ratioScore - penalty)));
}
