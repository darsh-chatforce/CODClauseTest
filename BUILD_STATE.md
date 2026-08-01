# BUILD_STATE — Operation Nightfall (hand-built reference FPS)

Append-only log. One line per completed step. A successor recovers from this file
plus `DECISIONS.md`.

Project: `/Users/dshah/Chatforce/handcrafted-fps/` · Vite + TypeScript + three@0.185.1 · WebGL only.

## Milestone 1 — core playable (graybox, zero assets)

- [x] Read both pipeline dissections (`BASELINE_COD_BUILD.md`, `REBUILD_COD_V2.md`) and the
      backend FPS genre playbook + game-feel reference. Failure list extracted (see DECISIONS).
- [x] Scaffolded Vite/TS project: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
      Deps installed (three 0.185.1, vite 5, typescript 5, puppeteer-core for the harness).
- [x] Module skeleton created: `src/{core,input,player,weapons,ai,hud,world,fx}`.
- [x] `src/config.ts` — single tuning surface (player, look, camera, weapon, viewmodel, enemy,
      arena, feel, mission). Every feel number lives in one file.
- [x] `src/core/mathx.ts` (frame-rate-independent `damp`, `turnToward`, easings) and
      `src/core/rng.ts` (seeded mulberry32; `Math.random` banned in gameplay).
- [x] `src/world/collision.ts` — AABB collision world: cylinder push-out with step-up, ground
      query, ray/AABB, ray/capsule + ray/sphere (enemy body + head volumes), LOS helper.
- [x] `src/world/arena.ts` — 40×40 fully-enclosed graybox compound: 4 perimeter walls +
      buttresses, 3-deck elevated northern firing line at 3.0 m, 2 staircases (10 × 0.30 m
      risers), central bunker, 16 crates / 10 barriers / 5 containers. All boxes registered as
      colliders from the same spec list (geometry and collision cannot drift).
- [x] `src/world/environment.ts` — dusk lighting: procedural gradient+sun-scatter sky shader,
      low warm key with 2048 shadows, cool hemisphere fill, cool bounce fill, ExpFog, ACES
      tonemapping.
- [x] `src/input/input.ts` — pointer lock, held/pressed/released edges, raw movementX/Y look
      accumulation, orbit drag, blur safety, plus `injectAction`/`injectLook` test seams.
- [x] `src/player/player.ts` — FPS controller: accel/decel rates, sprint/crouch/ADS speeds,
      gravity + jump with coyote time (110 ms) and input buffering (130 ms), step-up stairs,
      stance interpolation with headroom check, landing impact reporting, damage/death.
- [x] `src/player/avatar.ts` — `AvatarModel` interface + `PlayerAvatar` container + working
      `GrayboxAvatar` (articulated blocked-out soldier with a procedural locomotion cycle).
      This is the M2 rigged-model seam, defined as an interface with a real implementation.
- [x] `src/weapons/viewmodel.ts` — separate scene + separate camera + dedicated 3-point
      lighting; hip/ADS/sprint pose blending; sway, bob, recoil spring, reload animation with
      magazine swap; placeholder rifle built from primitives with the optic at the ADS axis;
      exact rasterised `measureScreenCoverage()`.
- [x] `src/weapons/rifle.ts` — hitscan carbine: mag 30 / reserve 120, 720 rpm, reload timers
      (normal + empty), learnable 30-shot recoil pattern with 22% retained kick, stance-derived
      spread + per-shot bloom, capsule/head hit resolution, accuracy stats.
- [x] `src/fx/` — `feel.ts` (trauma shake, hitstop, FOV kick), `tracers.ts` (instanced tracer
      pool), `impacts.ts` (spark pool, bullet-hole decals, pooled world flash lights),
      `textures.ts` (procedural canvas sprites — zero asset files).
- [x] `src/ai/navgraph.ts` — sampled waypoint graph (2 m grid, both storeys), traversability
      edges, cover flags, A* pathfinding, debug points.
- [x] `src/ai/enemy.ts` — soldier state machine `patrol → advance → halt → aim(400 ms) →
      fire(burst) → reposition`, disjoint moving/stationary state sets, velocity hard-zeroed on
      entering stationary states, faces velocity while moving / player while aiming, visor +
      chevron facing indicators doubling as the telegraph, flinch, collapse death, corpses.
- [x] `src/hud/hud.ts` + `hud.css` + `index.html` — crosshair with derived dynamic spread,
      health + vignette, ammo 30/120 with reload bar, hostiles counter, objective banner,
      mission timer, kill feed, hit marker, directional damage arcs.
- [x] `src/hud/screens.ts` — start / pause / end screens with mission stats.
- [x] `src/game.ts` — orchestrator: phase machine (menu/playing/paused/won/lost), hitstop-scaled
      gameplay clock vs real clock for feedback, camera rig (recoil, shake, land dip, FOV
      blend), two-pass render, third-person inspect (T), continuous AI doctrine audit,
      enclosure audit, full test snapshot.
