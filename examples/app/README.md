# Pulse on Paper

ChatPPG’s camera-PPG experience turns a recording into a painted manuscript,
then presents the existing HRV Spot Check analysis in the same visual language:
near-white paper, Water Brush titles, DM Sans measurements, defined blue pigment and
quiet scientific context. It is a plain HTML/CSS/JavaScript app using the built
ppg-js browser bundle plus a lazy app-only GPU compositor, both supplied by
`npm run build`.

A quiet shared footer links to ChatPPG and the ppg-js project website. Water Brush
is self-hosted under the included SIL Open Font License. Instructions, controls,
metric values and graph labels retain DM Sans for legibility.

Desktop visitors see an automatically revealed painted invitation with a crisp QR
code and a direct link to `https://chatppg.com/ppg-js-demo`. The code keeps its white
quiet zone and high-contrast modules; only the surrounding pigment animates.
Desktop capture stays disabled. Phones retain the capture instructions and action.

## Rendering goal

Target approximately **60 frames per second** during entry and accepted-waveform
reveal on supported mobile devices, without delaying camera acquisition or changing
the measured signal. Use current stable Three.js (pinned to **0.186.1**) with its
WebGPU renderer, TSL shaders and automatic WebGL2 fallback. A version pin makes
builds reproducible; upgrades require checking both backends again.

The app loads and warms the compositor during idle time. It uses one full-screen
triangle-pair per surface, no antialiasing or postprocessing chain, a maximum 2×
pixel ratio and an approximately 850,000-pixel budget per surface. Sustained slow
frames reduce resolution. Only entry diffusion and the reveal of cached pigment
textures animate; report plots render on demand. Texture generation occurs once
per accepted window, not once per frame. Hidden pages stop submitting frames.

Reduced-motion mode skips GPU loading and shows accepted strokes immediately.
Unsupported, blocked, cold or lost GPU contexts retain a lightweight Canvas2D
path and the same recording controls. GPU assets are separate from the published
PPG library, which keeps its zero-runtime-dependency contract.

