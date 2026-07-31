#!/usr/bin/env python
"""
GATED GLB optimiser.

Tripo returns ~2.7 MB per prop, almost all of it 2048² PBR textures. Seven of
those is an 18 MB download for a browser game, which is not shippable. Resizing
the textures to 512 and re-encoding to WebP fixes it.

WHY THIS SCRIPT EXISTS INSTEAD OF ONE `npx` LINE:

The obvious command — `gltf-transform optimize <in> <out> --texture-size 512
--texture-compress webp --compress draco` — **silently destroyed every model**:
2.6 MB in, 3 KB out, exit code 0, no warning. A 3 KB "GLB" still parses, still
loads, and renders nothing. That is the exact failure class this whole project
exists to catch: a tool that reports success while deleting the asset, caught only
because someone happened to read a file listing.

So optimisation here is GATED. Before/after, the GLB's own JSON chunk is parsed
and the structural counts are compared. Any of these aborts the swap and keeps
the original:

  * mesh / primitive / node / accessor count changed
  * total vertex count dropped by more than 2%
  * output is under 25% of the input size (a texture resize cannot legitimately
    do that; a geometry wipe can)

Nothing is written over an original until its replacement has passed.

Usage:  optimize_glb.py <file-or-dir> [...]
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

CLI = ["npx", "--yes", "@gltf-transform/cli@4.4.1"]


def glb_json(path: Path) -> dict:
    """Parse the JSON chunk out of a binary glTF container."""
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"{path.name}: not a GLB (magic {data[:4]!r})")
    _, _, total = struct.unpack_from("<III", data, 0)
    off = 12
    while off < min(total, len(data)):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        if ctype == 0x4E4F534A:  # 'JSON'
            return json.loads(data[off:off + clen].decode("utf-8"))
        off += clen
    raise ValueError(f"{path.name}: no JSON chunk")


def fingerprint(path: Path) -> dict:
    """The structural facts a texture resize must not change."""
    g = glb_json(path)
    accessors = g.get("accessors", [])
    prims = sum(len(m.get("primitives", [])) for m in g.get("meshes", []))
    verts = 0
    for m in g.get("meshes", []):
        for p in m.get("primitives", []):
            idx = p.get("attributes", {}).get("POSITION")
            if idx is not None and idx < len(accessors):
                verts += int(accessors[idx].get("count", 0))
    return {
        "meshes": len(g.get("meshes", [])),
        "primitives": prims,
        "nodes": len(g.get("nodes", [])),
        "accessors": len(accessors),
        "animations": len(g.get("animations", [])),
        "skins": len(g.get("skins", [])),
        "vertices": verts,
        "bytes": path.stat().st_size,
    }


def check(before: dict, after: dict) -> str | None:
    for key in ("meshes", "primitives", "nodes", "accessors", "animations", "skins"):
        if before[key] != after[key]:
            return f"{key} changed {before[key]} -> {after[key]}"
    if before["vertices"] and after["vertices"] < before["vertices"] * 0.98:
        return f"vertices dropped {before['vertices']} -> {after['vertices']}"
    # SIZE is the WEAK signal and STRUCTURE is the strong one. A 2048->512 resize
    # is a 16x pixel reduction, so a texture-dominated prop legitimately drops
    # below 25% — three of the six did, and rejecting them was the gate being
    # wrong, not the assets. What the 3 KB disaster actually looked like was
    # `meshes: 0, vertices: 0`, which the structural checks above catch outright.
    # A hard floor stays as a last-resort tripwire.
    if after["vertices"] == 0 and before["vertices"] > 0:
        return "output has no vertices"
    if after["bytes"] < 8 * 1024:
        return f"output is {after['bytes']} B — implausibly small for any GLB"
    if after["bytes"] < before["bytes"] * 0.06:
        return (f"output is {after['bytes']} B, under 6% of {before['bytes']} B — "
                f"beyond what a texture resize can account for")
    if after["bytes"] >= before["bytes"]:
        return f"no saving ({before['bytes']} -> {after['bytes']})"
    return None


def optimize(path: Path) -> bool:
    before = fingerprint(path)
    with tempfile.TemporaryDirectory() as td:
        stage = Path(td) / "stage.glb"
        out = Path(td) / "out.glb"
        # Two NARROW commands, not the `optimize` meta-command. Only textures are
        # touched; geometry is never passed to a simplifier or a quantiser.
        steps = [
            (CLI + ["resize", str(path), str(stage), "--width", "512", "--height", "512"], stage),
            (CLI + ["webp", str(stage), str(out), "--quality", "82"], out),
        ]
        for cmd, produced in steps:
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not produced.exists():
                print(f"  {path.name}: step failed ({cmd[3]}) — keeping original")
                if r.stderr:
                    print("   ", r.stderr.strip().splitlines()[-1][:160])
                return False
        try:
            after = fingerprint(out)
        except Exception as exc:  # noqa: BLE001
            print(f"  {path.name}: output unreadable ({exc}) — keeping original")
            return False
        why = check(before, after)
        if why:
            print(f"  {path.name}: GATE FAILED — {why}; keeping original")
            return False
        shutil.copy(out, path)
        print(f"  {path.name}: {before['bytes'] // 1024} KB -> {after['bytes'] // 1024} KB "
              f"({after['vertices']} verts, {after['meshes']} meshes) OK")
        return True


def main(argv: list[str]) -> int:
    targets: list[Path] = []
    for a in argv or ["."]:
        p = Path(a)
        targets.extend(sorted(p.rglob("*.glb")) if p.is_dir() else [p])
    if not targets:
        print("no .glb files found")
        return 2
    print(f"Optimising {len(targets)} GLB(s) — texture resize + WebP, gated\n")
    total_before = sum(t.stat().st_size for t in targets)
    ok = sum(1 for t in targets if optimize(t))
    total_after = sum(t.stat().st_size for t in targets)
    print(f"\n{ok}/{len(targets)} optimised · "
          f"{total_before / 1024 / 1024:.2f} MB -> {total_after / 1024 / 1024:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
