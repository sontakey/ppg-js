# Contributing

Thanks for looking at ppg-js. This is a personal MIT project (Sameer
Shariff) — issues and PRs are welcome, no CLA, no formal process.

## Dev setup

```bash
git clone https://github.com/sontakey/ppg-js.git
cd ppg-js
npm install
npm run build     # rollup -> dist/
npm run serve     # static file server for examples/, http://localhost:8080
```

## Tests

```bash
npm test
```

Runs all suites (`test/ppg-pipeline.test.js`, `test/replay.test.js`,
`test/camera.test.js`, `test/timestamps.test.js`). No test framework —
plain `node`, `assert/strict`, non-zero exit on failure. Run an individual
suite the same way, e.g. `node test/quality.test.js`.

Any change to `src/utils/{filter,peaks,quality,fingerState,recorder}.js` or
`SignalProcessor.js`/`PPGMonitor.js` should keep `npm test` green and, where
the change affects signal processing, add or update a synthetic case in
`test/ppg-pipeline.test.js` or `test/sim.test.js` rather than only relying on
real-log fixtures.

## Adding a real-log fixture

`test/fixtures/` holds real anonymized phone recordings
(`iphone-52s.json`, `iphone-200s.json`) captured via the demo's debug
recorder (`getDebugLog()` / "Save debug log" button) and replayed through the
production pipeline as a regression check (`test/fixtures.test.js`).

To add one:

1. Record a session on a phone using the demo (`examples/demo/`), tap
   **Save debug log**.
2. Anonymize it before committing — the raw log includes `userAgent` and
   `screen` dimensions in `meta`. Strip or genericize any field that isn't
   needed to reproduce the pipeline behavior (RGB samples, timestamps, and
   camera capability data are the parts that matter; free-text device info
   is not).
3. Drop the anonymized JSON into `test/fixtures/` with a descriptive name
   (`<device>-<duration>s.json`).
4. Add or extend a case in `test/fixtures.test.js` that replays it and
   asserts on the properties you care about (e.g. "at least N accepted
   beats", "no NaN timestamps") — don't just assert on the exact numbers the
   pipeline happens to produce today, since legitimate pipeline improvements
   would then fail the test.
5. Run `node tools/replay.js test/fixtures/<name>.json` once by hand to
   sanity-check the output before committing.

## Commit style

Short imperative subject line describing the change, no ticket numbers, no
prefix convention enforced. Look at `git log --oneline` for the existing
tone. One logical change per commit where practical.

## PR checklist

- [ ] `npm test` passes
- [ ] `npm run build` succeeds if you touched `src/` or `rollup.config.js`
- [ ] New signal-processing logic has a synthetic test case, not just a
      real-log fixture
- [ ] README/API reference updated if you changed constructor options,
      methods, or the metrics object shape
- [ ] No new runtime dependency added without discussing it first (the
      long-term plan is a zero-dependency core — see the Roadmap in
      README.md)
