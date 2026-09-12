/**
 * Always-on raw debug recorder. Captures every frame's raw channel means and
 * every derived event (peaks, IBIs, HR/RMSSD updates) so a session recorded
 * on a phone can be replayed offline through the exact same pipeline
 * (see tools/replay.js). No toggle - a bad session should never be lost.
 */

const DEFAULT_CAP = 10 * 60 * 60; // 10 minutes @ 60fps

/**
 * Fixed-size ring buffer of plain objects, so a long session can't grow
 * memory unbounded. Oldest samples are overwritten once the cap is hit.
 */
class RingBuffer {
  constructor(cap) {
    this.cap = cap;
    this.buf = new Array(cap);
    this.count = 0; // total pushed (may exceed cap)
  }

  push(item) {
    this.buf[this.count % this.cap] = item;
    this.count++;
  }

  get length() {
    return Math.min(this.count, this.cap);
  }

  /** Chronological snapshot. */
  toArray() {
    const n = this.length;
    if (this.count <= this.cap) return this.buf.slice(0, n);
    const start = this.count % this.cap;
    return this.buf.slice(start, this.cap).concat(this.buf.slice(0, start));
  }
}

export class DebugRecorder {
  /** @param {number} [capSamples] - ring buffer size for raw samples */
  constructor(capSamples = DEFAULT_CAP) {
    this.samples = new RingBuffer(capSamples);
    // Events are far lower rate than samples (peaks/IBIs/window updates,
    // not per-frame), so an unbounded array capped generously is enough.
    this.events = [];
    this.eventsCap = 20000;
    this.meta = null;
  }

  /**
   * Capture session metadata once, at start().
   * @param {Object} meta
   */
  start(meta) {
    this.meta = { startTime: new Date().toISOString(), ...meta };
    this.lastT = -Infinity;
    this.timestampAnomalies = { zero: 0, nonMonotonic: 0, nonFinite: 0 };
  }

  /**
   * @param {{t:number,r:number,g:number,b:number}} sample - t in ms
   * A sample whose t is non-finite, non-increasing, or (after the first
   * sample) exactly zero is still stored - a bad session should never be
   * lost - but its t is repaired with performance.now() so the file stays
   * replayable, and the anomaly is counted in this.timestampAnomalies.
   */
  pushSample(sample) {
    if (this.lastT === undefined) this.lastT = -Infinity;
    if (!this.timestampAnomalies) this.timestampAnomalies = { zero: 0, nonMonotonic: 0, nonFinite: 0 };

    let t = sample.t;
    const isFirst = this.samples.count === 0;
    let bad = false;
    if (!Number.isFinite(t)) {
      this.timestampAnomalies.nonFinite++;
      bad = true;
    } else if (!isFirst && t === 0) {
      this.timestampAnomalies.zero++;
      bad = true;
    } else if (t <= this.lastT) {
      this.timestampAnomalies.nonMonotonic++;
      bad = true;
    }
    if (bad) {
      // performance.now() is relative to process/page start, so it can
      // itself be <= lastT (e.g. lastT came from a large mediaTime-derived
      // value before this fix). Nudge forward by a nominal frame period so
      // the repaired stream is always strictly increasing and replayable.
      t = Math.max(performance.now(), this.lastT + 1);
    }
    this.lastT = t;
    this.samples.push(t === sample.t ? sample : { ...sample, t });
  }

  /** @param {Object} event - must include t (ms) and type */
  pushEvent(event) {
    if (this.events.length >= this.eventsCap) this.events.shift();
    this.events.push(event);
  }

  toJSON() {
    return {
      meta: this.meta,
      samples: this.samples.toArray(),
      events: this.events,
      timestampAnomalies: this.timestampAnomalies || { zero: 0, nonMonotonic: 0, nonFinite: 0 }
    };
  }
}
