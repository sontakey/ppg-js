# Adversarial Review — ppg-js fingertip PPG

Reviewed the whole `src/` tree, build config, and both demo HTML pages against
what actually makes camera PPG work. Ranked by impact on "does this produce a
usable heart rate on a real phone."

## Findings

### 1. [CRITICAL] `PPGMonitor.computeFrame` freezes the signal for ~8 minutes at a time
`src/PPGMonitor.js:197-229`

```js
if (Math.floor(windowNum / 100) % 2 === 0) {
  this.isSignal = 1;
  ... // process and update UI
} else {
  this.ac = fill(this.acWindow);  // freeze chart/metrics at last mean
  this.isSignal = 0;
}
```
`windowNum` increments once per 300-sample (5s @60fps) window. `Math.floor(windowNum/100)`
only flips parity every **100 windows = ~8.3 minutes**. So metrics/chart update
normally for the first ~8 minutes, then freeze completely (flat line, stale
numbers) for the next ~8 minutes, forever alternating. On any measurement
under ~8 minutes (i.e. every real usage) this is invisible or, worse, it hits
the freeze window and the whole UI looks dead. This is very likely why
Sameer sees it "never work" — it's not a signal problem, the app is
literally programmed to stop updating.
**Fix:** removed the alternation; every window is processed and the UI/chart
updates continuously. There is no reason to hold stale data.

### 2. [CRITICAL] Hardcoded 60 Hz sample rate, no correlation to the real capture rate
`src/PPGMonitor.js:281` (`requestAnimationFrame`) + `src/utils/helpers.js:85` (`sampleRate: 60`)

Frames are pushed once per `requestAnimationFrame` tick (display refresh,
usually 60 Hz) but the actual camera delivers frames at its own rate (often
24-30 fps with torch on, lower in low light as the sensor auto-extends
exposure). Every rAF tick re-reads the *same* video frame via
`drawImage`/`getImageData` when the camera hasn't produced a new one, so the
buffer contains duplicate consecutive samples at an assumed-vs-actual rate
mismatch. The FFT-based HR calculation (`SignalProcessor.process`) uses the
frequency axis `freqResolution = sampleRate / fftSize` with `sampleRate`
hardcoded to 60 — if the true capture rate is e.g. 28 fps, every frequency
bin (and therefore every reported heart rate) is scaled by 60/28 ≈ 2.1x. This
alone would explain wildly wrong or "impossible" heart rates.
**Fix:** switched to `requestVideoFrameCallback` when available (gives the
real per-frame `mediaTime`), falling back to `requestAnimationFrame` with
`performance.now()`. Timestamps are recorded per sample; the true sample
rate is computed per-window from `windowLength / (elapsed seconds)` and fed
into the FFT/SNR path and the new peak detector instead of the hardcoded 60.

### 3. [HIGH] No auto-exposure / white-balance / focus lock, no torch capability check
`src/PPGMonitor.js:79-95`, `src/utils/helpers.js:90-95`

Camera constraints only request `facingMode`, resolution, and frame rate.
Auto-exposure is left on. With a finger over the lens, AE constantly hunts to
compensate for the (correctly) near-total red saturation, producing a slow
oscillating drift that swamps the ~1% AC pulse component — the #1 cause of
garbage PPG signal on phone cameras. Torch is "enabled" by calling
`new ImageCapture(track).getPhotoCapabilities()` (a call whose result is
discarded) and then blindly applying `{advanced:[{torch:true}]}` without
ever checking `track.getCapabilities().torch` — on devices/browsers without
torch capability this constraint is silently rejected or throws, and the
user is never told to use another light source instead.
**Fix:** after `getUserMedia`, read `track.getCapabilities()` and apply,
conditionally, whichever of `torch: true`, `exposureMode: 'manual'`,
`whiteBalanceMode: 'manual'`, `focusMode: 'manual'` are actually supported,
in one `applyConstraints` call. Dropped the pointless `ImageCapture` call.
If torch isn't supported (all of iOS Safari, some Android), the guidance
text now says "use a bright light source" instead of assuming the flash is
on.

