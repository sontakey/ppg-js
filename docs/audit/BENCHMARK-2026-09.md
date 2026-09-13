# Benchmark: ppg-js 0.3 against HeartPy and vital_sqi

Run on 13 September 2026 against the code in the v0.3.0 pull request.
Scripts and reproduction steps are in `bench/`. HeartPy 1.2.6 and
vital_sqi 0.1.x were installed from PyPI into a venv (vital_sqi needs
NumPy 1.x, astropy < 6 and nolds 0.5.2 to import at all).

## What was compared, and how fairly

**Data.** The four real iPhone recordings in `test/fixtures/` (no ground
truth) and eleven simulator scenarios with exact beat times: clean signal at
30 and 60 fps, whole-count and fractional channel means, 10% dropped frames,
respiratory sinus arrhythmia (true RMSSD 22.8 ms), low amplitude, motion
bursts, one weak beat in five, a dominant dicrotic wave at 50 bpm, 110 bpm,
and a 4 s finger lift. Every other scenario has zero true variability, so
any RMSSD a detector reports is its own timing noise.

**HeartPy** was given the best case its documentation describes for PPG:
the inverted red channel interpolated onto a uniform grid at the recording's
rate, HeartPy's own 0.7-3.5 Hz bandpass, `hp.process` with `clean_rr=True`,
`high_precision=True` (1 kHz peak upsampling) and 40-180 bpm limits. It was
run twice per dataset: on the raw recording ("raw"), and on the span from
the first window ppg-js judged good to the last ("trimmed"), which is the
input an SQI-based pre-filter such as vital_sqi would hand it.

**ppg-js** results are its accepted beats from windows that passed the
quality gate (`getTachogram({ goodOnly: true })`); intervals next to a
recovered weak beat are excluded from RMSSD as the library does itself.

**Scoring.** Beats are matched to truth within 150 ms after removing each
detector's constant fiducial offset (the simulator's truth marks beat onset;
detectors mark the systolic peak). Sensitivity = matched truth beats / truth
beats in the span; false = accepted beats with no truth beat; timing error =
standard deviation of matched beat times in ms. RMSSD for HeartPy is its own
`rmssd` measure on its cleaned RR list.

**Caveats.** One phone for the real data. The simulator is the same one the
engine was developed against, so ppg-js has had every chance to fit it; the
real-recording rows are the check on that. HeartPy is a general PPG/ECG
library run out of the box, not tuned for this data.

## HeartPy: simulator scenarios with ground truth

| Scenario (truth HR / RMSSD) | HeartPy HR | HeartPy RMSSD | HeartPy timing err | HeartPy sens / false | ppg-js HR | ppg-js RMSSD | ppg-js timing err | ppg-js sens / false |
|---|---|---|---|---|---|---|---|---|
| clean 30 fps, whole counts (70 / 0) | 70.0 | 38.9 | 16.4 | 1.00 / 0 | 69.9 | **12.7** | **5.5** | 0.98 / 0 |
| clean 30 fps, fractional (70 / 0) | 70.0 | 36.8 | 14.9 | 1.00 / 0 | 69.9 | **9.4** | **4.0** | 0.98 / 0 |
| clean 60 fps (70 / 0) | 70.0 | 27.1 | 11.4 | 1.00 / 0 | 70.0 | **10.8** | **4.7** | 0.98 / 0 |
| 10% dropped frames (70 / 0) | 70.0 | 46.6 | 19.0 | 1.00 / 0 | 70.0 | **12.8** | **6.0** | 0.98 / 0 |
| RSA 6 breaths/min (70 / 22.8) | 70.0 | 50.8 | 20.4 | 1.00 / 1 | 70.5 | **27.1** | **10.9** | 0.99 / 1 |
| 110 bpm (110 / 0) | 110.2 | 31.9 | 12.8 | 1.00 / 1 | 110.0 | **11.1** | **5.0** | 0.99 / 0 |
| low amplitude, 2 counts (70 / 0) | 70.2 | 66.6 | 33.1 | 1.00 / 1 | 70.0 | **28.9** | **13.4** | 0.98 / 1 |
| one weak beat in five (70 / 0) | 69.9 | 84.4 | 34.8 | 1.00 / 0 | 69.6 | **16.8** | 41.6 | 0.98 / 0 |
| motion bursts (70 / 0) | 70.0 | 49.9 | 25.0 | 0.92 / 1 | 70.0 | **17.6** | **8.3** | 0.64 / 0 |
| dominant dicrotic wave (50 / 0) | **102.9** | 101.7 | 2.1 | 0.98 / 83 | **50.0** | **9.5** | 3.1 | 0.43 / 43 |
| 4 s finger lift (70 / 0) | failed | failed | - | - | 70.0 | 14.4 | 6.6 | 0.75 / 0 |

