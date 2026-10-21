"""Generate the deterministic source for a frozen pigment-wash background.

Run this before tools/rasterize-phone-wash.mjs. The source filter is evaluated
once during asset authoring; production uses WebP with no procedural filters.
"""
from math import cos, sin, pi
from pathlib import Path
import random

rng = random.Random(210726)


def roughen(points, amount, passes=3):
    for _ in range(passes):
        expanded = []
        for i, a in enumerate(points):
            b = points[(i + 1) % len(points)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = (dx * dx + dy * dy) ** .5 or 1
            offset = rng.uniform(-amount, amount)
            expanded.extend([a, ((a[0] + b[0]) / 2 - dy / length * offset,
                                 (a[1] + b[1]) / 2 + dx / length * offset)])
        points, amount = expanded, amount * .53
    return points


def polygon(points):
    return "M" + "L".join(f"{x:.0f} {y:.0f}" for x, y in points) + "Z"


def pool(cx, cy, rx, ry):
    angles = [i * pi / 6 for i in range(12)]
    points = [(cx + cos(a) * rx * rng.uniform(.78, 1.12),
               cy + sin(a) * ry * rng.uniform(.78, 1.12)) for a in angles]
    return polygon(roughen(points, min(rx, ry) * .13, 1 if min(rx, ry) < 9 else 2))


def render():
    # Multiple corners on every side avoid a geometric rectangle even at wide
    # layouts. Fine displacement has a frozen seed and a consistent scale.
    outline = [(x, 16 + rng.uniform(-2.4, 2.4)) for x in range(18, 584, 14)]
    outline += [(584 + rng.uniform(-2.4, 2.4), y) for y in range(18, 662, 14)]
    outline += [(x, 664 + rng.uniform(-2.4, 2.4)) for x in range(584, 16, -14)]
    outline += [(16 + rng.uniform(-2.4, 2.4), y) for y in range(664, 16, -14)]
    edge = polygon(roughen(outline, 3.8, 2))
    grain_rng = random.Random(375)
    grain_light, grain_dark = [], []
    for i in range(780):
        x, y, r = grain_rng.uniform(0, 128), grain_rng.uniform(0, 128), grain_rng.uniform(.18, .8)
        fleck = f'M{x:.1f} {y:.1f}l{r:.1f} {r*.4:.1f}l{-r*.4:.1f} {r:.1f}l{-r:.1f} {-r*.5:.1f}z'
        (grain_light if i % 2 else grain_dark).append(fleck)
    parts = [f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 680" preserveAspectRatio="none">
<defs>
 <linearGradient id="paper-wash" x2="1" y2=".55"><stop stop-color="#5586ec" stop-opacity=".42"/><stop offset=".48" stop-color="#b7d0f4" stop-opacity=".3"/><stop offset="1" stop-color="#48a9bf" stop-opacity=".4"/></linearGradient>
 <clipPath id="wash-edge"><path d="{edge}"/></clipPath>
 <pattern id="pigment-grain" width="128" height="128" patternUnits="userSpaceOnUse"><path d="{''.join(grain_light)}" fill="#fffdf8" opacity=".3"/><path d="{''.join(grain_dark)}" fill="#4569a6" opacity=".14"/></pattern>
 <filter id="watercolor" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency=".043" numOctaves="3" seed="37" result="bloom"/>
  <feDisplacementMap in="SourceGraphic" in2="bloom" scale="19" xChannelSelector="R" yChannelSelector="G" result="pigment"/>
  <feColorMatrix in="bloom" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 2.2 0 0 0 -.65" result="depth"/>
  <feComposite in="pigment" in2="depth" operator="in" result="granulation"/>
  <feComponentTransfer in="pigment" result="base"><feFuncA type="linear" slope=".7"/></feComponentTransfer>
  <feMerge result="wash"><feMergeNode in="base"/><feMergeNode in="granulation"/></feMerge>
  <feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="24" result="tooth"/>
  <feColorMatrix in="tooth" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .6 0 0 0 .6" result="paper"/>
  <feComposite in="wash" in2="paper" operator="in"/>
 </filter>
</defs>
<g filter="url(#watercolor)">
<path d="{edge}" fill="url(#paper-wash)"/>
<g clip-path="url(#wash-edge)">''']
    # Overlapping jagged washes create pigment blooms across several scales.
    # Concentrated pigment stays near the perimeter, leaving copy calm.
    fields = [(20, 110, 110, 140, '#315fcb'), (50, 440, 150, 150, '#315fd8'),
              (140, 560, 140, 130, '#3f62d7'), (410, 550, 155, 145, '#168a9e'),
              (560, 330, 120, 180, '#4f9fb4'), (570, 620, 160, 140, '#4b9d9c'),
              (500, 55, 180, 90, '#8e88c2'), (270, 675, 170, 100, '#7494ca')]
    for cx, cy, rx, ry, color in fields:
        for layer in range(5):
            scale = 1.45 - layer * .17
            parts.append(f'<path d="{pool(cx,cy,rx*scale,ry*scale)}" fill="{color}" opacity=".045"/>')
    for _ in range(135):
        cx, cy = rng.uniform(0, 600), rng.uniform(0, 680)
        radius = rng.uniform(13, 46)
        # Tiny translucent paper-shaped lakes, not opaque noise stipples.
        parts.append(f'<path d="{pool(cx,cy,radius,radius*rng.uniform(.65,1.4))}" fill="#fffdf8" opacity="{rng.uniform(.015,.05):.3f}"/>')
    for _ in range(140):
        cx, cy = rng.uniform(0, 600), rng.uniform(0, 680)
        parts.append(f'<path d="{pool(cx,cy,rng.uniform(2,8),rng.uniform(2,8))}" fill="#516ea7" opacity=".026"/>')
    parts += ['<path d="M0 0h600v680H0z" fill="url(#pigment-grain)"/>', '</g>', f'<path d="{edge}" fill="none" stroke="#638cc2" stroke-width=".65" opacity=".13"/>', '</g>', '</svg>']
    return '\n'.join(parts) + '\n'


if __name__ == '__main__':
    target = Path(__file__).resolve().parents[1] / '.dream-loop/phone-wash-source.svg'
    target.parent.mkdir(exist_ok=True)
    target.write_text(render())
    print(f'Wrote {target} ({target.stat().st_size} bytes)')
