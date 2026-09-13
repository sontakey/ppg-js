declare const __PPG_VERSION__: string | undefined;
import { createDefaultOptions, getContainerElement, type MonitorOptions, type ReadyInfo } from './helpers.js';
import { DebugRecorder, type DebugLog } from './recorder.js';
import { pickBackCamera } from './camera.js';
import { STATE, type FingerState } from './fingerState.js';
import { coachingMessage } from './coaching.js';
import { PpgEngine, type EngineWindow, type TachogramPoint, type SessionSummary } from './engine.js';
import { PPGError } from './errors.js';

// Small offscreen canvas the ROI is downscaled into before getImageData.
const ROI_CANVAS_WIDTH = 64;
const ROI_CANVAS_HEIGHT = 48;
// Red values at or above this count as clipped (sensor saturation).
const CLIP_LEVEL = 250;
// Minimum red DC used by the physical torch check.
const MIN_CHANNEL_DC = 40;
// Frames skipped right after the camera starts (exposure ramp).
const WARMUP_FRAMES = 30;

type VideoFrameMetadata = {
  expectedDisplayTime?: number;
  captureTime?: number;
  presentedFrames?: number;
  mediaTime?: number;
};

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface OpenedCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  chosenDeviceId: string | null;
  chosenLabel: string | null;
  chosenBy: string;
  videoInputsMeta: Array<{ deviceId: string; label: string; kind: string }>;
  capabilities: Record<string, unknown>;
  applied: Record<string, unknown>;
  constraintErrors: Record<string, string>;
  torchSupported: boolean;
  torchState: string;
}

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?: (t: string, cb: () => void) => void };

/**
 * Camera adapter: acquires the rear camera, reads ROI channel means once
 * per real camera frame and feeds them to a PpgEngine. Records everything
 * for offline replay. Renders no UI.
 */
export class PPGMonitor {
  readonly options: MonitorOptions;
  containerElement: HTMLElement | null;
  engine: PpgEngine;
  recorder: DebugRecorder;
  video: VideoWithRvfc | null = null;
  stream: MediaStream | null = null;
  currentMetrics: Record<string, unknown>;
  torchSupported = false;
  torchState = 'unknown';
  running = false;
  frameCount = 0;

  // Test seams (the parity test stubs these).
  roiCtx: CanvasRenderingContext2D | { drawImage: (...a: unknown[]) => void; getImageData: (...a: unknown[]) => ImageData } | null = null;
  roiSourceRect: { sx: number; sy: number; sw: number; sh: number } | null = null;
  startTimestampSec: number | null = null;

  private roiCanvas: HTMLCanvasElement | null = null;
  private ownsVideo = true;
  private rvfcHandle: number | null = null;
  private animationId: number | null = null;
  private lastPresentedFrames: number | null = null;
  private _torchCapable = false;
  private _chosenDeviceId: string | null = null;
  private _resuming = false;
  private _lastRedMean: number | null = null;
  private _preHiddenRedMean: number | null = null;
  private _trackMutedAt: number | null = null;
  private _exposureLocked = false;
  private _lastTrackSettings: Record<string, unknown> | null = null;
  private _lastLoggedCoachMessage: string | null = null;
  private _lastState: FingerState = STATE.NO_FINGER;
  private _torchWatchInterval: ReturnType<typeof setInterval> | null = null;
  private _settingsSnapshotInterval: ReturnType<typeof setInterval> | null = null;
  private _onVisibilityChange: (() => void) | null = null;
  private _onPageHide: (() => void) | null = null;
  private _onMotion: ((e: DeviceMotionEvent) => void) | null = null;
  private wakeLockSentinel: WakeLockSentinelLike | null = null;
  private wakeLockActive = false;
  private motionActive = false;
  private motionValue = 0;

  constructor(container: string | HTMLElement | null = null, options: Record<string, unknown> = {}) {
    this.options = createDefaultOptions(options);
    this.containerElement = getContainerElement(container);
    this.engine = new PpgEngine(this.options.signal);
    this.recorder = new DebugRecorder(this.options.debug.sampleCap);
    this.currentMetrics = this._initialMetrics();
    this.computeFrame = this.computeFrame.bind(this);
  }

  private _initialMetrics(): Record<string, unknown> {
    return {
      snr_dB: 0, perfusionIndex: 0, heartRate: 0, heartRateRaw: 0, ibi: 0, rmssd: 0, sdnn: 0,
      qualityStatus: 'Initializing', guidanceMessage: 'Call start() to begin',
      fingerState: STATE.NO_FINGER, qualityScore: 0, selectedChannel: 'red', acDcRatio: 0,
      quality: { state: STATE.NO_FINGER, good: false, reason: 'No finger detected', code: 'no_finger' },
      settleRemainingSec: 0, peakTimesSec: [], ibiDetails: []
    };
  }

  // ------------------------------------------------------------ lifecycle

