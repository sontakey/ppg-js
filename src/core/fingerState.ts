/**
 * NO_FINGER -> SETTLING -> MEASURING state machine gating when HR/IBI/HRV
 * are trustworthy enough to show, plus red/green channel selection with
 * hysteresis.
 *
 * Presence and drift are RELATIVE (chromaticity share and a fraction of the
 * red DC) rather than absolute 8-bit counts, so the same defaults work on
 * sensors whose green channel is not near-black under the torch and on
 * darker skin or a dimmer torch (docs/audit finding B3). Every threshold is
 * an option and is written into the debug-log meta by the engine.
 */

export const STATE = {
  NO_FINGER: 'NO_FINGER',
  SETTLING: 'SETTLING',
  MEASURING: 'MEASURING'
} as const;
export type FingerState = typeof STATE[keyof typeof STATE];

export interface ChannelMeans { redMean: number; greenMean: number; blueMean: number; }

export interface PresenceOptions {
  /** Minimum red DC (0-255) for a covered lens. */
  minRed: number;
  /** Minimum red share of R+G+B. Torch-lit skin is 0.6-0.9; a room is ~0.35. */
  minRedShare: number;
  /** Maximum green DC (0-255) - mostly relevant with the torch off, when a
   *  bright ambient scene can be red-tinted; ignored when <= 0. */
  maxGreen: number;
}

export const DEFAULT_PRESENCE: PresenceOptions = { minRed: 60, minRedShare: 0.5, maxGreen: 0 };

/** Finger-on-lens heuristic from per-frame channel means. */
export function isFingerPresent(m: ChannelMeans, opts: Partial<PresenceOptions> = {}): boolean {
  const o = { ...DEFAULT_PRESENCE, ...opts };
  const sum = m.redMean + m.greenMean + m.blueMean;
  if (sum <= 0) return false;
  const share = m.redMean / sum;
  if (m.redMean < o.minRed) return false;
  if (share < o.minRedShare) return false;
  if (o.maxGreen > 0 && m.greenMean > o.maxGreen) return false;
  return true;
}

/** Pick red or green by pulsatile amplitude, with hysteresis. */
export function selectChannel(prevChannel: 'red' | 'green' | null | undefined, redRatio: number, greenRatio: number, hysteresisFactor = 1.2): 'red' | 'green' {
  if (prevChannel === 'green') {
    return redRatio > greenRatio * hysteresisFactor ? 'red' : 'green';
  }
  return greenRatio > redRatio * hysteresisFactor ? 'green' : 'red';
}

export interface FingerStateOptions {
  /** Seconds of finger-present before MEASURING is allowed. */
  settleSec: number;
  /** Max DC drift to enter MEASURING, as a fraction of red DC (floor `driftFloorCounts`). */
  driftEnterFraction: number;
  /** DC drift while MEASURING that kicks back to SETTLING, as a fraction of red DC. */
  driftExitFraction: number;
  /** Absolute floor for the drift thresholds, in 8-bit counts. */
  driftFloorCounts: number;
  /** Min pulsatile AC/DC ratio to enter MEASURING (must hold for 2 windows). */
  minAcDcRatio: number;
  /** Finger presence must be stable this long before it flips. */
  debounceSec: number;
  /** A bounce out of SETTLING shorter than this keeps the settle countdown. */
  bounceGraceSec: number;
  presence: Partial<PresenceOptions>;
}

export const DEFAULT_FINGER_STATE: FingerStateOptions = {
  settleSec: 6,
  driftEnterFraction: 0.03,
  driftExitFraction: 0.06,
  driftFloorCounts: 3,
  minAcDcRatio: 0.002,
  debounceSec: 0.3,
  bounceGraceSec: 0.5,
  presence: {}
};

export interface FingerUpdate {
  tSec: number;
  redMean: number;
  greenMean: number;
  blueMean: number;
  /** Pulsatile AC/DC of the selected channel from the last completed window. */
  acDcRatio?: number;
}

export interface FingerUpdateResult {
  state: FingerState;
  changed: boolean;
  reason: string | null;
  drift: number;
  present: boolean;
}

export class FingerStateMachine {
  readonly opts: FingerStateOptions;
  /** Kept as a public field for callers that read the settle time. */
  readonly settleSec: number;
  state: FingerState = STATE.NO_FINGER;
  stateEnteredAt = 0;
  lastReason: string | null = null;

  private _settlingEntryTSec: number | null = null;
  private _lastLeftSettlingAt: number | null = null;
  private dcSamples: Array<{ t: number; dc: number }> = [];
  private debouncedPresent = false;
  private pendingPresent: boolean | null = null;
  private pendingSince = 0;
  private acdcHistory: number[] = [];
  private lastAcDcSeen: number | null = null;
  private largeDriftStreak = 0;