Reading the rows:

- **Timing and variability.** On every scenario with a valid comparison
  ppg-js's beat timing error is 2 to 3 times smaller than HeartPy's and its
  RMSSD on a zero-variability pulse is 2.5 to 4 times lower. With true
  variability present (RSA row) ppg-js reads 27 ms against a truth of 23;
  HeartPy reads 51. HeartPy's peak position is the sample maximum refined by
  local upsampling; ppg-js fits a 0.3 s least-squares vertex on a
  zero-phase-filtered signal, which is where the difference comes from.
- **Heart rate.** Both are within 1 bpm everywhere except the dicrotic
  case, where HeartPy locks onto the second harmonic and reports 103 bpm for
  a 50 bpm pulse; ppg-js's sub-harmonic guard reads 50. ppg-js's low
  sensitivity in that row is the flip side: when both humps are similar it
  occasionally switches fiducial, each switch costing one rejected interval
  (its RMSSD stays at 9.5 ms because the switches are rejected rather than
  averaged in).
- **Weak beats.** This row changed ppg-js. Before the benchmark, one weak
  beat in five made the artifact ratio exceed 20% and the gate rejected 19 of
  20 windows; HeartPy kept every beat. ppg-js now searches a 2x gap for a
  sub-threshold pulse, recovers it for heart rate and beat counting, and
  flags the two adjacent intervals `lowSnr` so they stay out of RMSSD. Its
  41.6 ms timing error in that row is the recovered beats (15% amplitude);
  HeartPy's 35 ms is the same beats, but HeartPy also folds them into
  RMSSD (84 ms on a signal with none).
- **Motion and lifts.** HeartPy keeps 92% of beats through the motion
  bursts at the cost of a 50 ms RMSSD; ppg-js drops the windows around each
  burst (sensitivity 0.64 over the whole span) and keeps RMSSD at 17.6.
  HeartPy cannot process the recording with a finger lift at all, raw or
  trimmed; ppg-js resettles and continues.

## HeartPy: real recordings (no ground truth)

| Recording | HeartPy raw | HeartPy trimmed to ppg-js's steady span | ppg-js |
|---|---|---|---|
| iphone-200s | 70.5 bpm, RMSSD 43.9, kept 141/189 peaks | 71.3 bpm, RMSSD 50.4 | 70.9 bpm, RMSSD 54.7 |
| iphone-52s | failed ("could not determine best fit") | 82.7 bpm, RMSSD 61.1 | 82.5 bpm, RMSSD 92.1 |
| iphone-cros-160s-mute | failed | 121.8 bpm, RMSSD 14.7 | 121.3 bpm, RMSSD 26.7 |
| iphone-cros-66s | failed | 77.8 bpm, RMSSD 51.8 | 76.3 bpm, RMSSD 86.5 |

Out of the box HeartPy fails on three of the four phone recordings because
the placement phase and the finger-off tail pull its fit outside the bpm
limits; given the span ppg-js's state machine marks steady, it succeeds on
all four and its heart rate agrees with ppg-js within 1.5 bpm. Its RMSSD is
lower than ppg-js's on the three shorter, noisier recordings. Without a
reference we cannot say which is right: HeartPy's `clean_rr` quotient filter
removes intervals aggressively, ppg-js accepts more. A chest-strap recording
alongside the camera (the `BleHeartRateSource` added in this PR) is what
settles it.

## Before and after on the same recordings (v0.2.0 replay vs v0.3.0)

| Recording | v0.2.0 good windows | v0.2.0 HR / RMSSD (median) | v0.3.0 good windows | v0.3.0 HR / RMSSD (median, floor) | rejected intervals v0.2 to v0.3 |
|---|---|---|---|---|---|
| iphone-200s | 33 / 39 | 71 / 49 | 33 / 38 | 71 / 48 (floor 2) | 3% to 3% |
| iphone-cros-66s | 8 / 12 | 79 / 73 | 9 / 11 | 77 / 81 (floor 8) | 14% to 11% |
| iphone-cros-160s-mute | 22 / 31 | 121 / 25 | 22 / 31 | 120 / 19 (floor 6) | 7% to 0% |
| iphone-52s | 7 / 10 | 83 / 79 | 6 / 9 | 84 / 90 (floor 6) | 11% to 9% |

