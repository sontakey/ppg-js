# HRV Spot Check reference screenshots

Captured on October 21, 2026 (America/Chicago) from the restored local source
`examples/app/index.html`, before the split deployment. The canonical reference
URL is <https://chatppg.com/ppg-js-demo>. Pulse Painting now has its own
[repository](https://github.com/sontakey/pulsepainting) and screenshots.

- `reference-ready.jpg`, `reference-capture.jpg`, `reference-report.jpg` are
  direct Chromium screenshots at a 390×844 CSS-pixel viewport, saved at CSS
  scale as 390×844 JPEGs, quality 85. No image pixels or metric values were edited.
- Ready is an ordinary page render. Capture and report use the public
  `test/fixtures/iphone-200s.json` recording through the built engine and real
  application callbacks, with camera I/O mocked.
- Capture follows 70 seconds of recorded samples; report follows manual Stop
  after 180 recorded seconds. This accelerated replay does not represent the
  wall-clock countdown, so the capture image shows 3:00.
- The report has 175 accepted beats, mean pulse 71 bpm, RMSSD 53.6 ms and SDNN
  47.6 ms. These are fixture replay results, not a new physical-phone measurement.
- `npm run test:app` regenerates these images under `.dream-loop/reference-demo`
  alongside scoped validation evidence. The separate `test:safari-session`
  command checks a full three-minute active protocol and interruptions at real
  wall-clock speed in desktop WebKit.

The imagery documents the original reference flow with the new light ChatPPG
skin. The plain app contains no GPU painting renderer, artwork or landscape.
