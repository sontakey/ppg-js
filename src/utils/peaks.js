/**
 * Time-domain peak detection + IBI/HR/RMSSD from a filtered PPG signal.
 * Operates on a uniformly-sampled, bandpass-filtered, systolic-peak-as-maxima
 * signal (see utils/filter.js).
 */

/**
 * Find systolic peaks with an amplitude-aware adaptive threshold and a
 * refractory period, then refine each peak time by parabolic interpolation
 * of the 3 samples around the discrete maximum (removes the +-1 sample /
 * +-16ms @ 30fps quantization that would otherwise dominate real HRV).
 *
 * The threshold tracks a rolling max envelope (causal, ~2s window) instead
 * of the whole-window mean+stddev, so a signal whose amplitude changes
 * partway through a 5s window (e.g. placement settling mid-window) doesn't
 * get a threshold set too high by an earlier louder stretch or too low by
 * a later quiet one - real 8-bit camera PPG pulses are only 1-2% of DC, so
 * getting this wrong is the difference between "no beats found" and beats.
 *
 * @param {Float64Array|Array<number>} signal - filtered signal, peaks = maxima
 * @param {number} sampleRate - Hz (uniform grid)
 * @param {number} [minRefractorySec=0.3] - min time between peaks (200 bpm cap).
 *   Pass a value derived from a prior FFT's dominant frequency (0.6 * expected
 *   IBI, clamped 0.3-1.0s) for tighter, physiologically-informed rejection.
 * @param {number} [envelopeWindowSec=2.0] - rolling max envelope window
 * @returns {number[]} peak times in seconds (fractional sample index / sampleRate)
 */
/**
 * Least-squares quadratic vertex fit over 2*halfWidth+1 samples centered on
 * index i (symmetric x = -halfWidth..halfWidth, so cross-terms vanish and
 * the normal equations reduce to two scalar solves). Falls back to 0 (no
 * refinement) for a degenerate/flat window.
 * @param {Float64Array|Array<number>} signal
 * @param {number} i - center index
 * @param {number} halfWidth - samples available on the shorter side (already clamped by caller)
 * @returns {number} offset in samples, clamped to [-halfWidth, halfWidth]
 */
function refineVertex(signal, i, halfWidth) {
  if (halfWidth < 1) return 0;
  let sx2 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let k = -halfWidth; k <= halfWidth; k++) {
    const x = k, y = signal[i + k];
    const x2 = x * x;
    sx2 += x2; sx4 += x2 * x2; sy += y; sxy += x * y; sx2y += x2 * y;
  }
  const n = 2 * halfWidth + 1;
  const det = n * sx4 - sx2 * sx2;
  if (det === 0 || sx2 === 0) return 0;
  const b = sxy / sx2; // linear coeff (odd/even separation from symmetric x)
  const a = (n * sx2y - sx2 * sy) / det; // quadratic coeff
  if (a === 0) return 0;
  const vertexX = -b / (2 * a);
  return Math.max(-halfWidth, Math.min(halfWidth, vertexX));
}

export function detectPeaks(signal, sampleRate, minRefractorySec = 0.3, envelopeWindowSec = 2.0) {
  const n = signal.length;
  if (n < 3) return [];

  const envelopeWindowSamples = Math.max(1, Math.round(envelopeWindowSec * sampleRate));

  // Causal rolling max of |signal| - O(n * w) with a small window (default
  // ~120 samples at 60fps) is fine for the 5s windows this runs on.
  // ponytail: naive O(n*w) scan; swap for a monotonic deque if windows grow much longer.
  const envelope = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - envelopeWindowSamples + 1);
    let m = 0;
    for (let j = lo; j <= i; j++) {
      const v = Math.abs(signal[j]);
      if (v > m) m = v;
    }
    envelope[i] = m;
  }

  const minRefractorySamples = minRefractorySec * sampleRate;
  const peaks = [];
  let lastPeakIdx = -Infinity;

  // Sub-sample vertex refinement uses a wider least-squares quadratic fit
  // (HALF_WIDTH samples either side), not a bare 3-point parabola. At the
  // quantization levels real 8-bit camera PPG produces (AC ~3 counts),
  // even after bandpass filtering the true local maximum is broad and
  // noisy - a 3-point fit locks onto whichever single noisy sample happens
  // to be locally highest, amplifying per-beat timing jitter by ~10x
  // relative to the actual peak location (confirmed via test/sim.test.js
  // clean-signal ground truth: 3-point RMSSD error ~100ms vs a fit that
  // uses more of the peak's shape ~15-20ms). Widening the fit averages
  // over more of the peak, trading a little peak-shape bias (harmless -
  // it's a constant per waveform shape, cancels in successive differences)
  // for much less noise sensitivity.
  const HALF_WIDTH = 9;

  for (let i = 1; i < n - 1; i++) {
    const threshold = 0.4 * envelope[i];
    if (
      signal[i] > threshold &&
      signal[i] > signal[i - 1] &&
      signal[i] >= signal[i + 1] &&
      i - lastPeakIdx >= minRefractorySamples
    ) {
      const refinedIdx = i + refineVertex(signal, i, Math.min(HALF_WIDTH, i, n - 1 - i));
      peaks.push(refinedIdx / sampleRate);
      lastPeakIdx = i;
    }
  }

  return peaks;
}

