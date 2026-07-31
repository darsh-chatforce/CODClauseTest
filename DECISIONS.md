# DECISIONS — Operation Nightfall (hand-built reference FPS)

Every meaningful choice, why it was made, and — where it is known — what the
generation pipeline's two attempts did instead.

Pipeline evidence: `../local-3d-research/BASELINE_COD_BUILD.md` (v1, judge 4/10,
calibrated 3/10) and `../local-3d-research/REBUILD_COD_V2.md` (v2, judge 2/10 six
times, calibrated 3/10). Craft references read before writing any code:
`babble-games-backend/ec2/app/game_generation/agentic/skills/threejs3d/genre-playbooks/first_person_shooter.md`
and `.../threejs-gameplay-systems/references/game-feel.md`.

Milestone 1 scope: **core playable, graybox, zero art assets.** Anything marked
STUB below is deliberately deferred to M2.

---

## 0. The thesis

Reading both dissections, almost nothing that made those builds a 3/10 was an
engine limitation. The v1 report says it outright: *"every top item is an
integration/direction failure."* The failures cluster into three kinds:

1. **Framing/transform failures** — the viewmodel (a black blob at ~25% of the
   frame, named by the judge four times across two runs and never fixed), the
   third-person avatar (a cyan debug cube because `registerPlayerAvatar` was
   never called), a missing perimeter wall.
2. **Direction failures** — a staged library sky fighting a bespoke generated
   sky; flat lighting; no crosshair in v1.
3. **Verification failures** — the loop could prove it *compiled and booted* but
   could not prove it *played*, so the extra budget went into re-proving rather
   than fixing.

So this build's organising principle is: **every property the pipeline got wrong
is an automated assertion here, not a comment.** `tools/smoke.mjs` runs 41 of
them against the live simulation. The three that matter most:

| pipeline failure | assertion here | current value |
|---|---|---|
| shipped a compound with a missing wall | 1600-ray enclosure audit from 25 interior points × 16 bearings × 4 heights | **0 leaks** |
| viewmodel a black blob at ~25% of frame | exact rasterised viewmodel coverage, offscreen render + pixel count | **4.5% hip / 9.2% ADS** (budget 15%) |
| enemies fire while moving (v2 §6) | disjoint state sets + hard velocity zeroing + continuous in-engine frame audit + 120 sampled state/speed pairs | **0 violations** |

---

## 1. Platform

### 1.1 WebGL only. No WebGPU.
The pipeline's WebGPU path broke in **both** runs and in different ways: v1
threw continuous `GPUValidationError` on a cube/env binding and rendered dark
with no IBL (D6); v2 threw `TypeError: Cannot read properties of null` in
`three.webgpu` `updateTexture` and **never booted at all** — stuck at
`LOADING 0%` (D6/N6). Both were invisible to the pipeline's own probe and judge
because those force WebGL.

A reference build's job is to be the thing that definitely works. `WebGLRenderer`,
one path, tested. Novelty is not on the M1 critical path.

### 1.2 Vite + TypeScript, `strict` + `noUnusedLocals` + `noImplicitOverride`.
`npm run build` runs `tsc --noEmit` before bundling, so a type error is a build
failure. Commit-quality is a stated requirement — this project may be vendored.

### 1.3 One tuning surface: `src/config.ts`.
Every feel-critical number (speeds, accelerations, timings, spreads, trauma
values, poses) is a named constant in one file with a comment explaining the
intent. A tuning pass is a diff to one file, and "what is tuned vs what is a
placeholder" has a literal answer.

---

## 2. The viewmodel — the pipeline's signature failure

This is the single most important file in M1 (`src/weapons/viewmodel.ts`). The
judge named the same defect in v1 rounds 1/2/3 and v2 rounds 1/2/4/5 — seven
blocking findings across two runs — and it was never fixed. Four structural
decisions make that class of failure impossible here rather than merely unlikely.

### 2.1 The viewmodel lives in its own `THREE.Scene` with its own camera.
Rendered in a second pass with `autoClear = false` + `clearDepth()`. Consequences,
all of which are structural rather than tuned:
- the gun **cannot** clip through world geometry (different depth buffer);
- its FOV is independent of the world FOV, so the ADS FOV pull (75° → 48°) does
  not warp the weapon;
- world fog cannot desaturate it.

*Pipeline:* v2's code was actually right in principle — `camera.add(w)` with a
shape guard rejecting non-elongated meshes — and the render was still wrong. A
camera-parented mesh in the main scene inherits the world's depth buffer, fog and
lighting; every one of those is a way to end up with a black blob.

### 2.2 The viewmodel scene carries its **own three-point lighting rig** plus IBL.
A key, a fill, a rim, an ambient, and a `scene.environment` prefiltered from a
procedural dusk equirect. A first-person weapon that depends on world lighting
*will* eventually be a silhouette — at dusk, indoors, in shadow. Here it cannot be.

This also fixed the one instance of the same bug in this build: metallic
materials with no environment map render **black** (no diffuse term, nothing to
reflect). The first render of this project's own gun was a dark slab for exactly
that reason. `applyImageBasedLighting()` in `src/world/environment.ts` generates
a 256×128 canvas sky, PMREMs it, and assigns it to *both* scenes. Zero asset
files.

*Pipeline:* D5 — v1 gated `setEnvironmentFromTexture` behind `CF_HEADLESS`, so
the judge scored a frame lit differently from the shipped game. v2 fixed the
guard and the frame was still wrong (D10): a staged library cubemap beat the
coder's own generated sky.

### 2.3 The 15% screen budget is **measured, not asserted by eye**.
`measureScreenCoverage(renderer)` renders the viewmodel scene alone into a
192×108 offscreen target with a transparent clear and counts covered pixels. Not
a bounding-box estimate — the real rasterised silhouette, so the budget cannot be
gamed by a thin diagonal prop. The smoke test asserts it at hip **and** at ADS,
and also asserts it is `> 0.5%` so "shrink it to nothing" is not a passing
strategy.

Measured now: **4.45% hip, 9.24% ADS.** Budget 15%. Pipeline: ~25%.

Tuning that landed there: viewmodel FOV **68°** (wider than the world FOV — it
shrinks the footprint and flattens the near-camera foreshortening that makes a
prop read as a slab), hip pose `(0.235, −0.20, −0.70)`.

### 2.4 Poses are named and blended; sway/bob/recoil/reload are additive layers.
`hip` / `ads` / `sprint` are three named transforms in `config.ts`, blended by
weight and smoothed with a time-constant. On top of that, in order: look
counter-sway, walk bob, recoil spring (`root`), and the reload animation (`anim`,
a separate group so it composes instead of fighting).

This is the M2 seam: `setModel(object, muzzleLocal, magazine)` replaces
`buildPlaceholderRifle()` and **every layer above keeps working**.

### 2.5 ADS alignment is geometric, not eyeballed.
The placeholder rifle's optic glass sits at model-space `y = SIGHT_HEIGHT = 0.093`,
and the ADS pose is `y = −0.093, x = 0`. The optic therefore lands exactly on the
screen centre, under the crosshair, by construction. `shots/03_ads.png` shows the
red dot dead-centre. Geometry behind the eye is near-plane clipped, which is what
real shooters do.

*Pipeline:* v2 round 4 — *"flat near-black silhouette floating in the lower-right,
not under the crosshair."*

---

## 3. Player controller

### 3.1 Acceleration as *rates*, not lerp factors.
`groundAccel = 62 m/s²`, `groundDecel = 48 m/s²`, applied against a target
velocity with `moveToward`. Not `lerp(v, target, 0.2)`. Consequence: identical
feel at 60 Hz and 144 Hz. Every smoothing operation in the project uses
`damp(current, target, tau, dt)` — an exponential with a time constant — for the
same reason.

