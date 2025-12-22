# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
