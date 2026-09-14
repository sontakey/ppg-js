/**
 * SDNN (sample standard deviation of NN intervals). RMSSD lives in peaks.ts;
 * the full HRV suite (time, frequency, nonlinear, baselines) is in
 * src/hrv/.
 * @param windowSize - defaults to all given IBIs
 */
export function sdnn(ibisMs: ArrayLike<number>, windowSize = Infinity): number {
  const arr = Array.from(ibisMs as ArrayLike<number>);
  const window = Number.isFinite(windowSize) ? arr.slice(-windowSize) : arr;
  if (window.length < 2) return 0;
  const m = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - m) ** 2, 0) / (window.length - 1);
  return Math.sqrt(variance);
}