Speeds: walk **5.1 m/s**, sprint **7.3 m/s** (the brief's "~7 m/s run"), crouch
2.5, ADS 3.2. Decel close to accel gives ~0.15 s from full sprint to a dead stop
— the "snappy stop". Asserted: `< 0.4 m/s within 220 ms of release` (measures
0.000).

### 3.2 Coyote time (110 ms) + jump buffering (130 ms).
Invisible, and the reason jumping off a stair edge never eats an input. Jump
apex measures 0.86 m.

*Pipeline:* v2's report could only say *"jump is inconclusive"* — the key binding
was consumed but `playerY` did not change at sample time. It never established
whether jumping worked.

### 3.3 Recoil is not stored on the player.
The weapon owns an additive `recoilPitch`/`recoilYaw` that springs to zero, and
folds a **retained 22%** into the player's actual aim. So the gun climbs and the
player must pull down (skill), while the rest recovers (comfort). The player's
own aim and the gun's kick never fight over one variable.

### 3.4 Crouch checks headroom before standing.
Holding `C` crouches; releasing under an obstacle keeps you crouched.

### 3.5 Damage is directional and readable, with no regeneration.
`healthRegenPerSec = 0` for M1: a readable damage economy is more useful for
tuning than a forgiving one.

---

## 4. Collision and level geometry

### 4.1 An AABB world, on purpose.
The compound is boxes, so an axis-aligned box world is *exact*, allocation-free
and debuggable — not a compromise. Characters are vertical cylinders.

### 4.2 Elevation via a step-up rule, not slopes.
Boxes whose top is within `stepHeight = 0.46 m` of the feet are treated as
walkable surfaces, not walls. The staircases are 10 boxes of 0.30 m rise each, so
they Just Work with zero slope maths — and enemies climb them with the identical
rule. Two elevations, ramps unnecessary.

### 4.3 Geometry and collision come from **one spec list**.
`buildArena()` builds an array of box specs and then, in a single loop, creates
both the mesh and the collider from each. They cannot drift apart.

### 4.4 Fully enclosed, and proved.
Four perimeter walls at 6 m plus buttresses. `auditEnclosure()` fires 1600 rays
(25 interior points × 16 bearings × 4 heights) and requires every one to be
stopped by geometry. **0 leaks.**

*Pipeline:* v1 shipped a compound with a missing wall. Nothing checked.

### 4.5 Layout is composed, not scattered.
40 × 40 m. A three-deck elevated firing line at 3.0 m along the north and east
walls, reached by two staircases and edged with waist-high railings (cover). A
central bunker that breaks the corner-to-corner diagonal. 16 crates (some
stacked, vault-height), 10 jersey barriers (crouch cover), 5 containers (full
sightline blockers). Design goal: **no position on the floor from which every
other position is visible.**

### 4.6 Graybox palette is a value ladder.
Floor darkest → walls → terrace → cover pieces lightest, in ~10% luminance steps.
Form reads from value alone, and the things you can hide behind pop out of the
ground plane. Zero textures.

---

## 5. Lighting and look

### 5.1 The sun elevation is a *gameplay* number, not only a look number.
The first pass used an 11° sun for maximum drama. A 6 m perimeter wall at 11°
casts a **31 m** shadow across a 40 m arena — the entire floor went black and the
level was unreadable (see git history; the first `01_spawn.png` was a black
frame). Settled at **28°**: a ~12 m rake, still unmistakably dusk, compound lit.

*Recorded because it is the general lesson:* raking light is a look; an unlit
level is a bug, and a still-frame judge cannot tell you which one you have.

### 5.2 Ambient budget: shadowed surfaces must still read.
Hemisphere at 2.4 (warm ground bounce, cool sky), a cool bounce fill from the
opposite side, ACES tonemapping at 1.15 exposure. A dusk palette is about hue and
contrast, not about crushing values below the display floor.

*Pipeline:* v1 judge round 2 — *"surfaces flat and matte, no specular variation;
frame tonally flat."* v2 — *"Lighting is flat… the frame is a midday blue sky
over a flat plane."*

### 5.3 Procedural sky, no image asset.
A gradient + sun-scatter shader on an inverted sphere, with the sun disc at the
directional light's own azimuth so the sky and the shadows agree. The first
version measured the gradient from the nadir, which put the warm band in the
wrong hemisphere; it now measures from the horizon up.

*Pipeline:* D10 — a staged library sky (`golden_sunset`, pink/purple cartoon
sunset with a flat red semicircle sun) beat the coder's own generated dusk sky in
**both** runs, and in v2 the code was right while the frame was still wrong.

### 5.4 Image-based lighting from that same sky.
See §2.2. One PMREM shared by the world and viewmodel scenes.

---

## 6. Weapon system

| property | value | note |
|---|---|---|
| magazine / reserve | 30 / 120 | |
| fire rate | 720 rpm (83 ms) | full-auto on hold |
| reload | 2050 ms / **2600 ms empty** | bolt catch; real timer, real animation |
| damage | 26, ×2.2 headshot | 4 body shots to kill |
| recoil | learnable 30-entry **pattern** | not noise |
| recoil retained | 22% | the rest springs back |
| spread | stance-derived + per-shot bloom | ADS 0.06° … sprint 3.4°, cap 4.5° |

### 6.1 The recoil pattern is learnable.
A 30-entry yaw-multiplier table: the first rounds climb, then the muzzle drifts
right and walks back left. A player who learns it is rewarded. Random-per-shot
recoil is unlearnable and therefore not a skill.

### 6.2 Bloom recovers *slower* than the fire rate.
`+0.5°/shot`, `−2.4°/s`. Holding the trigger loses accuracy; tapping keeps it.
That trade is the core skill expression of an automatic weapon. Measured:
0.35° → 2.61° over a 0.52 s burst, back to 0.35° after 1.6 s.

### 6.3 The crosshair gap is **derived from the cone**, not decorative.
`hud.setCrosshairSpread()` projects the weapon's current half-angle through the
camera to pixels. What the player sees is literally where their rounds can go.
Sprinting visibly blows it open; ADS collapses it to the dot.

### 6.4 Hitscan damage, visible bullets.
Damage resolves on the trigger frame (fair, latency-free); every shot also spawns
an instanced tracer that flies the real path at 320 m/s. Enemy hit volumes are a
**capsule** (body) plus a **sphere** (head) — a capsule reads far better than an
AABB when grazing a shoulder, and it costs a dozen flops.

### 6.5 Misses produce feedback too.
Sparks + a lingering bullet-hole decal + a brief world point light. A shooter
where only hits give feedback teaches the player nothing about where their spread
went.

*Pipeline:* v1 — *"No gunplay feel visible in captures — no muzzle flash, recoil,
tracers, impact decals or hitmarkers in-frame."*

---

## 7. Enemy AI — the doctrine

**The rule (explicit design constraint): a soldier NEVER fires while moving.**

    patrol / advance  →  halt (180 ms)  →  aim (400 ms telegraph)  →  fire (3-round burst)  →  reposition

### 7.1 The rule is enforced three ways, and tested.
1. `MOVING_STATES` and `STATIONARY_COMBAT_STATES` are **disjoint sets**, and
   `setState()` hard-zeroes velocity on entry to any non-moving state.
2. `Game.updatePlaying()` runs a **continuous in-engine audit** every frame:
   any soldier in a planted state with `speed > 0.05 m/s` increments
   `aiViolations`. Counter exposed on the snapshot.
3. `tools/smoke.mjs` drives ~24 s of real play, samples all six soldiers every
   200 ms (720 state/speed pairs), and asserts both the sampled pairs and the
   engine counter are zero — **and** that the states `aim` and `fire` were
   actually reached, so the assertion cannot pass vacuously.

Result: **0 violations, worst speed 0.0000 m/s**, all six states observed.

### 7.2 This deliberately contradicts the genre playbook.
`first_person_shooter.md` mandates *"Enemies pursue and strafe; fire is aimed but
DODGEABLE."* The user's doctrine overrides it. The playbook's underlying goal —
dodgeability — is preserved by different means: a 400 ms readable telegraph, a
2.6° aim cone, and 3-round bursts with a 420 ms recovery. **Deviation recorded
deliberately.**

*Pipeline:* v2's shipped build had enemies that *"move and fire while moving"*
(v2 §6, red tracers mid-run). No mechanism prevented it and nothing tested it.

### 7.3 Facing is unambiguous — two cues, not one.
Soldiers face their **velocity** while moving (7 rad/s) and the **player** while
aiming (4.2 rad/s). Facing is shown by an emissive visor on the front of the head
*and* a chest chevron. Both were enlarged after the first screenshot pass showed
soldiers reading as featureless capsules at 25 m. One cue is not enough.

### 7.4 The telegraph *is* the facing indicator.
Visor emissive ramps 0.9 → 4.5 across the 400 ms wind-up and holds through the
burst. A soldier that has stopped and lit up is about to shoot — and that is
400 ms of warning to break line of sight. A hit landed during the wind-up spoils
it, so interrupting a telegraph is rewarded.

### 7.5 Navigation: a sampled waypoint graph, not a navmesh.
2 m grid over both storeys, standability-filtered, edges gated on climbable rise
and a clear midpoint, A* over the result. **333 waypoints.** Nodes carry a
`cover` flag (something ≥ 0.8 m tall within 1.8 m) and the firing-position and
reposition scorers bias toward them, so soldiers tend to stop next to something
rather than in the open. `debugPoints()` renders the graph — that is how it was
tuned.

Cost note: the firing-position scan is one LOS raycast per candidate node,
recomputed at most every 0.85 s per soldier, staggered by state. Cheap.

### 7.6 Perception is real.
130° cone (200° once alerted, because a soldier under fire is aware), 60 m sight,
LOS raycast against the collision world, 4.5 s memory of the last known position.
Being shot alerts a soldier.

### 7.7 Death is permanent and readable.
Flinch flash + a 900 ms collapse (fold, sink, settle) + a corpse that lingers 30 s.
The collapse runs through the same per-frame hook a rigged death clip will use at M2.

---

## 8. Player avatar / third-person inspect (T)

### 8.1 The seam is an interface with a working implementation, not a TODO.
`AvatarModel` = `{ object, eyeHeight, update(dt, params), dispose() }`, where
`params` carries real locomotion state (speed, normalised blend weight, stance,
aim pitch, firing, reloading, dead, elapsed) — exactly what an `AnimationMixer`
needs. `GrayboxAvatar` is a conforming implementation: an articulated blocked-out
soldier (torso, helmet, visor, two arms, two legs, carried rifle) driven by a
hand-written locomotion cycle, with spine/head aim tracking and a fire kick.
M2 is one line: `avatar.setModel(new GltfAvatar(gltf))`.

*Pipeline:* N3 — *"`registerPlayerAvatar` is never called. Pressing T shows the
scaffold's cyan placeholder cube."* The seam existed and was documented; the
coder skipped it. Defining the seam as an interface **with a default that already
animates** means the M2 model has something concrete to conform to, and the
inspect view is never a debug cube.

### 8.2 The orbit camera pulls in when blocked.
A raycast from the focus point; if a wall is closer than the orbit distance, the
camera sits 0.35 m short of it. An inspect view that ends up inside geometry
inspects nothing (the first capture did exactly that).

### 8.3 Gameplay keeps running during inspect.
It is an inspect view, not a pause. Player input is frozen; enemies keep acting.

---

## 9. HUD

DOM overlay, not canvas: zero draw calls, crisp text at any DPR, and trivially
assertable from CDP. Layout follows the playbook conventions — centre crosshair
(+ hitmarker), TL objective + hostiles, TC mission timer, TR kill feed, BL health,
BR ammo + reload bar.

Shipped: dynamic crosshair, health + damage vignette (ramps only below 60% so it
reads as an alarm, not as permanent screen dirt), ammo `30 / 120`, reload progress
bar, hostiles counter, objective banner, mission timer, kill feed with headshot
tag, hit marker (red on kill), directional damage arcs rotated into the player's
own frame, low-ammo and low-health states.

*Pipeline:* v1 shipped `Score 159 | Time 15s` in plain white text — **no crosshair
in a shooter** — after having extracted crosshair and magazine sprites from its own
concept and rendered none of them (D8). v2 fixed this and it was its single
biggest visible win.

---

## 10. Game feel

Applied in the order the game-feel reference prescribes (latency → response curves
→ contact → camera → audio), and with its anti-patterns treated as rules:

- **Trauma-based shake**, `trauma²` with a hard cap. Firing adds 0.11 (0.06 ADS),
  taking a hit 0.42, a kill 0.20, a hard landing up to 0.16. Small events barely
  move the frame; stacked events cannot fling it.
- **Hitstop on kills only** — 55 ms at 0.06 scale. Reserved for the heaviest
  event so it reads as weight, not as lag.
- **Two clocks.** `gameplayDt` is scaled by hitstop; camera, shake, HUD, tracers
  and impacts read the **real** delta. A frozen frame you cannot see is a hitch,
  not hitstop. `Game.frame()` is explicit about which system reads which.
- **FOV**: ADS pull and sprint widen are *smoothed state*; the damage/fire kick is
  *additive on top*, in a separate variable. Feeding the kick back into the
  smoothing filter made a damage kick permanently drag the resting FOV — caught by
  the smoke test asserting sprint widens the FOV, which failed while a firefight
  was in progress. Real bug, found by automation.
- **Landing dip** proportional to impact speed, spring-recovered.
- **Determinism**: seeded mulberry32 everywhere; `Math.random` is banned in
  gameplay and effect paths so scripted playtests and screenshot baselines are
  reproducible.

---

## 11. Verification

`tools/smoke.mjs` — 41 assertions, adapted from the backend's
`ec2/tools/webkit_touch_smoke.mjs` pattern (own copy; the backend repo was read
only). It serves the production `dist/` from an in-process static server, boots
headless Chrome via `puppeteer-core` against the system binary, and drives the
**real** input state through `window.__FPS__` — headless Chrome cannot enter
pointer lock, so look is injected into the same accumulator the real `mousemove`
handler writes. Every assertion reads the live simulation, not a mock.

Coverage: boot + WebGL context, enclosure audit, nav graph, mission start, WASD /
walk speed / sprint speed / snappy stop / sprint FOV, jump (leaves ground, apex,
lands), auto-fire, spread bloom + recovery, reload start/refill/reserve
arithmetic, ADS FOV pull + cone tightening, viewmodel coverage at hip and ADS,
hit registration on a live moving AI (re-aimed from live positions before every
round), the AI doctrine audit, enemies damaging the player, inspect toggle both
ways, terrace standability, win condition, end screen, restart, and console
hygiene (zero errors **or warnings**).

**Stability: 5 consecutive clean runs, 41/41.** Two flakes were found and fixed
rather than retried — the harness had been shooting into a deck railing, and the
player was being killed mid-screenshot-composition (fixed with a debug
`invulnerable(on)` hook used only for frame composition).

*Pipeline:* the loop could prove compile/boot/input/proof but not play. v2's whole
extra budget went into that proof loop (`web_capture_render` 30–33 s,
`web_run_playtest` 8–11 s, each re-demanded) rather than into fixes — N1. A cheap,
fast, assertion-dense harness is the thing that makes budget buy quality.

---

## 12. What is TUNED vs what is STUBBED at M1

**Tuned** (a real pass was done; numbers are defensible): movement speeds and
accel/decel, jump arc + forgiveness windows, look sensitivity, ADS/sprint FOV
blend, fire rate + reload timings, recoil pattern + retention, spread ladder +
bloom rates, viewmodel poses + sway/bob/kick constants + FOV + screen budget,
enemy state timings + speeds + turn rates + engagement bands, trauma values,
arena layout + palette + sun angle + ambient budget, HUD layout and thresholds.

**Stubbed** (deliberate, M2+):
- **All art.** Every mesh is a primitive; every texture is drawn on a canvas.
- **No audio at all.** Not in the M1 brief; the game-feel reference's audio
  coupling section is unimplemented.
- **Reload animation** is a real timed transform sequence with a magazine swap,
  but it is not a rigged clip.
- **Death** is a procedural collapse, not a ragdoll.
- **Avatar locomotion** is hand-written procedural, not a blend tree.
- **No post-processing** (no bloom/grade/vignette in 3D — the vignette is DOM).
- **No touch controls** (the playbook mandates them; desktop-only at M1).
- **No LOD/instancing budget work** — ~120 static meshes, one shared geometry.
- **Score** has no persistence.

---

## 13. Deviations from the brief

1. **Ramp → stairs.** The brief said "ramp/stairs"; only stairs are built.
   Stairs traverse with the same step-up rule as everything else and need no
   slope collision, so the elevation requirement is met with strictly less
   machinery. Two staircases, both storeys navigable by player and AI.
2. **Enemies never fire while moving contradicts the genre playbook** (§7.2).
   User doctrine wins; dodgeability preserved by telegraph + burst + spread.
3. **Crouch is implemented** (listed as optional in the brief), because the
   headroom check and the crouch spread bonus were cheap and they make the cover
   field meaningful.
4. **Damage numbers not implemented** (listed as optional).
5. **The viewmodel is not a plain box.** The brief said "placeholder box gun";
   this is a multi-primitive rifle (receiver, handguard, barrel, suppressor,
   magazine, stock, grip, red-dot optic). Reason: the ADS alignment decision
   (§2.5) needs a real optic at a real height to be verifiable, and a genuine
   silhouette is what proves the transform architecture. Still zero asset files.

---
---

# MILESTONE 2 — world + assets

M2's brief was to replace the graybox with real assets, assembled BY HAND from
the backend's own pipeline parts used standalone. `babble-games-backend` was
never modified and the generation pipeline was never run; only
`app.config.settings` and `app.services.tripo_service` were imported, and the bpy
sidecar scripts were invoked directly as subprocesses.

The dissection value of M2 is mostly in §22 — **where the pipeline's parts fought
a careful human operator**. Those are the places an autonomous coder has no
chance at all.

---

## 14. The M2 thesis: an art pass must not be able to change how the game plays

M1's whole argument was that the pipeline's failures were integration failures,
not engine limitations. M2 is where that gets tested, because dressing a level is
exactly when integration failures happen: props drift from their colliders, a
model faces the wrong way, a texture never loads and the fallback ships.

So M2 has one structural rule on top of M1's, applied everywhere:

> **Collision is AUTHORED. Geometry is DRESSED.**

Every collider still comes from the same spec list M1 wrote (§4.3), and every
generated prop is normalised INTO its collider's AABB (`fitToBox`). Swapping art
cannot move a wall, cannot invalidate the nav graph, and cannot change the
enclosure audit. The proof is that the 41 M1 assertions kept passing with real
meshes in place of every box — and the two that broke (§20, §21) turned out to be
pre-existing ENGINE defects the art pass merely exposed, not art problems.

Nine new assertions were added, so the suite is now **50**.

| new assertion | why it exists | value |
|---|---|---|
| every asset loaded, zero failures | a silent 404 renders the fallback — the pipeline shipped a cyan cube exactly this way | 30/30 |
| sky is the HDRI, not the procedural fallback | "it loaded" and "it is being used" are different claims | hdri |
| all six clips resolve BY NAME | `native_apply` exports actions named `copy_<name>`; a mixer lookup miss is silent | 6/6 |
| props actually placed | `propsPlaced` counts fitted props, so a total prop failure is red rather than a level that quietly reverts to boxes | 40 |
| frame not too dark / not blown / not crushed | M1's worst bug was a BLACK level caught only by a human opening a PNG | mean 0.257 |
| W moves toward the look vector | the old assertion measured a DISTANCE and could not fail for an inversion (§20) | +4.15 m |
| D strafes right | same class | +2.95 m |

---

## 15. The enemy soldier: hand-assembling four pipeline stages

`assetgen/tripo_gen.py` → `assetgen/rig_soldier.py`. Four stages, standalone:

1. **Tripo text→3D in a strict T-pose.** The pose mandate is imported verbatim
   from the backend's `TPOSE_TEMPLATE` rather than paraphrased, because that
   wording is load-bearing for the rig step that follows — the landmark deriver
   reads a T-pose SILHOUETTE, and an A-pose drift makes every derived shoulder
   and elbow quietly wrong. Submitted on the v2 chain pinned to
   `model_version=v3.1-20260211` (the native P1 path drifts to A-pose), PBR on,
   then `highpoly_to_lowpoly`. 42.1 MB raw → 3.02 MB.
2. **T-pose gate BEFORE any rig work.** `tpose_gate.py` on the raw mesh:
   **usable, score 0.902, arm-span ratio 1.004, droop 6.8°.** Gate first, spend
   time second — this is the cheapest possible place to find out the generation
   is unusable.
3. **Auto-rig** — `derive_landmarks.py` (7-marker silhouette contract, no
   pre-existing skeleton) then `build_rig.py` (medial-seated fit + shell-split
   skin) onto the canonical 66-joint Mesh2Motion human skeleton.
4. **Six CC0 clips copied natively** onto that skeleton (`native_apply.py`), each
   then slimmed and renamed (`strip_to_animation.py`). **66 shared bones on every
   clip**, which is the number that says the native copy was legitimate rather
   than a partial match.

Whole chain: **28.4 s**. It is genuinely good machinery. The friction was never
in the algorithms — see §22.

### 15.1 The clip map is a HAND decision, and one of them is a compromise

| game state | clip | note |
|---|---|---|
| patrol standing | `Idle_A` | 3.13 s |
| patrol move | `Walk` | 1.67 s |
| advance / reposition | `Jog` | 1.17 s |
| **halt / aim / fire** | `Pistol_Idle` | **the compromise — see below** |
| discharge | `Pistol_Shoot` | one-shot at 2.4× |
| death | `Death_B` | 1.83 s, chosen over `Death_A` (4.46 s) because a 4.5 s fall outlives the 900 ms the game budgets for a kill |

**The 162-clip human library contains no rifle animations at all.** The complete
`ranged` set is bow, thrown, spell and pistol. For a two-handed carbine the
nearest options were `Bow_Pull_Hold` (a 6-frame static pose) or the pistol set.
`Pistol_Idle` was chosen because it is a real 51-frame breathing cycle, so an
aiming soldier is still alive on screen — a soldier frozen on a 6-frame pose
reads as a bug. The hands are wrong for the weapon and that is accepted and
recorded rather than hidden.

### 15.2 The doctrine drives the clips, so the animation cannot contradict the rule

The state→clip mapping is three lines because it is a direct read of M1's
doctrine: `MOVING_STATES` get the locomotion blend, `STATIONARY_COMBAT_STATES`
get the aim pose. Those sets are **disjoint by construction** (M1 §7.1), so a
soldier physically cannot be blending a walk cycle while shooting.

*Pipeline:* v2 §6 — enemies "move and fire while moving", red tracers mid-run.
Here the same invariant that makes that impossible in the simulation also makes
it impossible in the animation, from one definition.

### 15.3 Weights are a smoothed FIELD, not a crossfade state machine

Every action plays permanently at a weight that is `damp`ed toward a target. A
crossfade state machine can get stuck mid-transition when the source state
changes faster than the fade runs — and the AI changes state every 180 ms. A
weight field has no transitions to get stuck in.

### 15.4 Playback is rate-matched to real speed

`walk` and `run` timeScale = actual speed / the speed the clip was authored at
(1.45 and 4.1 m/s). Foot-skate — a locomotion cycle running at a fixed rate under
a variable-speed controller — is one of the loudest "prototype" tells, and it
costs one division.

### 15.5 The visor telegraph SURVIVES the art pass; the chevron does not

A rigged human states its own facing far better than a capsule, so M1's chest
chevron is retired. But the telegraph is not a facing cue, it is a **state** cue —
"I have stopped and I am about to shoot" — and no amount of character art
expresses that. So the emissive visor plate stays, now parented to the head
bone so it tracks every animation for free.

---

## 16. The player avatar: the seam, used

M1 §8.1 defined `AvatarModel` as an interface with a working graybox default
specifically so that M2 would be one line. It was one line.

The player is the **same rigged soldier** as the hostiles, in a different tint.
That is deliberate: a game where the thing you inspect in third person is a
different species from the things you shoot reads as two different games, which
is what the pipeline's build literally was (a cyan cube for the player, capsules
for the enemies).

