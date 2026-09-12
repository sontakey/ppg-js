/**
 * Time-domain peak detection + IBI/HR/RMSSD from a filtered PPG signal.
 * Operates on a uniformly-sampled, bandpass-filtered, systolic-peak-as-maxima
 * signal (see utils/filter.js).
 */

/**
 * Find systolic peaks with an adaptive threshold and a refractory period,
 * then refine each peak time by parabolic interpolation of the 3 samples
 * around the discrete maximum (removes the +-1 sample / +-16ms @ 30fps
 * quantization that would otherwise dominate real HRV).
 *
 * @param {Float64Array|Array<number>} signal - filtered signal, peaks = maxima
 * @param {number} sampleRate - Hz (uniform grid)
 * @param {number} [minRefractorySec=0.3] - min time between peaks (200 bpm cap)
 * @returns {number[]} peak times in seconds (fractional sample index / sampleRate)
 */
export function detectPeaks(signal, sampleRate, minRefractorySec = 0.3) {
  const n = signal.length;
  if (n < 3) return [];

  // Adaptive threshold: mean + 0.5 * stddev of the signal (simple, robust
  // enough for a bandpassed, zero-mean-ish AC signal).
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;

  let variance = 0;
  for (let i = 0; i < n; i++) variance += (signal[i] - mean) ** 2;
  const std = Math.sqrt(variance / n);
  const threshold = mean + 0.5 * std;

  const minRefractorySamples = minRefractorySec * sampleRate;
  const peaks = [];
  let lastPeakIdx = -Infinity;

  for (let i = 1; i < n - 1; i++) {
    if (
      signal[i] > threshold &&
      signal[i] > signal[i - 1] &&
      signal[i] >= signal[i + 1] &&
      i - lastPeakIdx >= minRefractorySamples
    ) {
      // Parabolic (3-point) sub-sample interpolation around the maximum.
      const y0 = signal[i - 1];
      const y1 = signal[i];
      const y2 = signal[i + 1];
      const denom = (y0 - 2 * y1 + y2);
      const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
      const refinedIdx = i + Math.max(-0.5, Math.min(0.5, offset));

      peaks.push(refinedIdx / sampleRate);
      lastPeakIdx = i;
    }
  }

  return peaks;
}

/**
 * Turn a list of peak times into validated IBIs, rejecting physiologically
 * impossible intervals and sudden jumps relative to a rolling median.
 *
 * @param {number[]} peakTimes - seconds
 * @param {number} [minIbiMs=300] - 200 bpm cap
 * @param {number} [maxIbiMs=2000] - 30 bpm floor
 * @param {number} [maxJumpFraction=0.3] - reject IBI that differs from the
 *   median of the last 5 accepted IBIs by more than this fraction
 * @returns {{ibisMs: number[], artifactCount: number, totalCount: number}}
 */
export function computeIBIs(peakTimes, minIbiMs = 300, maxIbiMs = 2000, maxJumpFraction = 0.3) {
  const ibisMs = [];
  const details = []; // one entry per candidate IBI, for debug/replay comparison
  let artifactCount = 0;
  const recent = [];

  for (let i = 1; i < peakTimes.length; i++) {
    const ibi = (peakTimes[i] - peakTimes[i - 1]) * 1000;
    let valid = ibi >= minIbiMs && ibi <= maxIbiMs;
    let reason = valid ? null : 'out_of_range';

    if (valid && recent.length >= 3) {
      const median = medianOf(recent.slice(-5));
      if (Math.abs(ibi - median) / median > maxJumpFraction) {
        valid = false;
        reason = 'jump_vs_median';
      }
    }

    if (valid) {
      ibisMs.push(ibi);
      recent.push(ibi);
    } else {
      artifactCount++;
    }
    details.push({ peakTimeSec: peakTimes[i], ibiMs: ibi, valid, reason });
  }

  return { ibisMs, artifactCount, totalCount: peakTimes.length - 1, details };
}

function medianOf(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Heart rate (bpm) from the median of the most recent N valid IBIs.
 * @param {number[]} ibisMs
 * @param {number} [windowSize=8]
 * @returns {number} 0 if not enough data
 */
export function heartRateFromIBIs(ibisMs, windowSize = 8) {
  if (ibisMs.length === 0) return 0;
  const window = ibisMs.slice(-windowSize);
  const medianIbi = medianOf(window);
  return medianIbi > 0 ? 60000 / medianIbi : 0;
}

/**
 * RMSSD (root mean square of successive differences) over a sliding window
 * of IBIs — the standard short-term HRV metric.
 * @param {number[]} ibisMs
 * @param {number} [windowSize=8]
 * @returns {number} ms, 0 if fewer than 2 IBIs in the window
 */
export function rmssd(ibisMs, windowSize = 8) {
  const window = ibisMs.slice(-windowSize);
  if (window.length < 2) return 0;

  let sumSq = 0;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (window.length - 1));
}