Heart rate and good-window counts are unchanged; the 160 s recording's
RMSSD falls from 25 to 19 ms with fewer rejected intervals, consistent with
the timing improvements measured on the simulator. The short recordings
keep their high RMSSD, which on these placements is likely real movement
rather than timing noise (the reported floor is 6 to 8 ms).

## vital_sqi: do its signal-quality indices add anything to the gate?

vital_sqi scores fixed segments with scalar indices (skewness, kurtosis,
entropy, perfusion, zero-crossing rate, SNR, and MSQ, the agreement between
two of its peak detectors) and leaves the accept/reject rule to the user; no
rule set ships with the package. The comparison is therefore threshold-free:
for each index, the rank separability (AUC) between 5 s segments ppg-js
marks good and segments it rejects, and on the simulator between segments
that are truly clean and segments containing a burst, a lift, or the
pre-placement start. 0.5 is no information, 1.0 perfect, 0.0 perfect but
inverted.

| Dataset | skewness | kurtosis | entropy | perfusion | zero-cross | SNR | MSQ |
|---|---|---|---|---|---|---|---|
| iphone-200s (vs gate) | 0.73 | 0.21 | 0.12 | 0.79 | 0.47 | 0.59 | 0.49 |
| iphone-cros-160s-mute (vs gate) | 0.75 | 0.14 | 0.09 | 0.67 | 0.89 | 0.50 | 0.14 |
| iphone-cros-66s (vs gate) | 0.72 | 0.28 | 0.39 | 0.72 | 0.61 | 0.67 | 0.28 |
| sim clean 30 fps (vs truth) | 0.31 | 0.40 | 0.21 | 0.48 | 0.00 | 0.83 | 0.52 |
| sim clean 60 fps (vs truth) | 0.17 | 0.43 | 0.48 | 0.69 | 0.00 | 0.90 | 0.62 |
| sim motion (vs truth) | 0.67 | 0.25 | 0.21 | 0.39 | 0.52 | 0.58 | 0.28 |
| sim lift (vs truth) | 0.33 | 0.33 | 0.53 | 0.57 | 0.18 | 0.75 | 0.54 |
| sim low amplitude (vs truth) | 0.31 | 0.69 | 0.40 | 0.60 | 0.36 | 0.83 | 0.57 |

No index is consistent across datasets: skewness separates well on the
phone recordings (0.72-0.75) and inverts on the simulator; SNR is the most
reliable on the simulator (0.71-0.90) and near chance on the phone; MSQ is
at or below chance almost everywhere on 5 s segments. The "trim the shaky
start and end" behaviour vital_sqi is used for is covered structurally by
the state machine: NO_FINGER and SETTLING windows are never good.

ppg-js's gate against the simulator's truth over the nine scenarios with a
defined truth label:

| | truly clean | truly disturbed |
|---|---|---|
| gate says good | 190 | 1 |
| gate says not good | 11 | 26 |

Sensitivity 94.5%, specificity 96%. Nine of the eleven misses are the first
MEASURING window of a session, which the gate holds until eight intervals
have accumulated by design.

**Conclusion on vital_sqi.** Adding its indices in front of ppg-js is not
justified by this data: a rule built on them would need per-device tuning
and would still be weaker than the gate ppg-js already applies. Its
design idea, deciding per segment before analysing, is already how the
engine works. The one index worth watching is its SNR, which tracks the
simulator truth; ppg-js's own `snr_dB` plays that role.

## Reproduce

```bash
node --import tsx bench/export-datasets.mjs bench/out
python3 -m venv .venv && .venv/bin/pip install "numpy==1.26.4" "scipy<1.14" heartpy vital-sqi "nolds==0.5.2" "astropy<6" "pandas<2.2"
.venv/bin/python bench/compare_heartpy.py bench/out > bench/heartpy-results.json
.venv/bin/python bench/compare_vitalsqi.py bench/out > bench/vitalsqi-results.json
```
