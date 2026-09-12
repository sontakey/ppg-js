# ppg-js

Real-time heart rate and HRV from a phone camera, in the browser.

[![CI](https://github.com/sontakey/ppg-js/actions/workflows/test.yml/badge.svg)](https://github.com/sontakey/ppg-js/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/%40sontakey%2Fppg-js.svg)](https://www.npmjs.com/package/@sontakey/ppg-js)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@sontakey/ppg-js)](https://bundlephobia.com/package/@sontakey/ppg-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`ppg-js` uses the camera and (where available) the flash to capture a
photoplethysmography (PPG) signal from a covered fingertip, and turns it into
heart rate, IBI, RMSSD, and SDNN with an explicit signal-quality gate so it
tells you when a number is not trustworthy instead of guessing.

![Measuring screen placeholder](docs/assets/hero.png)

> Hero image not yet captured — see [docs/design/screens](docs/design/) for
> the live demo UI once available; this path is a placeholder until then.

## Table of contents

- [Why](#why)
- [Live demo](#live-demo)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Signal quality contract](#signal-quality-contract)
- [Browser support](#browser-support)
- [Debugging with the recorder and replay CLI](#debugging-with-the-recorder-and-replay-cli)
- [Testing](#testing)
- [Accuracy and limitations](#accuracy-and-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Why

- **Raw waveform kept.** Every frame's RGB channel means are recorded, always,
  no toggle — a bad session is never lost and can be replayed offline.
- **Quality-gated numbers, not best-effort guesses.** Heart rate, RMSSD, and
  SDNN are only emitted while a strict per-window check (`good`) passes; the
  library tells you *why* a number isn't showing instead of showing a wrong one.
- **Debug log + replay, not "trust me."** A one-tap JSON export plus a Node
  CLI (`npm run replay`) runs a recorded session through the exact same
  pipeline the browser used, so a bad reading in the field is reproducible on
  a laptop.

## Live demo

**[https://ppg-js.vercel.app](https://ppg-js.vercel.app)**

Needs a real camera and HTTPS — open it on a phone.

## Quick start

### Install

```bash
npm install @sontakey/ppg-js
```

### CDN

```html
<script src="https://unpkg.com/@sontakey/ppg-js/dist/index.global.js"></script>
<script>
  const monitor = new PPG.PPGMonitor(null, { ui: { enabled: false }, onQualityUpdate: console.log });
</script>
```

The CDN build exposes a global `PPG` (IIFE). The core injects no CSS; the demo app in `examples/app/` shows a full UI built on the public API.

### Example

```javascript
import PPGMonitor from '@sontakey/ppg-js';

const ppg = new PPGMonitor('#container', {
  onReady: ({ torchSupported }) => {
    console.log('camera ready, torch:', torchSupported);
  },
  onQualityUpdate: (metrics) => {
    if (!metrics.quality.good) {
      console.log('not ready:', metrics.quality.reason);
      return;
    }
    console.log(`${metrics.heartRate} bpm, RMSSD ${metrics.rmssd}ms`);
  },
  onError: (err) => console.error(err)
});

await ppg.start();
// later
ppg.stop();
```

Pass `null` as the container for headless mode (no built-in UI, only
callbacks):

```javascript
const ppg = new PPGMonitor(null, { ui: { enabled: false }, onQualityUpdate });
```

## How it works

```
camera frame
   -> ROI crop + downscale (center 30% x 30%, 64x48 canvas)
   -> red/green channel means
   -> finger state machine (NO_FINGER / SETTLING / MEASURING)
   -> per-window: detrend -> bandpass filter -> peak detection -> IBI
   -> FFT cross-check (peak-frequency HR vs IBI-median HR)
   -> HR / RMSSD / SDNN
   -> strict quality gate ("good": true/false)
```

### Finger state machine

```
NO_FINGER --finger placed--> SETTLING --settled (6s, low drift, AC/DC ok)--> MEASURING
    ^                             |                                              |
    |                       finger lifted                                  large drift
    +-----------------------------+----------------------------------------------+
```

HR/IBI/RMSSD are only computed while `MEASURING`. The first several seconds
of any session are placement noise (baseline settling, exposure re-lock) and
are deliberately withheld rather than shown as a wrong number.

## API reference

### `new PPGMonitor(container, options)`

- `container` — `string | HTMLElement | null`. CSS selector or element for
  the built-in UI. `null` runs headless (no DOM, callbacks only).
- `options` — see defaults below (from `src/utils/helpers.js`
  `createDefaultOptions`); any subset may be passed, unspecified keys fall
  back to these defaults.

```javascript
{
  ui: {
    enabled: true,        // render the built-in video/chart/metrics UI
    showVideo: true,
    showMetrics: true,
    showChart: true,
    theme: 'light'         // not yet used
  },
  signal: {
    windowLength: 300,     // samples per processing window (5s @ 60 FPS)
    sampleRate: 60,        // Hz, fallback only — real rate is measured from frame timestamps
    cardiacBandLow: 0.75,  // Hz (45 BPM), bandpass filter low edge
    cardiacBandHigh: 4.0,  // Hz (240 BPM), bandpass filter high edge
    fftSize: 256           // FFT size for the coarse frequency-domain HR estimate
  },
  camera: {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 60 },
    facingMode: 'environment'   // 'user' for front camera
  },
  roi: {
    widthFraction: 0.3,   // center-crop fraction of frame width sampled
    heightFraction: 0.3
  },
  onReady: ({ torchSupported }) => {},   // camera acquired, monitoring started
  onQualityUpdate: (metrics) => {},      // fired once per window (~5s)
  onSignalUpdate: ({ time, value, isProcessing }) => {},  // fired every frame
  onFrame: ({ frameCount, xMean, acFrame }) => {},        // fired every frame
  onError: (error) => {}
}
```

### Methods

| Method | Returns | Notes |
|---|---|---|
| `start()` | `Promise<void>` | Requests camera, locks exposure/WB/focus/zoom where supported, begins the frame loop. |
| `stop()` | `void` | Stops the frame loop and releases the camera. |
| `destroy()` | `void` | `stop()` plus tears down the UI and buffers. |
| `getMetrics()` | `Object` | Snapshot of the current metrics object (see below). |
| `getSignalQuality()` | `string` | Current `qualityStatus` ("Excellent"/"Good"/"Fair"/"Poor"). |
| `getDebugLog()` | `{meta, samples, events, timestampAnomalies}` | Full raw recording so far; safe to call any time, running or stopped. |
| `downloadDebugLog()` | `string` (filename) | Triggers a browser download of the debug log JSON. |
| `copyDebugLogToClipboard()` | `Promise<void>` | Copies the debug log JSON to the clipboard. |
| `getTachogram()` | `Array<{t, ibiMs, valid, reason}>` | Every candidate IBI for the session, accepted and rejected. |
| `getSessionSummary()` | `Object` | min/median/max HR, RMSSD, SDNN over `good` windows only, plus `goodFraction`. |

### Metrics object (`onQualityUpdate` argument / `getMetrics()`)

```javascript
{
  snr_dB: number,             // frequency-domain SNR in the cardiac band
  perfusionIndex: number,     // AC/DC ratio as a percentage
  heartRate: number,          // BPM, 0 unless quality.good
  heartRateRaw: number,       // BPM, cross-checked estimate regardless of gate
  heartRateSource: string,    // which estimate won the FFT/IBI cross-check
  ibi: number,                // most recent inter-beat interval, ms
  rmssd: number,              // ms, 0 unless quality.good
  sdnn: number,                // ms, 0 unless quality.good
  artifactRatio: number,      // fraction of candidate IBIs rejected in last 60s
  sampleRate: number,         // measured Hz for this window
  signalStability: number,    // 0-1, variance-ratio between consecutive windows
  qualityStatus: string,      // "Excellent" | "Good" | "Fair" | "Poor" (SNR bucket)
  guidanceMessage: string,    // human-readable coaching text
  qualityFrameCount: number,
  fingerState: string,        // "NO_FINGER" | "SETTLING" | "MEASURING"
  selectedChannel: string,    // "red" | "green"
  qualityScore: number,
  settleRemainingSec: number,
  quality: {
    state: string,
    acdc: number,
    artifactRatio: number,
    ibiCount: number,
    fftAgree: boolean,
    good: boolean,
    reason: string | null
  },
  peakTimesSec: number[],     // debug: detected peaks, window-relative seconds
  ibiDetails: Array<{ peakTimeSec, ibiMs, valid, reason }>
}
```

## Signal quality contract

`metrics.quality.good` is `true` only when every one of these holds
(checked in this order — `reason` is always the first one that fails, see
`src/utils/quality.js`):

1. `fingerState === 'MEASURING'` (not `NO_FINGER` or `SETTLING`)
2. AC/DC ratio of the selected channel ≥ `0.005` (0.5%) — rejects a weak pulse
3. Artifact ratio (rejected IBIs / total candidate IBIs in the last 60s) ≤ `0.2`
4. At least 8 accepted IBIs in the last 60 seconds
5. The IBI-median heart rate agrees with the independent FFT-peak heart rate
   (no `crossCheckHeartRate` disagreement)

`heartRate`, `rmssd`, and `sdnn` are `0` whenever `good` is `false`.
`heartRateRaw` is always populated (even when not `good`) for callers that
want the raw estimate anyway.

## Browser support

| Browser | Camera | Torch | Notes |
|---|---|---|---|
| iOS Safari 14.1+ | Yes | **No** | No `torch` capability on iOS Safari; demo instructs users to use a bright external light source instead. |
| iOS Chrome | Yes | No | Chrome on iOS uses WebKit under the hood — same torch limitation as Safari. |
| Android Chrome | Yes | Yes | Torch supported via `MediaTrackConstraints.advanced.torch`. |
| Desktop Chrome/Edge 89+ | Yes | N/A | Works for development/testing; no fingertip-covers-flash physical setup, so expect poor real signal without a controlled light source. |
| Firefox 88+ | Yes | No | `getUserMedia` supported; not the primary tested target. |

Requirements: HTTPS (camera access requires a secure context), `getUserMedia`
support. `requestVideoFrameCallback` is used when available (accurate
per-frame capture timestamps) and falls back to `requestAnimationFrame`.

## Debugging with the recorder and replay CLI

Every session **always** records a raw debug log — no toggle, so a bad
measurement is never lost. It captures per-frame RGB channel means, session
metadata (camera capabilities/constraints, ROI, timing mode, measured sample
rate), and every detected peak/IBI/HR update.

**Record on a phone:**
1. Open the demo, start a measurement, hold the finger steady for the full
   session.
2. Tap **Save debug log** (downloads `ppg-debug-<ISO timestamp>.json`; iOS
   opens the share sheet instead of a direct save) or **Copy debug log** to
   copy the JSON to the clipboard.
3. Send the file to whoever is debugging.

**Replay offline:**

```bash
npm run replay -- /path/to/ppg-debug-2024-01-01T00-00-00.json
```

This runs the recorded raw samples through the exact same
filter → detect-peaks → IBI → HR/RMSSD pipeline the browser uses (imported
directly from `src/utils`, not a reimplementation), and prints measured fps
(mean/min/max/jitter), finger-present ratio, an HR timeline, the IBI list
with artifact flags, RMSSD, and a comparison against the peaks recorded live
(matched/missed/extra).

## Testing

```bash
npm test
```

Runs, assert-based, no framework, non-zero exit on failure:

- `test/ppg-pipeline.test.js` — synthetic-signal test of the real filter →
  peak → IBI pipeline
- `test/replay.test.js` — replay tool correctness
- `test/camera.test.js` — rear-lens selection logic
- `test/timestamps.test.js` — timestamp repair/monotonicity in the recorder
- `test/quality.test.js`, `test/missed-beat.test.js`, `test/fixtures.test.js`,
  `test/sim.test.js` — additional coverage of the quality gate, missed-beat
  handling, and synthetic simulation, runnable individually with `node
  test/<file>`

`test/fixtures/` contains two real anonymized iPhone recordings
(`iphone-52s.json`, `iphone-200s.json`) replayed through the pipeline as
regression fixtures — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to add
another one.

CI runs `npm test` on every push and PR (`.github/workflows/test.yml`).

## Accuracy and limitations

**Validated against:**
- Synthetic PPG signals with known heart rate, harmonics, baseline drift,
  irregular sample timing, and injected noise (`test/ppg-pipeline.test.js`,
  `test/sim.test.js`)
- Two real iPhone recordings, replayed through the exact production pipeline

**Not validated:**
- No clinical or IRB-approved validation against a reference pulse oximeter
  or ECG across a real population
- No accuracy claim across skin tones, motion, or ambient-light conditions
  beyond what the two recorded logs cover

**This is not a medical device.** It is for demonstration and research use
only — do not use it for diagnosis, treatment, or any decision that requires
a validated instrument.

## Roadmap

A TypeScript rewrite is planned. Nothing below exists in the current
JavaScript implementation yet:

- Zero-dependency core (drop the current `d3` and `fft.js` dependencies)
- Pluggable signal sources (camera today; wearables and other sensors as
  additional source implementations)
- Pluggable pipeline stages (swap filter/peak-detection/quality stages)
- Typed events end to end
- Face-based remote PPG (rPPG) via the POS algorithm, as an alternative
  source to fingertip camera capture
- Accelerometer-based motion gate as an additional quality-gate input

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Vandenberk T, et al. "Clinical Validation of Heart Rate Apps," JMIR Mhealth
Uhealth 2017;5(8):e129. <https://mhealth.jmir.org/2017/8/e129>
