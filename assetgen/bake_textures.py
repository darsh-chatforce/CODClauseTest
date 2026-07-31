#!/usr/bin/env python
"""
Seamless PBR texture baker for Operation Nightfall.

Writes REAL asset files (PNG) into `public/textures/` — albedo, normal and
roughness per material — rather than drawing on a canvas at runtime. Two reasons:

  1. SEAMLESS BY CONSTRUCTION. Every noise octave here is sampled on an integer
     lattice whose period DIVIDES the texture size, so the result wraps exactly.
     A generative image model cannot promise that, and a visible tile seam on a
     40 m floor is the single most obvious "this is a prototype" tell.
  2. They are inspectable, diffable, cacheable files. Runtime canvas noise is
     invisible to review and costs boot time on every load.

Run with the backend venv (numpy + Pillow), from anywhere:
    babble-games-backend/ec2/venv/bin/python assetgen/bake_textures.py
"""
from __future__ import annotations

import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "textures"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 1024
rng = np.random.default_rng(0x0F1FA11)


def use_seed(name: str) -> None:
    """Give each material its OWN deterministic generator.

    WHY: the first version drew every material from one shared stream in call
    order, so editing ONE material silently re-rolled every material baked after
    it. That is not a theoretical hazard — changing a single noise period in
    `plaster` moved `ground_slab`'s slab-tone draw and pushed its seam metric
    from 1.486 to 1.957, failing a gate on a texture that had not been touched.
    A bake where an unrelated edit changes unrelated output is not reproducible,
    and chasing that is exactly the kind of time sink that makes people delete
    the gate instead of the bug.

    Seeded from a CRC of the name rather than `hash()`, which is salted per
    process and would make the bake non-reproducible across runs."""
    global rng
    rng = np.random.default_rng(zlib.crc32(name.encode()) & 0xFFFFFFFF)


# ---------------------------------------------------------------- noise ---
def _lattice(period: int) -> np.ndarray:
    """Random values on a `period x period` lattice, tiled to wrap."""
    return rng.random((period, period))


def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * t * (t * (t * 6 - 15) + 10)


def snap_period(size: int, period: int) -> int:
    """Largest power of two <= `period` that still divides `size` (min 2).

    WHY THIS EXISTS: the first cut of this file simply skipped any octave whose
    period did not divide the texture size. That is a SILENT ZERO — `fbm` returned
    an all-zero field and three of the five materials baked out as flat colour
    (ground_slab came out as a 4 KB PNG, which is what exposed it). A guard that
    degrades quietly is worse than no guard: the texture still "worked", still
    loaded, and only a file-size glance caught it. Now the period is snapped to a
    legal value up front and `value_noise` RAISES on an illegal one."""
    p = 1 << max(1, int(period)).bit_length() - 1
    while p > 1 and size % p:
        p //= 2
    return max(p, 2)


def value_noise(size: int, period: int) -> np.ndarray:
    """Periodic value noise. `period` MUST divide `size` for an exact wrap."""
    if size % period:
        raise ValueError(f"value_noise: period {period} does not divide size {size} "
                         f"— the tile would not wrap. Use snap_period().")
    g = _lattice(period)
    # Sample coordinates in lattice space.
    lin = np.arange(size) * (period / size)
    xi = np.floor(lin).astype(int)
    tf = _smooth(lin - xi)
    x0 = xi % period
    x1 = (xi + 1) % period

    # Bilinear over the wrapped lattice.
    g00 = g[np.ix_(x0, x0)]
    g10 = g[np.ix_(x1, x0)]
    g01 = g[np.ix_(x0, x1)]
    g11 = g[np.ix_(x1, x1)]
    tx = tf[:, None]
    ty = tf[None, :]
    a = g00 * (1 - tx) + g10 * tx
    b = g01 * (1 - tx) + g11 * tx
    return a * (1 - ty) + b * ty


def fbm(size: int, base_period: int, octaves: int, gain: float = 0.5) -> np.ndarray:
    """Fractal sum of periodic value noise. Every octave period divides `size`."""
    total = np.zeros((size, size))
    amp = 1.0
    norm = 0.0
    period = snap_period(size, base_period)
    for _ in range(octaves):
        total += value_noise(size, period) * amp
        norm += amp
        amp *= gain
        period *= 2
        if period > size:
            break
    assert norm > 0, "fbm produced no octaves"
    return total / norm


