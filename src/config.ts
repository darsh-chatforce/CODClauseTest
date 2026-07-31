/**
 * Operation Nightfall — single tuning surface.
 *
 * Every feel-critical number lives here so a tuning pass is one file, and so the
 * "what is tuned vs what is a placeholder" question has a literal answer.
 * Units: metres, seconds, radians unless stated.
 */

export const PLAYER = {
  /** Eye height standing. Human-ish; a 1.8m soldier. */
  eyeHeight: 1.68,
  eyeHeightCrouched: 1.02,
  /** Collision cylinder. */
  radius: 0.34,
  height: 1.8,
  heightCrouched: 1.15,

  /** Ground speeds. Reference: modern military FPS run ≈ 7 m/s. */
  walkSpeed: 5.1,
  sprintSpeed: 7.3,
  crouchSpeed: 2.5,
  adsSpeed: 3.2,

  /** Acceleration/deceleration — high values = crisp start, snappy stop. */
  groundAccel: 62,
  groundDecel: 48,
  airAccel: 12,
  /** Fraction of ground control retained in air (0..1). */
  airControl: 0.42,

  gravity: 22.5,
  jumpSpeed: 6.4,
  /** Forgiveness windows (ms) — invisible but they are why jumping feels fair. */
  coyoteTimeMs: 110,
  jumpBufferMs: 130,
  /** Max height auto-stepped without a jump (stairs, kerbs). */
  stepHeight: 0.46,
  /** Crouch/stand transition speed (metres per second of eye travel). */
  crouchLerpSpeed: 7.5,

  maxHealth: 100,
  /** Regeneration is intentionally OFF for M1: readable damage economy. */
  healthRegenPerSec: 0,

  /** Landing feedback thresholds. */
  landSoftSpeed: 4.0,
  landHardSpeed: 9.0,
} as const;

export const LOOK = {
  sensitivity: 0.0022, // radians per pixel of mouse movement
  adsSensitivityScale: 0.62,
  pitchMin: -Math.PI / 2 + 0.02,
  pitchMax: Math.PI / 2 - 0.02,
} as const;

export const CAMERA = {
  fov: 75,
  adsFov: 48,
  sprintFovBonus: 6.5,
  /** Exponential smoothing time-constants (seconds). Lower = snappier. */
  fovTau: 0.085,
  near: 0.05,
  far: 400,
  /** Separate viewmodel camera: fixed FOV so the gun never distorts and never
   *  intersects world geometry (rendered in its own depth-cleared pass). Wider
   *  than the world FOV would suggest — it shrinks the gun's screen footprint
   *  and flattens the foreshortening that makes a near-camera prop read as a
   *  slab rather than as a weapon. */
  viewmodelFov: 68,
} as const;

export const WEAPON = {
  name: 'MK-4 CARBINE',
  magSize: 30,
  reserveMax: 120,
  startReserve: 120,
  /** 720 rpm. */
  fireIntervalMs: 83,
  reloadMs: 2050,
  /** Empty-mag reload is longer (bolt catch). */
  reloadEmptyMs: 2600,
  damage: 26,
  headshotMultiplier: 2.2,
  range: 160,

  /** Spread, in degrees of cone half-angle. */
  spreadBase: 0.35,
  spreadAds: 0.06,
  spreadMoving: 1.5,
  spreadSprint: 3.4,
  spreadJumping: 3.0,
  /** Bloom added per shot, and how fast it bleeds off (deg, deg/s).
   *  Recovery is deliberately slower than the fire rate, so holding the trigger
   *  loses accuracy and tapping keeps it — the core skill expression of an
   *  automatic weapon. A full 30-round mag walks the cone out to the cap. */
  spreadPerShot: 0.5,
  spreadMax: 4.5,
  spreadRecoverPerSec: 2.4,

  /** Recoil kick per shot (radians) — pitch up, yaw jitter. */
  recoilPitch: 0.0165,
  recoilYaw: 0.0072,
  recoilAdsScale: 0.62,
  /** Spring return: how fast the camera walks back to the pre-recoil aim. */
  recoilRecoverTau: 0.14,
  /** Fraction of recoil the player keeps (never auto-recovered) — a real gun
   *  climbs. 0 = fully compensating, 1 = no recovery. */
  recoilRetain: 0.22,

  adsTimeMs: 170,
  tracerSpeed: 320,
  tracerLength: 7.5,
} as const;

