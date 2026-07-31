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