`RiggedSoldier` implements `AvatarModel` and is consumed unchanged by both the
avatar container and the enemy class. One extra field was added to
`AvatarAnimParams`: `aiming`. It is the player's ADS flag and the enemy's
planted-combat-state flag — the same distinction from both sides.

---

## 17. Sky and light: matched in azimuth, deliberately NOT in elevation

Real photographic sky: Poly Haven `industrial_sunset_02_puresky` (CC0), staged in
the backend's shared library as `hdri_industrial_dusk` — six 1024² cube faces for
the background plus a 256×128 equirect PMREM'd into `scene.environment` for both
the world and the viewmodel scene.

### 17.1 The sun direction is MEASURED off the sky's own pixels

`assetgen/sky_sun.py` finds the brightest region across the six faces and
converts its face-local (u, v) to a world direction. Result: **azimuth +126.0°,
elevation +2.4°**. Horizon colour `#79848e`, zenith `#376897`, sun-side horizon
`#eed087` — the fog and light colours are sampled from the plate rather than
picked, so they cannot disagree with it.

*Pipeline:* D10 — a staged library sky beat the coder's own generated sky in
**both** runs, and in v2 the code was right while the frame was still wrong. A
sky and a key light that disagree is the loudest possible "this is fake" cue.

### 17.2 Elevation: the one place they are allowed to disagree, and why

The measured elevation is **2.4°** — it is a sunset plate; the sun is on the
horizon. Using it would be a bug, not a look. M1 §5.1 already established that a
6 m wall at 11° casts a 31 m shadow across a 40 m arena and blacks the floor out.
At 2.4° that shadow is **~143 m**: the entire compound in shade, the level
unreadable.

So the azimuth is matched exactly and the elevation is raised to 24°. The frame
reads as "the sun is low behind that ridge", which is true.

**The general lesson: matching a photographic sky is a constraint on DIRECTION,
not a licence to ship an unplayable one.**

### 17.3 The sky is ROTATED to the sun, and the rotation is DERIVED

At the measured 126° the sun sat ~90° right of the spawn view, so every frame
showed the plate's cool anti-sun half and the build rendered as a **midday blue
sky** — word for word the v2 dissection's complaint about the pipeline's own
output. Shipping a sunset HDRI that renders as noon is worse than shipping no
HDRI: same download, same picture.

So the sun is placed where the composition needs it (58°, backlighting the spawn
sightline) and `backgroundRotation` + `environmentRotation` are set to
`SUN_AZIMUTH_DEG − MEASURED_SUN_AZIMUTH_DEG`. The rotation is **derived from the
two azimuths**, so the plate's sun and the directional light cannot drift apart:
changing one turns the other.

### 17.4 Exposure is explicit, and it is GATED

`toneMappingExposure` 0.72, `backgroundIntensity` 0.62, `environmentIntensity`
0.95. The template's manifest recommends 0.6 for its own runtime; this build
sits higher because it also carries a 24° key light.

Background intensity is held DOWN on purpose: at 1.0 the plate's zenith is
brighter than anything in the compound, and a sky that out-values the level
flattens it.

None of those four numbers is defended by eye. `requestFrameStats()` samples the
**actual composited canvas** — both passes, after tone mapping, exactly what a
screenshot captures — and the suite asserts mean luminance in a readable band,
< 12% clipped white and < 20% crushed black. Measured: **mean 0.257, 0.0% white,
1.5% black.** "Too dark to play" is now a failing test.

---

## 18. Materiality

### 18.1 Textures are BAKED FILES, and they are seamless by construction

