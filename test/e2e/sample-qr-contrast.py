"""Compute worst-case WCAG contrast inside actual rendered text bounds."""
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
from PIL import Image


def luminance(rgb):
    rgb = np.asarray(rgb, dtype=float) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    return np.sum(linear * np.array([.2126, .7152, .0722]), axis=-1)


manifest_path = Path(sys.argv[1])
manifest = json.loads(manifest_path.read_text())
results = []
for capture in manifest['captures']:
    pixels = np.asarray(Image.open(capture['screenshot']).convert('RGB'))
    h, w = pixels.shape[:2]
    for text in capture['text']:
        foreground = [float(value) for value in re.findall(r'[\d.]+', text['color'])[:3]]
        fg = luminance(foreground)
        worst = float('inf')
        pixel_count = 0
        for rect in text['rects']:
            x0, y0 = max(0, math.floor(rect['x'])), max(0, math.floor(rect['y']))
            x1, y1 = min(w, math.ceil(rect['x'] + rect['width'])), min(h, math.ceil(rect['y'] + rect['height']))
            backdrop = pixels[y0:y1, x0:x1]
            if not backdrop.size:
                continue
            bg = luminance(backdrop)
            ratios = (np.maximum(bg, fg) + .05) / (np.minimum(bg, fg) + .05)
            worst = min(worst, float(np.min(ratios)))
            pixel_count += ratios.size
        passed = worst >= text['required'] and pixel_count > 0
        results.append({'viewport': capture['width'], 'selector': text['selector'], 'text': text['text'],
                        'color': text['color'], 'fontSize': text['fontSize'], 'required': text['required'],
                        'minimumContrast': round(worst, 3), 'sampledPixels': pixel_count, 'passed': passed})
        print(f"{capture['width']}px {text['selector']}: {worst:.2f}:1 (requires {text['required']}:1) {'PASS' if passed else 'FAIL'}")
output = {'passed': all(r['passed'] for r in results), 'scope': 'WCAG luminance contrast from browser pixels beneath character DOM bounds',
          'phone': manifest['phone'], 'checks': results}
(manifest_path.parent / 'result.json').write_text(json.dumps(output, indent=2) + '\n')
if not output['passed']:
    raise SystemExit(1)
