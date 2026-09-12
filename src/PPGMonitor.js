import { SignalProcessor } from './SignalProcessor.js';
import { UIRenderer } from './UIRenderer.js';
import { detrend } from './utils/detrend.js';
import { windowMean } from './utils/helpers.js';
import { createDefaultOptions, getContainerElement } from './utils/helpers.js';

/**
 * PPG Monitor - Real-time photoplethysmography signal monitoring
 * @class
 */
export class PPGMonitor {
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
    this.uiRenderer = this.options.ui.enabled && this.containerElement ?
      new UIRenderer(this.containerElement, this.options.ui) : null;

    // State
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.stream = null;
    this.animationId = null;

    // Signal buffers
    this.acdc = new Float32Array(this.options.signal.windowLength).fill(0.5);
    this.ac = new Float32Array(this.options.signal.windowLength).fill(0.5);
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

    // Current metrics
    this.currentMetrics = {
      snr_dB: 0,
      perfusionIndex: 0,
      heartRate: 0,
      ibi: 0,
      qualityStatus: "Initializing",
      guidanceMessage: this.options.ui.enabled ? "Press Measure to start" : "Call start() to begin"
    };

    // Bind methods
    this.computeFrame = this.computeFrame.bind(this);
    this.handleResize = this.handleResize.bind(this);
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

      // Request camera access
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.options.camera
      });

      // Lock exposure/WB/focus and enable torch where the device supports
      // it. Auto-exposure fighting the finger is the #1 cause of drifting
      // signal, so we lock everything the browser will let us lock, and
      // never assume torch exists (iOS Safari has none).
      const track = this.stream.getVideoTracks()[0];
      this.torchSupported = false;
      try {
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        const advanced = {};
        if (capabilities.torch) {
          advanced.torch = true;
          this.torchSupported = true;
        }
        if (capabilities.exposureMode && capabilities.exposureMode.includes('manual')) {
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
        }
      } catch (err) {
        console.warn('Could not apply camera capability constraints:', err);
      }

      // Assign stream to video
      this.video.srcObject = this.stream;

      // Wait for video to be ready
      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          resolve();
        };
      });

      // Set canvas dimensions
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;

      // Initialize timing
      this.initTime = new Date();

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
  computeFrame(now) {
    const DURATION = 100; // Initial frames to skip
    const timestampSec = now !== undefined ? now / 1000 : Date.now() / 1000;

    if (this.nFrame > DURATION) {
      // Draw video frame to canvas
      this.ctx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
      const frame = this.ctx.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);

      // Extract red channel mean
      const count = frame.data.length / 4;
      let rgbRed = 0;
      for (let i = 0; i < count; i++) {
        rgbRed += frame.data[i * 4]; // Red channel
      }

      // Invert and normalize. Camera PPG: more blood under the finger means
      // more light absorption, so raw red intensity DROPS at systole -
      // inverting here makes systolic peaks maxima, matching a pulse oximeter.
      const xMean = 1 - rgbRed / (count * 255);

      // Store in buffer
      const slot = this.nFrame % this.options.signal.windowLength;
      this.acdc[slot] = xMean;
      this.frameTimestamps[slot] = timestampSec;

      // Process window every WINDOW_LENGTH frames. Always process - the
      // previous version alternated between processing and freezing the UI
      // for 100 windows (~8 minutes) at a time, which made most short
      // measurements look completely dead.
      if (this.nFrame % this.options.signal.windowLength === 0) {
        const windowNum = this.nFrame / this.options.signal.windowLength;
        this.isSignal = 1;

        // Detrend signal
        const detrendedArray = detrend(this.acdc);
        this.ac = new Float32Array(detrendedArray);
        this.acWindow = windowMean(this.ac);

        // Real measured sample rate for this window, not an assumed FPS.
        const sampleRate = this.measuredSampleRate();

        // Calculate signal quality
        this.currentMetrics = this.signalProcessor.process(this.acdc, this.ac, sampleRate);

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
          time: (new Date() - this.initTime) / 1000,
          value: this.acFrame,
          isProcessing: this.isSignal === 1
        });
      }

      // Update technical info (lazy update every 10 frames)
      if (this.frameCount % 10 === 0 && this.uiRenderer) {
        const frameTime = ((new Date() - this.initTime) / 1000).toFixed(2);
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
      this.rvfcHandle = this.video.requestVideoFrameCallback((_nowMs, metadata) => {
        this.computeFrame(metadata.mediaTime * 1000);
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
