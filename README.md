# ppg-js

Heart rate, pulse-rate variability, respiration and an honest signal-quality
gate from a fingertip on a phone camera, in the browser. Zero dependencies,
typed, no UI.

[![CI](https://github.com/sontakey/ppg-js/actions/workflows/test.yml/badge.svg)](https://github.com/sontakey/ppg-js/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/%40sontakey%2Fppg-js.svg)](https://www.npmjs.com/package/@sontakey/ppg-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`ppg-js` turns the camera (and the flash, where the browser exposes it) into
a photoplethysmography sensor: cover the rear lens with a fingertip and it
reports heart rate, inter-beat intervals, RMSSD/SDNN, breathing rate and a
per-window quality verdict that says *why* a number is withheld rather than
guessing. Every session is recorded and can be replayed offline through the
exact same engine.

**Live demo:** <https://ppg-js.vercel.app> (needs a phone and HTTPS)

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [API](#api)
- [Signal quality contract](#signal-quality-contract)
- [HRV module](#hrv-module)
- [Other sources](#other-sources)
- [Browser and device support](#browser-and-device-support)
- [Debug recording and replay](#debug-recording-and-replay)
- [Accuracy and limitations](#accuracy-and-limitations)
- [Testing](#testing)
- [Contributing and license](#contributing-and-license)

## Install

```bash
npm install @sontakey/ppg-js
```

Browser global (no bundler):

```html
<script src="https://unpkg.com/@sontakey/ppg-js/dist/index.global.js"></script>
<script>
  const ppg = new PPG.PPG();
  ppg.addEventListener('metrics', (e) => console.log(e.detail.heartRate, e.detail.quality));
  document.querySelector('#start').onclick = () => ppg.start();
</script>
```

The global build exposes `PPG.PPG`, `PPG.PPGMonitor`, `PPG.PpgEngine`,
`PPG.hrv`, `PPG.dsp` and `PPG.sources`.

## Quick start

```ts
import { PPG } from '@sontakey/ppg-js';

const ppg = new PPG();

ppg.addEventListener('state', (e) => {
  // NO_FINGER -> SETTLING -> MEASURING
  console.log(e.detail.state, e.detail.reason);
});

ppg.addEventListener('metrics', (e) => {
  const m = e.detail;
  if (!m.quality.good) {
    console.log('not ready:', m.quality.reason, m.guidanceMessage);
    return;
  }
  console.log(`${m.heartRate} bpm, RMSSD ${m.rmssd.toFixed(0)} ms (noise floor ±${m.rmssdFloorMs.toFixed(0)} ms)`);
});

ppg.addEventListener('respiration', (e) => console.log(`${e.detail.rateBpm.toFixed(0)} breaths/min`));
ppg.addEventListener('error', (e) => console.error(e.detail.error.code, e.detail.error.guidance));

// Call from a user gesture (tap): camera, wake lock and motion permission all need one.
button.onclick = () => ppg.start();
// later
ppg.stop();
```

After a session:

```ts
import { hrv } from '@sontakey/ppg-js';

const beats = ppg.getTachogram({ goodOnly: true, hrvOnly: true }).filter(b => b.valid);
const report = hrv.analyzeHRV(beats, { rmssdFloorMs: ppg.getMetrics().rmssdFloorMs });
console.log(report.timeDomain.rmssd, report.frequencyDomain.lfhf, report.stressIndex.sqrt);
```

## What you get

| Field | Meaning |
|---|---|
| `heartRate` | bpm, median of the last accepted intervals, cross-checked against a spectral estimate; `0` unless `quality.good` |
| `ibi`, `rmssd`, `sdnn` | most recent interval and variability over the last 60 s of accepted beats; `0` unless `quality.good` |
| `rmssdFloorMs`, `timingUncertaintyMs` | the RMSSD the pipeline's own beat-timing noise would produce on a perfectly regular pulse, estimated per window (accurate to roughly ±50%) |
| `respiration` | `{ rateBpm, confidence }` from breathing-driven modulation of beat timing, pulse amplitude and baseline, only when the estimates agree |
| `quality` | `{ good, reason, code, acdc, artifactRatio, ibiCount, fftAgree, clippedFraction, motion, templateSqi }` |
| `templateSqi` | median correlation of each pulse with the window's mean pulse shape (0-1) |
| `acDcRatio`, `perfusionIndex` | pulsatile amplitude over DC of the selected channel (bandpassed per-beat, not raw range) |
| `heartRateFFT`, `heartRateIBI`, `heartRateSource`, `harmonicCorrected` | the two independent estimates and which one won |
| `fingerState`, `settleRemainingSec`, `guidanceMessage` | state machine and coaching copy |
| `sampleRate`, `selectedChannel`, `redDc`, `greenDc`, `clippedFraction`, `motion` | capture diagnostics |

Every `beat` event carries `{ time, ibiMs, valid, good, lowSnr, sqi, reason }`: `valid` is
the interval-level artifact decision, `good` is whether the window it came
from passed the quality gate, and `lowSnr` marks an interval next to a
recovered weak beat (counted for heart rate, excluded from variability).

## How it works

```
camera frame (requestVideoFrameCallback, captureTime when available)
  -> centre ROI, downscaled, channel means + clipped-pixel fraction
  -> PpgEngine.push({ t, r, g, b, clipped, motion })
       -> finger state machine every sample (relative presence, drift)
       -> every 5 s of signal time:
            interpolate the last 8 s onto one absolute 60 Hz grid
            zero-phase Butterworth bandpass (4th-order HP 0.6 Hz, 2nd-order LP 4.6 Hz)
            channel selection by pulsatile amplitude
            spectral HR (Hann, zero-padded, sub-harmonic guard) -> refractory prior
            peaks (adaptive threshold + 0.3 s vertex fit) -> absolute beat times
            missed-beat recovery (weak pulse inside a 2x gap, flagged lowSnr)
            template correlation per beat -> interval validation over the continuous stream
            RMSSD / SDNN over 60 s, respiration from beat modulation
            quality gate -> good / reason / code
```

The same `PpgEngine` runs the live camera path and `tools/replay.js`, so a
recorded session replays to identical windows (`test/live-parity.test.js`
asserts it).

### Finger state machine

```
NO_FINGER --finger placed--> SETTLING --6 s, low drift, pulse amplitude ok--> MEASURING
    ^                            |                                              |
    |                       finger lifted                                  large drift
    +----------------------------+----------------------------------------------+
```

Exposure, white balance and focus are locked when MEASURING is first reached
(the auto algorithms have converged on the finger by then) and released when
the finger lifts.

## API

### `new PPG(options?)`

Typed-event facade, always headless. Events: `ready`, `state`, `beat`,
`metrics`, `quality`, `waveform` (every frame), `respiration`, `error`.
Methods: `start(abortSignal?)`, `stop()`, `destroy()`, `getMetrics()`,
`getTachogram({ goodOnly, hrvOnly })`, `getSessionSummary()`, `exportDebugLog()`,
`downloadDebugLog(prefix?)`, `getConfig()`; getters `state`, `capabilities`,
`engine`.

### `new PPGMonitor(container, options?)`

The callback-style class the facade wraps (`container` is accepted for
compatibility and ignored; the core renders no UI). Callbacks: `onReady`,
`onState`, `onQualityUpdate` (per window), `onSignalUpdate` (per frame),
`onFrame`, `onError`. Same methods as `PPG` plus `getDebugLog()`,
`copyDebugLogToClipboard()`, `getEngine()`, and the `video` element as a
property for previews.

### Options (all optional)

```ts
{
  signal: {                     // PpgEngine options
    windowSec: 5,               // analysis window, seconds of signal time
    hopSec: 5,                  // interval between windows
    gridHz: 60,                 // uniform analysis grid
    cardiacBandLow: 0.75,       // Hz, heart-rate search band (45 bpm)
    cardiacBandHigh: 4.0,       // Hz (240 bpm)
    quality: { minAcDc: 0.002, maxArtifactRatio: 0.2, minIbiCount60s: 8,
               maxClippedFraction: 0.05, maxMotion: 1.5, minTemplateSqi: 0.6 },
    fingerState: { settleSec: 6, driftEnterFraction: 0.03, driftExitFraction: 0.06,
                   presence: { minRed: 60, minRedShare: 0.5 } },
    respiration: true, templateSqi: true
  },
  camera: {
    width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 },
    facingMode: 'environment',
    torch: true,                // request the flash when the device advertises it
    lockExposure: 'measuring',  // 'measuring' | 'start' | 'never'
    zoom: null                  // opt-in digital zoom (some Androids switch lens above 1)
  },
  roi: { widthFraction: 0.3, heightFraction: 0.3 },
  wakeLock: true,               // keep the screen on while measuring
  motion: false,                // DeviceMotion gate (asks permission on iOS)
  debug: { persistLastSession: false, includeUserAgent: false, sampleCap: 36000 },
  video: null                   // supply your own <video> element
}
```

### Errors

`start()` rejects with a `PPGError` whose `code` is one of
`insecure_context`, `unsupported`, `permission_denied`, `no_camera`,
`camera_busy`, `overconstrained`, `aborted`, `unknown`, and whose `guidance`
is a sentence you can show to the user.

### `PpgEngine` (`@sontakey/ppg-js/engine`)

Feed it your own samples: `engine.push({ t, r, g, b, clipped?, motion? })`
returns `{ state, stateChanged, waveform, window }`. Use it for other
capture paths (a WebView bridge, a wearable's raw PPG, a file).

### DSP (`@sontakey/ppg-js/dsp`)

Pure functions: `designBandpass`, `filtfilt`, `filtfiltPadded`,
`resampleToGrid`, `computeFFT`, `calculateSNRFromPSD`, `detectPeaksDetailed`,
`computeIBIs`, `crossCheckHeartRate`, `templateCorrelation`,
`estimateRespiration`, `evaluateQuality`, `FingerStateMachine`.

## Signal quality contract

`quality.good` is `true` only when, in this order, all of these hold; `reason`
and `code` name the first that fails:

1. `fingerState === 'MEASURING'` (`no_finger`, `settling`)
2. clipped-pixel fraction ≤ 5% (`saturated`)
3. device motion ≤ threshold, when a motion source is attached (`motion`)
4. pulsatile AC/DC ≥ 0.2% (`weak_pulse`)
5. ≤ 20% of candidate intervals rejected in the last 60 s (`irregular`)
6. ≥ 8 accepted intervals in the last 60 s (`collecting`)
7. median template correlation ≥ 0.6 (`morphology`)
8. interval-based and spectral heart rate agree within 25%
   (`double_count`, `missed_beats`, `fft_disagree`)

`heartRate`, `rmssd` and `sdnn` are `0` whenever `good` is `false`;
`heartRateRaw` is always populated.

## Signal quality indices

Every window carries `metrics.sqi`, the standard indices from the PPG
quality literature plus one documented composite, so you can build your own
acceptance rule or compare with other toolkits:

| Field | Definition |
|---|---|
| `score` | 0-1 composite: geometric mean of bounded sub-scores for template correlation, artifact ratio, pulse amplitude, SNR, clipping, motion and detector agreement (`components` lists each) |
| `skewness`, `kurtosis` | of the bandpassed pulse (Elgendi 2016: skewness is the most informative single index; a clean pulse is positively skewed) |
| `perfusion` | pulsatile amplitude / DC, percent |
| `relativePower`, `snrDb` | cardiac-band power over total power, linear and in dB |
| `zeroCrossingRate` | zero crossings per second of the bandpassed pulse (about 2 per beat when clean) |
| `templateCorrelation` | median per-beat correlation with the window's mean beat (Orphanidou 2015) |
| `detectorAgreement` | 1 − |HR from intervals − HR from spectrum| / HR from spectrum |
| `artifactRatio`, `clippedFraction`, `motion` | the gate's inputs |

Each `beat` event and tachogram point also carries `sqi`, that beat's
template correlation (the lower of its two peaks), so beats can be weighted
or filtered individually. The composite is for ranking and display; the
accept/reject decision remains `quality.good`.

## HRV module

`@sontakey/ppg-js/hrv` works on any list of intervals (numbers in ms, or
`{ ibiMs, t }` with beat times so gaps are handled correctly):

- `timeDomain`: mean RR/HR, SDNN, RMSSD, lnRMSSD, NN50/pNN50, min/max HR,
  triangular index, least-squares TINN, RR range
- `frequencyDomain`: Welch PSD on a 4 Hz linear resample using real beat
  times, LF/HF (VLF only for ≥ 5 min), normalised units, HF-peak respiration,
  coherence (0.04-0.26 Hz peak share); refuses recordings with > 20% gaps
- `nonlinear`: Poincaré SD1/SD2, sample entropy, DFA α1
- `stressIndex`: Baevsky SI and its square root (the form Kubios reports)
- `ansIndices` (experimental): PNS/SNS z-scores against cited references
- `ultraShortRmssd` (last 60 s), `lnRmssdBaseline` (7-day rolling mean,
  CV, smallest-worthwhile-change band)
- `analyzeHRV`: all of the above

What a camera measures is pulse-rate variability. At rest it tracks
heart-rate variability closely; under posture or temperature change the two
diverge. Treat the numbers accordingly.

## Other sources

`@sontakey/ppg-js/sources` has `BleHeartRateSource` (Web Bluetooth Heart
Rate Service: RR intervals from a Polar/Garmin chest strap, Chrome on
Android and desktop) and `ArraySource` (recorded samples through the
engine). Recording a strap alongside the camera is the cheapest way to
validate this library on your own device.

## Browser and device support

| Platform | Camera | Flash (torch) | Notes |
|---|---|---|---|
| iOS Safari 17+ and every iOS browser (WebKit) | yes | yes | `exposureMode` is not exposed on iPhone rear cameras; white balance is. The engine's late lock handles both. |
| Android Chrome | yes | yes | Torch, exposure/white-balance/focus locks, zoom, Web Bluetooth. Lens selection by label is best-effort. |
| Desktop Chrome/Edge/Firefox | yes | no | Works with a desk lamp for development; not a measurement setup. |
| In-app browsers (Instagram, Facebook, some WebViews) | often no | no | `start()` rejects with `unsupported`. |

Requirements: HTTPS (or localhost), `getUserMedia`. `requestVideoFrameCallback`
is used when available; `requestAnimationFrame` otherwise.

Tested against real recordings from one iPhone (iOS 26, 60 fps) and against
a simulator at 24/30/60 fps with dropped frames, saturation, motion,
respiratory modulation and dominant dicrotic waves, and benchmarked against
HeartPy and vital_sqi (`docs/audit/BENCHMARK-2026-09.md`). Android recordings are
the most valuable thing you can contribute right now; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Debug recording and replay

Every session records per-frame channel means, timestamps, camera
capabilities and settings, applied constraints, dropped-frame counts, every
peak and interval decision, and per-window quality records.
`getDebugLog()` returns it; `downloadDebugLog()` saves it. Nothing is written
to `localStorage` unless `debug.persistLastSession` is set.

```bash
npm run replay -- path/to/ppg-debug.json
```

replays the recording through the same engine the browser used and prints
state transitions, per-window quality, the HR timeline with the RMSSD floor,
every interval decision, respiration, and a comparison with the peaks the
phone recorded live.

## Accuracy and limitations

Measured on the simulator (what the tests enforce):

| Case | Result |
|---|---|
| Heart rate, 48-110 bpm, 24/30/60 fps | within 1 bpm |
| RMSSD floor on a zero-variability pulse, fractional ROI means | 9-13 ms (bound 15 ms) |
| Same with whole-count quantised means | 11-16 ms (bound 22 ms) |
| 10% dropped frames | raises RMSSD by < 2 ms |
| Respiration at 6 breaths/min | 6.0 ± 1 |

Not validated: no ECG or chest-strap comparison across a population, no
claim across skin tones or ambient light beyond the recordings in
`test/fixtures/`. **This is not a medical device.** It is for research and
personal curiosity, not diagnosis, treatment, or any decision that needs a
validated instrument.

## Testing

```bash
npm test          # strict typecheck + all unit suites
npm run test:e2e  # real Chromium + fake camera fed from a fixture (after npm run build)
```

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT, see [LICENSE](LICENSE).

The audit that drove the 0.3 rebuild, with its measurements and references,
is in [`docs/audit/AUDIT-2026-09.md`](docs/audit/AUDIT-2026-09.md).
