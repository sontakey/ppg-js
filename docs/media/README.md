# Pulse Painting screenshots

Captured from the local source app (`examples/app/index.html`) at 2026-10-22T02:57:16.780Z (October 21 in America/Chicago), before deployment of the Pulse Painting rename. The public app remains at https://chatppg.com/ppg-js-demo.

- Mobile screenshots use Chromium with iPhone 13 browser emulation, a 390 × 844 CSS-pixel viewport, and device scale factor 1.
- The optional desktop QR screenshot uses a 634 × 1014 viewport and device scale factor 1.
- All images are direct browser screenshots saved as JPEG at quality 85. Reduced motion is enabled to capture settled screens. No screenshot pixels, interface text, or metric values were edited.
- `pulse-painting-ready.jpg` and `pulse-painting-qr.jpg` are ordinary page renders.
- `pulse-painting-capture.jpg` and `pulse-painting-report.jpg` use the repository's public `test/fixtures/iphone-200s.json` recording through the built signal engine and application callbacks. Camera input is mocked; the empty live-preview thumbnail is expected. Capture is shown after 70 seconds of recorded samples, and the report follows manual completion after 180 seconds of recorded samples. This accelerated replay does not advance the wall-clock countdown, so the capture image still displays 3:00.
- The replay report computes mean pulse 71 bpm, RMSSD 53.6 ms, and SDNN 47.6 ms from the recording. These are fixture results, not a new physical-device measurement or a physiological-accuracy validation.

| File | Pixels | Bytes |
| --- | --- | ---: |
| `pulse-painting-ready.jpg` | 390 × 844 | 51,978 |
| `pulse-painting-capture.jpg` | 390 × 844 | 56,304 |
| `pulse-painting-report.jpg` | 390 × 844 | 62,026 |
| `pulse-painting-qr.jpg` | 634 × 1014 | 112,132 |