  /** Request the camera and begin measuring. Rejects with a PPGError. */
  async start(): Promise<void> {
    if (this.running) this.stop();
    try {
      this._preflight();
      // Fresh session state (docs/audit finding B10).
      this.engine = new PpgEngine(this.options.signal);
      this.frameCount = 0;
      this.startTimestampSec = null;
      this.lastPresentedFrames = null;
      this._exposureLocked = false;
      this._lastState = STATE.NO_FINGER;
      this._lastLoggedCoachMessage = null;
      this.currentMetrics = this._initialMetrics();

      if (this.options.video) {
        this.video = this.options.video as VideoWithRvfc;
        this.ownsVideo = false;
      } else {
        this.video = document.createElement('video') as VideoWithRvfc;
        this.ownsVideo = true;
      }
      this.video.setAttribute('playsinline', '');
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.autoplay = true;

      const opened = await this._openCamera();
      this._adoptCamera(opened);
      this._setupRoi();

      const usesRVFC = typeof this.video.requestVideoFrameCallback === 'function';
      const wakeLock = this.options.wakeLock ? await this._acquireWakeLock() : false;
      const motion = this.options.motion ? await this._startMotion() : false;

      this.recorder.start({
        userAgent: this.options.debug.includeUserAgent && typeof navigator !== 'undefined' ? navigator.userAgent : null,
        screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
        trackSettings: opened.track.getSettings ? opened.track.getSettings() : null,
        trackCapabilities: opened.capabilities,
        constraintsApplied: opened.applied,
        constraintErrors: opened.constraintErrors,
        torchSupported: this.torchSupported,
        frameCallbackMode: usesRVFC ? 'requestVideoFrameCallback' : 'requestAnimationFrame',
        roi: { ...this.options.roi, ...(this.roiSourceRect || {}) },
        engineConfig: this.engine.config,
        cameraOptions: this.options.camera,
        wakeLock,
        motion,
        appVersion: typeof __PPG_VERSION__ !== 'undefined' ? __PPG_VERSION__ : null,
        videoInputs: opened.videoInputsMeta,
        chosenDeviceId: opened.chosenDeviceId,
        chosenLabel: opened.chosenLabel,
        chosenBy: opened.chosenBy
      });

      this._bindTrackHandlers(opened.track);
      this._installWatchers();

      this.running = true;
      this._scheduleNextFrame();

      if (this.options.onReady) {
        const info: ReadyInfo = { torchSupported: this.torchSupported, torchState: this.torchState, wakeLock, motion, capabilities: opened.capabilities };
        this.options.onReady(info);
      }
    } catch (error) {
      const err = PPGError.from(error);
      this.running = false;
      if (this.options.onError) this.options.onError(err);
      throw err;
    }
  }

  private _preflight(): void {
    if (typeof navigator === 'undefined' || typeof document === 'undefined') throw new PPGError('unsupported');
    if (typeof window !== 'undefined' && 'isSecureContext' in window && !window.isSecureContext) throw new PPGError('insecure_context');
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') throw new PPGError('unsupported');
  }

  private _adoptCamera(opened: OpenedCamera): void {
    this.stream = opened.stream;
    this._chosenDeviceId = opened.chosenDeviceId;
    this.torchSupported = opened.torchSupported;
    this.torchState = opened.torchState;
    this._torchCapable = !!opened.capabilities.torch;
  }

  private _setupRoi(): void {
    if (!this.video) return;
    if (!this.roiCanvas) {
      this.roiCanvas = document.createElement('canvas');
      this.roiCanvas.width = ROI_CANVAS_WIDTH;
      this.roiCanvas.height = ROI_CANVAS_HEIGHT;
      this.roiCtx = this.roiCanvas.getContext('2d', { willReadFrequently: true });
    }
    const w = this.video.videoWidth || 640, h = this.video.videoHeight || 480;
    const { widthFraction, heightFraction } = this.options.roi;
    this.roiSourceRect = {
      sx: w * (1 - widthFraction) / 2,
      sy: h * (1 - heightFraction) / 2,
      sw: Math.max(1, w * widthFraction),
      sh: Math.max(1, h * heightFraction)
    };
  }

