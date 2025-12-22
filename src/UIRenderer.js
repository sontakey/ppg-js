import { RealTimeChart } from './components/RealTimeChart.js';

/**
 * UI Renderer for PPG Monitor
 * Handles all DOM manipulation, metrics display, and chart rendering
 */
export class UIRenderer {
  /**
   * Create a UI Renderer
   * @param {HTMLElement} container - Container element
   * @param {Object} options - UI options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.elements = {};
    this.chart = null;
    this.chartData = [];
    this.maxLength = 100;
    this.initTime = null;
  }

  /**
   * Render the complete UI structure
   * @param {HTMLVideoElement} videoElement - Video element for camera preview
   * @param {HTMLCanvasElement} canvasElement - Canvas element for processing
   * @param {Function} onStartCallback - Callback when measure button is clicked
   */
  render(videoElement, canvasElement, onStartCallback) {
    // Clear container
    this.container.innerHTML = '';

    // Create measure button
    const button = document.createElement('button');
    button.id = 'ppg-measure-btn';
    button.textContent = 'Measure';
    button.style.cssText = 'margin: 10px; width:100px; height:30px; font-size:15px;';
    button.addEventListener('click', () => {
      button.disabled = true;
      if (onStartCallback) onStartCallback();
    });
    this.container.appendChild(button);
    this.elements.button = button;

    // Create preview and quality container
    const previewQualityContainer = document.createElement('div');
    previewQualityContainer.className = 'preview-quality-container';

    // Preview section
    const previewSection = document.createElement('div');
    previewSection.className = 'preview-section';

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';

    videoElement.id = 'ppg-video';
    videoContainer.appendChild(videoElement);

    // Finger guide overlay
    const fingerGuide = document.createElement('div');
    fingerGuide.className = 'finger-guide';

    const guideCircle = document.createElement('div');
    guideCircle.className = 'guide-circle';
    fingerGuide.appendChild(guideCircle);

    const guideText = document.createElement('p');
    guideText.className = 'guide-text';
    guideText.textContent = 'Cover camera with finger';
    fingerGuide.appendChild(guideText);

    videoContainer.appendChild(fingerGuide);
    previewSection.appendChild(videoContainer);

    // Quality metrics section
    const qualitySection = document.createElement('div');
    qualitySection.className = 'quality-section';

    const qualityTitle = document.createElement('h3');
    qualityTitle.textContent = 'Signal Quality';
    qualitySection.appendChild(qualityTitle);

    // Metrics
    const metrics = [
      { label: 'SNR:', id: 'snr-value', defaultValue: '-- dB' },
      { label: 'Perfusion Index:', id: 'pi-value', defaultValue: '--%' },
      { label: 'Heart Rate:', id: 'hr-value', defaultValue: '-- BPM' },
      { label: 'IBI:', id: 'ibi-value', defaultValue: '-- ms' }
    ];

    metrics.forEach(metric => {
      const metricDiv = document.createElement('div');
      metricDiv.className = 'quality-metric';

      const label = document.createElement('div');
      label.className = 'metric-label';
      label.textContent = metric.label;

      const value = document.createElement('div');
      value.className = 'metric-value';
      value.id = metric.id;
      value.textContent = metric.defaultValue;

      metricDiv.appendChild(label);
      metricDiv.appendChild(value);
      qualitySection.appendChild(metricDiv);

      this.elements[metric.id] = value;
    });

    // Quality status
    const qualityStatus = document.createElement('div');
    qualityStatus.id = 'quality-status';
    qualityStatus.className = 'quality-status initializing';
    qualityStatus.textContent = 'Initializing';
    qualitySection.appendChild(qualityStatus);
    this.elements.qualityStatus = qualityStatus;

    // Guidance message
    const guidanceMessage = document.createElement('div');
    guidanceMessage.id = 'guidance-message';
    guidanceMessage.className = 'guidance-message';
    guidanceMessage.textContent = 'Press Measure to start';
    qualitySection.appendChild(guidanceMessage);
    this.elements.guidanceMessage = guidanceMessage;

    previewQualityContainer.appendChild(previewSection);
    previewQualityContainer.appendChild(qualitySection);
    this.container.appendChild(previewQualityContainer);

    // Canvas (hidden, only for processing)
    canvasElement.id = 'ppg-canvas';
    canvasElement.style.display = 'none';
    this.container.appendChild(canvasElement);

    // Chart container
    if (this.options.showChart) {
      const chartDiv = document.createElement('div');
      chartDiv.id = 'ppg-chart';
      this.container.appendChild(chartDiv);
      this.elements.chart = chartDiv;

      // Initialize chart
      this.chart = new RealTimeChart({
        width: this.container.clientWidth || 600,
        duration: 100
      });
    }

    // Technical info (collapsible)
    const technicalInfo = document.createElement('details');
    technicalInfo.className = 'technical-info';

    const summary = document.createElement('summary');
    summary.textContent = 'Technical Info';
    technicalInfo.appendChild(summary);

    const techMetrics = [
      { id: 'resolution', text: 'Video resolution:' },
      { id: 'delay', text: 'Frame compute delay:' },
      { id: 'frame-fps', text: 'Frame count:' },
      { id: 'frame-time', text: 'Frame time:' },
      { id: 'video-time', text: 'Video time:' },
      { id: 'signal', text: 'Signal:' },
      { id: 'signal-window', text: 'Window:' }
    ];

    techMetrics.forEach(metric => {
      const p = document.createElement('p');
      p.id = metric.id;
      p.textContent = metric.text;
      technicalInfo.appendChild(p);
      this.elements[metric.id] = p;
    });

    this.container.appendChild(technicalInfo);

    // Store guide circle for updates
    this.elements.guideCircle = guideCircle;
  }

