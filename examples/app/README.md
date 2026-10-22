# HRV Spot Check reference app

A focused example of the public ppg-js API: camera placement, a live waveform,
quality-gated metrics and an HRV report. It restores the four-screen flow from
commit `5621c7e`, with ChatPPG's light colors, DM Sans typography and cobalt
controls. The current camera and data-correctness fixes remain in place.

Live: <https://chatppg.com/ppg-js-demo>.

The creative artwork product is maintained separately at
<https://github.com/sontakey/pulsepainting> and hosted at
<https://chatppg.com/pulse-painting>. This reference app has no painting, GPU,
portrait or landscape dependencies.

## Run locally

From the repository root:

```sh
npm install
npm run build
npm run serve
```

Open `http://localhost:8080/examples/app/index.html`. Real camera capture requires
a supported phone and HTTPS (or a browser's trusted localhost environment).
Desktop visitors receive an explicit phone requirement. No camera is requested
until Start is pressed on a supported mobile user agent.

## Integration

`index.html` loads the browser global `PPG` namespace from the built library.
`app.js` constructs `PPG.PPGMonitor` in headless mode:

```js
const monitor = new PPG.PPGMonitor(null, {
  ui: { enabled: false },
  signal: { hopSec: 1 },
  wakeLock: true,
  motion: true,
  onReady: ({ torchSupported }) => { /* flash guidance */ },
  onQualityUpdate: metrics => { /* quality-gated HR, RMSSD and SDNN */ },
  onSignalUpdate: ({ time, value, isProcessing }) => { /* trace and active clock */ },
  onError: error => { /* actionable camera guidance */ },
});

// Invoke from the user's Start gesture.
await monitor.start();
// Later:
monitor.stop();
const beats = monitor.getTachogram({ goodOnly: true, hrvOnly: true }).filter(b => b.valid);
const report = PPG.hrv.analyzeHRV(beats);
```

The five-second signal window is recomputed once a second. Readouts show actual
computed values and are withheld when quality is insufficient. The three-minute
countdown advances only on fresh processing frames; hidden tabs, stale camera
state, queued callbacks and interruptions cannot earn missing recording time.
Startup generation guards prevent duplicate starts and late permission grants
from reviving a canceled session.

The report uses accepted beats with their real timestamps. It retains gaps,
metric sufficiency checks, method notes, timing-noise estimates and explicit
research-estimate wording. The full report is visible directly; interpretation
details expand and open for printing. Save report and Measure again remain
reachable in a floating mobile action area. Debug JSON export stays in the menu.

## Files and checks

- `index.html`: ready, placement, measuring and report screens.
- `app.js`: public API integration, lifecycle guards, live charts and report.
- `app.css`: light ChatPPG skin, 44px+ controls, mobile safe areas and print styles.
- `fonts/`: local DM Sans plus its SIL OFL license.

`npm run test:app` covers replayed metrics and report parity, 320–1440px graph
labels, large/constant-value chart cases, print, no data, quality withholding and
camera cancellation/denial. `npm run test:safari-session` runs a full three-minute
desktop WebKit replay with frame, main-thread and visibility interruptions.
These use mocked camera I/O and do not establish real-phone camera or
physiological accuracy. Screenshot provenance is in `docs/media/README.md`.

The `window.__demoState()` and `window.__demoReport()` hooks are local visual QA
aids, not library APIs or normal product behavior.
