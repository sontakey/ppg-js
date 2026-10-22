# HRV Spot Check / Pulse Painting split

The reference demo restores the structure of `5621c7e4e65461c153ec4bab773d02c004a8b65d`
(the last commit before the initial Pulse on Paper design), with a light ChatPPG
skin and the current lifecycle/correctness fixes retained. DSP/HRV/core algorithms
are unchanged by the split.

Pulse Painting was extracted from `732e1ef51f76bce9145bb7f666f92a30be5e0181` into
<https://github.com/sontakey/pulsepainting>. Its existing camera artwork app,
graphics assets, tests and design documents are owned by that repository.
Landscape generation and the zoom-out reveal are design work, not features of
this reference demo.

## Runtime and host contract

- Source: `examples/app/index.html`, `app.js`, `app.css`.
- Local font: `examples/app/fonts/dm-sans-latin.woff2` plus its OFL license.
- Library global: `examples/demo/dist/ppg.global.js`, built by `npm run build`.
- HTML title: `HRV Spot Check`.
- Public reference: <https://chatppg.com/ppg-js-demo>.
- Separate creative app: <https://chatppg.com/pulse-painting>.
- ChatPPG's host publisher versions the app and library assets atomically; no
  painting GPU, portrait, dock script or QR asset is required here.

## Verification

```sh
npm run build
npm test
npm run test:e2e
npm run test:app
npm run test:safari-session
```

`test:app` exercises the real engine with mocked camera I/O: live values, report
parity, numeric graph bounds at 320–1440px, print, no usable data, quality
withholding, duplicate starts, camera denial and late grants after cancel.
`test:safari-session` runs 180 active seconds in desktop WebKit with camera-frame,
main-thread and visibility interruptions. Physical iPhone acceptance remains a
separate task.

`docs/media` contains direct screenshots and provenance. `examples/legacy-ui/`
is unrelated untracked local work and was left untouched.

## Release state

Source version 0.3.1 is prepared. npm latest remains 0.3.0 because the user chose
to leave publication pending after authentication failed. Do not imply that
source version 0.3.1 has been published.