export const VIEWMODEL = {
  /** Hip pose, in camera space. -X left, +X right, -Z into the scene.
   *  The gun's own origin is its receiver; the muzzle is at local z = -0.70, so
   *  at hip the barrel reaches ~1.3 m downrange and clearly points INTO the
   *  scene under the crosshair. */
  hip: { x: 0.235, y: -0.2, z: -0.7 },
  /** ADS: x = 0 and y = -SIGHT_HEIGHT put the optic exactly on the screen
   *  centre; z pulls the gun back so the eye is at the sight (geometry behind
   *  the eye is near-plane clipped, which is what real shooters do). */
  ads: { x: 0.0, y: -0.093, z: -0.36 },
  sprint: { x: 0.3, y: -0.3, z: -0.62 },
  /** Sprint pose rotation (radians) — barrel angled down-right, "at rest". */
  sprintRot: { x: -0.32, y: 0.55, z: 0.18 },
  /** Positional smoothing time-constants (seconds). */
  poseTau: 0.075,
  swayTau: 0.09,
  /** Look-sway: metres of counter-motion per radian/sec of look velocity. */
  swayAmount: 0.021,
  swayMax: 0.05,
  /** Walk bob amplitude (m) and cycle rate (Hz at full speed). */
  bobAmount: 0.017,
  bobRate: 1.65,
  /** Recoil kickback along +Z and rotation. */
  kickBack: 0.045,
  kickPitch: 0.09,
  kickTau: 0.06,
  /** HARD BUDGET: the viewmodel must never cover more than this fraction of the
   *  frame. Asserted by tools/smoke.mjs — the pipeline failed exactly this twice. */
  maxScreenCoverage: 0.15,
} as const;

export const ENEMY = {
  count: 6,
  health: 100,
  radius: 0.36,
  height: 1.8,

  /** Movement — deliberately slower than the player. */
  patrolSpeed: 2.0,
  advanceSpeed: 3.5,
  repositionSpeed: 4.2,
  accel: 14,
  /** Turn rate while moving (rad/s) — they FACE their velocity. */
  turnRate: 7.0,
  /** Turn rate while aiming at the player (rad/s). */
  aimTurnRate: 4.2,

  /** ===== Fire doctrine (user directive) =====
   *  Enemies NEVER fire while moving. move → halt → aim → burst → reposition.
   *  `haltMs` is the settle after stopping; `telegraphMs` is the readable
   *  wind-up before the first round leaves the barrel. */
  haltMs: 180,
  telegraphMs: 400,
  burstCount: 3,
  burstIntervalMs: 130,
  postBurstMs: 420,
  /** Speed below which the enemy counts as "stopped" (m/s). The smoke test
   *  asserts speed < this whenever state ∈ {halt, aim, fire}. */
  stoppedSpeed: 0.05,

  damage: 9,
  headshotDamage: 15,
  /** Aim cone half-angle in degrees; larger = more dodgeable. */
  spreadDeg: 2.6,
  range: 55,
  /** Engagement band — they close to this before halting to shoot. */
  preferredRange: 18,
  minRange: 7,
  /** Sight. */
  viewDistance: 60,
  fovDeg: 130,
  /** How long they keep hunting the last known position after losing sight. */
  memoryMs: 4500,

  /** Reposition every N successful bursts, or when the player breaks LOS. */
  burstsBeforeReposition: 2,
  /** Cover-adjacent waypoints are preferred by this weight when repositioning. */
  coverBias: 0.55,

  /** Hit reaction. */
  flinchMs: 140,
  deathCollapseMs: 900,
  corpseLingerMs: 30000,
} as const;