- [x] `src/main.ts` — entry point + `window.__FPS__` automation API.
- [x] Typecheck clean (`tsc --noEmit`, strict) and production build green
      (595 kB / 154 kB gzip, 27 modules).
- [x] `tools/smoke.mjs` — CDP harness (in-process static server + puppeteer-core
      against system Chrome). 41 assertions driving the live simulation.
- [x] First verification run: 36/41. Four real findings fixed:
      (a) FOV kick was feeding back into the FOV smoothing filter, so a damage
          kick permanently dragged the resting FOV;
      (b) enemy `fire`-state exit was timed from state entry rather than from the
          last round, so the post-burst pause scaled with burst length;
      (c) `teleport` did not resolve a surface, so test poses ended up inside the
          deck;
      (d) spread bloom recovered faster than the fire rate, so sustained fire had
          no accuracy cost. Bloom retuned to +0.5°/shot, −2.4°/s.
- [x] Visual pass 1 on the captured frames: the arena rendered BLACK. Root cause
      was an 11° sun elevation — a 6 m perimeter wall casts a 31 m shadow across a
      40 m arena. Sun raised to 28°, ambient budget raised, graybox palette
      rebuilt as a value ladder, spawn yaw corrected (it faced a corner).
- [x] Visual pass 2: metallic viewmodel materials were rendering black (no
      environment to reflect). Added `applyImageBasedLighting()` — procedural
      canvas equirect → PMREM → `scene.environment` for BOTH the world and the
      viewmodel scene. Sky gradient fixed (it was measured from the nadir, putting
      the warm band in the wrong hemisphere).
- [x] Visual pass 3: viewmodel reframed (FOV 55°→68°, pose pushed out) — hip
      coverage 6.66% → 4.45%. Orbit camera given wall pull-in. Enemy facing
      indicators enlarged after they read as featureless capsules at 25 m.
- [x] Two harness flakes found and fixed at source, not retried: hit-registration
      was shooting into a deck railing (now targets a ground-floor hostile), and
      the player was being killed mid-screenshot-composition (added a debug
      `invulnerable(on)` hook used only for frame composition).
- [x] **M1 VERIFIED: 41/41 assertions, 5 consecutive clean runs.** Key numbers:
      enclosure 1600 rays / 0 leaks · viewmodel 4.45% hip, 9.24% ADS (budget 15%)
      · AI doctrine 0 violations across 720 sampled state/speed pairs, all six
      states observed · nav graph 333 waypoints · walk 5.10 / sprint 7.30 m/s ·
      jump apex 0.86 m · 0 console errors or warnings.
- [x] 6 milestone screenshots captured in `shots/`.
- [x] Dev server verified separately (`npm run dev` → http://localhost:5178/, 200
      on index and on `/src/main.ts`).
- [x] `DECISIONS.md` written — 13 sections, every choice mapped against what the
      pipeline's two runs did instead.

**M1 COMPLETE.** Milestone 2 (assets) NOT started, per instruction.

## Milestone 2 — world + assets

Backend tooling is used STANDALONE and READ-ONLY: `babble-games-backend` is never
modified and the generation pipeline is never run. Only two things are imported —
`app.config.settings` (API key) and `app.services.tripo_service` (HTTP client) —
plus the bpy sidecar scripts, invoked directly as subprocesses.

- [x] Oriented: read BUILD_STATE + DECISIONS, skimmed all 22 `src/` modules.
      Integration seams identified: `AvatarModel` (player), the inline soldier
      visual in `ai/enemy.ts` (needs the same treatment), `world/environment.ts`
      (sky + IBL + exposure), `world/arena.ts` (one spec list → mesh + collider).
- [x] Mapped the backend contracts: Tripo v2 rest-pose chain
      (`create_task` `model_version=v3.1-20260211` + `TPOSE_TEMPLATE` →
      `convert_to_lowpoly` → `download_model`), the bpy-sidecar autorig CLI
      (`derive_landmarks.py <model.glb> <out.json> [fwd] [--species=]` then
      `build_rig.py <model.glb> <landmarks.json> <method> <out_rig.glb>
      <species_template.glb> [skeleton_type]`, interpreter
      `ec2/bpy-sidecar/.venv/bin/python`, bpy 5.2.0 LTS), and the 221-clip
      CC0 animation library (`animation_library/clips/human/`, 66-joint human
      skeleton).
- [x] `assetgen/tripo_gen.py` — standalone Tripo driver (not the pipeline).
      Declares the whole asset ledger as one prompt table, writes a receipt JSON
      per asset (task ids, credit cost, balance delta, byte sizes).
- [x] Tripo credit balance verified: **20,175** before any M2 spend.
      Published costs: `text_to_model` 40, `highpoly_to_lowpoly` 30 per asset.