`assetgen/bake_textures.py` writes real PNG/JPEG into `public/textures/`:
concrete, plaster, corrugated metal, sand and a poured slab, each with albedo +
normal + roughness (+ metalness for metal), plus grime / hazard / stencil decals
and a ground blend mask.

Procedural, but **baked**, for two reasons: every noise octave is sampled on an
integer lattice whose period DIVIDES the texture size, so the tile wraps exactly —
a promise no generative image model can make — and a file is inspectable,
diffable and cacheable in a way runtime canvas noise never is.

**Tiling is asserted, not assumed.** `seam_error()` compares the wrap
discontinuity against the texture's own worst interior transition and the bake
FAILS above 1.5×. Worst shipped: **1.486** (`ground_slab_albedo`, whose wrap
falls on one of its own expansion joints).

That metric had to be fixed once, and the fix is the interesting part: the first
version compared the wrap against the MEAN interior difference, which failed
`ground_slab` at 1.97 for having deliberate hard joints. A gate that fails correct
work teaches people to raise the threshold, which is how gates die. The baseline
is now the 99th percentile — "no worse than the worst seam the texture already
has on purpose".

### 18.2 TWO ground textures at NON-HARMONIC scales

The house anti-tiling rule, implemented properly. The floor is two different
materials, not one texture at two scales:

* poured slab apron, **0.28 tiles/m** (a ~3.6 m slab module)
* drifted sand, **0.11 tiles/m** (a ~9 m drift)

0.28 / 0.11 ≈ **2.55, deliberately not 2**, so the two patterns never come back
into phase. The blend mask is stretched ONCE across the whole 40 m floor
(repeat = 1) so it contributes no period of its own — its entire job is to
destroy the period of the two under it. The eye finds the PERIOD, not the seam.

The mask needed a second pass too: the first one was high-contrast and produced
two large flat *territories* with a visible border, which is a different artefact
from the tiling it was meant to hide. Wide ramp, extremes pulled in.

### 18.3 The M1 value ladder survives as tints

M1 §4.6 built a ~10% luminance ladder — floor darkest, cover lightest — so form
read from value alone and the things you can hide behind popped out of the ground
plane. Texturing normally destroys that, because photographic albedo has its own
values that ignore the level design. So the ladder is preserved as a **multiply
tint per surface**, and the gameplay legibility the layout was tuned for survives
the art pass.

### 18.4 Painted steel is not a mirror

Containers first shipped at the metal set's 0.85 metalness and read as flat blue
slabs: a mirror shows you the environment, not the object, so a fully-metallic
surface has no form of its own. Containers are now `metalness 0.18 / roughness
0.78` (painted), railings `0.55 / 0.62` (galvanised, weathered). Per-spec PBR
overrides were added for exactly this.

### 18.5 Trim, decals, props

* **Wall-top coping** — a 0.28 m concrete course overhanging 0.12 m per side. It
  gives the perimeter a hard shadow line along its whole length, and it is the
  single biggest reason the walls now read as *built* rather than as extruded.
* **Decals** where a real compound carries them: dirt where ground meets a
  vertical face (it hides the material transition), hazard chevrons on the stair
  cheeks, unit stencils on the containers so the place reads as OCCUPIED. All
  three were cut to roughly a third of their first opacity — the first pass read
  as oil spills.
* **Seven generated props**, each fitted to its collider by uniform scale and
  **seated on the box floor**, not centred in it. Uniform scale is the point:
  stretching a crate to fill a non-cubic collider is instantly readable as wrong,
  whereas a prop slightly smaller than its collider is invisible.

### 18.6 The berm has to break the SKYLINE, which is stricter than "be outside the walls"

M1's compound ended at the top of a 6 m wall with raw sky beyond it. The first
berm — 11 m high, ridge at ~100 m — was **completely invisible from the floor**,
because from eye height the sightline grazing a 6 m wall 20.3 m away rises at
0.21 m/m and is already 14.5 m up by 60 m. An 11 m ridge sat entirely under it.

Pulled in and raised: inner radius 28 m, crest at ~60 m, 24 m high, with a
wobbled circumference so it is a landform rather than a second wall. The outer
skirt is driven **below** ground rather than tapered to it — a ring that ends at
ground level ends on a visible circular edge against the sky no matter how far
out you put it; a ring that keeps falling passes under the horizon. Fog finishes
it. No colliders: it is scenery, outside the enclosure audit entirely.

---

## 19. Assets: loud on failure, soft in the frame

`src/world/assets.ts`. Three rules, all aimed at the same failure class:

1. **Every load is recorded.** `AssetReport` lists successes and failures with
   URL and error; the suite asserts zero failures AND the console-hygiene
   assertion catches it a second time.
2. **Failure is never fatal.** A failed asset resolves to `null` and the caller
   keeps its graybox path. A bad deploy is a *degraded* game, not a black screen.
3. **URLs resolve against `document.baseURI`, in one function.** Vite is
   `base: './'`; a bare `/textures/x.png` works on a dev server and 404s the
   moment the build is served from a subpath. That exact bug is a documented
   pipeline regression, so it gets one code path.

`Game.init()` is a deliberate SECOND phase, and `window.__FPS__` is not published
until it resolves. A screenshot taken before the textures arrive is
indistinguishable from a build with no textures — making "ready" mean "assets are
in" removes that entire class of flake.

---

## 20. Two engine defects the art pass exposed

Neither was caused by M2. Both had been shipping since M1, and both are recorded
because *how they were found* is the point.

### 20.1 W and S were INVERTED, and the assertion could not fail for it

`wishX = ix*cos − iz*sin` negated the forward terms: `W` drove the player
**backwards along their own look vector**. Strafing was unaffected.

It shipped through M1's "41/41, five consecutive clean runs" because the
assertion measured `travelled`, a **distance** — and a distance has no sign. It
was found by a human playing the build.

This is the project's own thesis turned on itself: **an assertion that cannot
fail for the defect you have is not coverage.** M1's DECISIONS §11 claims the
harness proves the game *plays*; for this axis it only proved the player moved.

Fixed by writing the basis out explicitly (`forward`, `right`, `fwdAmount`)
instead of four sign-juggled terms, and by replacing the assertion with a
**projection**: displacement · forward must be positive. Same for strafe ·
right. Both now red for an inversion.

### 20.2 Every shot fired along the PREVIOUS frame's aim

`fireOnce()` read `camera.getWorldDirection()`, but `updateCamera()` runs later in
the frame than `updatePlaying()` — so every round in the game left the barrel
along the previous frame's orientation. One frame of aim latency on every shot,
invisible because the tracer is drawn along the same stale direction, so the
round goes exactly where the picture says it went.

It surfaced as a **flaky** hit-registration assertion (8 rounds, 0–1 hits,
different every run), not as a bug report. That is the useful part: *a flake is
usually a defect with a quiet voice.* Fixed at the source — the shot direction is
now built from `player.yaw/pitch + recoil` in the same YXZ basis `updateCamera`
uses, so the camera and the bullet cannot disagree.

---

## 21. Teleport could strand the player inside geometry

M2 added eight new colliders (a watchtower, an antenna mast, six oil drums). The
M1 test-only `teleport` resolved only the VERTICAL axis, so it could land the
player embedded in a solid box — after which every shot immediately hit the
inside face of that box at ~0 m. That is what first broke hit registration.

Fixed by adding the horizontal push-out. **The assertion was right and the engine
was wrong**, which is the rule: a teleport that can strand the player inside the
level is a real defect whether or not it is a test-only entry point.

---

## 22. FRICTION LOG — where the pipeline's own parts fought a careful operator

This is the section M2 exists to produce. Everything below was hit while
hand-assembling parts that all individually work.

### 22.1 A tool reported SUCCESS while destroying the asset

`gltf-transform optimize --texture-size 512 --texture-compress webp --compress
draco` turned every 2.6 MB prop into a **3 KB file, exit code 0, no warning**. A
3 KB "GLB" still parses and still loads; it renders nothing. It was caught only
because a file listing happened to be read.

This is the single most dangerous class of tool behaviour for an autonomous
pipeline, because every signal it checks says success.

Replaced with `assetgen/optimize_glb.py`: two NARROW commands (resize, then
webp — geometry never goes near a simplifier or quantiser), and a **structural
gate** that parses the GLB's own JSON chunk before and after and refuses the swap
on any change to mesh / primitive / node / accessor / animation / skin counts, or
a >2% vertex drop. Nothing overwrites an original until its replacement passes.

The gate then had to be *loosened* once, which is its own lesson: the first
version also rejected any output under 25% of the input, and that failed three
legitimate props — a 2048→512 resize is a 16× pixel reduction and a
texture-dominated prop genuinely drops below 25%. **Size is the weak signal;
structure is the strong one.** The 3 KB disaster looked like `meshes: 0,
vertices: 0`, which the structural check catches outright.

Result: 17.8 MB → 4.2 MB of GLB, with proof nothing was lost.

### 22.2 The same class of bug, in my own code

Worth recording because it is not a pipeline failing — it is how easy this
failure mode is. The first texture baker skipped any noise octave whose period
did not divide the texture size. That is a **silent zero**: `fbm` returned an
all-zero field and three of five materials baked out as flat colour. Nothing
errored. It was caught by noticing a 4 KB PNG in a listing.

Now the period is snapped up front and `value_noise` RAISES on an illegal one —
which immediately surfaced three more call sites that had been silently degraded.
**A guard that degrades quietly is worse than no guard.**

### 22.3 The animation library has no semantic mapping and no loop flags

`manifest.json` has 221 clips with `tags`, but the human tag vocabulary is
`climb, combat, dance, death, emote, farming, flight, idle, locomotion, magic,
misc, ranged, rest_pose, root_motion, sit, swim, zombie`. There is **no `walk`
tag, no `run` tag, no `aim` tag** — all locomotion is one bucket — and **no
`loop` flag anywhere**. There is no `"idle" → Idle_A.glb` table.

So every one of the six clip choices, and every `LoopRepeat` vs
`LoopOnce/clamp` decision, is a hand judgement (§15.1). A coder agent is choosing
these from filenames.

### 22.4 No rifle animations exist

See §15.1. For a military shooter — the single most common game genre a user will
ask for — the CC0 library's entire two-handed ranged provision is a bow. This is
a content gap, not a bug, but it is the kind that silently caps quality.

### 22.5 `native_apply` names the clip `copy_<name>`

`native_apply.py` creates its action as `copy_${CLIP_NAME}`, so the GLB's
`animations[0].name` is `copy_walk`, not `walk`. A three.js `AnimationMixer`
lookup by name then silently returns nothing — no throw, no warning, just a
soldier that never animates.

The fix is a second pass (`strip_to_animation.py`) that renames it. Nothing warns
you that you need it. Defended twice here: the rig script runs `analyze_glb` on
every output and asserts `clips == [name]`, and the runtime renames defensively
and logs if it had to.

### 22.6 One clip per GLB, and no merge tool exists

