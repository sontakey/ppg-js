# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Respiration** reports sooner and stays on. The modulation series are
  high-passed at 0.06 Hz instead of linearly detrended and searched down to
  0.067 Hz with the peak required to sit a half-lobe inside the band, so
  slow breathing near 6/min no longer straddles the band edge (lowest
  reportable rate about 5.5/min). A single clear source publishes a
  provisional rate (confidence 0.3), a recent firm rate is held for up to
  30 s while one source still tracks it (0.4), and a rate at twice the held
  one is read as its harmonic. `RespirationEstimate.basis` says which rule
  produced the rate. On the 3 min spot check the first estimate moved from
  95 s to 40 s after MEASURING, with one empty window instead of nine; the demo shows a ≈ prefix
  for provisional rates.

### Added
- `analyzeHRV` / `frequencyDomain` accept `respirationRateBpm` and report
  `respirationInLf`: when an independent breathing estimate is under
  9 breaths/min, respiratory sinus arrhythmia sits in the LF band and LF/HF
  is breathing-driven. The demo report prints a note in that case.
- Fixture `iphone-195s-slow-breathing.json`: a 3 min v0.3.0 spot check with
  periodic 30 fps dips and ~6.7 breaths/min breathing, with regression
  bounds on live/replay parity, gate rate, HR through the dips, respiration
  and the LF peak.

### Fixed
- **Beat acceptance could deadlock.** The jump-versus-median rule compared
  each interval with the median of accepted intervals only, so a reference
  seeded by two or three junk intervals from the moments after finger
  placement rejected every real beat for the rest of the session (no heart
  rate at all, "irregular beats" forever). Four consecutive mutually
  consistent rejects now re-seed the reference and are accepted
  retroactively; on a cold start the disagreeing seeds are dropped. The same
  rule follows a real sustained rate change. Fixture
  `iphone-63s-noisy-onset.json` reproduces the failure.
- Demo report: the "population mean" caption under the PNS/SNS bars was
  absolutely positioned without a positioned parent, so it anchored to the
  page and floated over other cards while the report scrolled.
- `tools/anonymize-log.js` now redacts device and group ids inside recorded
  events too, not only in `meta`; the two `iphone-cros-*` fixtures were
  re-anonymized.

## [0.3.0] - 2026-09-13

Rebuild of the signal core after the September 2026 audit
(`docs/audit/AUDIT-2026-09.md`). Heart rate was already right; this release
makes the variability numbers trustworthy and the capture layer portable.

### Changed
- **One streaming engine** (`PpgEngine`) drives both the live camera path and
  `tools/replay.js`. Windows are 5 s of signal time, every window is
  interpolated onto one absolute time grid from the frame timestamps, and
  beat times are absolute. Dropped or late frames no longer shift beats; the
  live/replay parity test now asserts window-for-window equality.
- **Filter**: 4th-order Butterworth high-pass + 2nd-order low-pass cascade,
  zero-phase, reflection-padded. Flat within 1.4 dB over 45-180 bpm, 48 dB
  down on breathing; the previous single biquad was 6 dB down at its own
  band edges.
- **Spectral heart rate**: every sample used, Hann window, zero-padding,
  parabolic peak refinement (about 1 bpm resolution at any camera rate, was
  14 bpm at 60 fps) and a sub-harmonic guard so a strong dicrotic wave no
  longer doubles the rate.
- **Beat timing**: 0.3 s least-squares vertex fit. Zero-variability RMSSD
  floor 9-13 ms (was 20-26 ms; 52 ms with 10% dropped frames). The engine
  reports its own `rmssdFloorMs` next to every RMSSD.
- **Pulse amplitude** is now the bandpassed per-beat amplitude over DC, not
  the raw window range; motion no longer passes the "weak pulse" check.
- **Finger presence** is relative (red share of R+G+B, minimum red DC) and
  drift thresholds are fractions of DC, so Android sensors with a bright
  green channel and darker skin work with the defaults. All thresholds are
  options and are written into the debug log.
