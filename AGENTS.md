# Repository boundaries

Use `rtk` for shell commands. Preserve unrelated untracked work.

- This repository owns the dependency-free `@sontakey/ppg-js` library and the
  focused HRV Spot Check reference demo in `examples/app`.
- Pulse Painting is a separate product: <https://github.com/sontakey/pulsepainting>.
  Its painting renderer, artwork features and landscape concepts belong there.
- Keep the reference demo's four-screen camera, waveform, metrics and report
  flow. Use the light ChatPPG skin; do not add brush fonts or decorative renderers.
- Preserve camera cancellation/recovery, fresh-frame countdown, quality gating,
  real beat timestamps and readable graph labels when editing the demo.
- Browser replay is not physical-device, physiological-accuracy or native-share
  validation. Report those scopes separately.
- npm 0.3.1 is prepared but publication was explicitly left pending. Do not
  publish a package or release tag without a new user instruction.

See `HANDOFF.md` for the split, deployment contract and verification commands.