  private _installWatchers(): void {
    // Torch can be dropped silently on any camera-session interruption;
    // poll every 2 s and eagerly on visibility return.
    this._torchWatchInterval = setInterval(() => {
      const liveTrack = this.stream && this.stream.getVideoTracks()[0];
      if (liveTrack && liveTrack.readyState === 'ended') { void this._resumeCamera('watchdog_ended'); return; }
      void this._reapplyTorchIfNeeded('interval');
    }, 2000);

    this._onVisibilityChange = () => {
      this.recorder.pushEvent({ t: nowMs(), type: 'visibilitychange', visibilityState: document.visibilityState });
      if (document.visibilityState === 'visible') {
        if (this.options.wakeLock && !this.wakeLockActive) void this._acquireWakeLock();
        const liveTrack = this.stream && this.stream.getVideoTracks()[0];
        const mutedTooLong = this._trackMutedAt != null && (nowMs() - this._trackMutedAt) > 1000;
        if (!liveTrack || liveTrack.readyState === 'ended' || mutedTooLong) {
          void this._resumeCamera('visibilitychange');
        } else {
          void this._forceReapplyTorch('visibilitychange');
        }
      } else {
        this._preHiddenRedMean = this._lastRedMean;
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._onPageHide = () => {
      this.recorder.pushEvent({ t: nowMs(), type: 'pagehide' });
      if (this.options.debug.persistLastSession) this._persistLastSessionLog();
    };
    window.addEventListener('pagehide', this._onPageHide);

    this._settingsSnapshotInterval = setInterval(() => {
      const liveTrack = this.stream && this.stream.getVideoTracks()[0];
      if (!liveTrack || !liveTrack.getSettings) return;
      this.recorder.pushEvent({ t: nowMs(), type: 'track_settings_snapshot', settings: liveTrack.getSettings() });
    }, 10000);
  }

  stop(): void {
    this.running = false;
    if (this.animationId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animationId);
    this.animationId = null;
    if (this.rvfcHandle != null && this.video && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.rvfcHandle);
    this.rvfcHandle = null;

    if (this._torchWatchInterval) { clearInterval(this._torchWatchInterval); this._torchWatchInterval = null; }
    if (this._settingsSnapshotInterval) { clearInterval(this._settingsSnapshotInterval); this._settingsSnapshotInterval = null; }
    if (this._onVisibilityChange) { document.removeEventListener('visibilitychange', this._onVisibilityChange); this._onVisibilityChange = null; }
    if (this._onPageHide) { window.removeEventListener('pagehide', this._onPageHide); this._onPageHide = null; }
    this._stopMotion();
    void this._releaseWakeLock();

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.video) {
      try { this.video.pause(); } catch { /* no-op */ }
      this.video.srcObject = null;
    }
    if (this.options.debug.persistLastSession) this._persistLastSessionLog();
  }

  destroy(): void {
    this.stop();
    if (this.video && this.ownsVideo && this.video.parentNode) this.video.parentNode.removeChild(this.video);
    this.video = null;
    this.roiCanvas = null;
    this.roiCtx = null;
    this.stream = null;
  }

  // -------------------------------------------------------------- camera

  private async _getUserMediaWithRetry(constraints: MediaStreamConstraints): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
      // Android Chrome can report the camera busy for a moment right after
      // a previous stream was stopped; one short retry clears it.
      if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        await new Promise(r => setTimeout(r, 300));
        return navigator.mediaDevices.getUserMedia(constraints);
      }
      throw err;
    }
  }

  private _baseVideoConstraints(): MediaTrackConstraints {
    const c = this.options.camera;
    return { width: c.width, height: c.height, frameRate: c.frameRate };
  }

  /**
   * Acquire the camera stream: facingMode first (unlocks labels), then a
   * targeted re-open of the physical wide rear lens by label, then torch
   * as its own constraint set. Exposure/white-balance/focus locks are
   * applied later, once the finger has settled (see _setLocks).
   */
  private async _openCamera(deviceId?: string): Promise<OpenedCamera> {
    let stream: MediaStream;
    let chosenDeviceId: string | null = deviceId || null;
    let chosenLabel: string | null = null;
    let chosenBy = deviceId ? 'resume-same-device' : 'facingMode-fallback';
    let videoInputsMeta: OpenedCamera['videoInputsMeta'] = [];

    if (deviceId) {
      stream = await this._getUserMediaWithRetry({ audio: false, video: { deviceId: { exact: deviceId }, ...this._baseVideoConstraints() } });
    } else {
      stream = await this._getUserMediaWithRetry({ audio: false, video: { ...this._baseVideoConstraints(), facingMode: this.options.camera.facingMode } });
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoInputsMeta = devices.filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId.slice(0, 8), label: d.label, kind: d.kind }));
        const picked = pickBackCamera(devices);
        if (picked) {
          chosenDeviceId = picked.deviceId;
          chosenLabel = picked.label;
          chosenBy = 'label-match';
          const initialTrack = stream.getVideoTracks()[0];
          if (initialTrack.getSettings && initialTrack.getSettings().deviceId !== picked.deviceId) {
            stream.getTracks().forEach(t => t.stop());
            stream = await this._getUserMediaWithRetry({ audio: false, video: { deviceId: { exact: picked.deviceId }, ...this._baseVideoConstraints() } });
          }
        }
      } catch (err) {
        console.warn('Camera lens selection skipped:', err);
      }
    }

    const track = stream.getVideoTracks()[0];
    const capabilities: Record<string, unknown> = (track.getCapabilities ? (track.getCapabilities() as Record<string, unknown>) : {}) || {};
    const applied: Record<string, unknown> = {};
    const constraintErrors: Record<string, string> = {};
    let torchSupported = false;
    let torchState = 'unknown';

    // Each capability goes in its own `advanced` set: the spec applies a
    // set only if ALL its members can be satisfied, so bundling torch with
    // focus/exposure lets one unsupported combination silently drop the
    // torch (docs/audit finding B1).
    if (capabilities.torch && this.options.camera.torch) {
      torchSupported = true;
      try {
        await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
        applied.torch = true;
      } catch (err) {
        constraintErrors.torch = String((err as Error)?.message || err);
      }
    } else {
      torchState = 'unsupported';
    }
    if (this.options.camera.lockExposure === 'start') {
      Object.assign(applied, await this._setLocks(track, capabilities, true, constraintErrors));
      this._exposureLocked = true;
    }
    const zoom = this.options.camera.zoom;
    const zoomCap = capabilities.zoom as { min?: number; max?: number } | undefined;
    if (zoom && zoomCap && typeof zoomCap.max === 'number' && zoomCap.max >= zoom) {
      try {
        await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
        applied.zoom = zoom;
      } catch (err) {
        constraintErrors.zoom = String((err as Error)?.message || err);
      }
    }

    if (!this.video) throw new PPGError('unknown', 'video element missing');
    const video = this.video;
    video.srcObject = stream;
    await new Promise<void>((resolve) => {
      let done = false;
      // Some WebViews never fire loadedmetadata for a live stream.
      const timer = setTimeout(() => finish(), 3000);
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      video.onloadedmetadata = () => {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch((e: unknown) => this.recorder.pushEvent({ t: nowMs(), type: 'video_play_rejected', error: String(e) }));
        finish();
      };
    });

    if (torchSupported) {
      const after = track.getSettings ? (track.getSettings() as Record<string, unknown>) : {};
      torchState = after.torch === true ? 'on' : 'off';
      applied.torchSetting = after.torch;
    }

    return { stream, track, chosenDeviceId, chosenLabel, chosenBy, videoInputsMeta, capabilities, applied, constraintErrors, torchSupported, torchState };
  }

  /**
   * Lock (or release) exposure, white balance and focus, one advanced set
   * per capability, reading back what actually took effect.
   */
  private async _setLocks(track: MediaStreamTrack, capabilities: Record<string, unknown>, lock: boolean, errors: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const applied: Record<string, unknown> = {};
    const modes: Array<'exposureMode' | 'whiteBalanceMode' | 'focusMode'> = ['exposureMode', 'whiteBalanceMode', 'focusMode'];
    const want = lock ? 'manual' : 'continuous';
    for (const key of modes) {
      const supported = capabilities[key] as string[] | undefined;
      if (!Array.isArray(supported) || !supported.includes(want)) continue;
      try {
        await track.applyConstraints({ advanced: [{ [key]: want } as MediaTrackConstraintSet] });
        const settings = track.getSettings ? (track.getSettings() as Record<string, unknown>) : {};
        applied[key] = settings[key] ?? want;
      } catch (err) {
        errors[key] = String((err as Error)?.message || err);
      }
    }
    return applied;
  }

  private async _lockExposureNow(trigger: string): Promise<void> {
    if (this._exposureLocked || this.options.camera.lockExposure !== 'measuring') return;
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    this._exposureLocked = true;
    const capabilities = (track.getCapabilities ? (track.getCapabilities() as Record<string, unknown>) : {}) || {};
    const errors: Record<string, string> = {};
    const applied = await this._setLocks(track, capabilities, true, errors);
    this.recorder.pushEvent({ t: nowMs(), type: 'exposure_locked', trigger, applied, errors });
  }

  private async _unlockExposure(trigger: string): Promise<void> {
    if (!this._exposureLocked || this.options.camera.lockExposure !== 'measuring') return;
    const track = this.stream && this.stream.getVideoTracks()[0];
    this._exposureLocked = false;
    if (!track || track.readyState !== 'live') return;
    const capabilities = (track.getCapabilities ? (track.getCapabilities() as Record<string, unknown>) : {}) || {};
    const applied = await this._setLocks(track, capabilities, false);
    this.recorder.pushEvent({ t: nowMs(), type: 'exposure_unlocked', trigger, applied });
  }

  private _bindTrackHandlers(track: MediaStreamTrack): void {
    this._trackMutedAt = null;
    track.onended = () => {
      this.recorder.pushEvent({ t: nowMs(), type: 'track_ended' });
      void this._resumeCamera('track_onended');
    };
    track.onmute = () => {
      this._trackMutedAt = nowMs();
      this.recorder.pushEvent({ t: nowMs(), type: 'track_muted' });
    };
    track.onunmute = () => {
      const mutedMs = this._trackMutedAt != null ? nowMs() - this._trackMutedAt : 0;
      this._trackMutedAt = null;
      if (mutedMs > 1500) {
        this.recorder.pushEvent({ t: nowMs(), type: 'track_unmuted', mutedMs });
        void this._resumeCamera('track_unmute_long');
        return;
      }
      this.recorder.pushEvent({ t: nowMs(), type: 'track_unmuted' });
      void this._forceReapplyTorch('track_unmute');
    };
  }

  /** Re-assert torch unconditionally (iOS can report torch:true while dark). */
  async _forceReapplyTorch(trigger: string): Promise<void> {
    if (!this._torchCapable || !this.stream || !this.options.camera.torch) return;
    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    try {
      await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
      const after = track.getSettings ? (track.getSettings() as Record<string, unknown>) : {};
      this.torchState = after.torch === true ? 'on' : 'off';
      this.recorder.pushEvent({ t: nowMs(), type: 'torch_reapplied', trigger, ok: this.torchState === 'on', forced: true });
    } catch (err) {
      this.recorder.pushEvent({ t: nowMs(), type: 'torch_reapplied', trigger, ok: false, forced: true, error: String((err as Error)?.message || err) });
    }
    this._schedulePhysicalTorchCheck(trigger);
  }

  private _schedulePhysicalTorchCheck(trigger: string): void {
    const baseline = this._preHiddenRedMean;
    if (!this._torchCapable || !baseline) return;
    setTimeout(() => {
      if (!this.stream || this._resuming) return;
      const state = this.engine.state;
      if (state !== STATE.MEASURING && state !== STATE.SETTLING) return;
      const dc = this._lastRedMean;
      const droppedHalf = typeof dc === 'number' && dc < baseline * 0.5;
      const belowFloor = typeof dc === 'number' && dc < MIN_CHANNEL_DC;
      if (droppedHalf || belowFloor) {
        this.recorder.pushEvent({ t: nowMs(), type: 'torch_physically_dark', trigger, baseline, dc });
        void this._resumeCamera('torch_physically_dark');
      }
    }, 2000);
  }

  /** Re-acquire the same camera after an interruption ended or muted the track. */
  async _resumeCamera(trigger: string): Promise<void> {
    if (this._resuming || !this.stream) return;
    this._resuming = true;
    this.recorder.pushEvent({ t: nowMs(), type: 'camera_resuming', trigger });
    this.currentMetrics.guidanceMessage = 'Resuming camera';
    if (this.options.onQualityUpdate) this.options.onQualityUpdate(this.currentMetrics);

    let ok = false;
    let error: string | null = null;
    try {
      this.stream.getTracks().forEach(t => t.stop());
      const opened = await this._openCamera(this._chosenDeviceId || undefined);
      this._adoptCamera(opened);
      this._bindTrackHandlers(opened.track);
      this._setupRoi();
      // A resume is a new placement: drop signal state, keep the tachogram and clock.
      this.engine.reset();
      this._exposureLocked = false;
      if (!this.recorder.meta) this.recorder.meta = {};
      const resumes = (this.recorder.meta.resumes as unknown[]) || [];
      resumes.push({ t: nowMs(), trigger, trackSettings: opened.track.getSettings ? opened.track.getSettings() : null });
      this.recorder.meta.resumes = resumes;
      // The rAF fallback can stall on a torn-down track; re-arm it.
      if (this.running && this.video && !this.video.requestVideoFrameCallback && this.animationId == null) this._scheduleNextFrame();
      ok = true;
    } catch (err) {
      error = String((err as Error)?.message || err);
      console.error('Camera resume failed:', err);
      if (this.options.onError) this.options.onError(PPGError.from(err));
    } finally {
      this._resuming = false;
      this.recorder.pushEvent({ t: nowMs(), type: 'camera_resumed', trigger, ok, ...(error ? { error } : {}) });
    }
  }

  async _reapplyTorchIfNeeded(trigger: string): Promise<void> {
    if (!this._torchCapable || !this.stream || !this.options.camera.torch) return;
    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    let settings: Record<string, unknown> = {};
    try { settings = track.getSettings ? (track.getSettings() as Record<string, unknown>) : {}; } catch { return; }
    const isOn = settings.torch === true;
    const prevState = this.torchState;
    this.torchState = isOn ? 'on' : 'off';
    if (isOn) return;
    if (prevState === 'on') this.recorder.pushEvent({ t: nowMs(), type: 'torch_lost', trigger });
    try {
      await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
      const after = track.getSettings ? (track.getSettings() as Record<string, unknown>) : {};
      this.torchState = after.torch === true ? 'on' : 'off';
      this.recorder.pushEvent({ t: nowMs(), type: 'torch_reapplied', trigger, ok: this.torchState === 'on' });
    } catch (err) {
      this.recorder.pushEvent({ t: nowMs(), type: 'torch_reapplied', trigger, ok: false, error: String((err as Error)?.message || err) });
    }
  }

  // ------------------------------------------------------- wake lock / motion

  private async _acquireWakeLock(): Promise<boolean> {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }) : null;
    if (!nav || !nav.wakeLock) return false;
    try {
      this.wakeLockSentinel = await nav.wakeLock.request('screen');
      this.wakeLockActive = true;
      this.wakeLockSentinel.addEventListener?.('release', () => { this.wakeLockActive = false; });
      this.recorder.pushEvent({ t: nowMs(), type: 'wake_lock', ok: true });
      return true;
    } catch (err) {
      this.recorder.pushEvent({ t: nowMs(), type: 'wake_lock', ok: false, error: String((err as Error)?.message || err) });
      return false;
    }
  }

  private async _releaseWakeLock(): Promise<void> {
    if (this.wakeLockSentinel) {
      try { await this.wakeLockSentinel.release(); } catch { /* no-op */ }
    }
    this.wakeLockSentinel = null;
    this.wakeLockActive = false;
  }

  private async _startMotion(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return false;
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    try {
      if (typeof DME.requestPermission === 'function') {
        const res = await DME.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch { return false; }
    this._onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const dev = Math.abs(mag - 9.81);
      this.motionValue += 0.2 * (dev - this.motionValue);
    };
    window.addEventListener('devicemotion', this._onMotion);
    this.motionActive = true;
    return true;
  }

  private _stopMotion(): void {
    if (this._onMotion && typeof window !== 'undefined') window.removeEventListener('devicemotion', this._onMotion);
    this._onMotion = null;
    this.motionActive = false;
    this.motionValue = 0;
  }

  // ----------------------------------------------------------- frame loop

  private _scheduleNextFrame(): void {
    if (!this.running || !this.video) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = this.video.requestVideoFrameCallback((nowMsArg, metadata) => this.computeFrame(nowMsArg, metadata));
    } else if (typeof requestAnimationFrame === 'function') {
      this.animationId = requestAnimationFrame(() => this.computeFrame(nowMs()));
    }
  }

  /**
   * Process one camera frame. Public so tests can drive it directly.
   * @param now - ms timestamp (performance.now() domain) of this frame
   * @param metadata - requestVideoFrameCallback metadata, when available
   */
  computeFrame(now?: number, metadata?: VideoFrameMetadata): void {
    if (!this.running && this.startTimestampSec == null && now === undefined) return;
    try {
      this._processFrame(now, metadata);
    } catch (err) {
      // Never let one bad frame kill the loop silently (docs/audit B5).
      this.recorder.pushEvent({ t: nowMs(), type: 'frame_error', error: String((err as Error)?.message || err) });
      if (this.options.onError) this.options.onError(PPGError.from(err));
    } finally {
      if (this.running) this._scheduleNextFrame();
    }
  }

  private _processFrame(now: number | undefined, metadata: VideoFrameMetadata | undefined): void {
    // Timestamp: captureTime (Chromium, local camera) > expectedDisplayTime
    // > callback time. WebKit reports mediaTime as 0 for live streams, so it
    // is never used.
    let tMs = typeof now === 'number' ? now : nowMs();
    if (metadata) {
      const ct = metadata.captureTime, edt = metadata.expectedDisplayTime;
      if (typeof ct === 'number' && Number.isFinite(ct) && ct > 0) tMs = ct;
      else if (typeof edt === 'number' && Number.isFinite(edt) && edt > 0) tMs = edt;
      if (typeof metadata.presentedFrames === 'number') {
        if (this.lastPresentedFrames != null) this.recorder.addDroppedFrames(metadata.presentedFrames - this.lastPresentedFrames - 1);
        this.lastPresentedFrames = metadata.presentedFrames;
      }
    }
    this.frameCount++;
    if (this.frameCount <= WARMUP_FRAMES && !this.startTimestampSec && metadata) return;
    if (!this.roiCtx || !this.roiSourceRect || !this.video) return;

    const { sx, sy, sw, sh } = this.roiSourceRect;
    if (!(sw > 0 && sh > 0)) return;
    this.roiCtx.drawImage(this.video, sx, sy, sw, sh, 0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
    const frame = this.roiCtx.getImageData(0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
    const data = frame.data;
    const count = data.length / 4;
    let rSum = 0, gSum = 0, bSum = 0, clipped = 0;
    for (let i = 0; i < count; i++) {
      const r = data[i * 4];
      rSum += r; gSum += data[i * 4 + 1]; bSum += data[i * 4 + 2];
      if (r >= CLIP_LEVEL) clipped++;
    }
    const rMean = rSum / count, gMean = gSum / count, bMean = bSum / count;
    const clippedFraction = clipped / count;
    this._lastRedMean = rMean;

    if (this.startTimestampSec == null) this.startTimestampSec = tMs / 1000;
    const tSec = tMs / 1000 - this.startTimestampSec;
    const motion = this.motionActive ? this.motionValue : undefined;

    this.recorder.pushSample({ t: tMs, r: rMean, g: gMean, b: bMean, clipped: clippedFraction, ...(motion !== undefined ? { motion } : {}) });

    const res = this.engine.push({ t: tSec, r: rMean, g: gMean, b: bMean, clipped: clippedFraction, motion });

    if (res.stateChanged) this._onStateChange(res.state, res.stateReason, tSec, tMs);
    if (res.window) this._onWindow(res.window, tMs, rMean, gMean, bMean, clippedFraction);

    if (this.options.onSignalUpdate) {
      this.options.onSignalUpdate({ time: tSec, value: res.waveform, isProcessing: res.state === STATE.MEASURING });
    }
    if (this.options.onFrame) {
      this.options.onFrame({ frameCount: this.frameCount, xMean: 1 - rMean / 255, acFrame: res.waveform, clippedFraction });
    }
  }

  private _onStateChange(state: FingerState, reason: string | null, tSec: number, tMs: number): void {
    this._lastState = state;
    this.recorder.pushEvent({ t: tMs, type: 'state_transition', state, reason });
    const liveTrack = this.stream && this.stream.getVideoTracks()[0];
    if (liveTrack && liveTrack.getSettings) {
      this.recorder.pushEvent({ t: tMs, type: 'track_settings_snapshot', settings: liveTrack.getSettings(), trigger: 'state_transition' });
    }
    if (state === STATE.SETTLING) void this._reapplyTorchIfNeeded('state_transition_settling');
    if (state === STATE.MEASURING) void this._lockExposureNow('measuring');
    if (state === STATE.NO_FINGER) void this._unlockExposure('finger_lifted');
    // Immediate coaching update on a transition (windows only come every few seconds).
    this.currentMetrics.fingerState = state;
    this.currentMetrics.settleRemainingSec = state === STATE.SETTLING ? this.engine.fingerState.settleSec : 0;
    if (this.options.onState) this.options.onState({ state, reason, time: tSec });
  }

  private _onWindow(w: EngineWindow, tMs: number, rMean: number, gMean: number, bMean: number, clippedFraction: number): void {
    const windowEndMs = tMs;
    const startMs = (this.startTimestampSec || 0) * 1000;
    const guidance = coachingMessage({
      state: w.fingerState,
      torchSupported: this.torchSupported,
      redMean: rMean, greenMean: gMean, blueMean: bMean,
      settleRemainingSec: w.settleRemainingSec,
      acDcRatio: w.acDcRatio,
      qualityCode: w.quality.code,
      clippedFraction
    });

    const metrics: Record<string, unknown> = {
      t: w.t,
      snr_dB: w.snr_dB,
      perfusionIndex: w.perfusionIndex,
      heartRate: w.heartRate,
      heartRateRaw: w.heartRateRaw,
      heartRateFFT: w.heartRateFFT,
      heartRateIBI: w.heartRateIBI,
      heartRateSource: w.heartRateSource,
      ibiFftDisagree: w.ibiFftDisagree,
      harmonicCorrected: w.harmonicCorrected,
      ibi: w.ibi,
      rmssd: w.rmssd,
      sdnn: w.sdnn,
      rmssdFloorMs: w.rmssdFloorMs,
      timingUncertaintyMs: w.timingUncertaintyMs,
      artifactRatio: w.artifactRatio,
      templateSqi: w.templateSqi,
      sampleRate: w.sampleRate,
      signalStability: w.signalStability,
      qualityStatus: w.qualityStatus,
      guidanceMessage: guidance,
      fingerState: w.fingerState,
      selectedChannel: w.selectedChannel,
      acDcRatio: w.acDcRatio,
      rawRangeRatio: w.rawRangeRatio,
      redDc: w.redDc,
      greenDc: w.greenDc,
      clippedFraction: w.clippedFraction,
      motion: w.motion,
      qualityScore: w.qualityScore,
      settleRemainingSec: w.settleRemainingSec,
      quality: w.quality,
      peakTimesSec: w.peakTimesSec,
      ibiDetails: w.ibiDetails,
      respiration: w.respiration,
      sqi: w.sqi,
      torchState: this.torchState,
      gap: w.gap
    };
    this.currentMetrics = metrics;

    if (guidance !== this._lastLoggedCoachMessage) {
      this._lastLoggedCoachMessage = guidance;
      this.recorder.pushEvent({ t: windowEndMs, type: 'coaching_message', message: guidance, state: w.fingerState });
    }

    const rejectionReasons: Record<string, number> = {};
    for (const d of w.ibiDetails) {
      if (d.valid) continue;
      const key = d.reason || 'unknown';
      rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
    }
    this.recorder.pushWindow({
      t: w.t, state: w.fingerState, acdc: w.acDcRatio, rawRange: w.rawRangeRatio, dcRed: w.redDc, dcGreen: w.greenDc,
      clipped: w.clippedFraction, motion: w.motion, channel: w.selectedChannel, artifactRatio: w.artifactRatio,
      ibiCount: w.quality.ibiCount, fftHr: w.heartRateFFT, ibiHr: w.heartRateIBI, fftAgree: !w.ibiFftDisagree,
      harmonicCorrected: w.harmonicCorrected, templateSqi: w.templateSqi, rmssdFloorMs: w.rmssdFloorMs, sqiScore: w.sqi ? w.sqi.score : null,
      good: w.quality.good, reason: w.quality.reason, code: w.quality.code, rejectionReasons, sampleRate: w.sampleRate,
      gap: w.gap, torchState: this.torchState
    });

    for (const peakSec of w.peakTimesSec) this.recorder.pushEvent({ t: startMs + peakSec * 1000, type: 'peak' });
    for (const d of w.ibiDetails) {
      this.recorder.pushEvent({ t: startMs + d.peakTimeSec * 1000, type: d.valid ? 'ibi_accepted' : 'ibi_rejected', ibiMs: d.ibiMs, reason: d.reason, good: d.good, lowSnr: d.lowSnr, sqi: d.sqi });
    }
    this.recorder.pushEvent({
      t: windowEndMs, type: 'metrics_update', heartRate: w.heartRate, rmssd: w.rmssd, qualityStatus: w.qualityStatus,
      snr_dB: w.snr_dB, fingerState: w.fingerState, selectedChannel: w.selectedChannel, acDcRatio: w.acDcRatio,
      ibiFftDisagree: w.ibiFftDisagree, good: w.quality.good, reason: w.quality.reason
    });

    const liveTrack = this.stream && this.stream.getVideoTracks()[0];
    if (liveTrack && liveTrack.getSettings) {
      const settings = liveTrack.getSettings() as Record<string, unknown>;
      const prev = this._lastTrackSettings || {};
      const keys = ['deviceId', 'width', 'height', 'frameRate'];
      if (keys.some(k => settings[k] !== prev[k])) {
        this.recorder.pushEvent({
          t: windowEndMs, type: 'track_settings_changed',
          from: { deviceId: String(prev.deviceId || '').slice(0, 8), width: prev.width, height: prev.height, frameRate: prev.frameRate },
          to: { deviceId: String(settings.deviceId || '').slice(0, 8), width: settings.width, height: settings.height, frameRate: settings.frameRate }
        });
      }
      this._lastTrackSettings = settings;
    }

    if (w.fingerState === STATE.MEASURING && typeof navigator !== 'undefined' && 'vibrate' in navigator && typeof navigator.vibrate === 'function' && w.ibiDetails.some(d => d.valid)) {
      try { navigator.vibrate(10); } catch { /* no-op */ }
    }

    if (this.options.onQualityUpdate) this.options.onQualityUpdate(this.currentMetrics);
  }

  // ------------------------------------------------------------- accessors

  /** Camera sample rate measured over the last window, Hz (0 before the first window). */
  measuredSampleRate(): number {
    return this.engine.lastWindow ? this.engine.lastWindow.sampleRate : 0;
  }

  getEngine(): PpgEngine { return this.engine; }

  getMetrics(): Record<string, unknown> { return { ...this.currentMetrics }; }

  getSignalQuality(): string { return String(this.currentMetrics.qualityStatus || ''); }

  getDebugLog(): DebugLog { return this.recorder.toJSON(); }

  downloadDebugLog(filenamePrefix = 'ppg-debug'): string {
    const json = JSON.stringify(this.getDebugLog(), null, 2);
    const filename = `${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return filename;
  }

  async copyDebugLogToClipboard(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) throw new PPGError('unsupported', 'Clipboard API unavailable');
    await navigator.clipboard.writeText(JSON.stringify(this.getDebugLog()));
  }

  /** Session tachogram; pass { goodOnly: true } for beats from windows that passed the gate. */
  getTachogram(opts: { goodOnly?: boolean; hrvOnly?: boolean } = {}): TachogramPoint[] { return this.engine.getTachogram(opts); }

  getSessionSummary(): SessionSummary { return this.engine.getSessionSummary(); }

  /** Persist the debug log to localStorage (opt-in via debug.persistLastSession). */
  _persistLastSessionLog(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const log = this.getDebugLog();
      let json = JSON.stringify(log);
      const LIMIT = 4.5 * 1024 * 1024;
      if (json.length > LIMIT) {
        this.recorder.markTruncated();
        json = JSON.stringify({ ...log, samples: log.samples.slice(-2000), truncated: true });
      }
      localStorage.setItem('ppg_last_session_log', json);
    } catch {
      try {
        this.recorder.markTruncated();
        localStorage.setItem('ppg_last_session_log', JSON.stringify({ ...this.getDebugLog(), samples: [] }));
      } catch (err2) {
        console.warn('Could not persist debug log:', err2);
      }
    }
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export default PPGMonitor;
