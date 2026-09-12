/**
 * NO_FINGER -> SETTLING -> MEASURING state machine that gates when HR/IBI/
 * RMSSD are trustworthy enough to show, plus red/green channel selection
 * with hysteresis (so the chosen channel doesn't flip every window).
 *
 * Built from two real iPhone logs: the first ~15-20s of any session is
 * placement noise (95-252 count swings on the red channel, plus a raw
 * on/off flicker from isFingerPresent as the finger seats) and must never
 * leak into a reported heart rate; only report once the DC baseline has
 * settled and the pulsatile (AC/DC) amplitude is large enough for the peak
 * detector, and only flip finger-present/absent after it sticks for a
 * beat, not for one noisy frame.
 */

export const STATE = {
  NO_FINGER: 'NO_FINGER',
  SETTLING: 'SETTLING',
  MEASURING: 'MEASURING'
};

/**
 * Cheap finger-on-lens heuristic from per-frame channel means: a covered
 * lens with the flash under the fingertip reads high red, low green/blue
 * (skin + blood absorb green/blue, transmit/reflect red).
 * @param {{redMean:number, greenMean:number, blueMean:number}} stats
 * @returns {boolean}
 */
export function isFingerPresent({ redMean, greenMean, blueMean }) {
  return redMean > 120 && greenMean < 60 && blueMean < 60;
}

/**
 * Pick red or green for peak detection based on which has the better
 * pulsatile amplitude (AC/DC ratio), with hysteresis so a window that's
 * only marginally better doesn't cause flip-flopping every 5s.
 * @param {string|null} prevChannel - 'red' | 'green' | null (first call)
 * @param {number} redRatio - AC/DC for red
 * @param {number} greenRatio - AC/DC for green
 * @param {number} [hysteresisFactor=1.2] - challenger must beat incumbent by this factor
 * @returns {'red'|'green'}
 */
export function selectChannel(prevChannel, redRatio, greenRatio, hysteresisFactor = 1.2) {
  if (prevChannel === 'green') {
    return redRatio > greenRatio * hysteresisFactor ? 'red' : 'green';
  }
  // Default incumbent is red (matches the pre-existing red-only pipeline).
  return greenRatio > redRatio * hysteresisFactor ? 'green' : 'red';
}

export class FingerStateMachine {
  // ponytail: index signature instead of per-field declarations - straight
  // JS->TS move, tightening the surface is Phase 2 hygiene work.
  [key: string]: any;

  /**
   * @param {Object} [opts]
   * @param {number} [opts.settleSec=6] - seconds of finger-present before MEASURING is allowed
   * @param {number} [opts.driftEnterCounts=6] - max DC drift (0-255 counts) to enter MEASURING
   * @param {number} [opts.driftExitCounts=12] - DC drift while MEASURING that kicks back to SETTLING
   * @param {number} [opts.minAcDcRatio=0.005] - min AC/DC ratio (0.5%) to enter MEASURING
   * @param {number} [opts.debounceSec=0.3] - finger presence must be stable this long before it flips
   */
  constructor(opts: any = {}) {
    this.settleSec = opts.settleSec ?? 6;
    this.driftEnterCounts = opts.driftEnterCounts ?? 6;
    this.driftExitCounts = opts.driftExitCounts ?? 12;
    this.minAcDcRatio = opts.minAcDcRatio ?? 0.005;
    this.debounceSec = opts.debounceSec ?? 0.3;

    this.state = STATE.NO_FINGER;
    this.stateEnteredAt = 0;
    this.selectedChannel = null;

    // SETTLING episode continuity: a short bounce out of SETTLING and
    // straight back in (debounce noise, < bounceGraceSec) must not reset
    // the settle countdown - see update() below and the app's ring UI.
    this.bounceGraceSec = opts.bounceGraceSec ?? 0.5;
    this._settlingEntryTSec = null;
    this._lastLeftSettlingAt = null;
    // Last non-null transition reason, retained across no-change frames so
    // the app can show a persistent "SETTLING · reason" line instead of it
    // flashing for one frame and disappearing.
    this.lastReason = null;

    // DC drift is measured on a 1s-moving-average-smoothed red mean:
    // drift = |mean(last 1s) - mean(1s ending 3s ago)|. Keep 4s of raw
    // samples (native cadence) to compute both windows on demand.
    this.dcSamples = [];

    // Finger-presence debounce: a raw flip only commits after it holds for
    // debounceSec.
    this.debouncedPresent = false;
    this.pendingPresent = null;
    this.pendingSince = 0;

    // acdc >= threshold must hold for 2 consecutive *window* updates (the
    // caller only changes acDcRatio once per ~5s window) - dedupe by value
    // change so this isn't just "2 consecutive frames at 30fps".
    this.acdcHistory = [];
    this.lastAcDcSeen = null;

    // large_drift exit requires 2 consecutive checks (hysteresis) so one
    // noisy frame while MEASURING doesn't bounce back to SETTLING.
    this.largeDriftStreak = 0;
  }

  /** Seconds already spent in the current state (for a "hold still... Ns" countdown).
   * While SETTLING, uses the episode start (see update()) so a sub-500ms
   * bounce out and back into SETTLING doesn't reset the countdown to 6. */
  timeInState(tSec) {
    if (this.state === STATE.SETTLING && this._settlingEntryTSec != null) {
      return Math.max(0, tSec - this._settlingEntryTSec);
    }
    return Math.max(0, tSec - this.stateEnteredAt);
  }