  constructor(opts: Partial<FingerStateOptions> & { driftEnterCounts?: number; driftExitCounts?: number } = {}) {
    const merged: FingerStateOptions = { ...DEFAULT_FINGER_STATE, ...opts, presence: { ...(opts.presence || {}) } };
    // Legacy absolute-count options map onto the floor.
    if (typeof opts.driftEnterCounts === 'number') { merged.driftFloorCounts = opts.driftEnterCounts; merged.driftEnterFraction = 0; }
    if (typeof opts.driftExitCounts === 'number') { merged.driftExitFraction = 0; }
    this.opts = merged;
    this.settleSec = merged.settleSec;
    this._legacyExitCounts = typeof opts.driftExitCounts === 'number' ? opts.driftExitCounts : null;
  }
  private _legacyExitCounts: number | null;

  /** Seconds already spent in the current state (settle episode aware). */
  timeInState(tSec: number): number {
    if (this.state === STATE.SETTLING && this._settlingEntryTSec != null) {
      return Math.max(0, tSec - this._settlingEntryTSec);
    }
    return Math.max(0, tSec - this.stateEnteredAt);
  }

  private _debouncedPresence(tSec: number, rawPresent: boolean): boolean {
    if (rawPresent === this.debouncedPresent) {
      this.pendingPresent = null;
      return this.debouncedPresent;
    }
    if (this.pendingPresent !== rawPresent) {
      this.pendingPresent = rawPresent;
      this.pendingSince = tSec;
    } else if (tSec - this.pendingSince >= this.opts.debounceSec) {
      this.debouncedPresent = rawPresent;
      this.pendingPresent = null;
    }
    return this.debouncedPresent;
  }

  /** |mean(last 1 s) - mean(1 s ending 3 s ago)| of red DC. */
  private _drift(tSec: number): number {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (const s of this.dcSamples) {
      if (s.t >= tSec - 1 && s.t <= tSec) { sa += s.dc; na++; }
      else if (s.t >= tSec - 4 && s.t <= tSec - 3) { sb += s.dc; nb++; }
    }
    if (!na || !nb) return 0;
    return Math.abs(sa / na - sb / nb);
  }

  private _driftEnterThreshold(dc: number): number {
    return Math.max(this.opts.driftFloorCounts, this.opts.driftEnterFraction * dc);
  }
  private _driftExitThreshold(dc: number): number {
    if (this._legacyExitCounts != null) return this._legacyExitCounts;
    return Math.max(this.opts.driftFloorCounts * 2, this.opts.driftExitFraction * dc);
  }

  update({ tSec, redMean, greenMean, blueMean, acDcRatio = 0 }: FingerUpdate): FingerUpdateResult {
    const rawPresent = isFingerPresent({ redMean, greenMean, blueMean }, this.opts.presence);
    const present = this._debouncedPresence(tSec, rawPresent);

    this.dcSamples.push({ t: tSec, dc: redMean });
    while (this.dcSamples.length && tSec - this.dcSamples[0].t > 4) this.dcSamples.shift();
    const drift = this._drift(tSec);

    if (acDcRatio !== this.lastAcDcSeen) {
      this.acdcHistory.push(acDcRatio);
      if (this.acdcHistory.length > 2) this.acdcHistory.shift();
      this.lastAcDcSeen = acDcRatio;
    }
    const acdcStreakOk = this.acdcHistory.length >= 2 && this.acdcHistory.every(v => v >= this.opts.minAcDcRatio);

    const prevState = this.state;
    let reason: string | null = null;

    if (!present) {
      if (prevState !== STATE.NO_FINGER) reason = 'finger_lifted';
      if (prevState === STATE.SETTLING) this._lastLeftSettlingAt = tSec;
      this.state = STATE.NO_FINGER;
    } else if (prevState === STATE.NO_FINGER) {
      this.state = STATE.SETTLING;
      reason = 'finger_placed';
      const bounced = this._settlingEntryTSec != null && this._lastLeftSettlingAt != null &&
        (tSec - this._lastLeftSettlingAt) < this.opts.bounceGraceSec;
      if (!bounced) this._settlingEntryTSec = tSec;
    } else if (prevState === STATE.SETTLING) {
      const settled = this.timeInState(tSec) >= this.opts.settleSec;
      if (settled && drift < this._driftEnterThreshold(redMean) && acdcStreakOk) {
        this.state = STATE.MEASURING;
        reason = 'settled';
      }
    } else if (prevState === STATE.MEASURING) {
      if (drift >= this._driftExitThreshold(redMean)) {
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
    if (changed && this.state === STATE.MEASURING) this._settlingEntryTSec = null;
    if (changed && this.state === STATE.SETTLING && (reason === 'large_drift' || this._settlingEntryTSec == null)) {
      this._settlingEntryTSec = tSec;
    }
    if (changed && this.state === STATE.SETTLING) {
      this.dcSamples = [{ t: tSec, dc: redMean }];
      this.acdcHistory = [];
      this.lastAcDcSeen = null;
    }
    return { state: this.state, changed, reason, drift, present };
  }
}
