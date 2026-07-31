#!/usr/bin/env python
"""
Does the generated optic actually have a HOLE in it?

WHY THIS EXISTS
---------------
The player asked to be able to look through the scope. `carbine.glb` (M2) has a
beautifully modelled red-dot sight with no aperture: Tripo modelled the SHAPE of
an optic, and a shape is not a hole. `carbine_optic.glb` (M3) re-generates with a
prompt that says "hollow", "open tube", "see-through", "the hole is empty air"
about six different ways.

Whether that WORKED is not a thing to decide by looking at a render, because a
dark recess and a hole look identical from the front. It is a geometry question
with a geometry answer: **fire rays down the sight line and count how many
triangles they cross.** Through a real aperture the count is zero. Through a
solid block it is two (front face, back face) or more.

    babble-games-backend/ec2/venv/bin/python assetgen/aperture.py <model.glb>

Reports a grid map of the optic's cross-section so a partial or off-centre hole
is visible rather than averaged away, and exits non-zero if there is no aperture.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

COMPONENT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path: Path):
    raw = path.read_bytes()
    assert raw[:4] == b"glTF", "not a GLB"
    json_len = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20 : 20 + json_len])
    off = 20 + json_len
    bin_len = struct.unpack_from("<I", raw, off)[0]
    blob = raw[off + 8 : off + 8 + bin_len]
    return gltf, blob


def read_accessor(gltf, blob, index):
    acc = gltf["accessors"][index]
    bv = gltf["bufferViews"][acc["bufferView"]]
    fmt = COMPONENT[acc["componentType"]]
    n = NCOMP[acc["type"]]
    size = struct.calcsize(fmt)
    stride = bv.get("byteStride") or size * n
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    out = np.empty((acc["count"], n), dtype=np.float64 if fmt == "f" else np.int64)
    for i in range(acc["count"]):
        base = start + i * stride
        out[i] = struct.unpack_from("<" + fmt * n, blob, base)
    return out


def collect(gltf, blob):
    """All triangles in the file, in scene space (node transforms applied)."""
    verts, tris = [], []
    base = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            p = read_accessor(gltf, blob, prim["attributes"]["POSITION"]).astype(np.float64)
            idx = read_accessor(gltf, blob, prim["index"] if "index" in prim else prim["indices"])
            idx = idx.reshape(-1)
            verts.append(p)
            tris.append(idx.reshape(-1, 3) + base)
            base += len(p)
    return np.concatenate(verts), np.concatenate(tris)


def ray_hits(origins, direction, V, F):
    """Möller–Trumbore, vectorised over triangles for each origin.

    Returns the number of triangle crossings per origin."""
    v0, v1, v2 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    e1, e2 = v1 - v0, v2 - v0
    h = np.cross(direction, e2)
    a = np.einsum("ij,ij->i", e1, h)
    live = np.abs(a) > 1e-12
    counts = []
    for o in origins:
        s = o - v0
        u = np.einsum("ij,ij->i", s, h) / np.where(live, a, 1.0)
        q = np.cross(s, e1)
        v = (q @ direction) / np.where(live, a, 1.0)
        t = np.einsum("ij,ij->i", e2, q) / np.where(live, a, 1.0)
        ok = live & (u >= 0) & (u <= 1) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
        counts.append(int(ok.sum()))
    return np.array(counts)


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "assetgen/out/carbine_optic.glb")
    gltf, blob = load_glb(path)
    V, F = collect(gltf, blob)
    print(f"{path.name}: {len(V)} verts, {len(F)} triangles")

    lo, hi = V.min(axis=0), V.max(axis=0)
    size = hi - lo
    # The BARREL AXIS is the longest bounding-box axis — measured, because this
    # generation came back with its long axis on X while the previous one used Z.
    axis = int(np.argmax(size))
    names = "XYZ"
    print(f"bounds {np.round(lo,3)} .. {np.round(hi,3)}   barrel axis = {names[axis]}")

    up = 1  # Y is up in glTF
    lat = 3 - axis - up if axis != up else 0  # the remaining axis

    # THE OPTIC: the topmost cluster, in the middle third along the barrel. Same
    # normalised-region idea the runtime fit uses, so the two cannot disagree
    # about what "the optic" means.
    v = (V[:, up] - lo[up]) / size[up]
    w = (V[:, axis] - lo[axis]) / size[axis]
    sel = (v > 0.72) & (w > 0.33) & (w < 0.72)
    if sel.sum() < 20:
        print("no optic region found")
        return 2
    O = V[sel]
    print(f"optic region: {sel.sum()} verts, "
          f"{names[up]} {O[:,up].min():.3f}..{O[:,up].max():.3f}, "
          f"{names[axis]} {O[:,axis].min():.3f}..{O[:,axis].max():.3f}, "
          f"{names[lat]} {O[:,lat].min():.3f}..{O[:,lat].max():.3f}")

    # Fire a grid of rays ALONG the barrel axis through the optic's cross-section,
    # starting behind it (the shooter's eye) and travelling downrange.
    direction = np.zeros(3)
    direction[axis] = -1.0 if True else 1.0
    start = O[:, axis].max() + 0.05  # behind the rear face

    N = 15
    ys = np.linspace(O[:, up].min(), O[:, up].max(), N)
    xs = np.linspace(O[:, lat].min(), O[:, lat].max(), N)
    grid = np.zeros((N, N), dtype=int)
    origins = []
    for iy, y in enumerate(ys):
        for ix, x in enumerate(xs):
            o = np.zeros(3)
            o[axis] = start
            o[up] = y
            o[lat] = x
            origins.append(o)
    counts = ray_hits(np.array(origins), direction, V, F)
    grid = counts.reshape(N, N)

    print("\ncross-section, rays fired down the sight line "
          "(. = CLEAR, digit = triangles crossed):")
    print("   " + "".join("-" for _ in range(N)))
    for iy in range(N - 1, -1, -1):
        row = "".join("." if grid[iy, ix] == 0 else str(min(9, grid[iy, ix])) for ix in range(N))
        print(f"  |{row}|")
    print("   " + "".join("-" for _ in range(N)))

    clear = int((grid == 0).sum())
    total = grid.size
    print(f"\nclear rays: {clear}/{total} of the sampled box")

    # THE VERDICT NEEDS THE RIGHT QUESTION, and the first version of this file
    # asked the wrong one.
    #
    # It counted clear rays in the middle of the SAMPLE BOX and passed on four or
    # more. But the sample box is a rectangle around an optic that is not
    # rectangular, so its corners are clear for every object ever modelled — and
    # a solid tube duly scored 18 clear "inner" rays and was declared OPEN. A
    # gate that passes the exact artefact it was written to catch is worse than
    # no gate, so:
    #
    # An APERTURE is a clear region at the CENTRE OF THE MATERIAL — a hole in the
    # doughnut, not space beside it. So: find the centroid of the cells that DID
    # hit something (that is where the optic body is), and ask whether the rays
    # through that centroid pass clean.
    hit = grid > 0
    if not hit.any():
        print("VERDICT: nothing in the sight line at all — region rule is wrong.")
        return 2
    iy, ix = np.nonzero(hit)
    cy, cx = int(round(iy.mean())), int(round(ix.mean()))
    r = 2
    core = grid[max(0, cy - r) : cy + r + 1, max(0, cx - r) : cx + r + 1]
    core_clear = int((core == 0).sum())
    print(f"optic body centre at grid ({cy}, {cx}); "
          f"{core_clear}/{core.size} rays through its core are clear")
    if core_clear >= core.size * 0.5:
        print("VERDICT: OPEN APERTURE — the sight can be looked through.")
        return 0
    print("VERDICT: SOLID — no through-hole. The optic must be authored.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