export const ARENA = {
  /** Playable footprint (metres). Fully enclosed — perimeter walls on all four
   *  sides, no gaps. The pipeline's build shipped a missing wall. */
  size: 40,
  wallHeight: 6,
  wallThickness: 0.6,
  /** Upper terrace. */
  terraceHeight: 3.0,

  /** ===== M2 materiality =====
   *  Texture tiling is stated in TILES PER METRE so the numbers mean something
   *  physical. A 1024² albedo at 0.5 tiles/m is a 2 m surface feature — roughly
   *  a real concrete form-board panel. */
  tilesPerMetreGround: 0.28,
  /** SECOND ground texture, deliberately at a DIFFERENT scale AND a different
   *  material. The house rule is anti-tiling: one texture repeated across a
   *  40 m floor reads as a grid no matter how seamless it is, so the floor is
   *  two surfaces — a slab apron and drifted sand — blended by a large-scale
   *  mask. The scales are non-harmonic (0.28 vs 0.11 ≈ 2.55×, not 2×) so the
   *  two patterns never come back into phase. */
  tilesPerMetreGroundB: 0.11,
  tilesPerMetreWall: 0.34,
  tilesPerMetreProp: 1.1,

  /** Terrain berm: an earth ridge OUTSIDE the compound so the perimeter wall is
   *  never silhouetted against bare sky. Radius from centre, and the height it
   *  rises to. It is decorative only — outside the collision world entirely. */
  /** The berm has to break the SKYLINE, which is a stricter constraint than
   *  "be outside the walls". From eye height (1.68 m) the sightline grazing a
   *  6 m wall 20.3 m away rises at ~0.21 m/m, so at 60 m it is already 14.5 m
   *  up — an 11 m ridge out at 100 m sat entirely BELOW it and was invisible
   *  from the floor, which is where the player spends the game. Pulled in and
   *  raised until it actually clears that line. */
  bermInnerRadius: 28,
  bermOuterRadius: 240,
  bermHeight: 24,
  /** How far the outer skirt drops BELOW ground by the outer radius, so the ring
   *  passes under the horizon instead of terminating on a visible circular edge. */
  bermFalloff: 42,
} as const;

/** Sky, exposure and the light budget. Grouped because they only make sense
 *  together: changing exposure without changing the light intensities just
 *  moves the whole picture up or down the tone curve. */
export const SKY = {
  /** ACES exposure. The `hdri_twilight_quarry` template recommends 0.5 for its
   *  own runtime; this build sits higher because it also carries a 22° key light
   *  (see environment.ts) rather than relying on the sky alone. The shipped
   *  value is defended by the frame-luminance assertion in tools/smoke.mjs, and
   *  since M3 it is ALSO the exposure the post-processing chain tone-maps at —
   *  one number, two render paths, so `postfx off` is the same picture. */
  exposure: 0.72,
  /** How brightly the sky IMAGE is drawn behind the level. Held DOWN: a sky that
   *  out-values the level flattens it. M3's plate is a brighter, hazier
   *  golden hour than M2's (mean face luminance 0.40 vs 0.26), so this comes
   *  down with it — the sky did not get to be more of the picture just because
   *  the file changed. */
  backgroundIntensity: 0.5,
  /** How much the sky LIGHTS the level via the PMREM environment map. */
  environmentIntensity: 0.85,

  sunIntensity: 3.6,
  /** Ambient is the dusk budget. M1 §5.2's lesson holds: a dusk palette is about
   *  hue and contrast, not about crushing values below the display floor — but
   *  the IBL now supplies most of the sky fill, so the hemisphere is pulled
   *  back to stop the two stacking into daylight. */
  hemiIntensity: 0.66,
  fillIntensity: 0.36,

  /** ExpF2 density. Tuned so the compound is CLEAR and only the berm dissolves.
   *  M2 sat at 0.0115 against a dark blue fog; against M3's brighter dusk plate
   *  the same density read as heavy haze and flattened the whole compound, so it
   *  comes down. The berm still dissolves because it is 60-140 m out — fog is
   *  exponential in distance, and the perimeter wall is only 28 m away. */
  fogDensity: 0.006,
} as const;

export const FEEL = {
  /** Trauma-based screenshake (see fx/feel.ts). */
  traumaFire: 0.11,
  traumaFireAds: 0.06,
  traumaHit: 0.42,
  traumaKill: 0.2,
  traumaLand: 0.16,
  traumaDecay: 1.5,
  shakeMaxOffset: 0.11,
  shakeMaxRoll: 0.02,

  /** Hitstop — reserved for kills only, so it reads as weight, not lag. */
  hitstopKillMs: 55,
  hitstopScale: 0.06,

  fovKickFire: 1.1,
  fovKickHit: 3.5,
  fovKickTau: 0.16,

  damageFlashMs: 110,
  damageArcMs: 900,
  hitMarkerMs: 140,
} as const;

export const MISSION = {
  objective: 'CLEAR THE COMPOUND',
  /** Score awards. */
  scoreKill: 100,
  scoreHeadshot: 175,
  scoreTimeBonusPerSec: 5,
  scoreAccuracyBonus: 500,
} as const;

/** Rendering layers. The viewmodel lives on its own layer and is drawn by a
 *  second camera in a depth-cleared pass — the standard AAA trick that stops the
 *  gun clipping through walls, and the reason the viewmodel FOV can be tuned
 *  independently of the world FOV. */
export const LAYER = {
  WORLD: 0,
  VIEWMODEL: 1,
} as const;