The [Aquarelle reference](https://ramotion.github.io/aquarelle/) informs irregular
wet fronts; the [watercolor-edge tutorial](https://www.infoworld.com/article/2258656/javascript-tutorial-create-a-watercolor-edge-with-p5js.html)
informs overlapping translucent pigment and darker edge deposits. The effect is
implemented in Three.js TSL; decorative noise never displaces waveform samples.

60 fps is a performance target, not a universal device guarantee. Browser replay
benchmarks must identify the renderer and hardware, and remain separate from
physical-phone camera/flash/thermal validation.

## Capture and pigment contract

- The phone flow is ready → finger placement → measuring → report. The timer
  counts three minutes in `MEASURING`; placement and finger-loss time do not count.
  Desktop camera access remains disabled.
- Begin pulse capture spreads pigment from the painted button across the viewport
  before revealing placement. Camera permission is requested in the original
  gesture; reduced-motion mode skips the transition. Cancellation and permission
  errors clear the transition, and repeated taps cannot start duplicate sessions.
- A stroke is accepted only after its approximately five-second analysis window
  passes the engine’s quality gate. It then reveals over 4.4 seconds, synchronized
  with the browser’s animation frames. Reduced-motion mode shows accepted strokes
  immediately. This is a delayed rendering of measured data, not a live prediction.
  The reveal reuses two viewport-sized pigment layers to leave the main thread
  available for camera sampling; it does not redraw the texture each frame.
- Geometry uses `monitor.engine.lastWindow.filtered` from the **selected analysis
  channel**, with its grid rate and timestamps. The per-frame `onSignalUpdate`
  callback is red-channel AC: it supplies the presence mask, not the manuscript’s
  shape. This internal `lastWindow` dependency must be checked when upgrading the
  engine.
- Each accepted window is amplitude-normalized for the page. Its composite SQI
  score controls blue depth; higher quality produces deeper blue. Color describes
  recording quality, not health, HRV, pulse strength or elapsed time. Stored strokes
  are never recolored by a later window. Pigment texture is deterministic decoration
  around the measured waveform.
- Rejected windows, missing samples and artwork pauses leave gaps. **Pause artwork**
  freezes the artwork while measurement and the session timer continue. Resume
  does not fill the paused interval with invented strokes.

The capture canvas shows the latest four five-second rows. The report includes a
two-row detail; **Save manuscript** exports the full captured timeline as a PNG,
with bounded canvas dimensions for mobile memory use.

## Report and exports

**Finish painting** stops capture and analyzes valid, HRV-eligible beats from
accepted windows, retaining their timestamps. The report leads with mean pulse,
RMSSD, SDNN and recording quality. “Good-signal windows” is the fraction of windows
that passed the quality gate; it is distinct from the SQI used for pigment depth.

Time-domain, frequency-domain, nonlinear and beat-timing details remain available
through disclosures. Existing analysis eligibility rules still apply: unavailable
metrics show their reason or a placeholder, and an empty session asks for another
recording. No values or artwork are fabricated. ANS estimates remain preliminary
population comparisons, and the estimated timing-noise floor is explicitly not a
confidence interval.

All report plots use shared DM Sans labels, measured numeric gutters, separate axis
titles and consistent round tick increments. They redraw when opened, resized,
loaded fonts change, or printing begins. Plot colors and wrapping legends use the
ChatPPG scientific palette; off-scale ANS labels align inside the available width.

**Save report** opens all report details and invokes the browser’s print dialog for
printing or PDF export, then restores the disclosure state after printing. **Save
debug log** and the debug menu retain the existing local session-log workflow.
The app enables last-session persistence in browser local storage; the manuscript
itself remains in memory until exported or reset.

## Local preview and checks

From the repository root, after installing dependencies:

```sh
rtk npm run build
rtk proxy python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://127.0.0.1:8080/examples/app/index.html>. The build supplies
`examples/demo/dist/ppg.global.js`, which exposes `PPG` and the monitor used by the
app. Actual phone capture requires a compatible phone and a secure context; the
loopback preview alone does not test its camera, flash or browser permissions.

```sh
rtk npm test
rtk npm run test:app
rtk npm run test:safari-session
rtk npm run test:paint-performance
rtk npm run test:paint-fallbacks
```

`test:app` starts its own loopback server and replays the checked-in iPhone fixture
through the real streaming engine and monitor callback adapter, mocking camera I/O. It checks
capture, pause behavior, selected-channel quality attribution, report values,
responsive widths, exports and unavailable-data handling. These are browser
integration checks, not physical-device or physiological-accuracy validation.
The graph checks measure actual canvas glyph bounds and overlaps, including large
power values, constant RR data and minute rollover. Entry checks cover normal and
reduced motion, duplicate taps, a canceled late camera grant, and permission errors.

`test:safari-session` runs a complete 180-second active measurement in Playwright
WebKit with iPhone emulation and real-time public-recording replay. It injects a
camera-frame interruption, main-thread stall and hidden/visible interval, then
checks recovery, automatic completion, paint cadence, report values and exports.
Use `PPG_SAFARI_URL` for the deployed app and `PPG_SAFARI_ARTIFACTS` for its evidence
directory. The recording's final minute is repeated if the session needs more
input; the evidence records exactly how much was used. Camera I/O is mocked.

The protocol clock counts adjacent processing-frame timestamps only while the
page is visible. A source or callback-delivery gap over 250 ms earns no time;
recording resumes from the next fresh frame without catching up missing time.
The report timing plot retains accepted-beat timestamps and leaves gaps in its
line across missing intervals. Stopping or destroying a monitor cancels pending
camera recovery, including streams returned after cancellation.

Capture keeps pulse/RMSSD/SDNN visible below the manuscript, with additional
signal details in an expandable section. A single live video moves from the
placement guide to the small upper-right camera preview. Controls remain in
normal flow with safe-area padding and 44px touch targets. New manuscript rows
ease into view over 900 ms using at most five cached rows for four visible rows;
only GPU uniforms or Canvas2D crop coordinates change during scrolling.
Artwork pause and background suspension preserve animation progress, and reduced
motion follows each new row immediately.

`test:paint-performance` records entry and live-reveal frame cadence alongside
real-time engine replay, using native WebGPU and forced WebGL2 at normal and 4× CPU
throttling. It records the actual backend, hardware, resolution and CPU submission
time in `.dream-loop/gpu-performance/results.json`. It requires those GPU backends
to be available and does not impose a universal hardware-dependent fps test gate.
Set `PPG_PERF_URL` to check a hosted preview or `PPG_SESSION_LOG` to replay a private
recording locally. A 390 × 844 viewport at DPR 3 is mobile emulation, not a phone.

The 2026-10-21 local benchmark on Apple M4 / Chrome 155 measured 60.00 fps for
both WebGPU and WebGL2 during 20 seconds of real-time replay. At 4× CPU throttling,
the same runs measured 59.45 and 59.70 fps, with four longer intervals in each run;
the p95 frame interval remained 16.7–16.8 ms. This excludes actual camera I/O and
phone thermals. The fallback suite separately verifies a blocked compositor module
and real WebGL2 context loss: the visible Canvas2D painting retains its measured
data and continues accepting new windows.

On macOS the test uses installed Google Chrome. Elsewhere it uses Playwright’s
Chromium; `PPG_CHROMIUM` can specify a browser executable. A private recording can
be used locally without copying it into the repository:

```sh
rtk proxy env PPG_SESSION_LOG=/absolute/path/to/session.json npm run test:app
```

## Files and publication

- `index.html`: branded ready, placement, measuring and report screens.
- `app.js`: monitor integration, pigment renderer, report and export actions.
- `app.css` and `fonts/`: responsive paper treatment, bundled fonts and print styles.
- `assets/phone-qr.svg`: offline-generated phone handoff QR, with generation notes.
- `src/paint-gpu.js`: app-only Three.js TSL source; the build emits `paint-gpu.js`.
- `../../test/e2e/pulse-on-paper.mjs`: app regression checks.

ChatPPG’s host repository publishes `/ppg-js-demo` by building its `apps/ppg-js`
Git submodule, publishing its runtime assets under a content-hashed directory in
`public/ppg-js-demo`, and rewriting asset paths while adding shared styles and metadata.
The app provides its own quiet attribution without a host navbar. Preserve the
`../demo/dist/ppg.global.js`, `app.css`, `app.js` references and `HRV Spot Check`
HTML title expected by that builder. Publishing requires the host to advance its
submodule revision, handle asset cache invalidation, rebuild and deploy. A local
change or passing test does not establish that the public site has been updated.
