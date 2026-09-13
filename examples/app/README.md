# examples/app — third-party dogfood demo

A second demo app, separate from `examples/demo/`. It uses ppg-js exactly the way a
third-party developer would: load the built UMD bundle, construct `PPGMonitor` in
headless UI mode, and drive your own screens off its callbacks. No framework, no
build step — `index.html` + `app.js` + `app.css`.

Design informed by `docs/design/inspiration.md` (structure only, not skin — see that
doc's brand-boundary note).

## How this app uses ppg-js

```js
// PPGMonitor is the global exported by ../demo/dist/ppg-monitor.min.js (UMD build)
const monitor = new PPGMonitor(null, {           // null container = headless, no built-in UI
  ui: { enabled: false },

  onReady: ({ torchSupported }) => {
    // torchSupported === false on iOS Safari — no flashlight API exists there.
    // Show your own copy telling the user to turn the flashlight on manually.
  },

  onQualityUpdate: (metrics) => {
    // Fires once per ~5s processing window. metrics.fingerState is
    // 'NO_FINGER' | 'SETTLING' | 'MEASURING'. Only trust heartRate/rmssd/sdnn
    // when metrics.quality.good is true — otherwise show metrics.quality.reason
    // (or metrics.guidanceMessage, which is the same reason once good).
    if (metrics.fingerState === 'MEASURING') { /* show HR screen */ }
    else { /* show placement/settling coaching */ }
  },

  onSignalUpdate: ({ value }) => {
    // Fires every frame (~30-60Hz). `value` is the detrended AC sample —
    // push it into your own ring buffer and draw it; there's no built-in chart
    // in headless mode.
  },

  onError: (err) => { /* getUserMedia failed, permission denied, etc. */ },
});

await monitor.start();   // requests camera, throws on failure — wrap in try/catch
monitor.stop();          // stops the camera stream; safe to call any time
monitor.getSessionSummary();   // { hr, rmssd, sdnn: {min,median,max}, goodFraction, ... }
monitor.getTachogram();        // [{ t, ibiMs, valid, reason }], accepted + rejected
monitor.downloadDebugLog();    // triggers a JSON file download (share sheet on iOS)
```

That's the whole integration surface used by this app — see `app.js` for the real
callsite (~150 lines total, ~20 of which are the constructor call above).

## HRV/ANS report (Kubios-style)

On Stop, the Summary screen is replaced by a full scrollable session report built
from the session's accepted (good-window) IBIs: time domain (SDNN, RMSSD, pNN50,
triangular index, TINN), frequency domain (Welch PSD, VLF/LF/HF power, LF/HF,
n.u., estimated respiration rate), nonlinear (Poincaré SD1/SD2, sample entropy,
DFA alpha1), and PNS/SNS autonomic-balance indices as z-scores against the Nunan
et al. (2010) healthy-adult population reference — explicitly labelled a
population reference, not a diagnosis.

All analysis math lives in `the library's `PPG.hrv` module`, a dependency-free plain script
(attaches `window.HRVAnalysis`, no ESM) so it loads via `<script src>` next to
`app.js`. It's pure functions on an array of IBIs in ms — no DOM, no ppg-js
dependency — intentionally placed outside `src/` because `src/` is mid-refactor;
move it into the library once that lands. See the file's header comment for
full references (Task Force 1996, Tarvainen 2002, Nunan 2010, Baevsky stress
index).

`app.js`'s `renderReport(acceptedIbiMs)` draws the report UI (PSD/Poincaré/
tachogram on `<canvas>`, no charting library). `window.__demoReport(ibis)` is a
QA-only hook (like `window.__demoState`) that renders the report from an
explicit IBI list without a camera session — used by `scratch/screenshot-report.mjs`
to screenshot it against the real 200s iPhone fixture.

"Save report" calls `window.print()`; a print stylesheet in `app.css` flips the
report to a light theme for PDF export.

## Event/callback contract we actually relied on

