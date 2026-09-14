/**
 * Signal sources. `PPGMonitor` (camera) lives at the package root; this
 * subpath holds the non-camera sources.
 */
export { BleHeartRateSource, parseHeartRateMeasurement } from './ble.js';
export type { HeartRateMeasurement, BleBeat } from './ble.js';
export { ArraySource } from './array.js';