def ridged(size: int, base_period: int, octaves: int) -> np.ndarray:
    """Ridged fBm — the crack/vein generator."""
    return 1.0 - np.abs(fbm(size, base_period, octaves) * 2.0 - 1.0)


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / max(hi - lo, 1e-6)


def bleed(a: np.ndarray, length: float, axis: int = 1, steps: int = 8) -> np.ndarray:
    """Smear a field along +`axis` with an exponential falloff of `length` px.

    Weathering is DIRECTIONAL — rust runs down from the thing that started it —
    and a symmetric blur cannot say that. This does it with `np.roll` only, so
    the smear wraps exactly and a run that leaves the bottom of the tile re-enters
    at the top already faded to nothing (decay^255 ~ 0.03 at length 70), which is
    what makes a directional effect legal under the seam audit.

    Shifts double each pass, and `max(out, roll(out, s) * decay**s)` composes, so
    after `steps` passes every offset d < 2^steps carries exactly decay**d."""
    decay = float(np.exp(-1.0 / max(length, 1e-3)))
    out = np.asarray(a, dtype=float).copy()
    step = 1
    for _ in range(steps):
        out = np.maximum(out, np.roll(out, step, axis=axis) * decay ** step)
        step *= 2
    return out


# ------------------------------------------------------------- to images ---
def height_to_normal(h: np.ndarray, strength: float = 2.0) -> np.ndarray:
    """Tangent-space normal map from a height field, with WRAPPING gradients so
    the normal map tiles as exactly as the albedo does."""
    dx = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength
    dy = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + nz * nz)
    n = np.stack([-dx / ln, -dy / ln, nz / ln], axis=-1)
    return (n * 0.5 + 0.5)


def seam_error(a: np.ndarray) -> float:
    """Tileability proof, in the same spirit as the enclosure audit.

    A seamless tile's wrap must be no more of a discontinuity than the WORST
    transition the texture already contains on purpose. The baseline is therefore
    the 99th percentile of interior row-to-row differences, not the mean.

    That distinction is not pedantry — it is the difference between a useful gate
    and a wrong one. `ground_slab` deliberately contains hard expansion joints
    with a tone step across each; against a MEAN baseline (dominated by the smooth
    interior of each slab) the wrap scored 1.97 and failed, even though the wrap
    falls exactly on a joint and looks like every other joint in the tile. A gate
    that fails correct work teaches people to raise the threshold, which is how
    gates die.

    ~1.0 means the wrap is indistinguishable from the texture's own worst seam.
    Above 1.5 is a real artefact."""
    edge = np.abs(a[0].astype(float) - a[-1].astype(float)).mean()
    rows = np.abs(np.diff(a.astype(float), axis=0)).mean(axis=tuple(range(1, a.ndim)))
    inner = float(np.percentile(rows, 99))
    return float(edge / max(inner, 1e-6))


_SEAMS: list[tuple[str, float]] = []


def save_rgb(name: str, rgb: np.ndarray, *, jpeg: bool = False, size: int | None = None) -> None:
    arr = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    _SEAMS.append((name, max(seam_error(arr), seam_error(arr.transpose(1, 0, 2)))))
    img = Image.fromarray(arr.transpose(1, 0, 2), "RGB")
    if size and size != img.width:
        img = img.resize((size, size), Image.LANCZOS)
    if jpeg:
        path = OUT / f"{name}.jpg"
        img.save(path, quality=90, optimize=True, subsampling=0)
    else:
        path = OUT / f"{name}.png"
        img.save(path, optimize=True)
    print(f"  {path.name:34s} {path.stat().st_size // 1024:5d} KB")


def save_gray(name: str, g: np.ndarray, *, size: int | None = None) -> None:
    arr = (np.clip(g, 0, 1) * 255).astype(np.uint8)
    _SEAMS.append((name, max(seam_error(arr), seam_error(arr.T))))
    img = Image.fromarray(arr.T, "L")
    if size and size != img.width:
        img = img.resize((size, size), Image.LANCZOS)
    path = OUT / f"{name}.png"
    img.save(path, optimize=True)
    print(f"  {path.name:34s} {path.stat().st_size // 1024:5d} KB")


def tint(h: np.ndarray, lo: tuple, hi: tuple) -> np.ndarray:
    """Map a 0..1 scalar onto a colour ramp."""
    lo_a = np.array(lo, dtype=float) / 255.0
    hi_a = np.array(hi, dtype=float) / 255.0
    return lo_a[None, None, :] + h[:, :, None] * (hi_a - lo_a)[None, None, :]


