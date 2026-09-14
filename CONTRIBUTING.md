# Contributing

Thanks for looking at ppg-js. This is an MIT project; issues and PRs are
welcome, no CLA, no formal process.

## Dev setup

```bash
git clone https://github.com/sontakey/ppg-js.git
cd ppg-js
npm install
npm run build      # tsup -> dist/ (esm, cjs, d.ts, browser global) + copies the global into examples/demo/dist
npm run serve      # static server for examples/, http://localhost:8080
```

## Tests

```bash
npm test           # typecheck (strict) + every test/*.test.js
npm run test:unit  # tests only
npm run test:e2e   # real Chromium + fake camera fed from a recorded fixture (needs `npm run build`)
```

No test framework: plain `node`, `assert/strict`, non-zero exit on failure.
Run one suite with `node --import tsx test/<file>`.

What the suites cover, so you know where a change belongs:

- `dsp.test.js` - filter response, FFT resolution and harmonic guard, template quality, BLE parser
- `engine.test.js` - ground-truth precision (RMSSD floor with and without dropped frames), gates, gaps, respiration
- `hrv.test.js` - HRV metrics against known values
- `sim.test.js`, `ppg-pipeline.test.js`, `missed-beat.test.js` - synthetic end-to-end cases
- `fixtures.test.js`, `live-parity.test.js` - real iPhone recordings through replay and through the live monitor path
- `camera-resume.test.js`, `camera.test.js`, `finger-state.test.js`, `quality.test.js`, `replay.test.js`, `timestamps.test.js`

Any change to the engine or DSP should keep the ground-truth bounds in
`engine.test.js` and `sim.test.js` where they are or tighten them. Do not
widen a bound to make a change pass; if a bound is wrong, say why in the PR.

## Adding a real recording

`test/fixtures/` holds anonymised phone recordings captured with the demo's
debug recorder and replayed as regression checks. The most valuable
recordings right now are ones from devices we do not have: any Android
phone, torch off, an older iPhone, a desktop webcam. To add one:

1. Record a session with the demo and tap **Save debug log**.
2. Anonymise it: `node tools/anonymize-log.js in.json test/fixtures/<device>-<duration>s.json`.
   This strips device identifiers; the user agent is already omitted unless
   `debug.includeUserAgent` was set.
3. Add a case to `test/fixtures.test.js` asserting on properties (reaches
   MEASURING, good fraction, HR range), not on exact numbers.
4. Run `npm run replay -- test/fixtures/<name>.json` once by hand.

## Commit style

Short imperative subject line, one logical change per commit. Look at
`git log --oneline` for the tone.

## PR checklist

- [ ] `npm test` passes (typecheck + unit)
- [ ] `npm run build` succeeds if you touched `src/`
- [ ] New signal-processing logic has a synthetic test with ground truth
- [ ] README updated if you changed options, methods, events or the metrics shape
- [ ] No new runtime dependency
