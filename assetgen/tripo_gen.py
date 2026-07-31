#!/usr/bin/env python
"""
STANDALONE Tripo driver for Operation Nightfall (the hand-built reference FPS).

This is NOT the generation pipeline. It imports two things from the backend repo
read-only — `app.config.settings` (for the API key) and `app.services.tripo_service`
(the HTTP client) — and drives them directly. No agent, no director, no coder phase,
no S3, no DynamoDB, no credit ledger writes.

Run from the backend ec2 dir so `app.*` imports resolve:

    cd babble-games-backend/ec2 && CHATFORCE_SKIP_SSM=true ./venv/bin/python \
        ../../handcrafted-fps/assetgen/tripo_gen.py character enemy_soldier

Chain (mirrors tripo_tools.py's AUTO-RIG REST-POSE PATH, lines 1919-1975):
  1. v2 create_task {type: text_to_model, model_version: v3.1-20260211,
     prompt: "<subject>, <TPOSE_TEMPLATE>", texture: true, pbr: true}
  2. wait_for_task -> download raw GLB (this is the mesh the T-pose gate scores)
  3. convert_to_lowpoly(task_id) -> wait -> download low-poly GLB
  4. write a receipt JSON next to it (task ids, credits, prompt, byte sizes)

The T-pose wording is imported from tripo_tools so it cannot drift from the rig
side's expectations.
"""
import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.getcwd())

from app.services import tripo_service as ts  # noqa: E402
from app.game_generation.agentic.tripo_tools import (  # noqa: E402
    TPOSE_MODEL_VERSION,
    TPOSE_TEMPLATE,
)

OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# The asset ledger. Every model this build generates is declared here so the
# prompts are reviewable in one place and a rerun is idempotent-ish (skips any
# slug whose .glb already exists unless --force).
#
# `character` entries get the T-pose mandate appended and go through the v2
# rest-pose chain. `prop` entries are plain generations (no pose mandate) — a
# crate has no rig.
# --------------------------------------------------------------------------
CHARACTERS = {
    "enemy_soldier": (
        "a modern military infantry soldier in dark olive-drab tactical combat "
        "fatigues, plate carrier vest with pouches, combat helmet with a mounted "
        "night-vision bracket, knee pads and tactical boots, dark neutral colours, "
        "clean stylised game-ready character, no weapon in hands, empty open hands"
    ),
}

PROPS = {
    "crate_military": (
        "a single weathered military supply crate, olive drab wooden ammunition box "
        "with metal corner brackets and stencilled markings, closed lid, game asset, "
        "isolated on a plain background, no ground, no base"
    ),
    "barrier_concrete": (
        "a single grey concrete jersey barrier road block, weathered scuffed concrete "
        "with faded orange hazard stripe, game asset, isolated, no ground plane"
    ),
    "sandbag_wall": (
        "a low stacked sandbag wall barricade, three courses of dusty tan hessian "
        "sandbags stacked in a straight run, military fortification, game asset, "
        "isolated, no ground plane"
    ),
    "watchtower": (
        "a military compound guard watchtower, square open steel-frame tower with a "
        "ladder, railed observation platform and a corrugated metal roof, weathered "
        "olive and rust, game asset, isolated, no ground plane"
    ),
    "antenna_mast": (
        "a military radio antenna mast, slender guyed lattice steel tower with a "
        "dish and whip antennas at the top, weathered grey metal, game asset, "
        "isolated, no ground plane"
    ),
    "oil_drum": (
        "a single rusted fuel barrel oil drum, dented weathered steel with peeling "
        "olive paint, upright closed lid, game asset, isolated, no ground plane"
    ),
    # The player's carbine. Generated as a PROP (no pose mandate — a rifle has no
    # skeleton) but at a higher face limit than the scenery, because it is the
    # single most-looked-at object in a first-person game: it occupies the lower
    # third of every frame the player ever sees. The prompt is written for the
    # VIEWMODEL transform architecture that already exists — a clean side profile
    # with an unambiguous barrel axis is what makes the muzzle and optic mounts
    # placeable by measurement rather than by nudging.
    "carbine": (
        "a modern military assault carbine rifle, short-barrelled 5.56 automatic "
        "carbine with a railed handguard, collapsible stock, pistol grip, straight "
        "box magazine, muzzle device on the end of the barrel and a small red-dot "
        "optic mounted on the top rail, matte black and dark olive furniture, "
        "clean readable silhouette, weapon pointing to the right with the barrel "
        "horizontal, side profile, game asset, isolated on a plain background, "
        "no hands, no character, no ground plane, no stand"
    ),
    # M3 RE-GENERATION: the player asked to be able to LOOK THROUGH the scope.
    #
    # `carbine` above produced a beautifully modelled optic that is a solid
    # block — Tripo modelled the SHAPE of a red dot with no aperture in it, so
    # aiming down it is an obstruction rather than a sight picture. This prompt
    # attacks that directly: the aperture is described as a hole you can see
    # through, repeatedly and in the generator's own vocabulary (open, hollow,
    # "see-through", thin ring), because a single mention of "red dot sight"
    # reliably yields a filled cuboid.
    #
    # Whether it WORKS is a measurement, not a hope — `assetgen/aperture.py`
    # ray-casts the optic region to decide. See DECISIONS §36.
    "carbine_optic": (
        "a modern military assault carbine rifle, short-barrelled 5.56 automatic "
        "carbine with a railed handguard, collapsible stock, pistol grip, straight "
        "box magazine and a muzzle device on the end of the barrel; mounted on the "
        "top rail is a HOLLOW OPEN TUBE red-dot sight — a thin metal ring with a "
        "large empty circular hole straight through it front to back, completely "
        "open and see-through like a doughnut or a washer, you can see the "
        "background through the middle of the sight, no glass, no lens, no solid "
        "face, the hole is empty air; matte black metal and dark olive furniture, "
        "clean readable silhouette, weapon pointing to the right with the barrel "
        "horizontal, side profile, game asset, isolated on a plain background, "
        "no hands, no character, no ground plane, no stand"
    ),
}


