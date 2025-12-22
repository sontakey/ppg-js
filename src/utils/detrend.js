/**
 * Linear detrending algorithm using least squares regression
 * Removes linear trends from PPG signal to isolate the AC component
 *
 * @param {Array|Float32Array} y - Input signal array
 * @returns {Array} Detrended signal
 */
export function detrend(y) {
  const n = y.length;
  const x = [];

  for (let i = 0; i <= n; i++) {
    x.push(i);
  }

  // Calculate sums for least squares regression
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;

  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxy += x[i] * y[i];
    sxx += x[i] * x[i];
  }

  // Calculate slope and intercept
  const mx = sx / n;
  const my = sy / n;
  const xx = n * sxx - sx * sx;
  const xy = n * sxy - sx * sy;
  const slope = xy / xx;
  const intercept = my - slope * mx;

  // Remove linear trend
  const detrended = [];
  for (let i = 0; i < n; i++) {
    detrended.push(y[i] - (intercept + slope * i));
  }

  return detrended;
}
