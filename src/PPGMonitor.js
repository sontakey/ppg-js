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

      // Enable torch/flashlight
      const track = this.stream.getVideoTracks()[0];
      try {
        const imageCapture = new ImageCapture(track);
        await imageCapture.getPhotoCapabilities();
        await track.applyConstraints({
          advanced: [{ torch: true }]
        });
      } catch (err) {
        console.warn('Torch not available:', err);
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
        this.options.onReady();
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
   */
  computeFrame() {
    const DURATION = 100; // Initial frames to skip

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

      // Invert and normalize
      const xMean = 1 - rgbRed / (count * 255);

      // Store in buffer
      this.acdc[this.nFrame % this.options.signal.windowLength] = xMean;

      // Process window every WINDOW_LENGTH frames
      if (this.nFrame % this.options.signal.windowLength === 0) {
        const windowNum = this.nFrame / this.options.signal.windowLength;

        // Alternate between processing and holding
        if (Math.floor(windowNum / 100) % 2 === 0) {
          this.isSignal = 1;

          // Detrend signal
          const detrendedArray = detrend(this.acdc);
          this.ac = new Float32Array(detrendedArray);
          this.acWindow = windowMean(this.ac);

          // Calculate signal quality
          this.currentMetrics = this.signalProcessor.process(this.acdc, this.ac);

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

        } else {
          this.ac = new Float32Array(this.options.signal.windowLength).fill(this.acWindow);
          this.isSignal = 0;
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

    // Continue processing
    this.animationId = requestAnimationFrame(this.computeFrame);
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