  /**
   * Update signal quality metrics display
   * @param {Object} metrics - Quality metrics object
   */
  updateMetrics(metrics) {
    if (!this.elements['snr-value']) return;

    this.elements['snr-value'].textContent = metrics.snr_dB.toFixed(1) + ' dB';
    this.elements['pi-value'].textContent = metrics.perfusionIndex.toFixed(1) + '%';
    this.elements['hr-value'].textContent = metrics.heartRate + ' BPM';
    this.elements['ibi-value'].textContent = metrics.ibi > 0 ? metrics.ibi + ' ms' : '-- ms';

    // Update quality status
    const statusElement = this.elements.qualityStatus;
    statusElement.textContent = metrics.qualityStatus;

    // Update status classes
    statusElement.classList.remove('excellent', 'good', 'fair', 'poor', 'initializing');
    statusElement.classList.add(metrics.qualityStatus.toLowerCase());

    // Update finger guide circle color
    if (this.elements.guideCircle) {
      const guideCircle = this.elements.guideCircle;
      guideCircle.classList.remove('excellent', 'good', 'fair', 'poor');
      guideCircle.classList.add(metrics.qualityStatus.toLowerCase());
    }

    // Update guidance message
    this.elements.guidanceMessage.textContent = metrics.guidanceMessage;
  }

  /**
   * Update technical info display
   * @param {Object} info - Technical information
   */
  updateTechnicalInfo(info) {
    if (info.resolution && this.elements.resolution) {
      this.elements.resolution.textContent = `Video resolution: ${info.resolution}`;
    }
    if (info.delay !== undefined && this.elements.delay) {
      this.elements.delay.textContent = `Frame compute delay: ${info.delay}`;
    }
    if (info.fps !== undefined && this.elements['frame-fps']) {
      this.elements['frame-fps'].textContent = `Frame count: ${info.frameCount}, FPS: ${info.fps}`;
    }
    if (info.frameTime !== undefined && this.elements['frame-time']) {
      this.elements['frame-time'].textContent = `Frame time: ${info.frameTime}`;
    }
    if (info.videoTime !== undefined && this.elements['video-time']) {
      this.elements['video-time'].textContent = `Video time: ${info.videoTime}`;
    }
    if (info.signal !== undefined && this.elements.signal) {
      this.elements.signal.textContent = `X: ${info.signal}`;
    }
    if (info.window !== undefined && this.elements['signal-window']) {
      this.elements['signal-window'].textContent = `nWindow: ${info.window}`;
    }
  }

  /**
   * Initialize chart with seed data
   */
  initializeChart() {
    if (!this.chart || !this.elements.chart) return;

    this.initTime = new Date();
    this.chartData = [];

    const now = new Date();
    for (let i = 0; i < this.maxLength; i++) {
      this.chartData.push({
        time: new Date(now.getTime() - (this.maxLength - i) * 100),
        x: 0.5,
        signal: 0
      });
    }
  }

  /**
   * Update chart with new data point
   * @param {Object} dataPoint - Data point { value, isSignal }
   */
  updateChart(dataPoint) {
    if (!this.chart || !this.elements.chart) return;

    const now = new Date();
    const chartPoint = {
      time: now - this.initTime,
      x: dataPoint.value,
      signal: dataPoint.isSignal ? 1 : 0
    };

    this.chartData.push(chartPoint);
    this.chartData.shift();

    this.chart.render(this.elements.chart, this.chartData);
  }

  /**
   * Handle window resize
   */
  handleResize() {
    if (this.chart && this.container) {
      this.chart.setWidth(this.container.clientWidth || 600);
      if (this.elements.chart && this.chartData.length > 0) {
        this.chart.render(this.elements.chart, this.chartData);
      }
    }
  }

  /**
   * Destroy the UI and cleanup
   */
  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }

    this.container.innerHTML = '';
    this.elements = {};
    this.chartData = [];
  }
}
