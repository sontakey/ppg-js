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
  }

  /** @param {{t:number,r:number,g:number,b:number}} sample - t in ms */
  pushSample(sample) {
    this.samples.push(sample);
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
      events: this.events
    };
  }
}