- [x] Enemy soldier generation submitted (T-pose mandate, PBR on, low-poly convert).
- [x] Prop batch submitted (crate, jersey barrier, sandbag wall, watchtower,
      antenna mast, oil drum) — 3-way parallel, `face_limit=4000`.
- [x] `assetgen/bake_textures.py` — seamless PBR baker (concrete, plaster, metal,
      sand, ground slab; grime/hazard/stencil decals; ground blend mask). Periodic
      value-noise lattice → exact wrap. **Bug found and fixed in it:** a guard
      that SKIPPED non-dividing octaves was a silent zero and baked 3 of 5
      materials as flat colour; now snapped up front and `value_noise` raises.
      Added a seam audit that fails the bake above 1.5× (worst shipped 1.486).
      Payload trimmed 9.13 MB → 4.3 MB (albedo JPEG 1024, data maps PNG 512).
- [x] Sky: `hdri_industrial_dusk` (Poly Haven `industrial_sunset_02_puresky`,
      CC0) pulled from `s3://babble-games-projects-test/shared/sky-cubemaps/`.
      `assetgen/sky_sun.py` MEASURED its sun off the pixels: azimuth +126.0°,
      elevation **+2.4°**; horizon `#79848e`, zenith `#376897`, sun-side `#eed087`.
- [x] `src/world/environment.ts` rewritten: cube background + PMREM
      `scene.environment` for both scenes, sun azimuth matched, elevation raised
      to 24° (2.4° would put the whole compound in a 143 m wall shadow), sky
      rotated by a DERIVED angle so plate-sun and key light cannot drift apart.
- [x] Enemy soldier generated (Tripo, T-pose mandate verbatim from
      `TPOSE_TEMPLATE`, PBR on, low-poly convert): 42.1 MB raw → 3.02 MB.
- [x] Auto-rigged + animated standalone via `assetgen/rig_soldier.py`:
      health check → **T-pose gate (usable, score 0.902, span 1.004, droop 6.8°)**
      → `derive_landmarks.py` → `build_rig.py` → 6 × `native_apply.py` →
      6 × `strip_to_animation.py` → `analyze_glb.py` name verification.
      **66/66 shared bones on every clip, all 6 clip names verified, 28.4 s.**
      Clips: idle=Idle_A, walk=Walk, run=Jog, aim=Pistol_Idle, fire=Pistol_Shoot,
      death=Death_B (the library has NO rifle animations — see DECISIONS §15.1).
- [x] Model FACING derived by measurement (`foot_l → ball_l` = Blender −Y →
      glTF +Z), so `YAW_OFFSET = π`. Nothing in the GLB records it.
- [x] `src/player/soldier.ts` — `RiggedSoldier` implements `AvatarModel` and is
      used by BOTH the player avatar and every enemy. SkeletonUtils clone,
      measured scale normalisation + precise-bounds seating, smoothed weight
      field (not a crossfade FSM), speed-matched playback, head-bone visor
      telegraph.
- [x] `src/ai/enemy.ts` — capsule build kept as the fallback, rigged soldier
      swapped in. State→clip map is a direct read of the doctrine, so the
      animation cannot contradict the never-fire-while-moving rule.
- [x] `src/player/avatar.ts` — THE M1 SEAM USED, one line. Player = same soldier,
      different tint.
- [x] `src/world/assets.ts` — loud-on-failure asset layer (report + zero-failure
      assertion + console error), soft in the frame (every failure falls back).
      `Game.init()` is a second phase; `window.__FPS__` is published only after it.
- [x] `src/world/arena.ts` re-skinned: massing unchanged, PBR per surface, M1
      value ladder preserved as tints, wall-top coping, hazard/grime/stencil
      decals, 7 Tripo props FITTED to their colliders (`fitToBox`, uniform scale,
      seated on the box floor), two ground materials at non-harmonic scales
      (0.28 / 0.11 tiles/m), terrain berm.
- [x] Berm retuned after measuring: an 11 m ridge at 100 m sat entirely BELOW
      the wall-top sightline and was invisible from the floor. Now inner 28 m,
      crest ~60 m, 24 m high, outer skirt driven below ground so it passes under
      the horizon rather than ending on a circular edge.
- [x] Prop batch generated (crate, jersey barrier, sandbag wall, watchtower,
      antenna mast, oil drum) + carbine. All 8 assets OK.
- [x] **GLB optimiser incident:** `gltf-transform optimize` with draco turned
      every 2.6 MB prop into a 3 KB file, **exit code 0, no warning**. Restored
      from originals and rebuilt the rig. Replaced with
      `assetgen/optimize_glb.py` — narrow commands + a STRUCTURAL gate (parses
      the GLB JSON chunk, compares mesh/primitive/node/accessor/animation/skin
      counts and vertex totals before and after). 17.8 MB → 4.2 MB, proven lossless.
