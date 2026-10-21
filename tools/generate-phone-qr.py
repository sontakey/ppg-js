"""Render the fixed phone handoff QR as a static, subtly inked SVG.

No encoder or SVG filter is shipped to the browser. This is the original
version-3 / error-correction-Q matrix generated with qrcode 8.2, for the URL
below. Keep the fixed pattern rather than making QR generation a runtime job.
"""
from pathlib import Path
import random

URL = "https://chatppg.com/ppg-js-demo"
MATRIX = """11111110101001001011101111111
10000010010001011010101000001
10111010011101000000101011101
10111010010100001101001011101
10111010101001010001101011101
10000010100000010000001000001
11111110101010101010101111111
00000000010110011010000000000
01111111010010101101000110001
00101000000000011011011111101
01010111111101111000111011100
00111101110010101011011011010
00110011011101010100010100111
10101100001000001001111011011
00101010100000011000100100000
00001101000011011001001011001
11001111110110000100110101110
11100000000000011011111111111
10101110010111100010001011000
10010100111001101011001010001
10001111101110100101111110101
00000000111101000100100011011
11111110101101111001101010000
10000010101001101001100011011
10111010110000010100111111101
10111010110100110011110101100
10111010100111011011111111110
10000010100001101010101011010
11111110000010100101000011100""".splitlines()
DARK = {(x, y) for y, row in enumerate(MATRIX) for x, v in enumerate(row) if v == "1"}


def functional(x, y):
    # Finder, separator, timing, format, dark module and alignment patterns.
    return ((x <= 8 and y <= 8) or (x >= 20 and y <= 8)
            or (x <= 8 and y >= 20) or x == 6 or y == 6
            or (20 <= x <= 24 and 20 <= y <= 24))


def module_path(x, y):
    # Only exposed outside corners soften. Adjoining modules remain joined;
    # no shrinking, pale gaps, distortion or filter touches the QR geometry.
    corners = [((-1, 0), (0, -1)), ((1, 0), (0, -1)),
               ((1, 0), (0, 1)), ((-1, 0), (0, 1))]
    tl, tr, br, bl = [0.12 if all((x + dx, y + dy) not in DARK for dx, dy in pair) else 0
                      for pair in corners]
    x, y = x + 4, y + 4
    if not any((tl, tr, br, bl)):
        return f"M{x} {y}h1v1h-1z"
    return (f"M{x+tl:g} {y}H{x+1-tr:g}Q{x+1} {y} {x+1} {y+tr:g}"
            f"V{y+1-br:g}Q{x+1} {y+1} {x+1-br:g} {y+1}"
            f"H{x+bl:g}Q{x} {y+1} {x} {y+1-bl:g}"
            f"V{y+tl:g}Q{x} {y} {x+tl:g} {y}Z")


def render():
    fixed, painted = [], []
    for x, y in sorted(DARK, key=lambda p: (p[1], p[0])):
        if functional(x, y):
            fixed.append(f"M{x+4} {y+4}h1v1h-1z")
        else:
            painted.append(module_path(x, y))
    ink = "".join(painted)
    rng = random.Random(21)
    # Frozen overprints suggest paper granulation. The underlying pigment is
    # always solid and dark; these overlays never remove any encoded mark.
    grain = "".join(f'<circle cx="{rng.uniform(4,33):.2f}" cy="{rng.uniform(4,33):.2f}" '
                    f'r="{rng.uniform(.035,.11):.3f}"/>' for _ in range(180))
    bristles = "".join(f'<path d="M4 {y:.2f}q14 -.18 29 .03"/>'
                       for y in [4.37 + i * .63 for i in range(46)])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37">
<title>{URL}</title>
<desc>Indigo ink QR code. The four-module paper border and all scan markers are preserved.</desc>
<defs>
  <linearGradient id="ink" x1="0" y1="0" x2="1" y2=".85">
    <stop stop-color="#173669"/><stop offset=".5" stop-color="#343362"/><stop offset="1" stop-color="#174a52"/>
  </linearGradient>
  <path id="ink-shape" d="{ink}"/>
  <clipPath id="pigment"><use href="#ink-shape"/></clipPath>
</defs>
<path fill="#fffdf8" d="M0 0h37v37H0z"/>
<use href="#ink-shape" fill="url(#ink)"/>
<g clip-path="url(#pigment)">
  <g fill="#8297ab" opacity=".16">{grain}</g>
  <g fill="none" stroke="#0f244b" stroke-width=".045" opacity=".2">{bristles}</g>
</g>
<path fill="#182e56" d="{"".join(fixed)}"/>
</svg>
'''


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[1] / "examples/app/assets/phone-qr.svg"
    target.write_text(render())
    print(f"Wrote {target} ({target.stat().st_size} bytes)")