Every applied clip is a separate file (deliberately — `strip.py` says games "load
one GLB per animation and play clip index 0"). There is no script anywhere in the
sidecar that merges several named clips into one GLB. Six clips is seven HTTP
requests for one character. Fine here; a real cost at scale.

### 22.7 `build_rig` writes a 5.5 MB `.weights.npz` next to its output

It is a hard requirement for `native_apply` (it carries the authoritative
species, the per-limb dominant-bone sets for girth compensation, and the finger
mode). But it lands in the OUTPUT directory — which was `public/models/`, so it
would have shipped 5.5 MB of numpy into the game bundle. Moved out by hand.

### 22.8 The rigged model's FACING is not recorded anywhere

Nothing in the output GLB says which way the character faces, and the pipeline's
own runtime answer is a *deterministic default* (`forward_yaw = π/2`) rather than
a measurement. Getting it wrong is silent and awful: the soldiers walk backwards,
aim away from you, and die folding the wrong way — and none of it throws, so it
survives every automated check that is not a screenshot.

Derived here by MEASUREMENT instead: the `foot_l → ball_l` bone vector is the toe
direction, it points Blender −Y, and the Blender→glTF conversion `(x,y,z) →
(x,z,−y)` maps that to **+Z**. The game's forward is −Z, so `YAW_OFFSET = π`.

### 22.9 The sky template's recommended exposure is for a different renderer

`hdri_industrial_dusk` ships `"exposure": 0.6`. That is a sensible number for a
sky-lit-only scene and wrong for one that also carries a key light. Useful as a
starting point, not as a value. And the plate's own sun elevation (2.4°) is
**unusable as a key-light elevation** in any level with walls — see §17.2.

### 22.10 Credit accounting over-estimates by ~1.4×

The documented per-task costs (`text_to_model` 40 + `highpoly_to_lowpoly` 30 =
70/asset) predicted 490 credits for seven assets. **Measured spend was 400**
(20,175 → 19,775), and a clean unparallelised measurement of the carbine alone
was **50 credits**. The published table is conservative — it never under-reports,
which is the right direction to be wrong in, but a build's cost report is
currently ~1.4× its true model spend.

### 22.11 `record_tripo_credits` can bill real user chips

Noted and deliberately NOT called from the standalone driver: it schedules
`credit_service.deduct_media_by_model` when a billing context exists. A standalone
script that innocently mirrors the pipeline's accounting could charge a user.

### 22.12 What worked well, and deserves saying

* The **T-pose gate** is genuinely good: cheap, run before any expensive work,
  and it scored the generation honestly (0.902 usable).
* **Native clip apply is the right architecture.** Because `build_rig` binds the
  mesh onto the very skeleton the clips were authored on, applying an animation
  is a per-bone rotation copy with zero retarget maths — 66/66 shared bones.
* The **whole rig + 6 clips ran in 28.4 s** on a laptop.
* The **sky library layout** (six faces + equirect + a manifest with attribution
  and a recommended exposure) is exactly the right shape for a consumer.

---

## 23. What is TUNED vs what is STUBBED at M2

**Newly tuned:** sun azimuth/elevation and the derived sky rotation, exposure and
both IBL intensities, fog density and colour, all five material tile scales and
their PBR overrides, decal density/opacity, berm geometry, clip choices and
locomotion blend thresholds, animation rate-matching constants, model scale
normalisation and seating.

**Still stubbed (M3):**
- **Audio** — nothing at all, per brief.
- **Post-processing** — no bloom/grade/DOF. (IBL is lighting and was in scope.)
- **The viewmodel is still the M1 procedural rifle** — see §24.
- **The soldier carries no weapon mesh.** The Tripo generation was prompted with
  empty open hands (a weapon fused into a T-posed mesh cannot be rigged
  separately), so hostiles currently aim empty-handed. The carbine now exists to
  fix this; it needs a hand-bone attachment, which is M3.
- **Death is a clip, not a ragdoll**; corpses do not settle on uneven ground.
- **No LOD / instancing.** ~40 prop instances each with its own material clone.
- **Enemy hit volumes are still capsule + sphere**, unchanged from M1 — correct
  and fair, but they no longer match the animated silhouette exactly.

---

## 24. The carbine: generated and verified, integration deferred to M3

Generated standalone at the user's request (`carbine` in the prop table, face
limit 8000, PBR on): a correct AR-pattern carbine — collapsible stock, pistol
grip, box magazine, railed handguard, muzzle device, red-dot on the top rail,
barrel axis unambiguous. 2.78 MB → 654 KB through the gated optimiser. 50 credits.
Rest-pose render at `assetgen/rigwork/carbine/`.

**It is deliberately NOT wired into the viewmodel yet**, and the reason is M1
§2.5. The ADS alignment is *geometric, not eyeballed*: the placeholder rifle's
optic glass sits at model-space `y = SIGHT_HEIGHT = 0.093` and the ADS pose is
`y = −0.093`, so the optic lands on the screen centre **by construction**. A
generated mesh has no such guarantee — its optic and muzzle are wherever Tripo
put them.

