/**
 * User-facing coaching copy + a 0-100 signal quality score, derived purely
 * from state machine state and channel stats. Kept separate from
 * PPGMonitor/UIRenderer so both the library UI and the plain-HTML demo can
 * share the exact same messages.
 */

/**
 * @param {Object} p
 * @param {string} p.state - STATE.NO_FINGER | SETTLING | MEASURING
 * @param {boolean} [p.torchSupported] - false on iOS Safari (no torch API)
 * @param {number} [p.redMean]
 * @param {number} [p.greenMean]
 * @param {number} [p.blueMean]
 * @param {number} [p.settleRemainingSec]
 * @param {number} [p.acDcRatio] - 0-1
 * @returns {string}
 */
export function coachingMessage(p) {
  const { state, torchSupported, redMean, greenMean, blueMean, settleRemainingSec, acDcRatio } = p;

  if (torchSupported === false) {
    return 'Turn on your flashlight from Control Center, then cover lens and flashlight';
  }

  if (state === 'NO_FINGER') {
    return 'Cover the main rear lens AND the flash with your fingertip pad';
  }

  if (typeof redMean === 'number' && redMean > 250) {
    return 'Ease off the pressure a little';
  }
  if (typeof redMean === 'number' && redMean < 150) {
    return 'Press a little more or cover the flash too';
  }
  if (
    typeof redMean === 'number' && typeof greenMean === 'number' && typeof blueMean === 'number' &&
    redMean >= 150 && (greenMean > 60 || blueMean > 60)
  ) {
    return 'Flash is uncovered, slide your finger to cover it';
  }

  if (state === 'SETTLING') {
    const s = Math.max(0, Math.ceil(settleRemainingSec ?? 0));
    return `Hold still... ${s}s`;
  }

  if (state === 'MEASURING' && typeof acDcRatio === 'number' && acDcRatio < 0.005) {
    return 'Weak pulse. Lighten your grip or warm your hand';
  }

  return 'Good signal - hold steady';
}

/**
 * 0-100 score from pulsatile amplitude (AC/DC ratio) and beat-rejection
 * rate. 0.5% AC/DC is the MEASURING floor -> score 0; 3%+ -> score 100.
 * Rejected/artifact beats subtract, capped so one bad beat isn't fatal.
 * @param {number} acDcRatio - 0-1
 * @param {number} [artifactRatio=0] - 0-1
 * @returns {number} 0-100 integer
 */
export function qualityScore(acDcRatio, artifactRatio = 0) {
  const ratioPct = acDcRatio * 100;
  const ratioScore = ((ratioPct - 0.5) / (3 - 0.5)) * 100;
  const clampedRatioScore = Math.max(0, Math.min(100, ratioScore));
  const penalty = Math.min(50, artifactRatio * 100);
  return Math.round(Math.max(0, Math.min(100, clampedRatioScore - penalty)));
}
