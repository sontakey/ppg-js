/**
 * PPG JS - Real-time PPG signal monitoring library (core bundle: no CSS,
 * no bundled UI - see examples/demo for a reference UI built on the events
 * below).
 * @module ppg-js
 */

import { PPG } from './core/PPG.js';
import { PPGMonitor } from './core/PPGMonitor.js';
import { SignalProcessor } from './core/SignalProcessor.js';
import { detrend } from './core/detrend.js';
import { computeFFT, calculateSNRFromPSD } from './core/fft.js';

export { PPG };
export type { PPGOptions, PPGMetrics, PPGCapabilities, PPGState } from './core/PPG.js';

/** @deprecated use `PPG` - kept as a thin alias for one release (v0.2.x). */
export { PPGMonitor };

export default PPG;

export {
  SignalProcessor,
  detrend,
  computeFFT,
  calculateSNRFromPSD
};