- [x] `requestFrameStats()` — samples the real composited canvas; the suite now
      asserts mean luminance in a readable band, < 12% clipped white, < 20%
      crushed black. Measured **mean 0.257, 0.0% white, 1.5% black.**
- [x] **USER-REPORTED BUG FIXED: W/S were inverted.** `wishX = ix*cos − iz*sin`
      negated the forward terms; W drove the player backwards along their own
      look vector. It survived M1's "41/41 × 5 clean runs" because the assertion
      measured a DISTANCE, which has no sign. Basis rewritten explicitly; TWO new
      assertions added that project displacement onto forward and right, so an
      inversion is now red.
- [x] Engine defect found via a FLAKE: `fireOnce()` read
      `camera.getWorldDirection()`, but `updateCamera()` runs later in the frame —
      every shot in the game left the barrel along the PREVIOUS frame's aim.
      Now built from `player.yaw/pitch + recoil` in the same YXZ basis.
- [x] Engine defect: test-only `teleport` resolved only the vertical axis, so
      M2's 8 new colliders could strand the player inside a solid box (after
      which every shot hit its inside face at ~0 m). Horizontal push-out added.
- [x] Hit-registration assertion de-raced at the SETUP, not the claim: it now
      re-closes to 5 m before each round instead of letting a 3.5 m/s target
      walk behind cover mid-sequence.
- [x] Carbine generated + verified (AR-pattern, optic on rail, clear barrel
      axis; 2.78 MB → 654 KB; 50 credits). **Integration deliberately deferred to
      M3** — the ADS alignment is geometric (M1 §2.5) and needs the optic/muzzle
      measured off the mesh; see DECISIONS §24.
- [x] Tripo spend: **20,175 → 19,725 = 450 credits ($4.50)** for 8 models.
      Documented per-task costs predicted 560, so the published table
      over-estimates by ~1.25× (clean single-asset measurement: 50, not 70).
- [x] `DECISIONS.md` extended with M2 §14–§24, including the **friction log
      (§22)** — 12 entries on where the pipeline's own parts fought a careful
      operator. That is the primary M2 deliverable.