# Download budget. Albedo is sRGB and tolerates JPEG; normal and roughness are
# DATA and stay lossless, but at half resolution — a 512 normal over a 1024
# albedo is invisible at play distance and cuts the payload by ~4x. The first
# bake shipped 9.13 MB of PNG for five materials, which is not a browser game.
ALBEDO_SIZE = 1024
DATA_SIZE = 512


def emit(name: str, albedo: np.ndarray, height: np.ndarray, rough: np.ndarray,
         normal_strength: float = 2.0) -> None:
    print(f"[{name}]")
    save_rgb(f"{name}_albedo", albedo, jpeg=True, size=ALBEDO_SIZE)
    save_rgb(f"{name}_normal", height_to_normal(height, normal_strength), size=DATA_SIZE)
    save_gray(f"{name}_rough", rough, size=DATA_SIZE)


# ------------------------------------------------------------ materials ---
def mat_concrete() -> None:
    use_seed("concrete")
    """Cast concrete: fine pore noise + coarse aggregate + form-board staining
    + hairline cracks. The workhorse for walls and the bunker."""
    fine = fbm(SIZE, 64, 4)
    coarse = fbm(SIZE, 8, 3)
    pores = norm01(fbm(SIZE, 256, 2))
    aggregate = (value_noise(SIZE, snap_period(SIZE, 512)) > 0.86).astype(float)
    cracks = np.clip(ridged(SIZE, 16, 4) - 0.86, 0, 1) * 7.0
    stain = norm01(fbm(SIZE, 4, 3))

    h = norm01(fine * 0.45 + coarse * 0.35 + pores * 0.2) - cracks * 0.5 + aggregate * 0.12
    v = 0.52 + coarse * 0.16 + fine * 0.10 - stain * 0.13 - cracks * 0.30 + aggregate * 0.08
    v = np.clip(v, 0.06, 1.0)
    alb = tint(norm01(v) * 0.62 + 0.22, (74, 74, 71), (176, 174, 166))
    # Damp streaks read cooler and darker.
    damp = np.clip(norm01(fbm(SIZE, 16, 3)) - 0.62, 0, 1) * 1.4
    alb[:, :, 2] += damp * 0.05
    alb *= (1.0 - damp[:, :, None] * 0.22)
    rough = np.clip(0.86 + fine * 0.10 - damp * 0.22 - aggregate * 0.06, 0.35, 1.0)
    emit("concrete", alb, h, rough, 2.6)


def mat_plaster() -> None:
    use_seed("plaster")
    """Painted sand plaster over block: broad trowel waves, chipped patches that
    expose the darker substrate, and a warm sun-bleached tone."""
    # Base period 6 snapped to 4 — quarter-tile features, i.e. ~70 cm bands on a
    # wall, which read as wood planking rather than as trowelled plaster. A
    # higher base period keeps the variation but stops it being directional
    # structure at architectural scale.
    waves = fbm(SIZE, 32, 4)
    grain = fbm(SIZE, 128, 3)
    # NOTE ON SCALE: the first bake used a base period of 12 (snapped to 8),
    # which put the chip features at ~1/8 of the tile — on a 6 m wall that is a
    # metre-wide black blotch, and the walls read as mouldy rather than weathered.
    # Chips are a SMALL-scale defect: period 64, a much higher threshold, and a
    # substrate only slightly darker than the plaster instead of near-black.
    chips = np.clip(ridged(SIZE, 64, 3) - 0.90, 0, 1) * 6.0
    chips = np.clip(chips + (value_noise(SIZE, snap_period(SIZE, 128)) > 0.965).astype(float) * 0.6, 0, 1)
    soil = np.clip(norm01(fbm(SIZE, 3, 2)) - 0.5, 0, 1) * 2.0

    h = norm01(waves * 0.7 + grain * 0.3) - chips * 0.55
    base = 0.62 + waves * 0.11 + grain * 0.06
    alb = tint(np.clip(base, 0, 1), (108, 96, 80), (206, 191, 165))
    # Substrate showing through a chip is grey block, not plaster.
    sub = tint(np.clip(grain, 0, 1), (128, 118, 104), (170, 158, 138))
    alb = alb * (1 - chips[:, :, None]) + sub * chips[:, :, None]
    # Ground-up soil splash on the lower band is applied in-engine by vertex
    # colour, not baked here — a baked gradient would tile visibly.
    alb *= (1.0 - soil[:, :, None] * 0.10)
    rough = np.clip(0.80 + grain * 0.12 + chips * 0.12, 0.4, 1.0)
    emit("plaster", alb, h, rough, 2.0)


