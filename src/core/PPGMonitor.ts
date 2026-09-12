import { SignalProcessor } from './SignalProcessor.js';
import { detrend } from './detrend.js';
import { windowMean } from './helpers.js';
import { createDefaultOptions, getContainerElement } from './helpers.js';
import { DebugRecorder } from './recorder.js';
import { pickBackCamera } from './camera.js';
import { FingerStateMachine, STATE, selectChannel } from './fingerState.js';
import { coachingMessage, qualityScore } from './coaching.js';

// Small offscreen canvas the frame is downscaled into before getImageData -
// 64x48 is plenty for a channel-mean ROI and is far cheaper per frame than
// reading a full 640x480 buffer every tick.
const ROI_CANVAS_WIDTH = 64;
const ROI_CANVAS_HEIGHT = 48;
// Minimum DC (mean channel value) for a channel to be eligible for AC/DC-
// ratio channel selection - a near-dark channel (e.g. green under a well-
// covered lens, DC ~13-19/255) inflates its AC/DC ratio via quantization
// noise, not real pulsatile signal (see real-log evidence).
const MIN_CHANNEL_DC = 40;

/** Peak-to-peak (max - min) of a typed array - cheap proxy for AC amplitude. */
function peakToPeak(arr) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return max - min;
}

/**
 * PPG Monitor - Real-time photoplethysmography signal monitoring
 * @class
 */
export class PPGMonitor {
  // ponytail: index signature instead of per-field declarations - straight
  // JS->TS move, tightening the surface is Phase 2 hygiene work.
  [key: string]: any;

  /**
   * Create a PPG Monitor instance
   * @param {string|HTMLElement|null} container - Container element or selector (null for headless mode)
   * @param {Object} options - Configuration options
   */
  constructor(container, options = {}) {
    // Merge options with defaults
    this.options = createDefaultOptions(options);

    // Get container element
    this.containerElement = getContainerElement(container);

    // Initialize components
    this.signalProcessor = new SignalProcessor(this.options.signal);
    // UI rendering (chart, video preview, technical info) lives in the demo
    // app now - the core bundle never touches the DOM beyond the video/
    // canvas elements it creates for capture, and never injects CSS.
    this.uiRenderer = null;

    // State
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    // Small downscaled ROI canvas - reused every frame instead of the
    // full-resolution `canvas` (still used to feed the video frame in).
    this.roiCanvas = null;
    this.roiCtx = null;
    this.stream = null;
    this.animationId = null;

    // Signal buffers
    this.acdc = new Float32Array(this.options.signal.windowLength).fill(0.5);
    this.ac = new Float32Array(this.options.signal.windowLength).fill(0.5);
    // Per-window red/green raw means, for AC/DC-based channel selection.
    this.redBuf = new Float32Array(this.options.signal.windowLength).fill(128);
    this.greenBuf = new Float32Array(this.options.signal.windowLength).fill(128);
    // Wall-clock timestamp (seconds) per sample, used to compute the real
    // capture rate instead of assuming a fixed FPS.
    this.frameTimestamps = new Float64Array(this.options.signal.windowLength);

    // Counters and timing
    this.frameCount = 0;
    this.nFrame = 0;
    this.initTime = null;
    this.isSignal = 0;
    this.acFrame = 0.008;
    this.acWindow = 0.008;

    // NO_FINGER/SETTLING/MEASURING gate - see utils/fingerState.js. HR/IBI/
    // RMSSD are only trustworthy (and only computed) while MEASURING.
    this.fingerState = new FingerStateMachine();
    this.selectedChannel = 'red';
    this.lastAcDcRatio = 0;

    // Session-long IBI tachogram (all candidates, valid + rejected - see
    // utils/peaks.js computeIBIs) and per-window good/HR/RMSSD/SDNN log,
    // for the demo's live plot and the Stop-time session summary.
    this.tachogram = [];
    this.sessionWindows = [];

    // Current metrics
    this.currentMetrics = {
      snr_dB: 0,
      perfusionIndex: 0,
      heartRate: 0,
      ibi: 0,
      qualityStatus: "Initializing",
      guidanceMessage: this.options.ui.enabled ? "Press Measure to start" : "Call start() to begin",
      fingerState: STATE.NO_FINGER,
      qualityScore: 0,
      selectedChannel: 'red'
    };

    // Bind methods
    this.computeFrame = this.computeFrame.bind(this);
    this.handleResize = this.handleResize.bind(this);

    // Always-on raw debug recorder (see utils/recorder.js). No toggle: a
    // bad/unrepeatable session must never be lost. Exported on demand via
    // getDebugLog()/downloadDebugLog().
    this.recorder = new DebugRecorder();
  }

