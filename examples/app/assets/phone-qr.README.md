# Phone QR asset

Encodes exactly `https://chatppg.com/ppg-js-demo`.

The fixed version-3 (29 × 29) matrix was originally generated with Python
`qrcode` 8.2 (BSD-3-Clause), error correction Q. Regenerate its presentation with
`python3 tools/generate-phone-qr.py`; that script uses only the standard library.
There is no encoder code, animation or runtime dependency in the image.

The four-module quiet zone on every side is solid warm paper (`#fffdf8`). All
finder, timing, alignment and format patterns remain square and solid indigo.
Only exposed outside corners of data modules are softened (0.12 module radius);
adjacent dark modules remain joined. A dark indigo–iris–teal ink gradient and
frozen granulation stay inside dark data modules. Pigment overlays do not punch
holes or lighten the pattern substantially. No distortion or filter touches
the encoded geometry or quiet zone.

CSS paints the surrounding frame once, then settles. The image itself stays
fully visible and stationary, including during that entrance. Reduced motion
disables the wash animation. Keep decorative filters outside the image and
retain its clean background and quiet zone when changing the surrounding card.
The surrounding `phone-wash.webp` is frozen pigment artwork, built by running
`python3 tools/generate-phone-wash.py` followed by
`node tools/rasterize-phone-wash.mjs`. Seeded geometry and SVG pigment filters
are evaluated once during authoring and rasterized to a cached image. No
procedural filter or painting loop is shipped. The texture stays independent
from the encoded image.

`test/e2e/qr-checks.mjs` captures the actual rendered image in Chromium and
WebKit, then `test/e2e/decode-phone-qr.py` uses OpenCV to decode the URL across
sizes, grayscale, blur, contrast and perspective variants. These browser/image
checks are reproducible scan evidence; they do not replace physical phone-camera
acceptance.

`node test/e2e/qr-readability-checks.mjs` samples the actual rendered pigment
under every character's DOM bounds after hiding only the text. It checks
WCAG AA contrast at 320, 634 and 1440 pixels, and verifies a fresh iPhone
context does not request either desktop artwork asset. This helper uses Pillow
and numpy for pixel analysis; set `PPG_QR_URL` for a preview or deployed URL.