def mat_metal() -> None:
    use_seed("metal")
    """Weathered corrugated galvanised sheet — wall panels, deck railings, stair
    cheeks, and (at a coarser tiling) shipping containers.

    RIB PITCH ARITHMETIC. `arena.ts` applies this material at `tiles: 1.1` tiles
    per metre on every panel, railing and stair cheek, so ONE TILE IS
    1 / 1.1 = 0.909 m of wall. Real corrugated cladding runs a 75-90 mm rib
    pitch, so the tile should carry

        0.909 m / 0.0825 m = 11.0 ribs

    hence RIBS = 11, i.e. a 909 / 11 = 82.6 mm pitch — mid-range and physically
    honest. Containers tile at 0.75/m, so their tile is 1.333 m and the same 11
    ribs land at 121 mm, which is the coarser profile a container box actually
    has; one map serves both. The previous 16 ribs was a 57 mm pitch, finer than
    any real sheet, and at 10 m it aliased into a flat grey haze.

    WHAT WAS WRONG, AND WHY NO NUMBER IN THIS FILE CAUGHT IT. The first version
    passed the seam audit comfortably and still read in game as psychedelic
    blue-and-orange marble:
      * rust was `fbm(base_period=8)` thresholded — blobs an EIGHTH OF A TILE
        across, i.e. 11 cm organic swirls. That is not corrosion, that is veining;
      * roughness floored at 0.18 under a 0.95 metalness map is a near-mirror,
        and a mirror shows you the SKY. That is where the blue came from, and no
        amount of albedo detail can show through a mirror;
      * the corrugation existed almost only in the HEIGHT map. Normal-mapped
        relief flattens with distance and with a grazing dusk sun, so the single
        cue that says "corrugated" disappeared at exactly the range these panels
        are seen from.
    Each fix is the mirror of one of those: the ribs are now baked into the
    ALBEDO as a crest/valley shading gradient (so they survive with the normal
    map contributing nothing), rust is small, sparse and directional, and the
    surface is dull enough to stop mirroring anything.

    ORIENTATION. Ribs run along +U, so on a wall face they stand VERTICALLY
    (BoxGeometry maps U across a side face and V up it). That is what puts the
    valleys in line with gravity: rain — and therefore rust — runs DOWN a valley.
    Sheets are lapped across those runs, so the lap joints are horizontal, with a
    row of fixings driven through each lap. Increasing index on axis 1 is
    downward on the wall (image row 0 is the top after the save transpose, and
    three.js flips Y on load), so the streaks bleed toward +axis 1."""
    RIBS = 11          # see the pitch arithmetic above
    LAPS = 1           # horizontal sheet laps per tile → one every 0.909 m
    u = np.arange(SIZE) / SIZE
    vv = np.arange(SIZE) / SIZE

    # ---- rib profile ------------------------------------------------------
    # A pure sine has no flat crest and no flat valley, so it reads as soft
    # banding rather than as pressed sheet. This is a rounded trapezoid: a flat
    # valley, two smoothstepped flanks, a flat crest. Built from a phase that is
    # an exact integer number of repeats across SIZE, so it wraps perfectly.
    ph = (u * RIBS) % 1.0
    tri = 1.0 - np.abs(ph * 2.0 - 1.0)                       # 0 valley → 1 crest
    prof = _smooth(np.clip((tri - 0.16) / 0.52, 0.0, 1.0))
    # Wrapping central difference → which way each flank faces. Baked at low
    # amplitude only: a heavy directional bake fights the real sun when the
    # player walks round the panel.
    dprof = np.roll(prof, -1) - np.roll(prof, 1)
    dprof = dprof / max(float(np.abs(dprof).max()), 1e-6)
    corr = prof[:, None].repeat(SIZE, axis=1)
    flank = dprof[:, None].repeat(SIZE, axis=1)
    valley = 1.0 - corr

    # ---- horizontal laps + fixing rows ------------------------------------
    # Placed at half-phase so the lap line never lands on the tile wrap.
    lp = (vv * LAPS) % 1.0
    lap = np.clip(1.0 - np.abs(lp - 0.5) / 0.009, 0, 1)          # shadow under lap
    lip = np.clip(1.0 - np.abs(lp - 0.484) / 0.008, 0, 1)        # lit edge above it
    lap2 = lap[None, :].repeat(SIZE, axis=0)
    lip2 = lip[None, :].repeat(SIZE, axis=0)
    # One fixing per rib crest per lap: RIBS x LAPS = 11 dimples, all built on
    # wrapped phases, so the row tiles exactly.
    du = (ph - 0.5) * (SIZE / RIBS)
    dv = (lp - 0.5) * (SIZE / LAPS)
    rad = np.sqrt(du[:, None] ** 2 + dv[None, :] ** 2)
    rivet = np.clip(1.0 - rad / 6.5, 0, 1)
    rivet_hi = np.clip(1.0 - np.abs(rad - 6.1) / 2.4, 0, 1) * (dv[None, :] < 0)

    # ---- noise ------------------------------------------------------------
    grain = fbm(SIZE, 256, 2)          # mill grain / galvanising spangle
    dirt = fbm(SIZE, 64, 3)            # ~1.4 cm dust and grime
    dish = fbm(SIZE, 8, 3)             # oil-canning: soft bowing between fixings
    # Dishing is the ONE large-scale feature allowed here, and only as a smooth
    # luminance term. The old rust used the same scale THRESHOLDED into hard,
    # saturated shapes — that step from "soft gradient" to "hard-edged coloured
    # blob" is the whole difference between weathering and marble.
    wash = norm01(fbm(SIZE, 12, 3))    # broad grime wash, smooth, never keyed

    # ---- rust: small, sparse, and running downhill ------------------------
    # Corrosion starts at a fixing, at a lap, or at a pinhole in the coating, and
    # then bleeds DOWN. So the sources are those features (gated by a coarse
    # field so only some of them are live), and the bleed does the rest.
    live = norm01(fbm(SIZE, 96, 3))
    # A SECOND, coarser gate on top of `live`. With only `live` (10 px features)
    # every lap row grew a continuous dotted fringe of rust along its whole
    # width, and at tiling distance that fringe IS the tile period — the exact
    # failure the seam work exists to avoid, arriving by a different door. This
    # gate lets roughly a third of the width bleed at all, in patches.
    patch = norm01(fbm(SIZE, 32, 2))
    pit = (value_noise(SIZE, snap_period(SIZE, 512)) > 0.955).astype(float)
    src = np.clip(rivet * (live > 0.52) * (patch > 0.50)
                  + lap2 * 0.9 * (live > 0.58) * (patch > 0.62)
                  + pit * (live > 0.42), 0, 1)
    # Two lengths, so runs are not all the same height: a strong short bleed
    # right under the source and a faint long one that reaches further down.
    runs = np.maximum(bleed(src, length=45.0, steps=7),
                      bleed(src * 0.55, length=150.0, steps=8))
    # Thin the runs along U and pull them into the valleys, where the water is.
    thin = np.clip(norm01(fbm(SIZE, 320, 2)) * 1.7 - 0.34, 0, 1)
    rust = np.clip(runs * thin * (0.30 + 0.90 * valley) * 2.0, 0, 1)
    # Plus fine speckle: individual rust pinpoints, not a wash.
    speck = (value_noise(SIZE, snap_period(SIZE, 512)) > 0.972).astype(float)
    rust = np.clip(rust + speck * (live > 0.38) * 0.9, 0, 1)

    # Plain dirt runs — the same downhill logic without the oxide, so the sheet
    # is weathered everywhere and rusty only in places. This is most of what
    # makes a panel look USED rather than newly delivered.
    grime = bleed(np.clip(norm01(fbm(SIZE, 224, 2)) - 0.50, 0, 1) * 2.2
                  + lap2 * 0.6 * (patch > 0.40), length=45.0, steps=7)
    grime = np.clip(grime * (0.35 + 0.85 * valley), 0, 1)

    # ---- height -----------------------------------------------------------
    # Corrugation dominates by an order of magnitude; everything else is a
    # perturbation. `emit` gets a much higher normal strength than before (1.4
    # produced a ~5 degree flank tilt, i.e. nothing) so a flank reads at ~30-40
    # degrees, which is the real geometry of a 15 mm deep, 83 mm pitch sheet.
    h = (corr * 1.0
         + dish * 0.05
         + grain * 0.02
         - lap2 * 0.10
         + lip2 * 0.03
         - rivet * 0.09
         - rust * 0.02)

    # ---- albedo -----------------------------------------------------------
    # THE POINT OF THIS BLOCK: the rib gradient is in the DIFFUSE. Even with the
    # normal map fully flattened by distance, a crest is lighter than a valley
    # and a valley is dirtier, so the ribs still read.
    lum = np.clip(0.44
                  + corr * 0.24                # crest catches the sky
                  + flank * 0.045              # one flank a touch brighter
                  + dish * 0.10                # oil-canning
                  - wash * 0.10                # broad grime wash
                  + grain * 0.07
                  - valley * dirt * 0.20       # grime collects in the valleys
                  - grime * 0.16               # dirt running down the valleys
                  - lap2 * 0.26
                  + lip2 * 0.13
                  - rivet * 0.28
                  + rivet_hi * 0.20, 0, 1)
    # Cool-grey galvanised. The ramp is deliberately narrow and desaturated so
    # the panels sit inside the dusk value ladder instead of punching out of it.
    steel = tint(lum, (68, 72, 78), (172, 176, 180))
    # Iron oxide, not traffic-cone orange: low chroma, dark, brownish.
    rust_col = tint(np.clip(grain * 0.55 + dirt * 0.45, 0, 1), (54, 40, 32), (118, 82, 58))
    alb = steel * (1 - rust[:, :, None]) + rust_col * rust[:, :, None]
    # A hint of warm dust over the cool steel, strongest low in the valleys.
    warm = (valley * dirt + grime * 0.8)[:, :, None] * np.array([0.05, 0.03, -0.02])[None, None, :]
    alb = np.clip(alb + warm, 0, 1)

    # ---- roughness / metalness -------------------------------------------
    # Weathered galvanising is DULL: 0.55-0.90, never a mirror. Held well clear
    # of the old 0.18 floor.
    rough = np.clip(0.66 + rust * 0.20 + grime * 0.12 + dirt * 0.08 - corr * 0.07
                    + lap2 * 0.06, 0.55, 0.90)
    emit("metal", alb, h, rough, 5.0)
    # Metalness: bare steel is metal, rust is not — but weathered, oxidised,
    # dust-filmed galvanising is not clean metal either. Peak 0.50 rather than
    # 0.95, which is what stops the panel from behaving as a sky-coloured mirror
    # while still letting the crests take a metallic sheen.
    save_gray("metal_metalness",
              np.clip(0.50 - rust * 0.44 - grime * 0.20 - dirt * 0.10 - lap2 * 0.15
                      + corr * 0.05, 0.0, 1.0),
              size=DATA_SIZE)


