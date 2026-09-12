import { PPGMonitor } from './PPGMonitor.js';
import { STATE } from './fingerState.js';

/** Finger/session state, mirrors utils/fingerState.js STATE values. */
export type PPGState = 'NO_FINGER' | 'SETTLING' | 'MEASURING';

export interface PPGOptions {
  /** Reserved for Phase 1 (CameraSource/ArraySource/...); unused for now. */
  source?: unknown;
  /** Reserved: caller-supplied <video> element instead of an internally created one. */
  video?: HTMLVideoElement;
  signal?: Partial<{
    windowLength: number;
    sampleRate: number;
    cardiacBandLow: number;
    cardiacBandHigh: number;
    fftSize: number;
  }>;
  camera?: MediaTrackConstraints & Record<string, unknown>;
  roi?: Partial<{ widthFraction: number; heightFraction: number }>;
  [key: string]: unknown;
}

export interface PPGMetrics {
  heartRate: number;
  ibi: number;
  rmssd: number;
  sdnn: number;
  snr_dB: number;
  perfusionIndex: number;
  qualityStatus: string;
  guidanceMessage: string;
  fingerState: PPGState;
  qualityScore: number;
  selectedChannel: string;
  [key: string]: unknown;
}

export interface PPGCapabilities {
  torchSupported: boolean;
}

/** CustomEvent<T> with `detail` typed - what every PPG event handler receives. */
export type PPGEvent<T> = CustomEvent<T>;

interface PPGEventMap {
  state: CustomEvent<{ state: PPGState; reason: string | null }>;
  beat: CustomEvent<{ ibiMs: number; heartRate: number }>;
  metrics: CustomEvent<PPGMetrics>;
  quality: CustomEvent<unknown>;
  waveform: CustomEvent<{ time: number; value: number; isProcessing: boolean }>;
  respiration: CustomEvent<{ rateBpm: number; confidence: number }>;
  error: CustomEvent<{ error: unknown }>;
}

/**
 * PPG - typed-event facade over the existing PPGMonitor pipeline. Always
 * headless (no container, no DOM UI, no CSS): callers that want a visual UI
 * build it themselves from these events (see examples/demo).
 */
export class PPG extends EventTarget {
  private _monitor: PPGMonitor;
  private _lastState: PPGState | null = null;

  constructor(options: PPGOptions = {}) {
    super();
    // headless: null container, UI forced off - the core bundle never
    // renders anything or injects CSS.
    const merged = { ...options, ui: { enabled: false } };
    this._monitor = new PPGMonitor(null, {
      ...merged,
      onReady: (info: { torchSupported: boolean }) => {
        this._capabilities = { torchSupported: !!info?.torchSupported };
      },
      onQualityUpdate: (metrics: PPGMetrics) => this._onQualityUpdate(metrics),
      onSignalUpdate: (signal: { time: number; value: number; isProcessing: boolean }) =>
        this.dispatchEvent(new CustomEvent('waveform', { detail: signal })),
      onError: (error: unknown) => this.dispatchEvent(new CustomEvent('error', { detail: { error } }))
    });
  }

  private _capabilities: PPGCapabilities = { torchSupported: false };

  private _onQualityUpdate(metrics: PPGMetrics): void {
    const state = metrics.fingerState;
    if (state !== this._lastState) {
      this._lastState = state;
      this.dispatchEvent(new CustomEvent('state', { detail: { state, reason: null } }));
    }
    this.dispatchEvent(new CustomEvent('metrics', { detail: metrics }));
    if ((metrics as any).quality) {
      this.dispatchEvent(new CustomEvent('quality', { detail: (metrics as any).quality }));
    }
    const ibiDetails = (metrics as any).ibiDetails as Array<{ valid: boolean; ibiMs: number }> | undefined;
    if (Array.isArray(ibiDetails)) {
      for (const d of ibiDetails) {
        if (d.valid) {
          this.dispatchEvent(new CustomEvent('beat', { detail: { ibiMs: d.ibiMs, heartRate: metrics.heartRate } }));
        }
      }
    }
  }

  /** Start capture. Pass an AbortSignal to auto-stop() on abort. */
  async start(signal?: AbortSignal): Promise<void> {
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener('abort', () => this.stop(), { once: true });
    }
    return this._monitor.start();
  }

  stop(): void {
    this._monitor.stop();
  }

  destroy(): void {
    this._monitor.destroy();
  }

  getMetrics(): PPGMetrics {
    return this._monitor.getMetrics();
  }

  getTachogram() {
    return this._monitor.getTachogram();
  }

  getSessionSummary() {
    return this._monitor.getSessionSummary();
  }

  exportDebugLog() {
    return this._monitor.getDebugLog();
  }

  /** Merged config actually in effect, including state-machine timing (settleSec etc). */
  getConfig() {
    return {
      ...this._monitor.options,
      settleSec: this._monitor.fingerState?.settleSec
    };
  }

  get capabilities(): PPGCapabilities {
    return this._capabilities;
  }
}

export { STATE };
export declare interface PPG {
  addEventListener<K extends keyof PPGEventMap>(
    type: K,
    listener: (ev: PPGEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener<K extends keyof PPGEventMap>(
    type: K,
    listener: (ev: PPGEventMap[K]) => void,
    options?: boolean | EventListenerOptions
  ): void;
}