/**
 * Turn a list of peak times into validated IBIs, rejecting physiologically
 * impossible intervals, missed-beat multiples, and sudden jumps relative to
 * a rolling median.
 *
 * A "missed beat" is an IBI that's ~2x or ~3x the recent median: the peak
 * detector skipped one or two real beats (e.g. amplitude dipped below
 * threshold for one cycle) rather than the heart actually slowing down.
 * Left unflagged, these drag the running median toward the longer interval
 * and a run of them reports a heart rate roughly half or a third of the
 * true one (observed: 39bpm reported during a 66-78bpm stretch). Rejected
 * as 'missed_beat' and NOT folded into `recent`, so the median doesn't
 * drift with the miss.
 *
 * @param {number[]} peakTimes - seconds
 * @param {number} [minIbiMs=300] - 200 bpm cap
 * @param {number} [maxIbiMs=2000] - 30 bpm floor
 * @param {number} [maxJumpFraction=0.3] - reject IBI that differs from the
 *   median of the last 5 accepted IBIs by more than this fraction
 * @returns {{ibisMs: number[], artifactCount: number, totalCount: number, details: Array}}
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
      const ratio = ibi / median;
      const isMissedBeatMultiple = [2, 3].some(k => ratio >= k * 0.8 && ratio <= k * 1.2);
      if (isMissedBeatMultiple) {
        valid = false;
        reason = 'missed_beat';
      } else if (Math.abs(ibi - median) / median > maxJumpFraction) {
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
 * Cross-check the time-domain (IBI-median) heart rate against the
 * frequency-domain (FFT dominant-peak) heart rate. A run of undetected
 * ("missed") beats can survive computeIBIs' median-based rejection (the
 * median itself drifts along with the misses) and still land far from the
 * true rate; the FFT estimate, being independent of individual peak
 * detections, catches that. Falls back to whichever estimate is available
 * when the other is 0.
 *
 * @param {number} ibiHrBpm - heartRateFromIBIs() output, 0 if unavailable
 * @param {number} fftHrBpm - FFT dominant-peak heart rate, 0 if unavailable
 * @param {number} [maxDisagreeFraction=0.25]
 * @returns {{heartRate:number, source:'ibi'|'fft'|'none', disagree:boolean}}
 */
export function crossCheckHeartRate(ibiHrBpm, fftHrBpm, maxDisagreeFraction = 0.25) {
  if (!ibiHrBpm && !fftHrBpm) return { heartRate: 0, source: 'none', disagree: false };
  if (!ibiHrBpm) return { heartRate: fftHrBpm, source: 'fft', disagree: false };
  if (!fftHrBpm) return { heartRate: ibiHrBpm, source: 'ibi', disagree: false };

  const diffFraction = Math.abs(ibiHrBpm - fftHrBpm) / fftHrBpm;
  if (diffFraction > maxDisagreeFraction) {
    return { heartRate: fftHrBpm, source: 'fft', disagree: true };
  }
  return { heartRate: ibiHrBpm, source: 'ibi', disagree: false };
}

/**
 * Slew-limit a displayed value so it can't jump more than maxDeltaPerStep
 * between consecutive window updates - smooths over a single bad window's
 * detector glitch without hiding a real, sustained heart rate change.
 * @param {number} prevDisplayed - previous displayed value (0 = no prior value, snaps to target)
 * @param {number} target - newly computed value
 * @param {number} [maxDeltaPerStep=8]
 * @returns {number}
 */
export function slewLimit(prevDisplayed, target, maxDeltaPerStep = 8) {
  if (!prevDisplayed || !target) return target;
  const delta = target - prevDisplayed;
  if (Math.abs(delta) <= maxDeltaPerStep) return target;
  return prevDisplayed + Math.sign(delta) * maxDeltaPerStep;
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