- `onReady({ torchSupported })` — once, after `start()` succeeds.
- `onQualityUpdate(metrics)` — the only source of truth for finger state, HR, RMSSD,
  SDNN, and the coaching string. Fires roughly every 5s (one `windowLength` worth of
  frames), not more often.
- `onSignalUpdate({ value, time, isProcessing })` — fires every frame; used only for
  the waveform strip.
- `onError(err)` — camera/permission failures.
- No `onFrame` needed for this UI (raw per-frame xMean isn't needed once you have
  `onSignalUpdate`'s processed value).

## Gotchas hit while dogfooding (feeds the library refactor)

1. **`metrics.settleRemainingSec` needs `SETTLE_SEC` duplicated in the consumer.**
   The countdown ring in the placement screen needs to know the *total* settle
   duration to compute a fraction, but the library only ever reports the
   *remaining* seconds. We hardcoded `SETTLE_SEC = 6` in `app.js` to match
   `FingerStateMachine`'s default — if that default ever changes, every consumer's
   ring animation silently goes wrong. **Ask:** expose the configured `settleSec`
   (e.g. on the `onReady` payload or as a getter) so consumers don't have to
   duplicate a constant that already exists inside the library.

2. **No `onSessionEnd`/`onStateChange` callback.** We have to infer "dropped out of
   MEASURING back to SETTLING" (a lift or big drift) purely by diffing
   `metrics.fingerState` across `onQualityUpdate` calls in the app. `FingerStateMachine.update()`
   already returns a `changed` flag internally — it's just never surfaced to the
   public API. **Ask:** surface state transitions as their own callback
   (`onStateChange({ state, reason })`) instead of making every consumer inspect fields
   the library never promises are stable in shape.

3. **`torchSupported` only arrives via `onReady`, not on the monitor instance
   until after `start()` resolves.** We do stash it as `monitor.torchSupported`
   (an internal field, not documented in `src/index.js`'s public exports) so the
   placement screen can re-check it later — that's relying on an implementation
   detail. **Ask:** either document `monitor.torchSupported` as public, or repeat
   it in every `onQualityUpdate` payload.

4. **Headless mode has no built-in chart, which is correct and expected**, but the
   demo has to duplicate a full ring-buffer + canvas draw loop that
   `UIRenderer`/`RealTimeChart.js` already implement internally for the built-in-UI
   mode. **Not asking to fix** — headless-by-design is the right call — but worth
   noting for anyone who wants a "give me a chart element with no other chrome"
   middle option between full UI and fully headless.

5. **UMD bundle, not ESM.** `examples/demo/dist/ppg-monitor.min.js` attaches
   `window.PPGMonitor` as a global; there's no ES module build in `dist/` to
   `import`. A plain `<script src>` tag works fine (used here), but a developer
   reaching for `import PPGMonitor from '...'` will hit a wall until an ESM build
   is published alongside the UMD one.

6. **The bundle injects global CSS even in headless mode.** `ppg-monitor.min.js`
   bundles `src/styles/ppg-monitor.css` (built-in-UI styles) and injects it as a
   `<style>` tag on load *regardless of `ui.enabled`*, including a `body {
   background-color:#f3f3f3 }` rule. Because that `<style>` lands in the DOM after
   our own `<link rel="stylesheet">`, it wins the cascade and silently blows away
   this app's dark theme. We worked around it with `!important` on `html, body` in
   `app.css` — a real fix is for the bundle to scope its injected CSS (e.g. under a
   `.ppg-monitor-ui` class) instead of styling bare `body`, so headless consumers
   never receive built-in-UI styling at all.

## Files

- `index.html` — 4 screens (ready / placement / measuring / summary), each a
  `<section>` toggled via `hidden`.
- `app.js` — the integration code above, plus a `window.__demoState(name)` hook
  used ONLY for visual QA screenshots (see `docs/design/screens/`); it is not part
  of the ppg-js API and does nothing in normal use beyond letting QA jump straight
  to a screen.
- `app.css` — dark, mobile-first, system font stack, 44px+ touch targets, safe-area
  padding, respects `prefers-reduced-motion`.
