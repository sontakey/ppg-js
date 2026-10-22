# Pulse on Paper screenshots

Captured from https://chatppg.com/ppg-js-demo on 2026-10-22 at 02:26 UTC (October 21 in America/Chicago). These JPEGs show the deployed light watercolor interface.

- Mobile screenshots use Chromium with iPhone 13 browser emulation, a 390 × 844 CSS-pixel viewport, and device scale factor 1.
- The optional desktop QR screenshot uses a 634 × 1014 viewport and device scale factor 1.
- All images are direct browser screenshots saved as JPEG at quality 85. Reduced motion is enabled to capture settled screens. No screenshot pixels, interface text, or metric values were edited.
- `pulse-on-paper-ready.jpg` and `pulse-on-paper-qr.jpg` are ordinary page renders.
- `pulse-on-paper-capture.jpg` and `pulse-on-paper-report.jpg` use the repository's public `test/fixtures/iphone-200s.json` recording through the deployed signal engine and application callbacks. Camera input is mocked; the empty live-preview thumbnail is expected. Capture is shown after 70 seconds of recorded samples, and the report follows manual completion after 180 seconds of recorded samples. This accelerated replay does not advance the wall-clock countdown, so the capture image still displays 3:00.
- The replay report computes mean pulse 71 bpm, RMSSD 53.6 ms, and SDNN 47.6 ms from the recording. These are fixture results, not a new physical-device measurement or a physiological-accuracy validation.

| File | Pixels | Bytes |
| --- | --- | ---: |
| `pulse-on-paper-ready.jpg` | 390 × 844 | 51,507 |
| `pulse-on-paper-capture.jpg` | 390 × 844 | 55,959 |
| `pulse-on-paper-report.jpg` | 390 × 844 | 61,640 |
| `pulse-on-paper-qr.jpg` | 634 × 1014 | 110,748 |
