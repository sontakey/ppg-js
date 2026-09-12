/**
 * Strict per-window quality gate. `good` must be true before HR/RMSSD/SDNN
 * are shown or a tachogram point is appended - see PPGMonitor.js/replay.js
 * callers. Every failing check is checked in a fixed priority order so
 * `reason` is always the single WORST failing reason, for a coaching
 * banner that says one thing at a time instead of a wall of caveats.
 */

const MIN_ACDC_RATIO = 0.005; // 0.5%
const MAX_ARTIFACT_RATIO = 0.2;
const MIN_IBI_COUNT_60S = 8;

/**
 * @param {Object} p
 * @param {string} p.state - STATE.NO_FINGER | SETTLING | MEASURING
 * @param {number} p.acdc - AC/DC ratio of the selected channel (0-1)
 * @param {number} p.artifactRatio - fraction of candidate IBIs rejected (0-1)
 * @param {number} p.ibiCount - count of accepted IBIs in the last 60s
 * @param {boolean} p.fftAgree - true unless crossCheckHeartRate flagged disagreement
 * @returns {{acdc:number, artifactRatio:number, ibiCount:number, fftAgree:boolean, state:string, good:boolean, reason:string|null}}
 */
export function evaluateQuality({ state, acdc, artifactRatio, ibiCount, fftAgree }) {
  let reason = null;

  if (state !== 'MEASURING') {
    reason = state === 'NO_FINGER' ? 'No finger detected' : 'Settling';
  } else if (acdc < MIN_ACDC_RATIO) {
    reason = 'Weak pulse';
  } else if (artifactRatio > MAX_ARTIFACT_RATIO) {
    reason = 'Irregular beats detected, hold still';
  } else if (ibiCount < MIN_IBI_COUNT_60S) {
    reason = `Collecting beats ${ibiCount}/${MIN_IBI_COUNT_60S}`;
  } else if (!fftAgree) {
    reason = 'Irregular beats detected, hold still';
  }

  return {
    state,
    acdc,
    artifactRatio,
    ibiCount,
    fftAgree,
    good: reason === null,
    reason
  };
}