def mat_sand() -> None:
    use_seed("sand")
    """Compacted desert grit — the dominant ground surface. Deliberately LOW
    contrast: a busy ground texture destroys enemy readability, which is the
    thing the whole build is about."""
    grains = fbm(SIZE, 384, 2)
    drift = fbm(SIZE, 12, 4)
    pebbles = np.clip(value_noise(SIZE, snap_period(SIZE, 128)) - 0.80, 0, 1) * 5.0
    tracks = np.clip(ridged(SIZE, 6, 3) - 0.72, 0, 1) * 2.2

    h = norm01(drift * 0.55 + grains * 0.3) + pebbles * 0.35 - tracks * 0.12
    base = np.clip(0.55 + drift * 0.20 + grains * 0.12 - tracks * 0.10, 0, 1)
    alb = tint(base, (96, 84, 66), (186, 168, 138))
    peb = tint(np.clip(grains, 0, 1), (94, 90, 84), (150, 146, 138))
    alb = alb * (1 - pebbles[:, :, None]) + peb * pebbles[:, :, None]
    rough = np.clip(0.92 + grains * 0.06 - pebbles * 0.18, 0.5, 1.0)
    emit("sand", alb, h, rough, 1.8)


def mat_ground_slab() -> None:
    use_seed("ground_slab")
    """Poured compound apron: big slabs with expansion joints, patch repairs and
    oil staining. This is the SECOND ground texture — it is deliberately a
    different KIND of surface from `sand`, not the same noise at a new scale, so
    that layering the two cannot read as one repeating pattern."""
    n = 4  # slabs across the tile
    u = (np.arange(SIZE) / SIZE * n) % 1.0
    joint_u = (np.minimum(u, 1 - u) < 0.012).astype(float)
    joint = np.maximum(joint_u[:, None].repeat(SIZE, axis=1),
                       joint_u[None, :].repeat(SIZE, axis=0))
    # Per-slab tone variation — index the slab, not the pixel.
    slab_id = (np.arange(SIZE) * n // SIZE)
    tone_lut = rng.random(n) * 0.09 - 0.045
    tone = tone_lut[slab_id][:, None] + tone_lut[slab_id][None, :] * 0.6

    grain = fbm(SIZE, 192, 3)
    wear = fbm(SIZE, 10, 4)
    cracks = np.clip(ridged(SIZE, 20, 4) - 0.88, 0, 1) * 8.0
    oil = np.clip(norm01(fbm(SIZE, 5, 3)) - 0.66, 0, 1) * 2.6

    h = norm01(grain * 0.3 + wear * 0.5) - joint * 0.9 - cracks * 0.4
    base = np.clip(0.58 + wear * 0.16 + grain * 0.10 + tone - cracks * 0.3, 0, 1)
    alb = tint(base, (68, 68, 66), (168, 166, 158))
    alb *= (1.0 - joint[:, :, None] * 0.68)
    alb *= (1.0 - oil[:, :, None] * 0.55)
    rough = np.clip(0.88 + grain * 0.08 - oil * 0.42 + joint * 0.05, 0.25, 1.0)
    emit("ground_slab", alb, h, rough, 3.0)


# ----------------------------------------------------------- decals -------
def _radial_falloff(size: int) -> np.ndarray:
    a = np.linspace(-1, 1, size)
    r = np.sqrt(a[:, None] ** 2 + a[None, :] ** 2)
    return np.clip(1.0 - r, 0, 1)


def decal_grime() -> None:
    use_seed("decal_grime")
    """Soft dirt bloom — RGBA, alpha-only shape. Dropped on wall bases and slab
    corners so surface transitions are never a hard line."""
    s = 512
    g = fbm(s, 8, 4)
    edge = _radial_falloff(s) ** 1.6
    a = np.clip((norm01(g) - 0.32) * 1.9, 0, 1) * edge
    col = tint(np.clip(g, 0, 1), (34, 30, 26), (86, 78, 66))
    rgba = np.concatenate([np.clip(col, 0, 1), a[:, :, None] * 0.72], axis=-1)
    img = Image.fromarray((rgba * 255).astype(np.uint8).transpose(1, 0, 2), "RGBA")
    img.save(OUT / "decal_grime.png", optimize=True)
    print(f"[decal_grime] {(OUT / 'decal_grime.png').stat().st_size // 1024} KB")


def decal_hazard() -> None:
    use_seed("decal_hazard")
    """Diagonal hazard chevrons, worn. Painted onto stair cheeks and dock edges —
    a real compound marks its trip hazards, and it gives the eye a saturated
    accent in an otherwise desaturated palette."""
    s = 512
    ax = np.arange(s)
    diag = ((ax[:, None] + ax[None, :]) / s * 6.0) % 1.0
    stripe = (diag < 0.5).astype(float)
    wear = fbm(s, 12, 4)
    scuff = np.clip(norm01(fbm(s, 40, 3)) - 0.42, 0, 1) * 2.0
    a = np.clip(1.0 - scuff * 1.1 - np.clip(wear - 0.55, 0, 1) * 2.2, 0, 1)
    yellow = np.array([214, 158, 40]) / 255.0
    black = np.array([28, 26, 24]) / 255.0
    col = stripe[:, :, None] * yellow + (1 - stripe[:, :, None]) * black
    col *= (0.72 + wear[:, :, None] * 0.4)
    rgba = np.concatenate([np.clip(col, 0, 1), a[:, :, None]], axis=-1)
    img = Image.fromarray((rgba * 255).astype(np.uint8).transpose(1, 0, 2), "RGBA")
    img.save(OUT / "decal_hazard.png", optimize=True)
    print(f"[decal_hazard] {(OUT / 'decal_hazard.png').stat().st_size // 1024} KB")


def decal_stencil() -> None:
    use_seed("decal_stencil")
    """Stencilled unit markings / numbers, heavily worn. Placed on containers and
    the bunker so the compound reads as OCCUPIED rather than as level geometry."""
    s = 512
    a = np.zeros((s, s))
    # Blocky stencil glyph strokes, laid out by hand as rectangles.
    def rect(x0, y0, x1, y1):
        a[int(x0 * s):int(x1 * s), int(y0 * s):int(y1 * s)] = 1.0
    # "07" style block glyphs + a bar.
    rect(0.08, 0.30, 0.14, 0.70); rect(0.08, 0.30, 0.30, 0.36)
    rect(0.24, 0.30, 0.30, 0.70); rect(0.08, 0.64, 0.30, 0.70)
    rect(0.38, 0.30, 0.60, 0.36); rect(0.50, 0.36, 0.56, 0.70)
    rect(0.68, 0.30, 0.74, 0.70); rect(0.68, 0.46, 0.90, 0.52)
    rect(0.84, 0.30, 0.90, 0.70)
    rect(0.08, 0.78, 0.90, 0.83)

    wear = fbm(s, 14, 4)
    flake = np.clip(norm01(fbm(s, 60, 3)) - 0.40, 0, 1) * 2.2
    a = np.clip(a - flake * 0.9 - np.clip(wear - 0.6, 0, 1) * 2.4, 0, 1)
    col = np.ones((s, s, 3)) * np.array([206, 202, 190]) / 255.0
    col *= (0.7 + wear[:, :, None] * 0.5)
    rgba = np.concatenate([np.clip(col, 0, 1), a[:, :, None] * 0.85], axis=-1)
    img = Image.fromarray((rgba * 255).astype(np.uint8).transpose(1, 0, 2), "RGBA")
    img.save(OUT / "decal_stencil.png", optimize=True)
    print(f"[decal_stencil] {(OUT / 'decal_stencil.png').stat().st_size // 1024} KB")


def ground_mask() -> None:
    use_seed("ground_mask")
    """The blend mask between the two ground surfaces.

    THE ANTI-TILING RULE: one texture repeated across a 40 m floor reads as a
    grid however seamless it is, because the eye finds the PERIOD, not the seam.
    So the floor is two different materials — a poured slab apron and drifted
    sand — at two non-harmonic tiling scales (0.28 and 0.11 tiles/m, a 2.55x
    ratio, deliberately not 2x so the two patterns never come back into phase).

    This mask decides which is on top. It is stretched ONCE across the whole
    40 m floor (repeat = 1), so it contributes no period of its own — it is the
    thing that breaks the other two. Drift is biased into the compound edges and
    away from the centre, where traffic would have worn it back to slab."""
    s = 512
    blobs = fbm(s, 4, 5)
    fine = fbm(s, 32, 3)
    # Radial bias: sand accumulates at the perimeter, the middle stays swept.
    a = np.linspace(-1, 1, s)
    r = np.sqrt(a[:, None] ** 2 + a[None, :] ** 2)
    edge = np.clip((r - 0.35) * 1.5, 0, 1)

    # A high-contrast mask makes two TERRITORIES with a visible border, which is
    # a different artefact from the tiling it was meant to hide. The point is to
    # interleave the two surfaces, so the ramp is wide and the extremes are
    # pulled in: the drift is mostly partial coverage, rarely fully one or other.
    m = np.clip(norm01(blobs) * 0.7 + fine * 0.3 - 0.30 + edge * 0.38, 0, 1)
    m = np.clip((m - 0.05) * 1.15, 0, 0.92)
    print("[ground_mask]")
    # NOT wrap-audited: this map is used at repeat = 1 and must NOT tile, so a
    # seam ratio is meaningless for it. Saved directly rather than via save_gray.
    img = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8).T, "L")
    img.save(OUT / "ground_mask.png", optimize=True)
    print(f"  ground_mask.png                    {(OUT / 'ground_mask.png').stat().st_size // 1024:5d} KB")