async def generate(slug: str, subject: str, *, is_character: bool, pbr: bool,
                   face_limit: int, force: bool) -> dict:
    dest = OUT / f"{slug}.glb"
    receipt_path = OUT / f"{slug}.receipt.json"
    if dest.exists() and not force:
        print(f"[skip] {slug}: {dest} already exists")
        return json.loads(receipt_path.read_text()) if receipt_path.exists() else {}

    svc = ts.TripoService()
    t0 = time.time()
    receipt: dict = {
        "slug": slug,
        "subject": subject,
        "is_character": is_character,
        "pbr": pbr,
        "face_limit": face_limit,
        "credits": 0,
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    try:
        bal0 = await svc.get_credit_balance()
        receipt["balance_before"] = bal0
        print(f"[{slug}] balance before: {bal0}")

        prompt = f"{subject}, {TPOSE_TEMPLATE}" if is_character else subject
        receipt["prompt"] = prompt

        payload = {
            "type": "text_to_model",
            "prompt": prompt,
            # Pinned v3.1: the P1 native path drifts to A-pose, which the rig's
            # landmark deriver (a T-pose SILHOUETTE reader) cannot score. Props
            # use the same version for a consistent material look.
            "model_version": TPOSE_MODEL_VERSION,
            "texture": True,
            "pbr": pbr,
        }
        if face_limit:
            payload["face_limit"] = face_limit

        task_id = await svc.create_task(payload)
        receipt["gen_task_id"] = task_id
        print(f"[{slug}] generation task {task_id} submitted, polling...")
        gen_result = await svc.wait_for_task(task_id, interval=10.0, timeout=900.0)
        receipt["credits"] += ts.tripo_task_credit_cost("text_to_model")

        raw = OUT / f"{slug}.raw.glb"
        await svc.download_model(gen_result, raw)
        receipt["raw_bytes"] = raw.stat().st_size
        print(f"[{slug}] raw mesh: {receipt['raw_bytes']} bytes -> {raw}")

        # Low-poly conversion. Preserves the pose; this is the mesh we ship.
        try:
            conv = await svc.convert_to_lowpoly(task_id)
            await svc.download_model(conv, dest)
            receipt["lowpoly_task_id"] = conv.get("task_id")
            receipt["credits"] += ts.tripo_task_credit_cost("highpoly_to_lowpoly")
            receipt["lowpoly"] = True
        except Exception as exc:  # noqa: BLE001 — a failed conversion must never lose the asset
            print(f"[{slug}] low-poly conversion FAILED ({exc}); keeping the raw mesh")
            receipt["lowpoly"] = False
            receipt["lowpoly_error"] = str(exc)
            await svc.download_model(gen_result, dest)

        receipt["bytes"] = dest.stat().st_size
        bal1 = await svc.get_credit_balance()
        receipt["balance_after"] = bal1
        if bal0 is not None and bal1 is not None:
            receipt["balance_delta"] = round(bal0 - bal1, 2)
        receipt["ok"] = True
    except Exception as exc:  # noqa: BLE001
        receipt["ok"] = False
        receipt["error"] = f"{type(exc).__name__}: {exc}"
        print(f"[{slug}] FAILED: {receipt['error']}")
    finally:
        await svc.close()

    receipt["seconds"] = round(time.time() - t0, 1)
    receipt_path.write_text(json.dumps(receipt, indent=2))
    print(f"[{slug}] done in {receipt['seconds']}s  credits~{receipt['credits']}  "
          f"delta={receipt.get('balance_delta')}")
    return receipt


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["character", "prop", "balance"])
    ap.add_argument("slugs", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-pbr", action="store_true")
    ap.add_argument("--face-limit", type=int, default=0)
    ap.add_argument("--parallel", type=int, default=1)
    args = ap.parse_args()

    if args.kind == "balance":
        svc = ts.TripoService()
        print("balance:", await svc.get_credit_balance())
        await svc.close()
        return 0

    table = CHARACTERS if args.kind == "character" else PROPS
    slugs = args.slugs or list(table)
    unknown = [s for s in slugs if s not in table]
    if unknown:
        print(f"unknown slugs: {unknown}; known: {list(table)}")
        return 2

    is_char = args.kind == "character"
    face_limit = args.face_limit or (0 if is_char else 4000)

    sem = asyncio.Semaphore(max(1, args.parallel))

    async def one(slug: str) -> dict:
        async with sem:
            return await generate(
                slug, table[slug],
                is_character=is_char,
                pbr=not args.no_pbr,
                face_limit=face_limit,
                force=args.force,
            )

    results = await asyncio.gather(*(one(s) for s in slugs))
    failed = [r.get("slug") for r in results if r and not r.get("ok", True)]
    total = sum(r.get("credits", 0) for r in results if r)
    print(f"\n=== {len(results)} asset(s), ~{total} credits, failed: {failed or 'none'} ===")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
