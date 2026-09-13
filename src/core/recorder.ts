/**
 * Always-on raw debug recorder: every frame's channel means and every
 * derived event, so a session recorded on a phone can be replayed offline
 * through the exact same engine (tools/replay.js).
 */

const DEFAULT_CAP = 10 * 60 * 60; // 10 minutes @ 60fps

export interface RecordedSample { t: number; r: number; g: number; b: number; clipped?: number; motion?: number; }
export interface RecordedEvent { t: number; type: string; [key: string]: unknown; }
export interface TimestampAnomalies { zero: number; nonMonotonic: number; nonFinite: number; }

export interface DebugLog {
  meta: Record<string, unknown> | null;
  samples: RecordedSample[];
  events: RecordedEvent[];
  windows: Record<string, unknown>[];
  timestampAnomalies: TimestampAnomalies;
  droppedFrames: number;
  truncated: boolean;
}

/** Fixed-size ring buffer; oldest entries are overwritten once full. */
class RingBuffer<T> {
  readonly cap: number;
  private buf: T[];
  count = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Array<T>(cap);
  }
  push(item: T): void {
    this.buf[this.count % this.cap] = item;
    this.count++;
  }
  get length(): number { return Math.min(this.count, this.cap); }
  toArray(): T[] {
    const n = this.length;
    if (this.count <= this.cap) return this.buf.slice(0, n);
    const start = this.count % this.cap;
    return this.buf.slice(start, this.cap).concat(this.buf.slice(0, start));
  }
  clear(): void { this.buf = new Array<T>(this.cap); this.count = 0; }
}

export class DebugRecorder {
  samples: RingBuffer<RecordedSample>;
  events: RecordedEvent[] = [];
  windows: Record<string, unknown>[] = [];
  eventsCap = 20000;
  meta: Record<string, unknown> | null = null;
  timestampAnomalies: TimestampAnomalies = { zero: 0, nonMonotonic: 0, nonFinite: 0 };
  droppedFrames = 0;
  truncated = false;
  private lastT = -Infinity;

  constructor(capSamples = DEFAULT_CAP) {
    this.samples = new RingBuffer<RecordedSample>(capSamples);
  }

  /** Begin a session: clears everything from any previous session. */
  start(meta: Record<string, unknown>): void {
    this.samples.clear();
    this.events = [];
    this.windows = [];
    this.droppedFrames = 0;
    this.truncated = false;
    this.lastT = -Infinity;
    this.timestampAnomalies = { zero: 0, nonMonotonic: 0, nonFinite: 0 };
    this.meta = { startTime: new Date().toISOString(), ...meta };
  }

  /**
   * Store a sample. A non-finite, non-increasing, or (after the first
   * sample) zero timestamp is repaired with performance.now() so the file
   * stays replayable, and counted in timestampAnomalies.
   */
  pushSample(sample: RecordedSample): void {
    let t = sample.t;
    const isFirst = this.samples.count === 0;
    let bad = false;
    if (!Number.isFinite(t)) { this.timestampAnomalies.nonFinite++; bad = true; }
    else if (!isFirst && t === 0) { this.timestampAnomalies.zero++; bad = true; }
    else if (t <= this.lastT) { this.timestampAnomalies.nonMonotonic++; bad = true; }
    if (bad) {
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      t = Math.max(nowMs, this.lastT + 1);
    }
    this.lastT = t;
    this.samples.push(t === sample.t ? sample : { ...sample, t });
  }

  pushEvent(event: RecordedEvent): void {
    if (this.events.length >= this.eventsCap) this.events.shift();
    this.events.push(event);
  }

  pushWindow(win: Record<string, unknown>): void {
    if (this.windows.length >= this.eventsCap) this.windows.shift();
    this.windows.push(win);
  }

  addDroppedFrames(n: number): void { if (n > 0) this.droppedFrames += n; }

  markTruncated(): void { this.truncated = true; }

  toJSON(): DebugLog {
    return {
      meta: this.meta,
      samples: this.samples.toArray(),
      events: this.events,
      windows: this.windows,
      timestampAnomalies: { ...this.timestampAnomalies },
      droppedFrames: this.droppedFrames,
      truncated: this.truncated
    };
  }
}