Wiring it correctly therefore means measuring the optic centre and the muzzle tip
off the GLB (the same measure-don't-guess approach as §22.8), deriving the ADS
pose from those, and re-verifying both the <15% screen budget and the
ADS-alignment assertion. That is real work, and doing it hastily to land inside
the M2 gate would put this project's single most important assertion — the one
that encodes the pipeline's signature failure, named seven times across two runs —
at risk for no schedule benefit.

The asset is generated, verified and paid for. The integration is M3's first task.

---

## 25. The hit-registration assertion: four bugs behind one flake

Recorded in full because it is the best worked example in the project of *a flake
being a defect with a quiet voice*, and because each layer only became visible
once the one above it was fixed.

The assertion — "a round fired at a live hostile registers a hit" — began failing
intermittently after the art pass. Four distinct causes, in the order they were
found:

1. **The teleport could strand the player inside geometry** (§21). M2 added eight
   colliders; the M1 teleport resolved only the vertical axis. Embedded in a box,
   every shot hit its inside face at ~0 m. *Engine bug.*
2. **Every shot fired along the previous frame's aim** (§20.2). `fireOnce()` read
   the camera matrix, which `updateCamera()` had not yet written this frame.
   *Engine bug — present since M1, affecting every shot in normal play.*
3. **The player was being killed mid-sequence, and death stops the weapon.**
   `rifle.update()` only runs while `phase === 'playing'`, so once the mission
   ended the fire cooldown stopped ticking and `canFire` never became true again.
   Seven of eight rounds were **silently never fired** — and the assertion still
   passed or failed on whether the single round that did fire connected. This one
   is the nastiest: a green test computing a hit rate over a denominator of one.
   Fixed with M1's existing `invulnerable()` hook, and defended by a NEW
   assertion that every round the harness asks for actually leaves the barrel.
4. **The stand-off position was chosen geometrically and could be behind cover.**
   The harness parked itself 5 m from the target along a fixed bearing, which
   sometimes put the central bunker in the way. A hit-registration test must not
   be able to fail for a reason that has nothing to do with hit registration, so
   `Game.hasLosTo(enemyId)` was added — test-support API in the same family as
   `auditEnclosure()`, running the engine's OWN `hasLineOfSight` — and the
   harness now tries eight bearings and takes the first with a genuinely clear
   line.

Then a fifth, which was the assertion being *right*: once 1–4 were fixed the hit
rate went to **4 of 4**, the target died at 104 damage, and the "all 8 rounds
fired" check failed because the test had finished its job in four. The loop now
stops at the kill.

**Two of the five were real engine defects shipping in M1 behind a green suite.**
The reason they surfaced at all is that the art pass perturbed the conditions
enough to turn a silent bug into an intermittent one. Nobody would have written a
bug report for "shots are aimed one frame late".

---

# MILESTONE 3 — polish, post-processing, audio, and the dissection

---

## 26. The M3 thesis: polish is where a build stops being a demo

M1 proved the game plays. M2 proved an art pass can be applied without changing
how it plays. M3 is the milestone where the build has to survive being *looked
at* by someone who is not grading it on effort — which is precisely the bar both
pipeline runs failed. Neither of them failed on mechanics: v1 and v2 both
compiled, booted, took input, spawned rigged enemies and ran live combat. Both
scored 3/10 anyway, because a shooter is judged on its frame, and the frame was
dominated by an unlit black blob.

So M3's rule is the inverse of the usual polish rule. Polish here is not "add
effects". It is: **every remaining thing that a person would notice in the first
five seconds gets fixed, measured, and given an assertion so it cannot come
back.** Three of those came from the M2 gate review, and all three are the same
failure the dissections describe — an integration/direction failure, not an
engine limitation.

---

## 27. The three gate-review fixes

### 27.1 The visor telegraph was a HUD element wearing a soldier's head

M2's telegraph was `BoxGeometry(0.16, 0.045, 0.03)` parented to the head bone at
`(0, 0.05, 0.1)`, emissive at intensity 0.9 in saturated orange. In
`shots/07_enemy_closeup.png` it read as a flat cream slab floating clear of the
face. Three independent mistakes had stacked, and the interesting part is that
each one is a *category* of error rather than a bad number:

1. **The units were not metres.** Head-bone space is un-scaled rig space, and
   this rig is authored at roughly 1 unit tall and then normalised to 1.8 m. So
   "0.16 wide" was ~0.29 m and "0.1 forward" was ~0.18 m: a 29 cm signboard 18 cm
   in front of the face. Nothing in the code said what those units were, and
   nothing could have caught it — the number is dimensionless in the source.
2. **It was flat.** A box across a head reads as a box across a head. A visor is
   a *wrapped* surface, and the wrap is most of what makes it read as worn.
3. **It was already saturated at rest.** `emissiveIntensity: 0.9` on a saturated
   orange tone-maps to near-white through ACES, so the idle state was already
   blown and the 400 ms wind-up had almost no headroom to brighten into. **A
   telegraph that is always on is not a telegraph.**

The rebuild answers all three. The geometry is a cylinder-segment lens (~120° of
wrap) inside a matte housing, with a strap closing the loop round the back of the
skull so the goggles read as worn from behind as well as from the front. It is
authored in **real metres** and converted into bone units by a factor MEASURED
off the head bone's own world matrix — `perUnit = |matrixWorld.column(0)|` — so it
is head-sized on any rig at any normalisation scale. And it rests **dark**: a
deep ember at 0.35 climbing to 4.2, a ~12× swing, with the lens (and only the
lens) on the bloom allow-list so the wind-up reads as a light source rather than
as a brighter surface.

The general lesson, which is item 4 of the dissection: **a quantity with no unit
in the source is a bug waiting for a coordinate-system change.** Authoring in
world units and converting at the boundary costs one measured scalar.

### 27.2 The corrugated metal was a mirror, not a material

The `metal` set — perimeter panels, deck railings, stair cheeks, shipping
containers — read as psychedelic blue/orange marble. Three causes, and none of
them was "the texture is bad":

1. **The rust was the wrong SCALE.** `fbm(SIZE, 8, 4)` puts its features at ⅛ of
   a tile, i.e. ~11 cm blobs, then a threshold turned them into hard-edged
   shapes. That is the orange veining.
2. **The surface was a mirror.** Roughness floored at 0.18 under a metalness map
   peaking at 0.95. A mirror shows you the *environment*, not the object — so the
   panels showed the sky, and the sky was blue. This is the same defect M2 had
   already diagnosed for the shipping containers and "fixed" with an override
   that never executed (§31.1).
3. **The corrugation was invisible.** It existed only in the height map, at a
   normal strength producing ~5° of peak flank tilt. At play distance that is
   nothing, and there was zero corrugation in the albedo, so the one cue that
   would identify the material was carried entirely by the weakest channel.

The rebake fixes each in kind. The rib pitch is derived from the actual in-game
tiling rather than chosen: `arena.ts` uses 1.1 tiles/m, so one tile is 0.909 m,
and real corrugated cladding runs 75–90 mm, giving **11 ribs per tile at 82.6 mm**
— the old 16 was a 57 mm pitch, finer than any real sheet. The profile becomes a
rounded trapezoid, the ribs are re-oriented to stand *vertically* on a wall face
(so lap joints are horizontal and the valleys run with gravity), and the rib
shading is baked into the **albedo** — 0.139 column-mean peak-to-peak — so the
material survives with the normal map contributing nothing. Rust is rebuilt as
small-scale directional streaks bled *downhill* from fixings, laps and coating
pinholes, double-gated so it does not band along every lap row, desaturated to
iron oxide, and held to 15.5% coverage. Roughness lands 0.60–0.91 and metalness
peaks at 0.50.

**The seam audit stayed green throughout** (worst across all materials unchanged
at 0.892) and the other four materials were verified byte-identical by md5 before
and after — the per-material seeded RNG from M2 §22.2 doing exactly the job it
was added for.

One process note worth keeping. The bake was iterated **against a rendered
preview that was actually looked at**, four times. Iteration 2 measured well and
looked properly weathered, and was wrong: every lap row had grown a continuous
rust fringe, so at tiling distance those fringes *were* the tile period. That is
the same failure the seam gate exists to prevent, arriving through a door the
seam gate does not watch, and **no number in the file would have flagged it.**

### 27.3 The sky measured as a sunset and rendered as noon

M2 shipped `hdri_industrial_dusk`, whose sun `assetgen/sky_sun.py` measured at
azimuth +126.0°, elevation **+2.4°** — a sun sitting on the horizon. The frame
read as bright midday blue. This is, word for word, the verdict in the v2
dissection about the pipeline's own build: *"the frame is a midday blue sky over
a flat plane."* We shipped it with a measurement in hand.

The reason is worth stating exactly, because "we measured it" is the trap:

> A sunset plate's warmth is a **wedge** around the sun, and that wedge has a
> **height**. `industrial_sunset_02_puresky` has a spectacular one — roughly 35°
> wide, hugging the horizon — and everything outside it is a saturated blue
> zenith. The measurement `elevation = +2.4°` is a **true statement about one
> pixel.** It says nothing about the other 99.99% of the sky, which is the part
> the player is looking at.

So the replacement was chosen on a different measurement: **warm ARC coverage**,
not brightest-pixel position. `hdri_twilight_quarry` (Poly Haven
`drackenstein_quarry_puresky`, CC0) carries a warm tint across 100% of the
horizon arc with a median warm-wedge height of ~23°, and a desaturated slate
zenith instead of a cobalt one. Its per-face numbers say the same thing: the
sun-facing face is 0.61 warm, and the anti-sun faces sit at a neutral grey-blue
(mean RGB 0.347 / 0.373 / 0.392) rather than the previous plate's blue. **Turn
around in this level and it still looks like evening.** The contact sheet was
composited and looked at before installing, because the failure being fixed is
precisely one that survives numbers.

Every downstream constant was re-derived from the new plate's own pixels: fog,
key colour, hemisphere fill, and the procedural fallback's three colours. Two of
them are deliberately *not* straight samples, and both deserve their comment:

- **`FOG_COLOR` is sampled from the shadow side of the horizon band, not its
  mean.** The first pass took the measured horizon (#928b7b) straight and the
  compound turned to milk — a fog colour brighter than most of the level lifts
  every distant surface toward the sky and contrast dies first. Fog density came
  down 0.0115 → 0.006 with it; the berm still dissolves because fog is
  exponential in distance and the berm is 60–140 m out while the perimeter wall
  is 28 m.
- **`GROUND_BOUNCE_COLOR` is not sampled from the sky at all.** The plate's lower
  hemisphere is a grey quarry lake. Our ground is warm sand over a concrete
  apron, and the hemisphere light's ground term models light bouncing off *the
  surface the player is standing on*, not off the surface in the photograph.

The sun elevation stays raised (22°, from a measured 5.7°) for the reason M1
established: a 6 m perimeter wall at 5.7° casts a 60 m shadow across a 40 m
arena. But the disagreement is now much smaller and much better justified —
against a plate whose warm wedge reaches ~23°, a 22° key is *coherent* with the
picture rather than merely playable.

---

## 28. The carbine: fitted by measurement, and the assertion that proves it

M2 generated the carbine and **deliberately did not ship it** (§24). The reason
was never modelling quality; it was that this project's ADS alignment is
*geometric* (§2.5). The aim-down-sights pose is not a hand-tuned offset that
looks right — it is literally `x = 0, y = -SIGHT_HEIGHT`, which lands the optic on
the screen centre **provided the optic is actually at `(0, SIGHT_HEIGHT)` in
model space.** A generated mesh arrives at an arbitrary scale, in an arbitrary
pose, with its origin wherever the generator put it, and none of that is
recorded anywhere.

The tempting move is to drop it in and nudge the pose until the dot looks
centred. That is the move this whole file exists to not make: it produces a
number nobody can defend, and it breaks silently the next time the asset is
regenerated.

So `src/weapons/carbine.ts` **measures**:

1. **Scale** from the mesh's own bounding box to 0.86 m — a real short-barrelled
   5.56 carbine with the stock collapsed.
2. **The optic** is located by a region rule expressed in *normalised* bounding
   box coordinates (`v > 0.80, w ∈ [0.38, 0.66]`), so the rule survives a
   re-generation at a different scale. The optical axis is the **bounding-box
   centre** of that region, not its vertex centroid: a red dot's tube is hollow
   and its mount hangs below, so a centroid sits low.
3. **The model is translated** so the measured optic centre lands on
   `(0, SIGHT_HEIGHT)`. ADS is now correct *by construction*.
4. **The bore** is found the same way, so the muzzle flash, the tracer origin and
   the world flash light sit on the barrel axis rather than at the model origin.
5. **The magazine is split out of the single generated mesh.** Tripo returns one
   mesh with one material; there is no `magazine` node to find. Rather than
   accept "the asset does not support a reload animation", the triangles inside
   the magazine region are moved to a second geometry that **shares the
   original's vertex attribute buffers** and differs only in its index — one
   extra draw call, zero extra memory, and M1's reload (mag drops at 25%, hidden
   through the swap, seats at 62%) keeps working with the real weapon. **777
   triangles**, measured.

Every one of those five steps is a measurement with a failure mode, so every one
of them reports. `CarbineFit.problems` is non-empty if any region rule caught
nothing plausible, and the caller keeps the placeholder rather than shipping a
weapon whose optic is somewhere unknown — because a misaligned sight is a
*gameplay* failure, not a cosmetic one.

### 28.1 The assertion is the point

New in `tools/smoke.mjs`:

```
[PASS] ADS puts the optic ON the crosshair (geometric, not eyeballed)
       — optic lands 0.14 px from screen centre (NDC 0.00018, -0.00014)
```

It projects the optic's optical axis through the **real viewmodel camera in the
real settled ADS pose** and demands it land within 2 px of the crosshair on a
1600×900 frame. Until M3, §2.5's "geometric, not eyeballed" claim rested on the
placeholder rifle having been *built* with its optic at `SIGHT_HEIGHT` — true,
but circular. This is the first build in which the claim has evidence, and it is
the assertion that fails if anyone ever "fixes" a misaligned sight by moving the
pose.

It also caught its own subtlety on first run: at 450 ms the reading was 3.32 px
and red. The ADS pose is an exponentially-damped blend (`poseTau` 75 ms) with
additive sway and bob on top, and at 450 ms it is still ~0.3% short of target.
That residual is *correct* — a sight that snapped instantly would feel wrong — so
the fix was to let the filter finish before measuring, not to widen the tolerance
until a transient fits inside it. **Widening a tolerance to cover a real
transient is how a gate stops meaning anything.**

### 28.2 The screen budget survived the real mesh

| | placeholder (M2) | generated carbine (M3) | budget |
|---|---:|---:|---:|
| hip | 4.45% | **5.89%** | 15% |
| ADS | 9.24% | **8.83%** | 15% |

This is the number the pipeline failed twice, at ~25%, in four separate blocking
judge rounds. It did not need to be defended by argument here because it is a
**rasterised measurement** — the viewmodel scene is rendered alone into a 192×108
target and the covered pixels are counted — so a fatter mesh simply moves the
number and the gate either passes or does not.

### 28.3 The optic had no reticle in it, and the hands were derived

Two things the mesh could not provide:

**The reticle.** Tripo modelled the *shape* of a red dot; there is no red dot in
it, and aiming down an empty tube is an obstruction rather than a sight picture.
So the reticle is authored, at the measured optical axis — the one place it can
go and still be true. It is drawn with `depthTest: false`, which is what real
shooters do: a reticle is a projected image on the shooter's eye, not a physical
object inside the tube, and depth-testing it against a lumpy generated housing
means it disappears exactly when it is needed.

**The hand mount.** The obvious way to seat a weapon on a hand bone is to guess
three Euler angles and adjust against a screenshot. The first pass did exactly
that and produced a soldier holding a carbine vertically across his chest. The
numbers were also meaningless and would have been silently wrong on any other
rig.

Nothing about the hand bone's own axes needs to be known. What *is* known is
where the weapon must end up — barrel down the body's forward axis, optic up — so
the required world orientation is the model root's turned 180° about Y (the
carbine's muzzle is its −Z; the model's forward is its +Z), and the local
rotation is whatever takes the hand bone there:

```
holderLocal = inverse(handWorld) · (rootWorld · Ry(π))
```

Only *then* is a small deliberate cant added on top (12° muzzle-down, 5° roll),
because a rifle held dead level looks like it is on a tripod. The big rotation is
computed; only the small stylistic one is a number somebody chose. Correspondingly
`buildWorldCarbine` re-origins the weapon **on its pistol grip** (found by the
same normalised region rule), so attaching it is a matter of parenting with a
palm offset rather than of discovering by trial the translation that happens to
work.

The hostiles carry the same weapon the player carries, and so does the
third-person avatar. That is not a detail: a firefight in which the thing
shooting at you is visibly holding nothing is the single most common "unfinished"
read in a generated build, and both dissections have a version of it.

---

## 29. Post-processing: bloom by intent, and a measured budget

### 29.1 Bloom belongs to things that EMIT light, not to things that are bright

The one-line version of this feature is `UnrealBloomPass(threshold 0.85)` on the
composited frame, and it is wrong here in a specific, expensive way. At dusk the
brightest things in the picture are the sky and the sun-facing concrete, so a
threshold bloom **blooms the sky**: contrast collapses, the picture goes soft,
and the actual emitters gain nothing because they were never the brightest pixels
in the first place. The one gameplay-critical emissive in this game is a 400 ms
telegraph the player is meant to read at 30 m. Blooming everything *except* it is
an anti-feature.

So bloom is selective, by an explicit allow-list. `markBloom()` is called at
exactly six sites — the enemy visor lens, the viewmodel muzzle flash, the world
and enemy tracer pools, the impact sparks, and the optic reticle. **Nothing is
tagged by accident and nothing is tagged by brightness.**

The bloom pass then re-renders the scene with every *untagged* material swapped
for flat black. That second render is the expensive choice and it is deliberate:
a layer mask would have been cheaper and would have let a visor glow through a
wall, because objects that are not drawn cannot occlude. Keeping occlusion
correct is what makes the telegraph a *positional* cue rather than a wallhack.

The chain is deliberately short — `ScenePass → FinalPass → SMAA` — with the bloom
mix, the ACES tone map, the dusk grade, the vignette and the sRGB encode folded
into **one** full-screen pass instead of three, because each pass is a 1080p
read+write and they are all cheap arithmetic.

### 29.2 The tone map had to move, and both paths must agree

Since three r152 the renderer applies `toneMapping` **only when it draws to the
canvas**. Rendering the scene into a composer target therefore yields linear HDR
— exactly what bloom needs — and makes the tone map the final pass's job. The
ACES implementation in `postfx.ts` is three's own, copied verbatim, so that
`postfx off` and `postfx on` are the same game at two levels of polish rather
than two differently-exposed games.

That is asserted, not asserted-by-comment:

```
[PASS] postfx ON  renders a readable frame  — mean 0.172
[PASS] postfx OFF renders a readable frame  — mean 0.199
[PASS] the two render paths agree on exposure — Δ0.026
```

The settings screen can turn post-processing off, which means the game has **two
render paths**, and a suite that only exercises one of them is testing half the
build.

### 29.3 The frame budget, measured — and AO rejected on the evidence

Measured on the development machine (Apple M4, ANGLE/Metal, 1600×900, vsync on),
120-frame rolling window:

| configuration | mean | p95 | fps |
|---|---:|---:|---:|
| post-processing OFF | 16.67 ms | 17.2 ms | **60.0** |
| full (bloom + grade + vignette + SMAA) | **16.67 ms** | 16.8–18.1 ms | **60.0** |
| without SMAA | 16.67 ms | 17.3 ms | 60.0 |
| without bloom or SMAA | 16.66 ms | 17.3 ms | 60.1 |
| full + GTAO | **18.9–22.8 ms** | **33.4 ms** | **44–53** |