- **Quality gate** adds saturation, motion, pulse-shape (template
  correlation) and double-count/missed-beat checks, each with a stable
  `quality.code`.
- **Camera**: each capability gets its own `advanced` constraint set (a
  bundled set is applied all-or-nothing); exposure/white balance/focus lock
  now happens after the finger has settled (`camera.lockExposure`), not while
  the camera looks at the room; zoom is opt-in (`camera.zoom`); one retry on
  `NotReadableError`; `captureTime` preferred for frame timestamps;
  `presentedFrames` deltas counted as `droppedFrames`.
- **Lifecycle**: screen wake lock while measuring (`wakeLock`), optional
  DeviceMotion gate (`motion`), an error boundary around the frame loop,
  `PPGError` with stable codes and user-facing guidance, a preflight check
  for insecure contexts and in-app browsers, full reset on `start()`.
- **Privacy**: the debug log is no longer written to `localStorage` unless
  `debug.persistLastSession` is set; the user agent is omitted unless
  `debug.includeUserAgent` is set.
- **Coaching**: state is checked before the torch hint, so torch-less
  devices get real guidance while measuring.
- Session tachogram entries carry the window's `good` flag;
  `getTachogram({ goodOnly: true })`.
- Package: `browser` field removed, `require` condition ships its own types,
  subpath exports `./dsp`, `./hrv`, `./sources`, `./engine`; strict
  TypeScript throughout with real types on the public surface; `tsc` runs in
  CI; a Playwright job runs the real `getUserMedia` path against a fake
  camera fed from a recorded fixture.

### Added
- Signal-quality indices: `metrics.sqi` per window (skewness, kurtosis,
  perfusion, relative cardiac power, SNR, zero-crossing rate, template
  correlation, detector agreement, artifact ratio, clipping, motion) with a
  documented 0-1 composite `score` and its components; per-beat `sqi`
  (template correlation) on `beat` events and tachogram points. Functions
  exported from `@sontakey/ppg-js/dsp`.
- Missed-beat recovery: when an interval is about twice the recent median,
  the engine looks for a weaker beat inside the gap (a pulse that dipped
  under the adaptive threshold) before rejecting it. Recovered beats count
  for heart rate and the beat count but are flagged `lowSnr` and excluded
  from RMSSD/SDNN; `getTachogram({ hrvOnly: true })` drops them. Found by
  benchmarking against HeartPy (`docs/audit/BENCHMARK-2026-09.md`).
- `@sontakey/ppg-js/hrv`: the HRV analysis ported from the demo with the
  formula errors fixed (Baevsky stress index, linear RR resampling on real
  beat times with gap handling, least-squares TINN, sample-standard
  deviations, sample entropy template count, VLF hidden under 5 min) plus
  lnRMSSD, ultra-short (60 s) RMSSD, a rolling lnRMSSD baseline with the
  smallest worthwhile change, coherence, and experimental PNS/SNS indices
  with cited references.
- Respiration rate from the pulse train (interval, amplitude and baseline
  modulation fused when they agree), on the `respiration` event.
- `@sontakey/ppg-js/sources`: `BleHeartRateSource` (Web Bluetooth chest
  strap, RR intervals) and `ArraySource` (replay).
- Per-beat template quality (`templateSqi`), `clippedFraction`, `motion`,
  `timingUncertaintyMs` in metrics.

### Fixed
- Recorder leaked samples across `start()` calls.
- A beat inside the filter's edge region was lost at every window boundary.
- Coaching showed the flashlight hint on torch-less devices even with a good
  signal.
- Demo report used beats from windows the quality gate had rejected.
- Build no longer rewrites tracked HTML; deploy stamps every script tag so
  the immutable cache cannot serve a stale app shell.

### Removed
- `SignalProcessor` (replaced by `PpgEngine`), the Rollup config, the
  `.backup` sources and `LIBRARY_SUMMARY.md`; `examples/app/hrv-analysis.js`
  (now `PPG.hrv`).