- [x] Hit-registration flake fully diagnosed — **four separate causes**, two of
      them real ENGINE defects shipping in M1 behind a green suite (stale-frame
      aim; vertical-only teleport), one a green test computing a hit rate over a
      denominator of ONE (the player died, and the fire cooldown only ticks while
      `phase === 'playing'`, so 7 of 8 rounds silently never fired), one a
      stand-off bearing chosen geometrically that could sit behind the bunker.
      Added `Game.hasLosTo(enemyId)` (test-support API in the same family as
      `auditEnclosure()`, running the engine's own `hasLineOfSight`) so the
      harness picks a firing position with a genuinely clear line. Full write-up
      in DECISIONS §25.
- [x] New assertion: **every round the harness asks for must actually leave the
      barrel** — the check that would have caught the denominator-of-one bug.
- [x] Screenshot composition: the mechanics block (movement → hit registration)
      now runs invulnerable, so measurements are not corrupted by a dying player
      and frames are not flooded by the damage vignette. The doctrine block still
      runs fully vulnerable — "enemies damage the player" is its own assertion.
- [x] 7th screenshot added: `07_enemy_closeup.png` — a rigged hostile at ~4 m in
      a planted combat state (braced aim pose, visor telegraph lit, front on).
- [x] Texture baker hardened: **per-material seeded RNG**. The whole bake shared
      one stream in call order, so editing ONE material silently re-rolled every
      material baked after it (changing a plaster noise period moved
      `ground_slab`'s slab-tone draw and failed its seam gate at 1.957 on a
      texture that had not been touched). Seam audit now worst **0.892**.
- [x] Seam metric corrected: baseline is the 99th-percentile interior row
      difference, not the mean, so a texture with deliberate hard edges (slab
      joints) is not failed for having them.
- [x] Berm rebuilt as a meandering RIDGELINE (crest radius varies with angle, 5
      theta harmonics, soft shoulder) after the first version rendered as a ring
      of smooth cones. Fog raised to 0.0115 so the far ridge dissolves.
- [x] Plaster de-banded (base period 6 → 32); at 0.34 tiles/m the old waves read
      as wood planking on a 6 m wall.
- [x] Dev server verified: `npm run dev` → http://localhost:5178/ — 200 on
      index, `/src/main.ts`, `/models/soldier.glb`, `/sky/px.png`,
      `/textures/concrete_albedo.jpg`.
- [x] Shipped payload **13 MB** total (models 6.1 MB · textures 5.1 MB ·
      sky 2.3 MB); JS bundle 713 kB / 188 kB gzip.

**M2 COMPLETE — 52/52 assertions.** Milestone 3 (audio, post-processing,
carbine viewmodel integration, weapon in soldier hands) NOT started, per
instruction.

## Milestone 3 — polish, postfx, audio, carbine

- [x] Oriented cold from BUILD_STATE + DECISIONS; re-read `config.ts`, `game.ts`,
      `world/environment.ts`, `world/assets.ts`, `weapons/viewmodel.ts`,
      `player/soldier.ts`, `ai/enemy.ts`, `assetgen/bake_textures.py`,
      `tools/smoke.mjs`, and the 7 shipped screenshots. All three gate-review
      defects confirmed VISUALLY in `shots/07_enemy_closeup.png` and
      `shots/01_spawn.png`: (a) the visor telegraph is a flat cream slab floating
      clear of the face; (b) the `metal` material reads as blue/orange marble, not
      corrugated steel — the corrugation is invisible and the rust is a large
      organic bloom over a near-mirror surface; (c) the sky reads midday blue.
- [x] S3 shared sky library enumerated (21 templates). Real dusk candidates exist:
      `hdri_dramatic_sunset`, `hdri_golden_sunset`, `hdri_twilight_quarry`,
      `hdri_soft_dawn` — so "swap to a true dusk sky" is a sourcing decision, not
      a defence-of-daylight decision.
- [x] **GATE FIX (a) — visor telegraph.** M2's flat cream box replaced by an
      integrated wrapped goggle strip (cylinder-segment lens + matte housing +
      rear strap) in `player/soldier.ts`. Authored in METRES and converted via a
      factor MEASURED off the head bone's own world matrix — M2's numbers were
      un-scaled rig units, so its "0.16 wide" plate was really 0.29 m and its
      "0.1 forward" was 0.18 m. Rests DARK (emissive 0.35) and climbs to 4.2
      across the 400 ms wind-up; M2 rested at 0.9, already ACES-blown, so the
      telegraph had no headroom to brighten into.
- [x] **GATE FIX (b) — corrugated metal.** `assetgen/bake_textures.py`
      `mat_metal()` rebaked. Rib pitch DERIVED from the shipped tiling (1.1
      tiles/m → 0.909 m tile → 11 ribs at 82.6 mm, real cladding pitch; the old
      16 was 57 mm). Ribs re-oriented vertical, baked into the ALBEDO (0.139
      column-mean p-p) so they survive without the normal map, normal strength
      1.4 → 5.0. Rust rebuilt as small-scale directional streaks bled downhill
      from fixings/laps/pinholes, double-gated against lap-row banding,
      desaturated to iron oxide, 15.5% coverage. Roughness 0.60-0.91, metalness
      peak 0.50 (was floored at 0.18 / peaking 0.95 = a sky mirror).
      **Seam audit worst UNCHANGED at 0.892; other four materials verified
      byte-identical by md5.** Iterated 4× against a rendered preview that was
      actually looked at — iteration 2 measured fine and had grown a rust fringe
      along every lap row, which no number in the file would have caught.
- [x] **GATE FIX (c) — dusk sky.** `hdri_industrial_dusk` → `hdri_twilight_quarry`
      (Poly Haven drackenstein_quarry_puresky, CC0), pulled STANDALONE from the
      shared S3 sky library. Root cause recorded in `environment.ts`: the old
      plate's measured "elevation +2.4°" was a true statement about ONE PIXEL and
      said nothing about the 99.99% of sky the player looks at. The replacement
      was chosen on warm ARC coverage (100% of the horizon arc, median warm-wedge
      height ~23°, anti-sun faces neutral grey-blue) and the contact sheet was
      composited and LOOKED AT before installing. Sun re-measured independently:
      azimuth +126.0°, elevation +5.7°. All light/fog/fallback constants
      re-derived; FOG_COLOR taken from the SHADOW side of the horizon band (the
      straight sample turned the compound to milk) and fog density 0.0115 → 0.006.
- [x] **ENGINE DEFECT:** `assets.standard()` set `roughness`/`metalness` to 1
      UNCONDITIONALLY when a map existed, silently discarding every explicit
      override in `arena.ts` — including the shipping containers' `metalness:
      0.18`, which carries a comment explaining it fixes them mirroring the sky
      and **had never once executed**. Hid behind a comment asserting the
      opposite. Blanket per-surface defaults in `arena.ts` removed with it
      (they would have become a blanket scaling of every baked map).
- [x] `src/weapons/carbine.ts` — the generated AR fitted BY MEASUREMENT: scaled
      by its own bbox to 0.86 m; optic and bore located by region rules in
      NORMALISED bbox coordinates (survive a re-generation); model translated so
      the measured optic centre lands on `(0, SIGHT_HEIGHT)` so ADS is correct by
      construction; magazine SPLIT out of the single generated mesh (777 tris,
      sharing vertex buffers, differing only in index) so M1's reload mag-swap
      still works. Loud on failure: any region rule that catches nothing keeps
      the placeholder rather than shipping an unknown optic.
- [x] Reticle AUTHORED at the measured optical axis — Tripo modelled the shape of
      a red dot with no red dot in it, and an empty tube is an obstruction, not a
      sight picture.
- [x] Carbine in EVERY soldier's hands (hostiles + third-person avatar). Mount
      orientation DERIVED, not dialled in:
      `holderLocal = inverse(handWorld)·(rootWorld·Ry(π))`, with only a small
      stylistic cant on top. The first pass guessed Euler angles and produced a
      soldier holding a carbine vertically across his chest.
- [x] **ENGINE DEFECT:** the carbine was assigned `LAYER.VIEWMODEL` — a hangover
      from a pre-M1 design — making it invisible to the viewmodel camera (which,
      like every three.js camera, has only layer 0). Caught by M1's
      `viewmodel is actually on screen` assertion reading 0.00%.
- [x] `src/fx/postfx.ts` — SELECTIVE bloom on an explicit `markBloom()` allow-list
      (visor lens, muzzle flash, both tracer pools, sparks, reticle) via the
      darken-non-bloom two-pass method so occlusion stays correct and the dusk sky
      cannot bloom. Chain: `ScenePass → FinalPass (bloom mix + ACES + dusk grade +
      vignette + sRGB, folded into one pass) → SMAA`. Tone map moved into the
      final pass (three only tone-maps canvas draws) and copies three's ACES
      verbatim so postfx on/off agree — asserted, Δ0.026.
- [x] **FRAME COST MEASURED** on Apple M4 / ANGLE-Metal at 1600×900, vsync on,
      120-frame window: postfx OFF **16.67 ms**, FULL **16.67 ms** (locked 60),
      no-SMAA 16.67, no-bloom/SMAA 16.66. **GTAO 18.9-22.8 ms mean, 33.4 ms p95
      = 44-53 fps → AO SHIPS OFF**, available in settings, number recorded.
      Harness prints the GPU string (headless Chrome can fall back to SwiftShader
      and a software frame cost is not a frame cost). Uncapping vsync to measure
      headroom starved the compositor and corrupted the luminance probe — reverted.
- [x] **LATENT SHADER BREAK found by instrumenting for perf:** three injects its
      own `RRTAndODTFit`/`ACESFilmicToneMapping` into any ShaderMaterial whose
      target is the CANVAS, so the final pass compiled fine mid-chain and failed
      the moment SMAA was disabled and it became last. Renamed `nf*`.
- [x] `src/audio/audio.ts` — SYNTHESISED WebAudio, not generated files (payload,
      layering/distance, determinism, defensibility — see DECISIONS §30). Gunshots
      as four layers (crack/body/action/tail, tail growing with distance),
      hit/kill confirms, reload foley scheduled against the REAL reload duration,
      distance-driven footsteps, wind + rumble bed, UI ticks, end stings.
      Mastered through a 20:1 limiter at −8 dBFS into a 0.62 master so the worst
      case cannot reach 0 dBFS. NEVER THROWS — failure is a recorded reason.
- [x] Feel: shell ejection (8 pooled cases in the viewmodel scene), muzzle-flash
      sprite + light driven from ONE shared `FLASH_MS`, polished death
      (directional shove along the shot line, per-soldier yaw twist, weapon
      dropped and falling to rest).
- [x] Settings toggles (post-processing / AO / audio) rendered into BOTH the start
      and pause screens from ONE definition, so an option cannot exist on one
      screen and not the other.
- [x] `tools/look.mjs` — fast visual/perf probe (~40 s vs the suite's ~4 min) for
      look tuning. Reports GPU, luminance on both paths from the SAME viewpoint,
      viewmodel coverage, ADS optic alignment, per-stage frame cost.
- [x] `tools/balance.mjs` — **difficulty MEASURED**, not guessed: a scripted
      competent player (bounded 4.5 rad/s turn, ~1.4° persistent aim error,
      220 ms reaction, continuous strafing, reloads at 4, no cover use) runs the
      real mission N times inside the page on rAF. Tuning history:
      **87.5% (16 runs, M2 as shipped) → 75.0% (20 runs, damage 9→13,
      headshot 15→22) → 62.5% (24 runs, + burst 3→4) = IN the 60-70% band.**
      `telegraphMs` and `spreadDeg` deliberately NOT touched: difficulty is bought
      with damage, which the player can respond to, not with information.
- [x] Smoke suite extended **52 → 64 assertions**: carbine fitted / optic on the
      ADS axis in model space / magazine split; postfx on by default and AO off;
      audio init does not throw and the graph came up; **ADS puts the optic ON the
      crosshair (0.14 px, tolerance 2 px)**; both render paths boot readable and
      agree on exposure; post-processing holds a playable frame rate.
      The optic assertion caught its own subtlety — at 450 ms the ADS pose is
      still ~0.3% short and read 3.32 px, so the harness now lets the filter
      settle rather than the tolerance being widened to cover a real transient.
- [x] `DECISIONS.md` extended with §26-§34, closing with the **DISSECTION SUMMARY
      — top 10 divergences**, each phrased as a concrete pipeline change. That
      section is the primary deliverable of the exercise.
- [x] `tools/clip.mjs` — 6 s recorded run (`shots/run.gif`, 2.8 MB), driven by the
      SAME competent-player bot as `balance.mjs` so what the clip shows and what
      the win-rate measurement measured are the same thing. First version used
      `page.screenshot()` in a loop and managed 2.6 fps (a slideshow of a fight);
      switched to CDP `Page.startScreencast` and captures at ~60 fps real-time.
      Playback duration is DERIVED from the measured capture rate, not assumed.
- [x] **M3 VERIFIED: 64/64 assertions, ALL GREEN.** Key numbers: carbine fitted
      (13,734 verts, 0.86 m, optic local (0.000000, 0.093000), 777 mag triangles)
      · **ADS optic lands 0.01 px from screen centre** · viewmodel 5.89% hip /
      8.76% ADS (budget 15%) · frame luminance 0.172 postfx-ON / 0.199 postfx-OFF,
      Δ0.026, 0.0% clipped white, 1.5% crushed black · postfx 16.67 ms = locked 60
      · enclosure 0 leaks · AI doctrine 0 violations, all six states observed ·
      audio graph live · 0 console errors or warnings.
- [x] Fresh 7-screenshot set captured into `shots/` at the same angles as M1/M2
      plus the enemy close-up.
- [x] Dev server verified: `npm run dev` → http://localhost:5178/.

## Milestone 3 — user-reported additions (mid-M3)

- [x] **USER BUG: background mountains/dunes flicker + lighting issues.** DIAGNOSED
      by measurement, not guessed. New `tools/flicker.mjs`: parks the camera and
      measures inter-frame difference, then sweeps it and measures the SECOND
      temporal difference (smooth pan ⇒ smooth change; anything that FLIPS spikes
      it), with post-processing on and off.
      · Static camera: **0.000/255 on both paths** — no instability at rest.
      · Under a pan the terrain BODY is stable and only the SILHOUETTE lights up,
        which **disproves z-fighting and shadow acne** (both make noise ACROSS a
        surface, not along its outline). Neither was "fixed".
      Causes found: (A) tessellation — `RingGeometry(28,240,192,22)` = 1.875°/seg
      = a 3.3 m facet at 100 m, so `computeVertexNormals` produced hard shading
      breaks (visible as straight-edged triangular facets down the dune flank in
      `shots/diagnostics/terrain_before_after.png`) and straight silhouette
      segments that crawl. Raised to **384×40**; A/B confirms continuous shading.
      (B) postfx silently discards hardware MSAA (`antialias:true` is
      default-framebuffer only; EffectComposer allocates `samples:0`) — REAL, and
      **measured at +11.7 ms for 4× / +7.1 ms for 2× on a half-float target**, so
      it does NOT ship; the line stays at 0 with the cost table beside it.
      (C) shadow camera was ±32 m while the berm starts at r=28 m with
      `receiveShadow`, and a 6 m wall at 22° throws a ~14.9 m shadow — a hard
      circular lighting discontinuity at r=32. Widened to ±40 m.
      **The probe's own first version called `killAll()`, which WINS the mission
      and puts a static DOM panel over the measured band — it reported a
      reassuring 0.00%.** Recorded in DECISIONS §35.
- [x] **USER REQUEST: see-through scope.** New Tripo generation `carbine_optic`
      (70 credits) with a prompt restating the aperture six ways ("HOLLOW OPEN
      TUBE", "the hole is empty air"). New `assetgen/aperture.py` fires a ray grid
      down the sight line and counts triangle crossings — the only way to tell a
      hole from a dark recess. **Verdict: BOTH generations SOLID, zero clear rays
      through the optic core.** Tripo models the shape of a sight, not a hole.
      · The probe's FIRST verdict was wrong (it counted clear rays in the corners
        of a rectangular sample box and declared the solid tube OPEN). Criterion
        rewritten to test the centre of the MATERIAL. Third instance in this build
        of a measurement that was true and useless.
      · Fallback implemented as briefed: **generated base + authored functional
        optic.** `stripRegion()` deletes the 776 generated optic triangles; an
        authored torus housing + tube + front ring + mount post replaces them,
        with **nothing in the middle** — not even a transparent lens. The
        viewmodel is drawn over the already-rendered world, so the aperture IS
        the absence.
      · TWO region rules, deliberately: `optic` (v>0.80) defines the optical AXIS
        and stays tight; `opticStrip` (v>0.72, wider) only removes material.
      · New assertion: `probeSightLine()` raycasts −Z from the viewmodel camera
        (the real ADS sight line) and the suite asserts it is CLEAR.
      Recorded in DECISIONS §36.
- [x] Boot path `?postfx=0` added — post-processing off is now reachable from
      COLD, not only via the in-session toggle, with its own assertions.
- [x] **68/68 assertions ALL GREEN.** carbine fitted (13,734 verts, 776 optic tris
      stripped, 777 mag tris split) · aperture clear · ADS optic 0.01 px from
      centre · viewmodel 5.77% hip / 8.22% ADS · postfx ON 16.67 ms = locked 60 ·
      AO 28.9 ms → stays OFF · cold no-postfx boot clean.
- [ ] **M4 — MULTIPLAYER: NOT STARTED, by instruction** (after the M3 gate).
      Brief on file: co-op 2-4 players vs the AI; authoritative Node/TS WebSocket
      server in `server/`, one command alongside vite; server-authoritative enemy
      AI + hit validation; client prediction for own movement + snapshot
      interpolation (10-15 Hz) for remotes; room-code join; remote players use the
      existing soldier avatar + name tags; shared kill feed; single-player must
      keep working fully offline with the server absent; smoke extended to boot
      server + two headless clients and assert they see each other move and share
      enemy state.
- [x] **Difficulty re-measured, and the MEASUREMENT ran out of resolution.**
      damage 13 → 12 scored **53.1%** (32 runs) — WORSE than the same-or-harder
      build's 62.5% (24) and 57.5% (40). A change that can only make the mission
      easier cannot lower the win rate, so that is noise. At n=32 the standard
      error on a proportion near 0.5 is ~8.8 points and the 95% interval is ~35
      points wide, against a target band 10 points wide; resolving it would need
      ~400 runs per configuration. **Shipped: damage 13 / headshot 22 / burst 4,
      pooling 38 wins in 64 runs = 59.4%, 95% CI ≈ [47%, 71%]** — the
      best-supported estimate, whose interval contains the band. `balance.mjs`
      now prints the CI and refuses to call a band it cannot resolve. DECISIONS
      §32.1, and it amends dissection item 9: a plan must state the band AND the
      sample size, and the tool must report an interval, not a bare percentage.
- [x] **FINAL: 68/68 assertions ALL GREEN**, fresh 7-shot set, dev server 200 on
      index + `/src/main.ts` + soldier/carbine GLBs + sky + textures.

## Milestone 4 — MULTIPLAYER (co-op vs the AI)

- [x] **Chunk 1 (`10b5a32`) — authoritative server.** `server/index.ts` (ws on
      :8787, `/health` so a harness can wait for readiness instead of sleeping a
      hopeful number of ms, room codes from a no-0/O/1/I/5/S alphabet) and
      `server/room.ts`. The headline: the room runs **the game's own `Enemy`,
      `NavGraph`, `CollisionWorld` and `arenaLayout()`** — the same 106 collider
      specs and 328 waypoints the browser builds — not a server-side
      reimplementation. A multiplayer server that reimplements its game's AI is a
      second game, and it diverges the first time somebody tunes a number.
      Authority split, stated in `src/net/protocol.ts`: enemies SERVER-AUTHORITATIVE,
      hits SERVER-VALIDATED (the client sends an origin and a direction, nothing
      else), player movement CLIENT-AUTHORITATIVE **by choice** — there is nothing
      to gain by cheating at walking, and the thing worth protecting (who killed
      what) is already validated.
- [x] **Chunk 2 (`8f40922`) — client integration.** `src/net/client.ts` (socket,
      snapshot ring, interpolation at `now − 120 ms` between two snapshots that
      have ALREADY ARRIVED, never extrapolated; yaw the short way round the
      circle), `src/net/remote.ts` (teammates are the same `RiggedSoldier` +
      generated carbine as everything else, friendly tint + name tag; locomotion
      RECONSTRUCTED from consecutive snapshots rather than sent), `Enemy.networked`
      (visual half only in a room), and the `Game` wiring. Design constraint above
      everything else: **`src/net/` must be removable** — `Game.net` is null in
      single player, nothing in boot touches it, every use is guarded.
- [x] **SINGLE-PLAYER REGRESSION, server absent: 67/68.** The one failure is not a
      regression, it is the machine: *"post-processing holds a playable frame
      rate"* read **40.28 ms** against a <33 ms bar, on a box carrying a load
      average of **7.4 (1 min) / 12.2 (5 min)** with a browser pinned at 90% CPU,
      rendering through SwiftShader (software GL) because headless Chrome has no
      GPU here. The same assertion read 16.67 ms at M3 on the same code path. The
      assertion is CORRECT and is not being touched; it is re-run on a quiet
      machine below rather than widened, which is the M3 rule (a real transient is
      waited out, not covered by a looser tolerance).