  /**
   * Start PPG monitoring
   * @returns {Promise<void>}
   */
  async start() {
    try {
      // Create video and canvas elements
      this.video = document.createElement('video');
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');

      // Render UI if enabled
      if (this.uiRenderer) {
        this.uiRenderer.render(this.video, this.canvas, null);
      }

      // Request camera access. First pass unlocks device labels (Safari/
      // Chrome hide them until a permission grant exists) so we can pick
      // the physical main/wide rear lens by label below - without this,
      // iOS may hand out a virtual multi-camera device that silently
      // switches lenses (wide -> ultra-wide macro) once the finger gets
      // close, causing baseline jumps and torch loss mid-session.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.options.camera
      });

      let chosenDeviceId = null;
      let chosenLabel = null;
      let chosenBy = 'facingMode-fallback';
      let videoInputsMeta = [];
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoInputsMeta = devices
          .filter(d => d.kind === 'videoinput')
          .map(d => ({ deviceId: d.deviceId.slice(0, 8), label: d.label, kind: d.kind }));
        const picked = pickBackCamera(devices);
        if (picked) {
          chosenDeviceId = picked.deviceId;
          chosenLabel = picked.label;
          chosenBy = 'label-match';
          const initialTrack = this.stream.getVideoTracks()[0];
          if (initialTrack.getSettings && initialTrack.getSettings().deviceId !== picked.deviceId) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                deviceId: { exact: picked.deviceId },
                width: this.options.camera.width,
                height: this.options.camera.height,
                frameRate: this.options.camera.frameRate
              }
            });
          }
        }
      } catch (err) {
        // enumerateDevices/getUserMedia retry failed - keep the original
        // facingMode stream rather than aborting the whole session.
        console.warn('Camera lens selection skipped:', err);
      }


      // Lock exposure/WB/focus and enable torch where the device supports
      // it. Auto-exposure fighting the finger is the #1 cause of drifting
      // signal, so we lock everything the browser will let us lock, and
      // never assume torch exists (iOS Safari has none).
      const track = this.stream.getVideoTracks()[0];
      this.torchSupported = false;
      let capabilities: any = {};
      const advanced: any = {};
      let constraintsApplied = false;
      let constraintsError = null;
      let zoomApplied = false;
      let zoomError = null;
      let exposureModeAvailable = false;
      try {
        capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.torch) {
          advanced.torch = true;
          this.torchSupported = true;
        }
        // Real devices vary: iPhone rear cameras expose no exposureMode at
        // all (confirmed on the phone this fix targets) - log that
        // explicitly rather than silently no-op'ing, so a future debug log
        // makes clear this device gives us no exposure lock, not that the
        // lock attempt was skipped/broken.
        exposureModeAvailable = !!(capabilities.exposureMode && capabilities.exposureMode.includes('manual'));
        if (exposureModeAvailable) {
          advanced.exposureMode = 'manual';
        }
        if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('manual')) {
          advanced.whiteBalanceMode = 'manual';
        }
        if (capabilities.focusMode && capabilities.focusMode.includes('manual')) {
          advanced.focusMode = 'manual';
        }
        if (Object.keys(advanced).length > 0) {
          await track.applyConstraints({ advanced: [advanced] });
          constraintsApplied = true;
        }
      } catch (err) {
        console.warn('Could not apply camera capability constraints:', err);
        constraintsError = String(err && err.message || err);
      }

      // Zoom in on the lens: a moderate optical/digital zoom fills more of
      // the frame with fingertip (vs. lens + surrounding bezel), improving
      // per-pixel signal. Applied as its own constraint call so a failure
      // here doesn't roll back the exposure/WB/focus locks above.
      try {
        if (capabilities.zoom && capabilities.zoom.max >= 2) {
          const targetZoom = Math.min(2, capabilities.zoom.max);
          await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
          zoomApplied = true;
        }
      } catch (err) {
        console.warn('Could not apply zoom constraint:', err);
        zoomError = String(err && err.message || err);
      }

      // Assign stream to video
      this.video.srcObject = this.stream;

      // Wait for video to be ready
      await new Promise<void>((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          resolve();
        };
      });

      // Set canvas dimensions
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;

      // Downscaled ROI canvas: a center crop of the video is drawn scaled
      // down into this small canvas, so getImageData reads ROI_CANVAS_WIDTH
      // x ROI_CANVAS_HEIGHT pixels instead of the full frame - both a
      // tighter fingertip-only region and far less per-frame work.
      this.roiCanvas = document.createElement('canvas');
      this.roiCanvas.width = ROI_CANVAS_WIDTH;
      this.roiCanvas.height = ROI_CANVAS_HEIGHT;
      this.roiCtx = this.roiCanvas.getContext('2d', { willReadFrequently: true });

      const roiWidthFraction = this.options.roi.widthFraction;
      const roiHeightFraction = this.options.roi.heightFraction;
      this.roiSourceRect = {
        sx: this.video.videoWidth * (1 - roiWidthFraction) / 2,
        sy: this.video.videoHeight * (1 - roiHeightFraction) / 2,
        sw: this.video.videoWidth * roiWidthFraction,
        sh: this.video.videoHeight * roiHeightFraction
      };

      // Initialize timing
      this.initTime = new Date();

      // Capture session metadata once, for debug replay parity checks.
      const usesRVFC = typeof this.video.requestVideoFrameCallback === 'function';
      this.recorder.start({
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
        trackSettings: track.getSettings ? track.getSettings() : null,
        trackCapabilities: capabilities,
        constraintsRequested: advanced,
        constraintsApplied,
        constraintsError,
        exposureModeAvailable,
        zoomApplied,
        zoomError,
        torchSupported: this.torchSupported,
        frameCallbackMode: usesRVFC ? 'requestVideoFrameCallback' : 'requestAnimationFrame',
        roi: { widthFraction: roiWidthFraction, heightFraction: roiHeightFraction, ...this.roiSourceRect },
        signalOptions: this.options.signal,
        appVersion: null,
        videoInputs: videoInputsMeta,
        chosenDeviceId,
        chosenLabel,
        chosenBy
      });


      // Watch for the browser silently switching lens/track mid-session
      // (the exact iOS multi-cam behavior this whole change works around).
      // Checked once per window alongside metrics rather than every frame -
      // settings don't change fast enough to need per-frame polling, and
      // this keeps the hot path untouched.
      this._lastTrackSettings = track.getSettings ? track.getSettings() : {};
      track.onended = () => this.recorder.pushEvent({ t: performance.now(), type: 'track_ended' });
      track.onmute = () => this.recorder.pushEvent({ t: performance.now(), type: 'track_muted' });
      track.onunmute = () => this.recorder.pushEvent({ t: performance.now(), type: 'track_unmuted' });


      // Initialize chart if UI is enabled
      if (this.uiRenderer) {
        this.uiRenderer.initializeChart();
        this.uiRenderer.updateTechnicalInfo({
          resolution: `${this.video.videoWidth} x ${this.video.videoHeight}`,
          delay: 0
        });

        // Handle window resize
        window.addEventListener('resize', this.handleResize);
      }

      // Start frame processing
      this.computeFrame();

      // Emit ready callback
      if (this.options.onReady) {
        this.options.onReady({ torchSupported: this.torchSupported });
      }

    } catch (error) {
      console.error('Failed to start PPG monitor:', error);
      if (this.options.onError) {
        this.options.onError(error);
      }
      throw error;
    }
  }

  /**
   * Stop PPG monitoring
   */
  stop() {
    // Cancel animation frame
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // Cancel pending video frame callback (requestVideoFrameCallback path)
    if (this.rvfcHandle && this.video && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    this.nFrame = 0; // stop processing frames still in flight after this call

    // Stop video stream
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    // Pause video
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }

    // Remove resize listener
    if (this.uiRenderer) {
      window.removeEventListener('resize', this.handleResize);
    }
  }

  /**
   * Process a single video frame
   * @param {number} [now] - performance.now()-relative timestamp (seconds)
   *   when using requestVideoFrameCallback; falls back to Date.now() under rAF.
   */
  computeFrame(now?: number) {
    const DURATION = 100; // Initial frames to skip
    const timestampSec = now !== undefined ? now / 1000 : Date.now() / 1000;

    if (this.nFrame > DURATION) {
      // Draw a center-cropped, downscaled ROI instead of the whole frame:
      // most of a 640x480 frame is unlit bezel once only the lens+flash are
      // covered, and averaging it in dilutes the real fingertip signal.
      const { sx, sy, sw, sh } = this.roiSourceRect;
      this.roiCtx.drawImage(this.video, sx, sy, sw, sh, 0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
      const frame = this.roiCtx.getImageData(0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);

      const count = frame.data.length / 4;
      let rSum = 0, gSum = 0, bSum = 0;
      for (let i = 0; i < count; i++) {
        rSum += frame.data[i * 4];
        gSum += frame.data[i * 4 + 1];
        bSum += frame.data[i * 4 + 2];
      }
      const rMean = rSum / count;
      const gMean = gSum / count;
      const bMean = bSum / count;

      // Invert and normalize. Camera PPG: more blood under the finger means
      // more light absorption, so raw red intensity DROPS at systole -
      // inverting here makes systolic peaks maxima, matching a pulse oximeter.
      const xMean = 1 - rMean / 255;
      // Same inversion for green, used when selectChannel picks it.
      const gxMean = 1 - gMean / 255;

      // Raw debug sample - always recorded, no toggle.
      this.recorder.pushSample({ t: timestampSec * 1000, r: rMean, g: gMean, b: bMean });

      // NO_FINGER/SETTLING/MEASURING gate. Runs every frame (cheap: a few
      // comparisons + a short rolling-drift array), not just at window
      // boundaries, so a lift is caught immediately rather than up to 5s late.
      const sessionSec = this.initTime ? (Date.now() - Number(this.initTime)) / 1000 : timestampSec;
      const acDcForGate = this.lastAcDcRatio;
      const { state: fingerState, changed: stateChanged, reason: stateReason } =
        this.fingerState.update({ tSec: sessionSec, redMean: rMean, greenMean: gMean, blueMean: bMean, acDcRatio: acDcForGate });

      if (stateChanged) {
        this.recorder.pushEvent({ t: timestampSec * 1000, type: 'state_transition', state: fingerState, reason: stateReason });
        if (fingerState === STATE.SETTLING) {
          // A lift, a large drift, or a fresh placement all invalidate the
          // sample buffer - reset it so stale pre-transition samples can
          // never pollute the next MEASURING window (buffer is a ring, so
          // without this a lift mid-window would leave old good samples
          // mixed with new noise until the ring fully cycles).
          this.nFrame = DURATION; // next tick starts a fresh window at slot 0 post-increment semantics below
          this.acdc.fill(0.5);
          this.redBuf.fill(rMean);
          this.greenBuf.fill(gMean);
          this.signalProcessor.reset();
        }
      }

      // Store in buffer
      const slot = this.nFrame % this.options.signal.windowLength;
      this.acdc[slot] = this.selectedChannel === 'green' ? gxMean : xMean;
      this.redBuf[slot] = rMean;
      this.greenBuf[slot] = gMean;
      this.frameTimestamps[slot] = timestampSec;

      // Process window every WINDOW_LENGTH frames. Always process - the
      // previous version alternated between processing and freezing the UI
      // for 100 windows (~8 minutes) at a time, which made most short
      // measurements look completely dead.
      if (this.nFrame % this.options.signal.windowLength === 0) {
        const windowNum = this.nFrame / this.options.signal.windowLength;
        this.isSignal = 1;

        // Per-window AC/DC ratio for red and green, to pick the better
        // channel for peak detection (hysteresis avoids flipping every
        // window on a marginal difference). A channel whose DC is too low
        // (near-dark, e.g. an uncovered/under-covered green channel) is
        // excluded - its AC/DC ratio is quantization noise, not signal.
        const redDc = windowMean(this.redBuf);
        const greenDc = windowMean(this.greenBuf);
        const redAc = peakToPeak(this.redBuf) / (redDc || 1);
        const greenAc = peakToPeak(this.greenBuf) / (greenDc || 1);
        const redEligible = redDc > MIN_CHANNEL_DC;
        const greenEligible = greenDc > MIN_CHANNEL_DC;
        const redRatio = redEligible ? redAc : 0;
        const greenRatio = greenEligible ? greenAc : 0;
        this.selectedChannel = (redEligible || greenEligible)
          ? selectChannel(this.selectedChannel, redRatio, greenRatio)
          : 'red';
        this.lastAcDcRatio = this.selectedChannel === 'green' ? greenRatio : redRatio;

        // Detrend signal
        const detrendedArray = detrend(this.acdc);
        this.ac = new Float32Array(detrendedArray);
        this.acWindow = windowMean(this.ac);

        // Real measured sample rate for this window, not an assumed FPS.
        const sampleRate = this.measuredSampleRate();

        // Only run HR/IBI/RMSSD/SDNN while MEASURING - the first ~15s of any
        // session (placement + iOS re-exposure settling) produces numbers
        // that look plausible but are noise, per the real-log evidence this
        // whole change is built from. Strict per-window quality gating
        // (utils/quality.js `good`) happens inside process().
        if (fingerState === STATE.MEASURING) {
          this.currentMetrics = this.signalProcessor.process(this.acdc, this.ac, sampleRate, {
            fingerState,
            acDcRatio: this.lastAcDcRatio,
            nowSec: sessionSec
          });
        } else {
          this.currentMetrics = {
            snr_dB: 0, perfusionIndex: 0, heartRate: 0, heartRateRaw: 0,
            ibi: 0, rmssd: 0, sdnn: 0, artifactRatio: 0, sampleRate,
            signalStability: 0, qualityStatus: 'Initializing',
            guidanceMessage: '', qualityFrameCount: 0,
            quality: { state: fingerState, acdc: 0, artifactRatio: 0, ibiCount: 0, fftAgree: true, good: false, reason: fingerState === STATE.NO_FINGER ? 'No finger detected' : 'Settling' },
            peakTimesSec: [], ibiDetails: []
          };
        }
        this.currentMetrics.fingerState = fingerState;
        this.currentMetrics.selectedChannel = this.selectedChannel;
        this.currentMetrics.acDcRatio = this.lastAcDcRatio;
        this.currentMetrics.settleRemainingSec = fingerState === STATE.SETTLING
          ? Math.max(0, this.fingerState.settleSec - this.fingerState.timeInState(sessionSec))
          : 0;
        this.currentMetrics.qualityScore = this.currentMetrics.quality.good
          ? qualityScore(this.lastAcDcRatio, this.currentMetrics.artifactRatio)
          : 0;
        this.currentMetrics.guidanceMessage = this.currentMetrics.quality.good
          ? coachingMessage({
              state: fingerState,
              torchSupported: this.torchSupported,
              redMean: rMean,
              greenMean: gMean,
              blueMean: bMean,
              settleRemainingSec: this.fingerState.settleSec - this.fingerState.timeInState(sessionSec),
              acDcRatio: this.lastAcDcRatio
            })
          : this.currentMetrics.quality.reason;

        // Session-long tachogram + good-window accounting, for the demo's
        // IBI plot and the Stop-time summary (getSessionSummary()). Only
        // GOOD windows contribute HR/RMSSD/SDNN samples and accepted-beat
        // tachogram points; rejected/missed beats are kept too (drawn as
        // hollow/red markers by the caller) so the user can see what was
        // thrown out even during a not-good stretch.
        if (Array.isArray(this.currentMetrics.ibiDetails)) {
          for (const d of this.currentMetrics.ibiDetails) {
            this.tachogram.push({ t: sessionSec, ibiMs: d.ibiMs, valid: d.valid, reason: d.reason });
          }
        }
        this.sessionWindows.push({
          t: sessionSec,
          good: this.currentMetrics.quality.good,
          heartRate: this.currentMetrics.heartRate,
          rmssd: this.currentMetrics.rmssd,
          sdnn: this.currentMetrics.sdnn
        });


        // Log derived events for offline/live comparison (see utils/recorder.js).
        const windowEndMs = timestampSec * 1000;
        const windowStartMs = windowEndMs - (this.options.signal.windowLength / sampleRate) * 1000;
        if (Array.isArray(this.currentMetrics.peakTimesSec)) {
          for (const peakSec of this.currentMetrics.peakTimesSec) {
            this.recorder.pushEvent({ t: windowStartMs + peakSec * 1000, type: 'peak' });
          }
        }
        if (Array.isArray(this.currentMetrics.ibiDetails)) {
          for (const d of this.currentMetrics.ibiDetails) {
            this.recorder.pushEvent({
              t: windowStartMs + d.peakTimeSec * 1000,
              type: d.valid ? 'ibi_accepted' : 'ibi_rejected',
              ibiMs: d.ibiMs,
              reason: d.reason
            });
          }
        }
        this.recorder.pushEvent({
          t: windowEndMs,
          type: 'metrics_update',
          heartRate: this.currentMetrics.heartRate,
          rmssd: this.currentMetrics.rmssd,
          qualityStatus: this.currentMetrics.qualityStatus,
          snr_dB: this.currentMetrics.snr_dB,
          fingerState,
          selectedChannel: this.selectedChannel,
          acDcRatio: this.lastAcDcRatio,
          ibiFftDisagree: this.currentMetrics.ibiFftDisagree || false
        });

        // Detect the exact failure mode this whole change targets: iOS
        // silently swapping the active lens/resolution mid-session.
        const liveTrack = this.stream && this.stream.getVideoTracks()[0];
        if (liveTrack && liveTrack.getSettings) {
          const settings = liveTrack.getSettings();
          const prev = this._lastTrackSettings || {};
          const keys = ['deviceId', 'width', 'height', 'frameRate'];
          const changed = keys.some(k => settings[k] !== prev[k]);
          if (changed) {
            this.recorder.pushEvent({
              t: windowEndMs,
              type: 'track_settings_changed',
              from: { deviceId: (prev.deviceId || '').slice(0, 8), width: prev.width, height: prev.height, frameRate: prev.frameRate },
              to: { deviceId: (settings.deviceId || '').slice(0, 8), width: settings.width, height: settings.height, frameRate: settings.frameRate }
            });
          }
          this._lastTrackSettings = settings;
        }

        // Update UI
        if (this.uiRenderer) {
          this.uiRenderer.updateMetrics(this.currentMetrics);
          this.uiRenderer.updateTechnicalInfo({
            window: windowNum
          });
        }

        // Emit quality update callback
        if (this.options.onQualityUpdate) {
          this.options.onQualityUpdate(this.currentMetrics);
        }
      }

      // Get current AC value
      this.acFrame = this.ac[this.nFrame % this.options.signal.windowLength];

      // Haptic tick on each accepted beat (Android Chrome; no-op elsewhere -
      // iOS Safari has no navigator.vibrate). Approximated here as "just
      // crossed into a new peak this frame" via the peak list from the last
      // processed window would require frame-accurate replay of history, so
      // instead we tick once per window when a fresh MEASURING window
      // reports at least one accepted beat - close enough for a haptic cue
      // and avoids re-deriving frame-level peak timing here.
      if (
        this.nFrame % this.options.signal.windowLength === 0 &&
        fingerState === STATE.MEASURING &&
        typeof navigator !== 'undefined' && navigator.vibrate &&
        Array.isArray(this.currentMetrics.ibiDetails) &&
        this.currentMetrics.ibiDetails.some(d => d.valid)
      ) {
        navigator.vibrate(10);
      }

      // Update chart
      if (this.uiRenderer && this.nFrame % 10 === 0) {
        this.uiRenderer.updateChart({
          value: this.acFrame,
          isSignal: this.isSignal
        });
      }

      // Emit signal update callback
      if (this.options.onSignalUpdate) {
        this.options.onSignalUpdate({
          time: (Date.now() - Number(this.initTime)) / 1000,
          value: this.acFrame,
          isProcessing: this.isSignal === 1
        });
      }

      // Update technical info (lazy update every 10 frames)
      if (this.frameCount % 10 === 0 && this.uiRenderer) {
        const frameTime = ((Date.now() - Number(this.initTime)) / 1000).toFixed(2);
        const videoTime = this.video.currentTime.toFixed(2);
        const fps = (this.frameCount / this.video.currentTime).toFixed(3);

        this.uiRenderer.updateTechnicalInfo({
          frameTime,
          videoTime,
          fps,
          frameCount: this.frameCount,
          signal: xMean.toFixed(4)
        });
      }

      // Emit frame callback
      if (this.options.onFrame) {
        this.options.onFrame({
          frameCount: this.frameCount,
          xMean,
          acFrame: this.acFrame
        });
      }

      this.frameCount++;
    }

    this.nFrame++;

    // Continue processing. Prefer requestVideoFrameCallback: it fires once
    // per actual decoded camera frame (not once per display refresh) and
    // hands back the frame's real capture time, which is what
    // measuredSampleRate() below needs. Falls back to requestAnimationFrame
    // on browsers without rVFC (older Safari).
    if (this.video.requestVideoFrameCallback) {
      this.rvfcHandle = this.video.requestVideoFrameCallback((nowMs, metadata) => {
        // WebKit live camera streams report mediaTime as 0 on iOS (it's a
        // media-element timeline concept that doesn't apply to a live
        // MediaStream), which poisons measuredSampleRate() and every peak
        // timestamp downstream. expectedDisplayTime and nowMs are both in
        // the performance.now() clock domain (ms) and are always populated,
        // so prefer expectedDisplayTime (closer to actual capture) and fall
        // back to nowMs. Never use mediaTime.
        const edt = metadata.expectedDisplayTime;
        const t = (typeof edt === 'number' && isFinite(edt) && edt > 0) ? edt : nowMs;
        this.computeFrame(t);
      });
    } else {
      this.animationId = requestAnimationFrame(() => this.computeFrame(performance.now()));
    }
  }

  /**
   * Real sample rate (Hz) measured from actual frame timestamps in the
   * current window, instead of assuming a fixed FPS. Camera capture rate
   * varies with lighting/exposure and is often well below the display's
   * 60Hz refresh, especially with torch + finger covering the lens.
   * @returns {number}
   */
  measuredSampleRate() {
    const ts = this.frameTimestamps;
    const n = ts.length;
    if (n < 2) return this.options.signal.sampleRate;

    // frameTimestamps is a ring buffer; find min/max within the current
    // window (ignore zero-initialized slots not yet written).
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (ts[i] === 0) continue;
      if (ts[i] < min) min = ts[i];
      if (ts[i] > max) max = ts[i];
    }

    const elapsed = max - min;
    if (!isFinite(elapsed) || elapsed <= 0) return this.options.signal.sampleRate;

    const rate = (n - 1) / elapsed;
    // Sanity clamp: reject absurd values (e.g. clock jump) rather than
    // feeding garbage into the FFT/filter frequency axis.
    if (rate < 1 || rate > 240) return this.options.signal.sampleRate;
    return rate;
  }

  /**
   * Handle window resize
   */
  handleResize() {
    if (this.uiRenderer) {
      this.uiRenderer.handleResize();
    }
  }

  /**
   * Get the raw debug log recorded so far: {meta, samples, events}.
   * Available whether or not the session is still running.
   * @returns {{meta: Object|null, samples: Array, events: Array}}
   */
  getDebugLog() {
    return this.recorder.toJSON();
  }

  /**
   * Trigger a browser download of the debug log as JSON. Works via
   * Blob + <a download> on Android Chrome and iOS Safari 13+ (iOS shows
   * the share sheet instead of a direct save - that's expected).
   * @returns {string} filename used
   */
  downloadDebugLog() {
    const json = JSON.stringify(this.getDebugLog(), null, 2);
    const filename = `ppg-debug-${new Date().toISOString()}.json`;
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

  /**
   * Copy the debug log JSON to the clipboard - fallback for browsers/contexts
   * where a download prompt isn't convenient (e.g. no Files app handy).
   * @returns {Promise<void>}
   */
  async copyDebugLogToClipboard() {
    const json = JSON.stringify(this.getDebugLog());
    await navigator.clipboard.writeText(json);
  }

  /**
   * Session-long IBI tachogram: every candidate IBI (accepted + rejected),
   * for the demo's live tachogram plot. Rejected/missed beats included so
   * the caller can draw hollow/red markers for what was thrown out.
   * @returns {Array<{t:number, ibiMs:number, valid:boolean, reason:string|null}>}
   */
  getTachogram() {
    return this.tachogram;
  }

  /**
   * Session summary over GOOD windows only (see utils/quality.js) - min/
   * median/max HR, RMSSD, SDNN, plus the fraction of session time that was
   * good. Call any time, including after stop().
   * @returns {Object}
   */
  getSessionSummary() {
    const good = this.sessionWindows.filter(w => w.good);
    const median = (arr) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const stats = (arr) => arr.length ? { min: Math.min(...arr), median: median(arr), max: Math.max(...arr) } : null;

    return {
      totalWindows: this.sessionWindows.length,
      goodWindows: good.length,
      goodFraction: this.sessionWindows.length ? good.length / this.sessionWindows.length : 0,
      hr: stats(good.map(w => w.heartRate).filter(v => v > 0)),
      rmssd: stats(good.map(w => w.rmssd).filter(v => v > 0)),
      sdnn: stats(good.map(w => w.sdnn).filter(v => v > 0))
    };
  }

  /**
   * Get current signal quality metrics
   * @returns {Object} Current metrics
   */
  getMetrics() {
    return { ...this.currentMetrics };
  }

  /**
   * Get current signal quality status
   * @returns {string} Quality status
   */
  getSignalQuality() {
    return this.currentMetrics.qualityStatus;
  }

  /**
   * Destroy the PPG monitor and cleanup
   */
  destroy() {
    this.stop();

    if (this.uiRenderer) {
      this.uiRenderer.destroy();
      this.uiRenderer = null;
    }

    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.stream = null;

    this.acdc = null;
    this.ac = null;
  }
}

export default PPGMonitor;
