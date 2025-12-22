/**
 * PPG Vitals - Real-time PPG signal monitoring library
 * @module ppg-vitals
 */

import PPGMonitor from './PPGMonitor.js';
import { SignalProcessor } from './SignalProcessor.js';
import { detrend } from './utils/detrend.js';
import { computeFFT, calculateSNRFromPSD } from './utils/fft.js';
import './styles/ppg-monitor.css';

// Export main class as default
export default PPGMonitor;

// Export additional utilities for advanced users
export {
  PPGMonitor,
  SignalProcessor,
  detrend,
  computeFFT,
  calculateSNRFromPSD
};
