import type { EngineOptions } from './engine.js';

/** Mean of an array or typed array. */
export function windowMean(array: ArrayLike<number>): number {
  const n = array.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += array[i];
  return sum / n;
}

/** Legacy SNR bucket label. */
export function getQualityStatus(snr: number): 'Excellent' | 'Good' | 'Fair' | 'Poor' {
  if (snr >= 10) return 'Excellent';
  if (snr >= 5) return 'Good';
  if (snr >= 0) return 'Fair';
  return 'Poor';
}

export interface CameraOptions {
  width: ConstrainULong;
  height: ConstrainULong;
  frameRate: ConstrainDouble;
  facingMode: ConstrainDOMString;
  /** Digital zoom to request (opt-in; on some Android phones zoom > 1 switches to a lens with no torch). */
  zoom: number | null;
  /** When to lock exposure/white balance/focus: after the finger has settled (default), at start, or never. */
  lockExposure: 'measuring' | 'start' | 'never';
  /** Request the torch when the device advertises it. */
  torch: boolean;
}

export interface RoiOptions { widthFraction: number; heightFraction: number; }

export interface DebugOptions {
  /** Persist the last session's debug log to localStorage on stop()/pagehide (raw PPG is health data: opt-in). */
  persistLastSession: boolean;
  /** Include navigator.userAgent in the debug log meta. */
  includeUserAgent: boolean;
  /** Ring-buffer capacity for raw samples. */
  sampleCap: number;
}

export interface MonitorCallbacks {
  onReady: ((info: ReadyInfo) => void) | null;
  onQualityUpdate: ((metrics: Record<string, unknown>) => void) | null;
  onSignalUpdate: ((s: { time: number; value: number; isProcessing: boolean }) => void) | null;
  onFrame: ((f: { frameCount: number; xMean: number; acFrame: number; clippedFraction: number }) => void) | null;
  onState: ((s: { state: string; reason: string | null; time: number }) => void) | null;
  onError: ((err: unknown) => void) | null;
}

export interface ReadyInfo {
  torchSupported: boolean;
  torchState: string;
  wakeLock: boolean;
  motion: boolean;
  capabilities: Record<string, unknown>;
}

export interface MonitorOptions extends MonitorCallbacks {
  ui: { enabled: boolean };
  /** Engine (signal-processing) options. Legacy `windowLength`/`sampleRate` keys are ignored. */
  signal: Partial<EngineOptions> & { windowLength?: number; sampleRate?: number };
  camera: CameraOptions;
  roi: RoiOptions;
  debug: DebugOptions;
  /** Keep the screen awake while measuring (navigator.wakeLock). */
  wakeLock: boolean;
  /** Feed device motion into the quality gate (asks permission on iOS). */
  motion: boolean;
  /** Caller-supplied <video> element for the capture stream. */
  video: HTMLVideoElement | null;
}

export type MonitorUserOptions = {
  [K in keyof MonitorOptions]?: MonitorOptions[K] extends object | null
    ? (MonitorOptions[K] extends null ? MonitorOptions[K] : Partial<NonNullable<MonitorOptions[K]>> | null)
    : MonitorOptions[K];
};

export function createDefaultOptions(userOptions: Record<string, unknown> = {}): MonitorOptions {
  const u = userOptions as MonitorUserOptions;
  const defaults: MonitorOptions = {
    ui: { enabled: false },
    signal: {},
    camera: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 60 },
      facingMode: 'environment',
      zoom: null,
      lockExposure: 'measuring',
      torch: true
    },
    roi: { widthFraction: 0.3, heightFraction: 0.3 },
    debug: { persistLastSession: false, includeUserAgent: false, sampleCap: 10 * 60 * 60 },
    wakeLock: true,
    motion: false,
    video: null,
    onFrame: null,
    onQualityUpdate: null,
    onSignalUpdate: null,
    onState: null,
    onError: null,
    onReady: null
  };
  const fn = <T>(v: T | undefined | null, d: T): T => (typeof v === 'function' ? v : d);
  return {
    ui: { ...defaults.ui, ...(u.ui || {}) },
    signal: { ...defaults.signal, ...(u.signal || {}) },
    camera: { ...defaults.camera, ...(u.camera || {}) } as CameraOptions,
    roi: { ...defaults.roi, ...(u.roi || {}) },
    debug: { ...defaults.debug, ...(u.debug || {}) },
    wakeLock: u.wakeLock ?? defaults.wakeLock,
    motion: u.motion ?? defaults.motion,
    video: (u.video as HTMLVideoElement | null | undefined) ?? null,
    onFrame: fn(u.onFrame as MonitorCallbacks['onFrame'], null),
    onQualityUpdate: fn(u.onQualityUpdate as MonitorCallbacks['onQualityUpdate'], null),
    onSignalUpdate: fn(u.onSignalUpdate as MonitorCallbacks['onSignalUpdate'], null),
    onState: fn(u.onState as MonitorCallbacks['onState'], null),
    onError: fn(u.onError as MonitorCallbacks['onError'], null),
    onReady: fn(u.onReady as MonitorCallbacks['onReady'], null)
  };
}

/** Resolve a container selector/element (kept for API compatibility; the core renders no UI). */
export function getContainerElement(container: string | HTMLElement | null | undefined): HTMLElement | null {
  if (!container) return null;
  if (typeof container === 'string') return typeof document !== 'undefined' ? document.querySelector<HTMLElement>(container) : null;
  if (typeof HTMLElement !== 'undefined' && container instanceof HTMLElement) return container;
  return null;
}
