#!/usr/bin/env python
"""
Measure the sun direction of the downloaded HDRI sky cubemap.

WHY: the single most common "generated game" lighting tell is a sky whose sun is
in one place and a directional light that rakes from somewhere else — the shadows
disagree with the picture and the brain reads it as fake instantly. The pipeline
dissections record exactly this (a staged library sky fighting the coder's own
lighting). So the sun direction is MEASURED off the actual pixels here and pasted
into `src/world/environment.ts` as a constant, not guessed.

Method: find the brightest texel across all six faces, convert its face-local
(u, v) to a world direction using the standard cubemap axis convention, and report
azimuth/elevation. Also reports the sky's mean luminance per face so the exposure
choice has a number behind it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

SKY = Path(__file__).resolve().parent.parent / "public" / "sky"

# Standard cube-map face bases: for face F, direction = fwd + u*right + v*up,
# with u,v in [-1, 1]. This is the OpenGL/WebGL cubemap convention that three.js
# CubeTextureLoader consumes in the order [px, nx, py, ny, pz, nz].
FACES = {
    "px": ((1, 0, 0), (0, 0, -1), (0, -1, 0)),
    "nx": ((-1, 0, 0), (0, 0, 1), (0, -1, 0)),
    "py": ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
    "ny": ((0, -1, 0), (1, 0, 0), (0, 0, -1)),
    "pz": ((0, 0, 1), (1, 0, 0), (0, -1, 0)),
    "nz": ((0, 0, -1), (-1, 0, 0), (0, -1, 0)),
}


def main() -> int:
    manifest = json.loads((SKY / "manifest.json").read_text())
    print(f"template : {manifest['template_id']}")
    print(f"source   : {manifest['attribution']}")
    print(f"preset   : {manifest['lighting_preset']}   manifest exposure: {manifest['exposure']}")
    print()

    best = (-1.0, None, 0, 0, 0)
    stats = []
    for name, (fwd, right, up) in FACES.items():
        img = np.asarray(Image.open(SKY / f"{name}.png").convert("RGB"), dtype=np.float64) / 255.0
        # Relative luminance. The sun disc is the brightest region by a wide margin.
        lum = img @ np.array([0.2126, 0.7152, 0.0722])
        stats.append((name, float(lum.mean()), float(lum.max())))
        # Blur slightly so a single hot pixel does not win over the real disc.
        k = 9
        pad = np.pad(lum, k // 2, mode="edge")
        sm = np.zeros_like(lum)
        for dy in range(k):
            for dx in range(k):
                sm += pad[dy:dy + lum.shape[0], dx:dx + lum.shape[1]]
        sm /= k * k
        idx = int(np.argmax(sm))
        py, px = divmod(idx, lum.shape[1])
        if sm.flat[idx] > best[0]:
            best = (float(sm.flat[idx]), name, px, py, lum.shape[0])

    print("per-face luminance (mean / max):")
    for n, m, mx in sorted(stats, key=lambda s: -s[1]):
        print(f"  {n}  mean {m:.4f}   max {mx:.4f}")
    print()

    score, face, px, py, size = best
    fwd, right, up = (np.array(v, dtype=float) for v in FACES[face])
    u = (px + 0.5) / size * 2 - 1
    v = (py + 0.5) / size * 2 - 1
    d = fwd + u * right + v * up
    d /= np.linalg.norm(d)

    # three.js world frame: +Y up, -Z is the game's "north" (see enemy.ts fwd).
    azimuth = math.degrees(math.atan2(d[0], -d[2]))   # 0 = north (-Z), +ve = east
    elevation = math.degrees(math.asin(d[1]))

    print(f"brightest region : face {face}  texel ({px},{py})  smoothed luminance {score:.4f}")
    print(f"SUN DIRECTION    : ({d[0]:+.4f}, {d[1]:+.4f}, {d[2]:+.4f})")
    print(f"                   azimuth {azimuth:+.1f}deg  elevation {elevation:+.1f}deg")
    print()
    print("Paste into src/world/environment.ts:")
    print(f"  const SUN_DIR = new THREE.Vector3({d[0]:.4f}, {d[1]:.4f}, {d[2]:.4f});")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