def main() -> int:
    print(f"Baking seamless PBR textures at {SIZE}x{SIZE} into {OUT}\n")
    mat_concrete()
    mat_plaster()
    mat_metal()
    mat_sand()
    mat_ground_slab()
    ground_mask()
    decal_grime()
    decal_hazard()
    decal_stencil()

    files = list(OUT.glob("*.png")) + list(OUT.glob("*.jpg"))
    total = sum(p.stat().st_size for p in files)
    print(f"\n{len(files)} files, {total / 1024 / 1024:.2f} MB total")

    # ---- tileability gate -------------------------------------------------
    # Every tiling map must wrap as cleanly as its own interior. A visible seam
    # repeated 12x across a 40 m floor is the loudest possible "prototype" tell,
    # so it is a measured gate here rather than something to notice in a
    # screenshot later.
    print("\nSeam audit (wrap discontinuity / interior discontinuity, 1.0 = perfect):")
    worst = 0.0
    for name, ratio in sorted(_SEAMS, key=lambda kv: -kv[1]):
        flag = "  FAIL" if ratio > 1.5 else ""
        worst = max(worst, ratio)
        print(f"  {name:30s} {ratio:6.3f}{flag}")
    if worst > 1.5:
        print(f"\nSEAM AUDIT FAILED (worst {worst:.3f} > 1.5)")
        return 1
    print(f"\nSeam audit PASSED — worst {worst:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