**Post-processing is free at this resolution on this machine** — every stage sits
inside the vsync cap. **Ambient occlusion is not.** GTAO costs 2.2–6.1 ms of mean
frame time and, more damningly, pushes p95 to 33.4 ms, which is a hard dropped
frame every sync interval. The brief conditioned AO on holding 60 fps at 1080p;
it does not, so **it ships OFF**, remains available behind the settings toggle,
and the number is recorded here rather than the feature being quietly dropped or
quietly shipped.

Two methodological notes, both of which cost time and are worth the reader's:

- **The harness prints which GPU drew the frame.** Headless Chrome can silently
  fall back to SwiftShader, and a frame cost measured on a software rasteriser is
  not a frame cost. Every number above is from `ANGLE Metal Renderer: Apple M4`.
- **Uncapping vsync to measure headroom destroyed the measurement.**
  `--disable-frame-rate-limit` makes the render loop starve the compositor:
  `Page.captureScreenshot` times out and the luminance probe samples a
  half-composited canvas (24% crushed black on a frame that measures 1.5% with
  vsync on). The capped numbers answer the real question anyway, because the
  question is "does it hold 60", not "how fast could it go".

### 29.4 Instrumenting for performance found a latent shader break

`PostFx.setParts()` exists so the cost of each stage can be attributed —
"post-processing costs 5 ms" is not an actionable number. Disabling SMAA made the
final pass the *last* pass, which made its render target the **canvas**, which
made three inject its own `RRTAndODTFit` and `ACESFilmicToneMapping` into the
shader — colliding with the verbatim copies, and failing compilation with
`'RRTAndODTFit' : function already has a body`.

A configuration-dependent shader break, invisible in the shipped configuration,
surfaced by instrumenting for an unrelated question. It is now `nfRRTAndODTFit`
with a comment explaining exactly why the prefix is not decoration.

---

## 30. Audio: synthesised, and the trade stated plainly

The brief allowed either the backend's generative audio tools or hand-built
synthesis. Synthesis won on four grounds:

1. **Payload.** The shipped game is 13 MB, most of it the sky and the soldier. A
   dozen generated WAVs at usable quality is another 2–6 MB for sounds that are
   half a second long — and every one of them is a filtered noise burst with an
   envelope. Storing a rendered PCM copy of a filtered noise burst is paying
   megabytes for arithmetic.
2. **Layering and distance.** A gunshot here is four layers whose parameters are
   driven per shot: a high-passed **crack** sweeping down, a fast low **body**
   (220 → 58 Hz), a bright mechanical **action** tick that makes a burst sound
   like a mechanism rather than a repeated sample, and a **tail** that *grows*
   with distance because a far shot is mostly its own reflections. Enemy fire at
   six ranges is six filter settings, not six sample sets.
3. **Determinism and testability.** No fetch, no decode, no 404, no CDN, no
   "the audio silently failed to load and nobody noticed" — which is the exact
   class of failure §19 exists for. Not having assets is a stronger guarantee
   than loading them loudly.
4. **It is the defensible version.** A generated gunshot would be a *better*
   gunshot. It would also be a black box, and the point of this build is that
   every choice in it has a reason attached.

**The trade, stated honestly:** these are good *synthesised* sounds, not recorded
ones. A shipping game would want recordings for the weapon at minimum. What is
here is convincing at gameplay distance and completely defensible line by line;
it is not a sound designer.

Three details that are design rather than plumbing:

- **Mastering is structural, not a mixing opinion.** Voices → bus → limiter
  (20:1, −8 dBFS, 3 ms attack) → master at 0.62. Web Audio does not clip
  internally — it clips at the *device* — so without a limiter the failure mode
  is a crackle that only appears on someone else's machine.
- **Reload foley is scheduled against the animation, not against its own timer.**
  The three clacks land at the same normalised times the viewmodel's reload uses
  (mag out 25%, mag in 62%, bolt 88%) computed from the real reload duration, so
  the empty-mag reload's extra 550 ms moves the sound with it. Foley on a private
  timer is how a reload ends up clicking after the mag is already seated.
- **Footstep cadence is driven by DISTANCE TRAVELLED, not by a timer.** One step
  per 0.82 m of stride (0.62 crouched, 0.95 sprinting), which is why a sprint
  sounds faster than a walk without a single rate constant anywhere — and why
  crouching is audibly quieter, which matters because the AI's perception is
  real (§7.6) and the audio should agree with what the soldiers can tell.

Audio **never throws**. Browsers refuse an AudioContext before a user gesture,
headless Chrome runs muted, and some environments have no device at all; none of
those may take the game down, so each ends as `ready === false` plus a recorded
reason. `tools/smoke.mjs` asserts both that `initAudio()` does not throw and that
the graph came up.

---

## 31. Two more engine defects, and one that had been shipping behind a comment

### 31.1 Every explicit material override was silently discarded

`assets.standard()` ended with:

```ts
if (mat.roughnessMap) mat.roughness = 1;
if (mat.metalnessMap) mat.metalness = 1;
```

The intent is right — a roughnessMap only *modulates* the scalar, so leaving it
at a default throws the map away. The bug is that it ran **unconditionally**, so
it also overwrote whatever the caller had explicitly asked for. Every
`roughness:` / `metalness:` override in `world/arena.ts` was dead code.

Including this one:

```ts
// Containers are PAINTED steel, not bare. At the metal set's default 0.85
// metalness they mirrored the sky and read as flat blue slabs …
metalness: 0.18,
```

That comment describes a fix, correctly, for a defect that is plainly visible in
`shots/01_spawn.png` — and the fix **had never once executed**. The containers
went on mirroring the sky for the whole of M2.

This is the most instructive bug in the milestone, because of *where* it hid:
**behind a comment asserting the opposite.** Nothing in a 64-assertion suite
could see it, because the suite had no way to ask "did that number reach the
GPU?" A code comment is not a test, and a comment that explains a fix is
indistinguishable from a comment that explains a fix that does not work.

Fixing it required a second change: `arena.ts` had been supplying blanket
per-surface defaults (`0.55/0.7` for metal, `0.92/0.02` otherwise) for *every*
spec, so with the override bug fixed those defaults would have become a blanket
**scaling** of every baked map. They are gone; `undefined` now means "the map is
the value", and only a spec that deliberately says "this surface is painted, not
bare" carries a scalar.

### 31.2 The carbine was assigned to a layer nothing draws

`fitCarbine` set every object to `LAYER.VIEWMODEL`. That constant is a hangover
from a design in which the weapon lived in the *world* scene and was separated by
a layer mask; it has not worked that way since M1, when the viewmodel got its own
scene and its own camera — and every three.js camera has only layer 0 enabled. So
the weapon was invisible to the only camera that ever draws it, in the frame and
in the coverage measurement alike.

It was caught by **`viewmodel is actually on screen (not culled away)` reading
0.00%** — an assertion added at M1 for a completely different reason (a
frustum-culling bug on skinned meshes). That is the argument for keeping cheap
sanity assertions around after the bug that motivated them is dead: this one
found an unrelated defect two milestones later, and it is the difference between
a red test and a human going "the gun is gone".

---

## 32. Difficulty is a distribution, so it was measured

The brief asks for a mission that is losable but winnable — roughly 60–70% for a
competent player. That is a claim about a distribution. There is no way to read a
distribution off a screenshot, off one playthrough, or off the numbers in
`config.ts`, and the author of a shooter is the worst available instrument for
measuring its difficulty because they know where the hostiles spawn.

