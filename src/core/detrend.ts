/** Linear least-squares detrend. Returns a new Float64Array. */
export function detrend(y: ArrayLike<number>): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) out[i] = y[i] - (intercept + slope * i);
  return out;
}