  _debouncedPresence(tSec, rawPresent) {
    if (rawPresent === this.debouncedPresent) {
      this.pendingPresent = null;
      return this.debouncedPresent;
    }
    if (this.pendingPresent !== rawPresent) {
      this.pendingPresent = rawPresent;
      this.pendingSince = tSec;
    } else if (tSec - this.pendingSince >= this.debounceSec) {
      this.debouncedPresent = rawPresent;
      this.pendingPresent = null;
    }
    return this.debouncedPresent;
  }

  _drift(tSec) {
    const inRange = (lo, hi) => this.dcSamples.filter(s => s.t >= lo && s.t <= hi);
    const a = inRange(tSec - 1, tSec);
    const b = inRange(tSec - 4, tSec - 3);
    if (!a.length || !b.length) return 0;
    const meanOf = arr => arr.reduce((s, x) => s + x.dc, 0) / arr.length;
    return Math.abs(meanOf(a) - meanOf(b));
  }

  /**
   * @param {Object} sample
   * @param {number} sample.tSec - session-relative seconds
   * @param {number} sample.redMean
   * @param {number} sample.greenMean
   * @param {number} sample.blueMean
   * @param {number} [sample.acDcRatio=0] - AC/DC of the currently selected channel (0-1)
   * @returns {{state:string, changed:boolean, reason:string|null, drift:number, present:boolean}}
   */
  update({ tSec, redMean, greenMean, blueMean, acDcRatio = 0 }) {
    const rawPresent = isFingerPresent({ redMean, greenMean, blueMean });
    const present = this._debouncedPresence(tSec, rawPresent);

    this.dcSamples.push({ t: tSec, dc: redMean });
    while (this.dcSamples.length && tSec - this.dcSamples[0].t > 4) this.dcSamples.shift();
    const drift = this._drift(tSec);

    if (acDcRatio !== this.lastAcDcSeen) {
      this.acdcHistory.push(acDcRatio);
      if (this.acdcHistory.length > 2) this.acdcHistory.shift();
      this.lastAcDcSeen = acDcRatio;
    }
    const acdcStreakOk = this.acdcHistory.length >= 2 &&
      this.acdcHistory.every(v => v >= this.minAcDcRatio);

    const prevState = this.state;
    let reason = null;

    if (!present) {
      if (prevState !== STATE.NO_FINGER) reason = 'finger_lifted';
      // A bounce out of SETTLING that returns within bounceGraceSec is
      // debounce noise, not a real lift - keep the settle episode alive
      // (don't clear _settlingEntryTSec) so the countdown doesn't reset.
      if (prevState === STATE.SETTLING) this._lastLeftSettlingAt = tSec;
      this.state = STATE.NO_FINGER;
    } else if (prevState === STATE.NO_FINGER) {
      this.state = STATE.SETTLING;
      reason = 'finger_placed';
      const bounced = this._settlingEntryTSec != null &&
        this._lastLeftSettlingAt != null &&
        (tSec - this._lastLeftSettlingAt) < this.bounceGraceSec;
      if (!bounced) this._settlingEntryTSec = tSec;
      // else: keep the prior _settlingEntryTSec - episode continues.
    } else if (prevState === STATE.SETTLING) {
      const settled = this.timeInState(tSec) >= this.settleSec;
      if (settled && drift < this.driftEnterCounts && acdcStreakOk) {
        this.state = STATE.MEASURING;
        reason = 'settled';
      }
    } else if (prevState === STATE.MEASURING) {
      if (drift >= this.driftExitCounts) {
        this.largeDriftStreak++;
        if (this.largeDriftStreak >= 2) {
          this.state = STATE.SETTLING;
          reason = 'large_drift';
        }
      } else {
        this.largeDriftStreak = 0;
      }
    }

    const changed = this.state !== prevState;
    if (changed) {
      this.stateEnteredAt = tSec;
      this.largeDriftStreak = 0;
    }
    if (reason) this.lastReason = reason;
    if (changed && this.state === STATE.MEASURING) {
      // Settling succeeded - the episode is over; the next SETTLING entry
      // (after a future lift) must start a fresh countdown.
      this._settlingEntryTSec = null;
    }
    if (changed && this.state === STATE.SETTLING && (reason === 'large_drift' || this._settlingEntryTSec == null)) {
      // large_drift (MEASURING -> SETTLING) always starts a fresh episode;
      // otherwise only start fresh if there's no episode already open (a
      // finger_placed re-entry after a bounce reuses the open episode -
      // see the `bounced` branch above, which leaves this non-null).
      this._settlingEntryTSec = tSec;
    }
    if (changed && this.state === STATE.SETTLING) {
      // A lift, a large drift, or a fresh placement all invalidate whatever
      // was in the sample buffer - the caller must reset it so stale
      // pre-transition samples never pollute the next MEASURING window.
      this.dcSamples = [{ t: tSec, dc: redMean }];
      this.acdcHistory = [];
      this.lastAcDcSeen = null;
    }

    return { state: this.state, changed, reason, drift, present };
  }
}
