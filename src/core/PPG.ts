import { PPGMonitor } from './PPGMonitor.js';
import { STATE, type FingerState } from './fingerState.js';
import type { EngineWindow, TachogramPoint, SessionSummary, PpgEngine } from './engine.js';
import type { QualityResult } from './quality.js';
import type { RespirationEstimate } from './respiration.js';
import type { MonitorUserOptions, ReadyInfo } from './helpers.js';
import type { DebugLog } from './recorder.js';
import type { PPGError } from './errors.js';

/** Finger/session state. */
export type PPGState = FingerState;

/** Constructor options (all optional). */
export type PPGOptions = Omit<MonitorUserOptions, 'ui' | 'onReady' | 'onQualityUpdate' | 'onSignalUpdate' | 'onFrame' | 'onState' | 'onError'>;

/** Per-window metrics delivered on the `metrics` event and by getMetrics(). */
export interface PPGMetrics extends Omit<EngineWindow, 'filtered'> {
  /** Human-readable coaching text for the current state and quality. */
  guidanceMessage: string;
  torchState: string;
}

export interface PPGCapabilities {
  torchSupported: boolean;
  torchState: string;
  wakeLock: boolean;
  motion: boolean;
  capabilities: Record<string, unknown>;
}

export type PPGEvent<T> = CustomEvent<T>;

export interface PPGBeat {
  /** Beat time, seconds since the session started. */
  time: number;
  ibiMs: number;
  /** Interval accepted by the artifact rules. */
  valid: boolean;
  /** Produced by a window that passed the quality gate. */
  good: boolean;
  /** Recovered weak beat at either end: use for heart rate, not for variability. */
  lowSnr: boolean;
  reason: string | null;
  heartRate: number;
}

export interface PPGEventMap {
  ready: CustomEvent<PPGCapabilities>;
  state: CustomEvent<{ state: PPGState; reason: string | null; time: number }>;
  beat: CustomEvent<PPGBeat>;
  metrics: CustomEvent<PPGMetrics>;
  quality: CustomEvent<QualityResult>;
  waveform: CustomEvent<{ time: number; value: number; isProcessing: boolean }>;
  respiration: CustomEvent<RespirationEstimate & { time: number }>;
  error: CustomEvent<{ error: PPGError }>;
}

/**
 * PPG: typed-event facade over PPGMonitor + PpgEngine. Always headless.
 */
export class PPG extends EventTarget {
  private _monitor: PPGMonitor;
  private _capabilities: PPGCapabilities = { torchSupported: false, torchState: 'unknown', wakeLock: false, motion: false, capabilities: {} };
  private _abortListener: (() => void) | null = null;
  private _abortSignal: AbortSignal | null = null;

  constructor(options: PPGOptions = {}) {
    super();
    this._monitor = new PPGMonitor(null, {
      ...(options as Record<string, unknown>),
      ui: { enabled: false },
      onReady: (info: ReadyInfo) => {
        this._capabilities = { ...info };
        this.dispatchEvent(new CustomEvent('ready', { detail: this._capabilities }));
      },
      onState: (s: { state: string; reason: string | null; time: number }) =>
        this.dispatchEvent(new CustomEvent('state', { detail: s })),
      onQualityUpdate: (metrics: Record<string, unknown>) => this._onWindow(metrics as unknown as PPGMetrics),
      onSignalUpdate: (signal: { time: number; value: number; isProcessing: boolean }) =>
        this.dispatchEvent(new CustomEvent('waveform', { detail: signal })),
      onError: (error: unknown) => this.dispatchEvent(new CustomEvent('error', { detail: { error } }))
    });
  }

  private _onWindow(metrics: PPGMetrics): void {
    this.dispatchEvent(new CustomEvent('metrics', { detail: metrics }));
    if (metrics.quality) this.dispatchEvent(new CustomEvent('quality', { detail: metrics.quality }));
    if (Array.isArray(metrics.ibiDetails)) {
      for (const d of metrics.ibiDetails) {
        const beat: PPGBeat = { time: d.peakTimeSec, ibiMs: d.ibiMs, valid: d.valid, good: d.good, lowSnr: d.lowSnr, reason: d.reason, heartRate: metrics.heartRate };
        this.dispatchEvent(new CustomEvent('beat', { detail: beat }));
      }
    }
    if (metrics.respiration && metrics.respiration.rateBpm != null) {
      this.dispatchEvent(new CustomEvent('respiration', { detail: { ...metrics.respiration, time: metrics.t } }));
    }
  }

  /** Start capture. Pass an AbortSignal to auto-stop() on abort. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this._abortSignal && this._abortListener) this._abortSignal.removeEventListener('abort', this._abortListener);
    this._abortSignal = null; this._abortListener = null;
    if (signal) {
      if (signal.aborted) return;
      this._abortSignal = signal;
      this._abortListener = () => this.stop();
      signal.addEventListener('abort', this._abortListener, { once: true });
    }
    return this._monitor.start();
  }

  stop(): void {
    if (this._abortSignal && this._abortListener) this._abortSignal.removeEventListener('abort', this._abortListener);
    this._abortSignal = null; this._abortListener = null;
    this._monitor.stop();
  }

  destroy(): void { this._monitor.destroy(); }

  getMetrics(): PPGMetrics { return this._monitor.getMetrics() as unknown as PPGMetrics; }

  getTachogram(opts: { goodOnly?: boolean; hrvOnly?: boolean } = {}): TachogramPoint[] { return this._monitor.getTachogram(opts); }

  getSessionSummary(): SessionSummary { return this._monitor.getSessionSummary(); }

  exportDebugLog(): DebugLog { return this._monitor.getDebugLog(); }

  downloadDebugLog(filenamePrefix?: string): string { return this._monitor.downloadDebugLog(filenamePrefix); }

  /** Effective configuration (camera, engine thresholds, finger-state timing). */
  getConfig(): { options: PPGMonitor['options']; engine: PpgEngine['config'] } {
    return { options: this._monitor.options, engine: this._monitor.engine.config };
  }

  /** Underlying engine (for advanced use, e.g. the last filtered window). */
  get engine(): PpgEngine { return this._monitor.engine; }

  get capabilities(): PPGCapabilities { return this._capabilities; }

  get state(): PPGState { return this._monitor.engine.state; }
}

export { STATE };
export declare interface PPG {
  addEventListener<K extends keyof PPGEventMap>(type: K, listener: (ev: PPGEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof PPGEventMap>(type: K, listener: (ev: PPGEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}
