#!/usr/bin/env python
"""
STANDALONE auto-rig + animation driver for the Operation Nightfall soldier.

Hand-assembles three pieces of the backend's asset pipeline WITHOUT running the
pipeline: the bpy sidecar's autorig scripts, the CC0 animation library, and the
sidecar's native clip-apply. Nothing in the backend repo is modified; the sidecar
scripts are invoked as plain subprocesses with the sidecar's own interpreter.

    T-pose gate  ->  derive_landmarks  ->  build_rig  ->  native_apply xN  ->  strip_to_animation xN
                     (silhouette)         (fit+skin)     (copy clip)          (rename + drop mesh)

Output (into `public/models/`):
    soldier.glb            rigged mesh, no animation   <- the base the runtime clones
    soldier_<clip>.glb     one clip each, animations[0].name === <clip>

Run with the SIDECAR interpreter (bpy 5.2), from anywhere:
    babble-games-backend/ec2/bpy-sidecar/.venv/bin/python assetgen/rig_soldier.py
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

BACKEND = Path("/Users/dshah/Chatforce/babble-games-backend/ec2")
PY = BACKEND / "bpy-sidecar" / ".venv" / "bin" / "python"
AR = BACKEND / "bpy-sidecar" / "scripts" / "autorig"
SC = BACKEND / "bpy-sidecar" / "scripts"
LIB = BACKEND / "app" / "game_generation" / "agentic" / "animation_library"

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assetgen" / "out" / "enemy_soldier.glb"
WORK = ROOT / "assetgen" / "rigwork"
DEST = ROOT / "public" / "models"

# ---------------------------------------------------------------------------
# CLIP MAP — semantic game state -> CC0 library file.
#
# The library has NO semantic-name table (no "idle" -> file mapping exists), and
# its tag vocabulary lumps all locomotion into one bucket, so this mapping is a
# HAND CHOICE and belongs in the decision log rather than in a lookup.
#
# There is no RIFLE clip in the library at all — the entire two-handed ranged set
# is bow + pistol. `Pistol_Idle` is the closest readable "weapon up, braced,
# breathing" pose for a soldier holding a carbine, and it is a real 51-frame
# cycle rather than a 6-frame static pose, so an aiming soldier is still alive on
# screen. That mismatch is accepted deliberately and recorded.
# ---------------------------------------------------------------------------
CLIPS = {
    "idle":  "Idle_A",             # 3.13 s, 76 f — patrol standing
    "walk":  "Walk",               # 1.67 s, 41 f — patrol move
    "run":   "Jog",                # 1.17 s, 28 f — advance/reposition
    "aim":   "Pistol_Idle",        # 2.08 s, 51 f — halt/aim/fire braced pose
    "fire":  "Pistol_Shoot",       # recoil punch, played over the aim pose
    "death": "Death_B",            # 1.83 s — snappier than Death_A (4.46 s)
}

MARK = re.compile(r"^(\w+_RESULT|GATE_JSON)\s+(\{.*\})\s*$", re.M)


def run(script: Path, *args: str, timeout: int = 300) -> tuple[str, dict | None]:
    """Invoke a sidecar script exactly the way `bpy_sidecar.run_script` does —
    the sidecar's own interpreter, cwd + TMPDIR pinned to the workdir — and pull
    the `*_RESULT {json}` marker line off stdout."""
    cmd = [str(PY), str(script), *[str(a) for a in args]]
    print(f"  $ {script.name} {' '.join(str(a) for a in args[:2])} ...")
    p = subprocess.run(
        cmd, cwd=str(WORK), capture_output=True, text=True, timeout=timeout,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home()),
             "TMPDIR": str(WORK), "TEMP": str(WORK), "TMP": str(WORK)},
    )
    out = p.stdout + p.stderr
    m = None
    for match in MARK.finditer(p.stdout):
        try:
            m = json.loads(match.group(2))
        except json.JSONDecodeError:
            pass
    if p.returncode != 0:
        print(out[-2500:])
        raise SystemExit(f"{script.name} exited {p.returncode}")
    return out, m


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} — run tripo_gen.py character first")
    WORK.mkdir(parents=True, exist_ok=True)
    DEST.mkdir(parents=True, exist_ok=True)
    report: dict = {"clips": {}, "source_bytes": SRC.stat().st_size}
    t0 = time.time()

    # 0. Sidecar liveness. Cheap, and it separates "my rig is bad" from "bpy is
    #    broken" — the two failure modes look identical from a stack trace.
    print("[0] sidecar health check")
    run(SC / "health_check.py", WORK / "health.json", timeout=180)

    # 1. T-POSE GATE on the raw generated mesh, BEFORE any rig work.
    #    The landmark deriver reads a T-pose SILHOUETTE; if Tripo drifted to an
    #    A-pose the derived shoulders/elbows are wrong and everything downstream
    #    is quietly wrong too. Gate first, spend time second.
    print("[1] T-pose silhouette gate")
    _, gate = run(SC / "tpose_gate.py", SRC.resolve(), "soldier", timeout=300)
    report["tpose_gate"] = gate
    if gate:
        print(f"    usable={gate.get('usable')} score={gate.get('score')} "
              f"span={gate.get('span_ratio')} droop={gate.get('avg_droop_deg')}")

    # 2. Species template — the canonical 66-joint m2m human skeleton. This is the
    #    SAME skeleton the clips were authored on, which is the whole reason the
    #    clips can be copied natively instead of retargeted.
    tpl = WORK / "human_template.glb"
    shutil.copy(LIB / "skeletons" / "human.glb", tpl)

    # 3. Landmarks from the silhouette (no pre-existing skeleton needed).
    print("[2] derive landmarks")
    lm = WORK / "landmarks.json"
    _, lmres = run(AR / "derive_landmarks.py", SRC.resolve(), lm, timeout=300)
    report["landmarks"] = lmres
    if lmres and not lmres.get("ok", True):
        raise SystemExit(f"landmark contract violated: {lmres}")

    # 4. Fit + skin onto the canonical skeleton.
    print("[3] build rig")
    rigged = DEST / "soldier.glb"
    _, build = run(AR / "build_rig.py", SRC.resolve(), lm, "a_robust",
                   rigged.resolve(), tpl, "human", timeout=600)
    report["build"] = build
    if build and not build.get("ok", True):
        raise SystemExit(f"build_rig refused: {build.get('reason')} — {build}")
    if not rigged.exists():
        raise SystemExit("build_rig wrote no GLB")
    print(f"    rigged {rigged.stat().st_size // 1024} KB  "
          f"weights {(rigged.with_suffix('.glb.weights.npz')).exists()}")

    # 5. Rest-pose render — the cheapest possible proof that the skin bound sanely.
    print("[4] render rest pose")
    run(SC / "render_rest.py", rigged.resolve(), WORK / "rest", timeout=600)

    # 6. Apply each clip natively, then slim it to a named animation-only GLB.
    #    native_apply names the action `copy_<name>`, so the strip step is what
    #    actually makes `animations[0].name === 'walk'` for the AnimationMixer.
    for name, clip_file in CLIPS.items():
        src_clip = LIB / "clips" / "human" / f"{clip_file}.glb"
        if not src_clip.exists():
            print(f"[!] {name}: missing library clip {src_clip.name} — skipped")
            continue
        print(f"[5] apply {name} <- {clip_file}")
        full = WORK / f"soldier_{name}.full.glb"
        _, ares = run(AR / "native_apply.py", rigged.resolve(), src_clip, name,
                      full, timeout=900)
        out = DEST / f"soldier_{name}.glb"
        run(SC / "strip_to_animation.py", full, out.resolve(), name, timeout=300)
        report["clips"][name] = {
            "library_clip": clip_file,
            "frames": (ares or {}).get("frames"),
            "shared_bones": (ares or {}).get("shared_bones"),
            "bytes": out.stat().st_size if out.exists() else 0,
        }
        print(f"    -> {out.name} {out.stat().st_size // 1024} KB "
              f"({(ares or {}).get('frames')} frames, "
              f"{(ares or {}).get('shared_bones')} shared bones)")

    # 7. Confirm the shipped clip names are what the runtime will look up. A clip
    #    named `copy_walk` when the code asks for `walk` is a silent no-animation
    #    bug, so it is verified here rather than discovered in the browser.
    print("[6] verify clip names")
    for name in report["clips"]:
        out = DEST / f"soldier_{name}.glb"
        info = WORK / f"{name}.analysis.json"
        run(SC / "analyze_glb.py", out.resolve(), info, timeout=300)
        data = json.loads(info.read_text())
        got = [c["name"] for c in data.get("clips", [])]
        report["clips"][name]["clip_names"] = got
        ok = got == [name]
        print(f"    {name:6s} animations={got} {'OK' if ok else 'MISMATCH'}")
        report["clips"][name]["name_ok"] = ok

    report["seconds"] = round(time.time() - t0, 1)
    (DEST / "soldier.receipt.json").write_text(json.dumps(report, indent=2))
    bad = [n for n, c in report["clips"].items() if not c.get("name_ok")]
    print(f"\n=== rigged + {len(report['clips'])} clips in {report['seconds']}s; "
          f"name mismatches: {bad or 'none'} ===")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