So `tools/balance.mjs` runs a scripted competent player through the real mission
N times and counts. "Competent" is defined precisely, because the number is only
as meaningful as the bot: it aims at the nearest hostile it has **real** line of
sight to (the engine's own `hasLineOfSight`, not a guess), turns at a bounded
4.5 rad/s rather than snapping, carries a persistent ~1.4° aim error resampled
several times a second, waits 220 ms after acquiring a target before firing,
strafes continuously, reloads at 4 rounds rather than at 0 — and does **not** use
cover, pre-fire, or know where anyone spawns. It runs inside the page on
`requestAnimationFrame`; driving it over CDP measures the harness's round-trip
latency as if it were the player's reaction time.

The tuning history is the deliverable:

| build | change | runs | win rate | mean HP on a win |
|---|---|---:|---:|---:|
| M2 as shipped | damage 9, burst 3 | 16 | **87.5%** | 42 |
| M3 step 1 | damage 9 → 13, headshot 15 → 22 | 20 | **75.0%** | 54 |
| M3 shipped | + burst 3 → 4 | 24 | **62.5%** | 48 |

The step-1 target came from arithmetic rather than from taste: damage taken on a
win was 58.5 ± 18 hp, so a ~1.45× scaling puts the mean close enough to 100 that
the variance does the rest.

**Note what was NOT tuned.** `telegraphMs` stays at 400 and `spreadDeg` stays at
2.6. Shortening the wind-up or tightening the aim cone would also have moved the
win rate — faster, in fact — and both would have done it by taking away the
player's ability to *read* and *dodge*, which is the design (§7). Difficulty is
bought with damage, which the player can respond to, not with information, which
they cannot. The final step used burst length rather than more damage per round
for the same reason: a 4-round burst is still something you can break line of
sight partway through.

Honest limitations: the bot does not use cover, so it measures a floor rather
than the median player; and a run in which it cannot find the last hostile times
out and is counted as a loss, which is conservative toward the game.

---

## 33. What is TUNED vs what is STUBBED at M3

**Tuned, measured, and asserted:**
- Viewmodel screen coverage with the real generated mesh (5.89% / 8.83%).
- ADS optic alignment (0.14 px from centre).
- Frame cost per post-processing stage, on a named GPU.
- Frame luminance on both render paths, and their agreement.
- Mission win rate (62.5% over 24 runs).
- Texture seam ratios (worst 0.892).
- Sky sun direction and warm-arc coverage.

**Deliberately not done, and why:**
- **Ambient occlusion is off.** Measured at 44–53 fps; the brief conditioned it
  on 60. Available in settings.
- **No hands or arms on the viewmodel.** Both dissections call this out in the
  pipeline's build and it is a real gap here too. It needs a rigged first-person
  arms mesh with the weapon parented into it — a generation and rigging job of
  the same size as the soldier, not a polish item, and doing it badly (floating
  detached gloves) is worse than the honest floating weapon.
- **Enemy audio is positional but not occluded.** A shot from behind a wall is
  attenuated by distance, not by the wall. Cheap to add (the collision world
  already answers the query) and deliberately deferred: it would need its own
  assertion to be worth having.
- **The recoil pattern is learnable but not taught.** No firing-range or pattern
  overlay.
- **No difficulty settings.** One tuned curve, measured.
- **WebGPU is still not attempted.** See item 7 of the dissection.

---

## 34. DISSECTION SUMMARY — the top 10 divergences

This is the primary deliverable of the whole exercise: the most instructive
differences between what this build did and what the pipeline was observed to do
across `BASELINE_COD_BUILD.md` (v1) and `REBUILD_COD_V2.md` (v2), each written as
a concrete change to make to the pipeline. Ranked by leverage — item 1 is worth
more than items 5–10 combined, because it is the defect that dominated both runs.

---

### 1. Make the viewmodel screen budget a MECHANICAL gate, not a judged opinion

**Observed.** The weapon viewmodel was a giant unlit black blob at ~25% of the
frame in v1 and again in v2. The visual judge named it in blocking rounds 1, 2, 4
and 5 of v2 — four times, in nearly the same words — and in three consecutive
rounds of v1. It was never fixed. v2's own conclusion: *"This is the whole game,
visually."*

**Why it never got fixed.** It was only ever a *scored* finding. The pipeline's
mechanical gates — compiles, boots, takes input, capture succeeds, playtest
passes — were green throughout both runs, and those are the gates that terminate
the loop. The coder responded to proof demands on every one of those turns and to
the look finding on none of them. **Scorers get ignored; gates get fixed.**

**Change.** Add a `web_measure_viewmodel_coverage` tool that renders the
viewmodel alone into a small offscreen target and counts covered pixels — the
exact rasterised footprint, not a bounding-box estimate — and make it a hard
gate in the FPS playbook: `TERMINAL: SUCCESS` is refused while first-person
coverage is outside 0.5–15%. Pair it with two structural requirements in the
brief that make the number achievable: the viewmodel renders in its own scene
with its own camera in a depth-cleared second pass, and it carries **its own
lights**. A first-person weapon that depends on world lighting will eventually be
a silhouette; when it has a dedicated three-point rig that is structurally
impossible, which is why this build never had the problem to fix.

---

### 2. Every declared seam needs a mechanical "was it called?" assertion

**Observed.** v2's N3: `registerPlayerAvatar` is never called, so pressing **T**
shows the scaffold's **cyan placeholder cube** — while `enemy_soldier_rigged.glb`
exists, ships, and is used for the enemies. A one-line seam the scaffold
documents, skipped. v1's D5 is the same shape: `setEnvironmentFromTexture` was
copied inside a `CF_HEADLESS` guard, so the judge scored a frame lit differently
from the shipped game.

**Change.** Make every scaffold seam self-reporting. The scaffold registers each
seam in a `window.__seams__` map with a `called` flag; the probe reads it and
fails the build on any seam left unfulfilled, naming it. A seam that is a comment
saying "replace this" is a suggestion. A seam that fails the build when it is not
used is a contract.

This build's version of the same idea is stronger and cheaper: **`AvatarModel` is
an interface with a working implementation, not a TODO.** M1 shipped
`GrayboxAvatar` conforming to it, so M2's rigged soldier was a one-line
substitution and there was never a state in which the seam was unfilled. The
generalisable rule is: *ship the default implementation, not the placeholder.*

---

### 3. Give the sky ONE owner, and make the probe report what is actually bound

**Observed.** D10, in both runs, and worse in v2. The scaffold stages a sky
library template at scaffold time; the coder generates a bespoke sky that matches
the concept; the staged template wins. In v2 the coder *explicitly wrote* that
"bespoke dusk sky matches the concept better than the staged library sky",
generated a genuinely good `sky_dusk.png`, and called `applySkyDome` +
`setEnvironmentFromTexture` on it — **and the shipped frame still rendered the
blue/tan `hdri_golden_sunset` cubemap.** The code was right and the frame was
wrong, which is strictly worse than v1, where the generated sky was simply never
wired.

**Change.** Two parts, and the second is the one that matters. (a) When the plan
says the coder generates a sky, the scaffold's staged template must be **removed
from the project tree**, not merely left unreferenced — an asset that cannot be
bound cannot win. (b) The render probe must report the **identity of the sky
actually bound at runtime** (`{templateId, background, environment, envSource}` —
v2's smoke already emits exactly this) and the build must fail when it is not the
one the plan chose. v2 had the evidence in hand and nothing compared it to the
intent.

---

### 4. Measure the thing the viewer sees, not the thing that is easy to measure

**Observed.** Both dissections land on lighting/palette: v1's *"the sky fights the
game … the whole palette is wrong because of it"*, v2's *"the frame is a midday
blue sky over a flat plane"* against a `golden_hour` preset with bloom and grade
wired.

**And we did it too, with a measuring tool in hand.** M2 measured its HDRI's sun
at elevation +2.4°, recorded it, matched the key light's azimuth to it, and
shipped a frame that reads as noon. The measurement was *true* — and it described
one pixel. A sunset plate's warmth is a wedge with a **height**, and the previous
plate's wedge hugged the horizon under a saturated blue zenith.

**Change.** Extend the sky/lighting probe from "where is the brightest texel" to
whole-plate statistics that describe the *visible* sky: warm fraction above the
horizon, fraction of the horizon **arc** that is warm, and the median height of
the warm wedge. Gate mood-vs-concept coherence on those. Generalised: **for every
"we measured it" gate in the pipeline, ask what fraction of the delivered pixels
the measurement actually describes.** A statistic over one texel is not a
statistic over a frame.

---

### 5. Assert what reached the GPU — code comments and code are both insufficient

**Observed.** D5 (env map right in code, wrong in the captured frame), D10 (sky
right in code, wrong in the frame). And in this build, §31.1: `assets.standard()`
silently overwrote every explicit `roughness`/`metalness` override, so the
shipping containers' `metalness: 0.18` — carrying a comment explaining that it
fixes them mirroring the sky — **never executed for the whole of M2**, and the
containers are visibly blue slabs in the M2 screenshots.

The common shape is: *the source says X, the frame says Y, and nothing compares
them.*

**Change.** Add a **material/scene truth probe** that walks the live scene graph
after boot and emits the resolved values actually bound — per material:
`roughness`, `metalness`, which maps are present, `envMapIntensity`; per light:
type, colour, intensity, direction; plus tone mapping and exposure. Diff that
against the plan's declared art direction and surface the differences in the
build receipt. Most "the code is right and the frame is wrong" defects in both
runs die instantly against a readback, and none of them are visible to any
amount of code review.

---

### 6. Every asset-producing or asset-transforming tool must assert a structural post-condition

**Observed.** v2's N4: two **0-byte model files** ship, after `[S3] read FAILED …
reason='empty-body'` logged 10× following 5 retries each. N6: a texture with a
**null image** is bound on both backends — WebGL degrades with six
`Texture marked for update but no image data found` warnings, WebGPU throws and
never boots.

**And our own, which is the sharpest version of it** (§22.1): `gltf-transform
optimize` with Draco turned every 2.6 MB prop into a **3 KB file, exit code 0, no
warning**. A tool reported success while destroying the asset. It was replaced
with `assetgen/optimize_glb.py`, which parses the GLB JSON chunk and compares
mesh / primitive / node / accessor / animation / skin counts and vertex totals
before and after, and fails on any mismatch.

**Change.** Make "success" mean "the artifact is usable", enforced. Every asset
tool asserts, before returning: non-zero bytes, the container parses, and — for
transforms — the structural counts are preserved. A downloaded texture asserts a
decodable image with non-zero dimensions **at download time**, not at bind time
on a backend nobody tests. Exit code 0 with a destroyed artifact is the worst
possible failure mode, because every downstream check inherits the lie.

---

### 7. Ship one backend and prove it, or prove both

**Observed.** The WebGPU path was broken in v1 (`GPUValidationError`, a 1×1
placeholder bound where a 6-face cube was expected — renders, but materially
darker with environment lighting lost) and broken *differently and worse* in v2
(`TypeError: Cannot read properties of null` in `three.webgpu` `updateTexture` —
**the game never boots, stuck at LOADING 0%**). Both times it was **invisible to
the probe and to the judge, because both force WebGL.** v1's own note: *"Same root
cause, silent on the backend everybody tests."*

**Change.** Either drop the WebGPU path from the shipped bundle entirely until it
has a gate, or add a real-GPU headless smoke that boots it and fails on any
uncaptured WebGPU error and on a boot that does not reach first frame. A code
path that ships to players and is verified by nothing is worse than one that does
not ship — it converts a known limitation into a random one.

This build chose the first option and wrote the reason down at M1 (§1.1): **WebGL
only, deliberately, because reliability beats novelty for a reference build.**
That decision cost nothing and removed an entire failure class that consumed two
pipeline runs.

---

### 8. Make the runway buy fixes instead of proof

**Observed.** v1's D3 — the loop terminated SUCCESS on a live blocking verdict at
half budget — was correctly identified as the highest-leverage fix, shipped, and
worked: `refusing SUCCESS — blocking verdict live` fired **13 times**. And the
score went **from 4/10 to 2/10.** v2's own diagnosis: *"between judge rounds, the
coder is not doing visual work"* — the extra runway went into the **proof loop**
(`web_capture_render` at 30–33 s, `web_run_playtest` at 8–11 s, each re-demanded
whenever the other landed), not the fix loop. Attempt 1 then died on the 140-turn
cap with under half its dollars spent (N1). Meanwhile the *same* weapon finding
appeared in four separate rounds and nothing in the loop treats "the judge said
this four times" differently from "the judge said this once".

**Change.** Two coupled changes. (a) **Cache proof against a source hash.** A
capture and a playtest do not invalidate each other; re-demand either only when
the files it covers have changed. (b) **Escalate repeats.** Hash each judge
finding; on the second identical finding, force a *fix-only* turn — no capture,
no playtest — that must produce a diff touching the named subsystem, and on the
third, fail the build with that finding as the reason. Right now more budget buys
more evidence that the same thing is still broken.

---

### 9. Difficulty is a distribution — measure it with a scripted competent player

**Observed.** The pipeline never measures difficulty at all. v2's verification
reports *"player health drops 100 → 52 during a 9 s forward run"* as evidence that
**combat is live** — which it is — and there is no notion anywhere of whether the
mission is winnable, let alone how often. Combined with enemies that **fire while
moving**, the shipped experience is unbounded in both directions and nobody can
say which.

**Change.** Add a bot-playtest tool that runs the built game N times with a
scripted competent player and returns a win-rate distribution, and make a target
band part of the plan the build is graded against. Define "competent" explicitly
in the tool (bounded turn rate, persistent aim error, reaction delay, strafing,
sane reload behaviour, no cover use) so the number means something and is
comparable across builds. Then tune against it: this build went 87.5% → 75% →
**62.5%** across three measured configurations.

And a design rule that came out of doing it: **buy difficulty with damage, not
with information.** Shortening the aim telegraph or tightening the enemy cone
moves the win rate faster than raising damage does, and both do it by removing
the player's ability to read and dodge. The telegraph is the design; it is not a
tuning knob.

---

### 10. Bloom by intent, and give every optional stage a measured cost

**Observed.** v2 ships `golden_hour`, bloom and grade all wired, and the verdict
on the frame is *"Lighting is flat … a midday blue sky over a flat plane."*
Post-processing was present and contributed nothing, because a threshold bloom
over a bright sky blooms the sky. Separately, D9: **`judge_asset` is absent from
the catalog**, so 9 (v1) and 10 (v2) generated images shipped **uninspected on a
build whose entire purpose was visual quality** — an optional quality stage that
was simply not there, and whose absence was logged every turn and acted on never.

**Change.** Two parts. (a) **Bloom requires an explicit emitter allow-list.** The
brief should demand that the coder tag authored emitters (muzzle flashes, screens,
lights, telegraphs, tracers) and bloom *only* those, via the standard two-pass
selective method so occlusion stays correct. Threshold bloom on an outdoor
daylight or dusk frame is an anti-feature and should be named as one. (b) **Every
optional render stage carries a measured cost in the build receipt** — frame time
with the stage on and off, on a named GPU — and any stage that misses the frame
budget ships **off**, behind a settings toggle, with the number recorded. That is
what happened here: post-processing measured free (16.67 ms, locked 60) and
shipped on; GTAO measured 18.9–22.8 ms mean with a 33.4 ms p95 and shipped off.
Neither outcome was a matter of opinion.

Finally, on D9 specifically: **a quality gate that is absent from the catalog
should fail the build, not log a skip.** `asset-inspection gate skipped` repeated
every turn for two consecutive runs is a gate that exists only in the
documentation.

---

### The thread running through all ten

Nine of these ten are the same sentence in different clothes:

> **The pipeline's mechanical gates are excellent and its judged findings are
> advisory, so everything that is only judged does not get fixed.**

The fix is not a better judge. It is to convert the things that actually
determine whether a build reads as finished — viewmodel scale, seam fulfilment,
which asset is bound, whether the frame's mood matches the concept, what reached
the GPU, whether the artifact is usable, whether the optional stage is affordable,
whether the mission is winnable — from *opinions a scorer holds* into
**measurements a gate enforces**. Every one of them is cheap. Every one of them
is a number this build already computes.