### 4. [HIGH] No time-domain peak detection — "IBI" is derived, not measured
`src/SignalProcessor.js:49-56`

Heart rate comes only from the single dominant FFT bin in a 5-second window;
"IBI" is just `60000 / heartRate`, i.e. every beat in the window is assumed
identical. There is no way to compute real beat-to-beat variability (HRV),
no artifact rejection, no per-beat waveform to look at, which is one of the
explicit design goals (RMSSD, per-beat IBI). The FFT number alone is also
comparatively imprecise for spot heart rate and does nothing to sanity-check
implausible beats.
**Fix:** added `src/utils/filter.js` (biquad bandpass IIR, 0.7–4 Hz, no new
dependency) and `src/utils/peaks.js` (adaptive-threshold peak picker with a
300 ms refractory period, parabolic sub-sample peak-time interpolation, IBI
rejection outside 300–2000 ms or >30% jump from the rolling median-of-5, HR
from median of the last 8 valid IBIs, RMSSD over the valid-IBI window). Wired
into `SignalProcessor.process()` as `hr_peaks`, `ibiMs`, `rmssd`,
`artifactRatio` alongside the existing FFT/SNR numbers (kept — see below).

### 5. [MEDIUM] Raw signal is inverted, but only implicitly, and undocumented
`src/PPGMonitor.js:191` (`const xMean = 1 - rgbRed / (count*255)`)

This inversion is actually *correct* (more blood = more absorption = lower
raw red intensity, so `1 - normalized red` makes systolic peaks maxima) —
flagged here only because it's undocumented and easy for a future editor to
"fix" by removing it, silently breaking peak polarity. Added a comment.
**Kept as-is**, just documented.

### 6. [LOW] `detrend.js` builds an off-by-one-sized index array
`src/utils/detrend.js:12` (`for (let i = 0; i <= n; i++) x.push(i)`) produces
`n+1` entries but only `n` are ever read (the sum loops all use `i < n`). Not
a functional bug, just wasted allocation. Left alone — not worth touching in
a minimal diff, noted for whoever next touches this file.

### 7. [LOW] iOS Safari specifics
`playsinline` is present on both video elements in the demo (`autoplay
playsinline`, good — kept), `getUserMedia` is behind a user gesture (button
click, good — kept), and the demo is served over GitHub Pages HTTPS (good —
kept). Only the torch-unsupported messaging (finding #3) was actually
missing.

### Kept as-is (reviewed, found fine)
- Center ROI is the full frame, not a tiny crop, but red-channel averaging
  over the whole frame is a reasonable, cheap ROI choice for a finger fully
  covering the lens; not changed.
- Red-channel-only extraction (`src/PPGMonitor.js:184-188`) — correct choice
  for a torch-lit finger (green saturates, as the design doc noted).
- FFT + SNR-based quality/guidance UI (`SignalProcessor.js`, `helpers.js`)
  — reasonable for the "quality meter" use case, kept and left driving the
  guidance text and traffic-light indicator. It is a coarse 5-second-window
  estimate; the new peak-based HR/IBI/RMSSD is the one to trust for actual
  numbers.
- `torch: true` / HTTPS / GitHub Pages deployment plumbing already correct.

## Not fixed / explicitly out of scope
- No CSV/raw-sample export was added. It's a real gap for offline debugging
  but is a UI feature addition, not a signal-quality bug; flagging instead
  of scope-creeping the diff. Easy follow-up: push `{t, r, g, b}` to an array
  and offer a "Download CSV" button.
- No rewrite of the architecture. The buffering/windowing structure in
  `PPGMonitor` is adequate once the freeze bug (#1) and sample-rate bug (#2)
  are fixed; a full rewrite was not necessary.
