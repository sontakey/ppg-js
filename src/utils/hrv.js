/**
 * SDNN (standard deviation of NN/IBI intervals) - the standard long-term-ish
 * HRV companion to RMSSD (see utils/peaks.js rmssd, which captures beat-to-
 * beat variability; SDNN captures overall spread).
 * @param {number[]} ibisMs
 * @param {number} [windowSize=Infinity] - defaults to using all given IBIs
 *   (callers pass an already-windowed "last 60s of accepted IBIs" array)
 * @returns {number} ms, 0 if fewer than 2 IBIs
 */
export function sdnn(ibisMs, windowSize = Infinity) {
  const window = ibisMs.slice(-windowSize);
  if (window.length < 2) return 0;
  const m = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - m) ** 2, 0) / (window.length - 1);
  return Math.sqrt(variance);
}
