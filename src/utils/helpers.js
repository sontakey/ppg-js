/**
 * Calculate mean of array or typed array
 *
 * @param {Array|Float32Array} array - Input array
 * @returns {number} Mean value
 */
export function windowMean(array) {
  const n = array.length;
  let sum = 0;

  for (let i = 0; i < n; i++) {
    sum += array[i];
  }

  return sum / n;
}

/**
 * Get quality status from SNR value
 *
 * @param {number} snr - Signal-to-noise ratio in dB
 * @returns {string} Quality status: "Excellent", "Good", "Fair", or "Poor"
 */
export function getQualityStatus(snr) {
  if (snr >= 10) return "Excellent";
  if (snr >= 5) return "Good";
  if (snr >= 0) return "Fair";
  return "Poor";
}

/**
 * Generate user guidance message based on signal quality metrics
 *
 * @param {number} snr - Signal-to-noise ratio in dB
 * @param {number} pi - Perfusion index (%)
 * @param {number} stability - Signal stability (0-1)
 * @returns {string} Guidance message
 */
export function generateGuidance(snr, pi, stability) {
  if (snr < 0) {
    if (pi < 0.3) {
      return "Cover camera completely with finger";
    }
    return "Adjust finger placement";
  }

  if (snr >= 0 && snr < 5) {
    if (pi < 1.0) {
      return "Press finger more firmly";
    }
    if (pi > 15) {
      return "Reduce finger pressure slightly";
    }
    if (stability < 0.5) {
      return "Hold finger still";
    }
    return "Adjusting... hold steady";
  }

  if (snr >= 5 && snr < 10) {
    return "Good signal - hold steady";
  }

  // snr >= 10
  return "Excellent signal!";
}

/**
 * Validate and merge user options with defaults
 *
 * @param {Object} userOptions - User-provided options
 * @returns {Object} Merged options
 */
export function createDefaultOptions(userOptions = {}) {
  const defaults = {
    ui: {
      enabled: true,
      showVideo: true,
      showMetrics: true,
      showChart: true,
      theme: 'light'
    },
    signal: {
      windowLength: 300,      // 5 seconds at 60 FPS
      sampleRate: 60,         // Target FPS
      cardiacBandLow: 0.75,   // Hz (45 BPM)
      cardiacBandHigh: 4.0,   // Hz (240 BPM)
      fftSize: 256            // Next power of 2 >= 300
    },
    camera: {
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: { ideal: 60 },
      facingMode: 'environment'
    },
    onFrame: null,
    onQualityUpdate: null,
    onSignalUpdate: null,
    onError: null,
    onReady: null
  };

  // Deep merge
  return {
    ui: { ...defaults.ui, ...(userOptions.ui || {}) },
    signal: { ...defaults.signal, ...(userOptions.signal || {}) },
    camera: { ...defaults.camera, ...(userOptions.camera || {}) },
    onFrame: userOptions.onFrame || defaults.onFrame,
    onQualityUpdate: userOptions.onQualityUpdate || defaults.onQualityUpdate,
    onSignalUpdate: userOptions.onSignalUpdate || defaults.onSignalUpdate,
    onError: userOptions.onError || defaults.onError,
    onReady: userOptions.onReady || defaults.onReady
  };
}

/**
 * Get container element from selector or element
 *
 * @param {string|HTMLElement|null} container - Container selector or element
 * @returns {HTMLElement|null} Container element
 */
export function getContainerElement(container) {
  if (!container) return null;

  if (typeof container === 'string') {
    return document.querySelector(container);
  }

  if (container instanceof HTMLElement) {
    return container;
  }

  return null;
}