## [0.2.0] - 2026-09-12

First npm release.

- TypeScript core, zero runtime dependencies, ESM + CJS + IIFE builds with type declarations.
- `PPG` class with typed events; `PPGMonitor` kept as a deprecated alias.
- Fingertip pipeline: rear-lens lock, ROI center crop, red/green channel selection, amplitude-aware peak detection with parabolic refinement, missed-beat rejection, FFT/IBI cross-check, NO_FINGER/SETTLING/MEASURING gate, strict per-window `good` contract.
- Live/replay parity: the live path warms the bandpass with the previous window and reads ring buffers chronologically; a parity test drives the real engine against two real iPhone recordings.
- iOS: playsinline capture video, torch re-apply watchdog, `expectedDisplayTime` timestamps.
- Always-on debug recorder with per-window instrumentation, track-settings snapshots and constraint attempts; `tools/replay.js` for offline diagnosis.
- HRV Spot Check demo app (3-minute protocol, Kubios-style ANS/HRV report) at https://ppg-js.vercel.app.

### Added
- iOS `requestVideoFrameCallback` timing fix: use `expectedDisplayTime`/`nowMs`
  instead of `mediaTime` (always 0 on iOS live streams), unified clock domain
- Timestamp regression tests (`test/timestamps.test.js`), recorder timestamp
  repair guards, replay-side timing reconstruction
- Rear-camera lens lock by device label, with mid-session lens-swap detection
- Node replay tool (`tools/replay.js`, `npm run replay`) that runs a recorded
  debug log through the exact same filter/peak/IBI pipeline used live
- Always-on raw debug recorder (`src/utils/recorder.js`) plus
  `getDebugLog()` / `downloadDebugLog()` / `copyDebugLogToClipboard()` on
  `PPGMonitor`, and Save/Copy debug log buttons in the demo
- Synthetic-signal test for the real filter -> peak -> IBI pipeline
- `npm test` script wiring all suites into one command (CI gate)

### Fixed
- Removed the ~8-minute freeze alternation that stopped the UI/chart from
  updating for long stretches of any real measurement
- Hardcoded 60 Hz sample-rate assumption replaced with a per-window measured
  rate from real frame timestamps
- Camera constraints tightened (facingMode/back-lens selection) to stop iOS
  silently handing out a multi-camera virtual device mid-session

## [1.0.0] - 2024-12-22 (pre-npm prototype; numbering predates the 0.x series above)

### Added
- Complete library refactoring into modular, reusable npm package
- Class-based API with `PPGMonitor` main class
- Signal quality metrics: SNR (dB), Perfusion Index, Heart Rate, IBI
- FFT-based signal analysis with cardiac frequency band filtering
- Real-time camera preview with finger placement guidance
- Color-coded visual feedback (green/yellow/red circle)
- Active user guidance messages
- Headless mode support for custom UIs
- Default UI with responsive layout
- Real-time D3.js chart visualization
- Rollup build system with UMD and ESM outputs
- Comprehensive examples (basic, headless)
- Full API documentation
- TypeScript-friendly exports
- Performance optimizations (requestAnimationFrame, typed arrays)
- Browser compatibility layer

### Changed
- Refactored monolithic code into modular architecture
- Extracted utilities (detrend, FFT, helpers)
- Extracted SignalProcessor class for signal analysis
- Extracted UIRenderer class for DOM manipulation
- Improved signal processing with stability tracking
- Enhanced error handling and user feedback

### Technical
- ES6+ syntax throughout
- Modular imports/exports
- Bundled dependencies (D3, FFT.js)
- Source maps for debugging
- Optimized bundle size
- No global pollution

## [0.1.0] - Initial Version

### Initial Features
- Basic PPG signal capture from smartphone camera
- Red channel extraction
- Linear detrending
- Real-time visualization
- Simple frame processing loop
