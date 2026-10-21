"""Decode browser-rendered QR images and bounded camera-like perturbations.

Development-only dependencies: OpenCV and numpy. No image or data leaves the
machine. These checks do not claim physical camera or native scanner coverage.
"""
import json
from pathlib import Path
import sys

import cv2
import numpy as np


def variants(image):
    yield "rendered", image
    for width in (228, 180, 160, 128):
        yield f"size-{width}", cv2.resize(image, (width, width), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    yield "grayscale", gray
    yield "soft-focus-0.55px", cv2.GaussianBlur(image, (3, 3), .55)
    yield "reduced-contrast-60pct", np.uint8(image.astype(float) * .6 + 90)
    h, w = image.shape[:2]
    # Modest perspective convergence, preserving a camera-visible paper margin.
    src = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    dst = np.float32([[w * .05, 0], [w * .95, h * .06],
                      [w - 1, h * .96], [0, h - 1]])
    yield "perspective-6pct", cv2.warpPerspective(image, cv2.getPerspectiveTransform(src, dst),
                                                (w, h), borderValue=(248, 253, 255))
    transform = cv2.getRotationMatrix2D((w / 2, h / 2), 12, .9)
    yield "rotation-12deg", cv2.warpAffine(image, transform, (w, h), borderValue=(248, 253, 255))


def main():
    manifest_path = Path(sys.argv[1])
    manifest = json.loads(manifest_path.read_text())
    detector = cv2.QRCodeDetector()
    results = []
    for capture in manifest["captures"]:
        image = cv2.imread(capture["file"])
        if image is None:
            raise RuntimeError(f"Cannot read {capture['file']}")
        # Ignore the single outside CSS corner pixel; the entire internal quiet
        # zone must be untextured, unpainted paper on all four edges.
        border = int(image.shape[0] * 4 / 37) - 1
        strips = [image[1:border, 1:-1], image[-border:-1, 1:-1],
                  image[1:-1, 1:border], image[1:-1, -border:-1]]
        expected = np.array([248, 253, 255], dtype=np.int16)
        quiet_zone = all(np.max(np.abs(strip.astype(np.int16) - expected)) <= 2 for strip in strips)
        if not quiet_zone:
            raise AssertionError(f"Quiet zone contains decoration: {capture['name']}")
        for name, variant in variants(image):
            decoded, points, _ = detector.detectAndDecode(variant)
            passed = decoded == manifest["expectedURL"]
            results.append({"capture": capture["name"], "variant": name,
                            "width": variant.shape[1], "decoded": decoded, "passed": passed})
            if not passed:
                cv2.imwrite(str(manifest_path.parent / f"failed-{capture['name']}-{name}.png"), variant)
    # A full rendered card also needs to decode with its painted surround.
    for capture in manifest.get("cards", []):
        decoded, _, _ = detector.detectAndDecode(cv2.imread(capture["file"]))
        results.append({"capture": capture["name"], "variant": "painted-surround",
                        "decoded": decoded, "passed": decoded == manifest["expectedURL"]})
    output = {"decoder": f"OpenCV {cv2.__version__}", "scope": "Rendered browser pixels and bounded image perturbations; no physical camera test",
              "passed": all(r["passed"] for r in results), "checks": results}
    (manifest_path.parent / "decode-result.json").write_text(json.dumps(output, indent=2) + "\n")
    print(f"QR decode: {sum(r['passed'] for r in results)}/{len(results)} passed")
    for result in results:
        if not result["passed"]:
            print(json.dumps(result))
    if not output["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
