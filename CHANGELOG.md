# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.0.0] - 2024-12-22

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
