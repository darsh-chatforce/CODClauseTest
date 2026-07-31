import * as THREE from 'three';
import { ARENA, LAYER, SKY } from '../config';
import type { Assets } from './assets';

/**
 * Dusk lighting.
 *
 * M2 replaces M1's procedural gradient with a REAL photographic sky: Poly Haven's
 * `industrial_sunset_02_puresky` (CC0), staged in the backend's shared sky library
 * as the `hdri_industrial_dusk` template — six 1024² cube faces for the background
 * plus a 256×128 equirect that is PMREM-prefiltered into `scene.environment`.
 *
 * Three things about this are deliberate, and they are the reason it does not
 * look like the pipeline's builds:
 *
 * 1. **The sun direction is MEASURED off the sky's own pixels**, not guessed.
 *    `assetgen/sky_sun.py` finds the brightest region across the six faces and
 *    converts it to a world direction; the azimuth it reports (126°) is pasted in
 *    below. A sky whose sun is in one place and a key light that rakes from
 *    another is the loudest possible "this is fake" cue, and it is exactly what
 *    both dissections describe — a staged library sky fighting the coder's own
 *    lighting.
 *
 * 2. **The elevation deliberately does NOT match** — see `SUN_ELEVATION_DEG`.
 *
 * 3. **Exposure is explicit and gated.** A dusk HDRI at a default exposure reads
 *    as flat grey. The template ships a recommended exposure; that is the
 *    starting point, and the shipped value is defended by a measured
 *    frame-luminance assertion in `tools/smoke.mjs` rather than by eye.
 *
 * The procedural M1 sky is KEPT as a fallback. If the HDRI 404s the game is a
 * degraded dusk rather than a black void — loud in the asset report, soft in the
 * frame.
 */

export interface EnvironmentHandles {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  /** Procedural fallback sky mesh — hidden once the HDRI is in. */
  proceduralSky: THREE.Mesh;
  sunDirection: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Measured from public/sky/ by assetgen/sky_sun.py. Re-run it if the sky changes.
//   template : hdri_twilight_quarry
//              (Poly Haven drackenstein_quarry_puresky, CC0)
//   sun      : azimuth +126.0°, elevation +5.7°
//   colours  : horizon #928b7b · zenith #454d5a · sun-side horizon #c9bda1
//              anti-sun horizon #7a7c77
// ---------------------------------------------------------------------------
const MEASURED_SUN_AZIMUTH_DEG = 126.0;

/**
 * M3: THE SKY WAS REPLACED, AND WHY THE FIRST ONE FAILED.
 *
 * M2 shipped `hdri_industrial_dusk` — a plate that MEASURES as a sunset (its sun
 * sat at +2.4° elevation) and RENDERS as a midday blue sky. The gate review said
 * so in one line, and it was right. The failure is worth recording precisely,
 * because "measured, therefore correct" is exactly the trap this project keeps
 * walking into:
 *
 *   A sunset plate's warmth is a WEDGE around the sun, and that wedge has a
 *   HEIGHT. `industrial_sunset_02_puresky` has a spectacular one — but it is
 *   about 35° wide and hugs the horizon, and everything outside it is a
 *   saturated blue zenith. The measurement `elevation = +2.4°` is a true
 *   statement about one pixel. It says nothing about the other 99.99% of the
 *   sky, which is what the player is actually looking at.
 *
 * So the replacement was chosen on a DIFFERENT measurement — how much of the
 * visible sky is warm, not where the brightest pixel is. `hdri_twilight_quarry`
 * carries a warm tint across the whole horizon arc with a median warm-wedge
 * height of ~23°, and a desaturated slate zenith rather than a blue one. The
 * per-face numbers from `sky_sun.py` show the same thing: the sun-facing face
 * has a warm fraction of 0.61 and the ANTI-SUN faces still sit at a neutral
 * grey-blue (mean RGB 0.347/0.373/0.392) rather than the previous plate's
 * cobalt. Turn around in this level and it still looks like evening.
 *
 * The lesson generalises past skies and is item 4 of the dissection summary: a
 * measurement is only a gate if it measures the thing the viewer sees.
 */

/**
 * WHERE THE SUN IS PUT, AND WHY THE SKY IS ROTATED TO FOLLOW IT.
 *
 * At the measured 126° the sun sits almost 90° to the right of the spawn view
 * (the player spawns facing ~37°), so the compound was lit from off-screen and
 * every frame showed the sky's COOL anti-sun half. The result read as a midday
 * blue sky — which is, word for word, what the v2 dissection says about the
 * pipeline's build: *"the frame is a midday blue sky over a flat plane."*
 * Shipping a sunset HDRI that renders as noon is a worse failure than shipping
 * no HDRI at all, because it costs the download and looks the same.
 *
 * So the sun is placed where the composition needs it — 58°, backlighting the
 * compound across the spawn sightline — and THE SKY IS ROTATED BY THE
 * DIFFERENCE so the two stay locked. That is the important part: the rotation is
 * DERIVED from the two azimuths, not hand-tuned, so the sky's own sun and the
 * directional light physically cannot drift apart. Changing `SUN_AZIMUTH_DEG`
 * turns the sky with it.
 */
const SUN_AZIMUTH_DEG = 58.0;

/** Radians to rotate the sky so its sun lands at `SUN_AZIMUTH_DEG`. Derived. */
const SKY_ROTATION_Y = ((SUN_AZIMUTH_DEG - MEASURED_SUN_AZIMUTH_DEG) * Math.PI) / 180;

/**
 * THE ONE PLACE THE SKY AND THE LIGHT ARE ALLOWED TO DISAGREE.
 *
 * The measured elevation is **2.4°** — it is a sunset plate and the sun is
 * sitting on the horizon. Using it would be a bug, not a look: M1 already
 * established (DECISIONS §5.1) that a 6 m perimeter wall at 11° casts a 31 m
 * shadow across a 40 m arena and blacks the entire floor out. At 2.4° that
 * shadow is ~143 m — the whole compound would be in shade and the level would be
 * unreadable.
 *
 * So the AZIMUTH is matched exactly — that is what the eye actually checks, that
 * the bright part of the sky and the direction shadows point agree — and the
 * ELEVATION is raised to a playable rake. The frame reads as "the sun is low
 * behind that ridge", which is true, rather than as an unlit level.
 */
const SUN_ELEVATION_DEG = 22.0;

function directionFrom(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  // Azimuth is measured from -Z (the game's north) toward +X — the same
  // convention as assetgen/sky_sun.py and the forward vector in ai/enemy.ts.
  return new THREE.Vector3(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
}

/**
 * Sampled from the sky's own horizon band, so fog and sky cannot disagree — but
 * sampled from the SHADOW side of it, not the mean.
 *
 * The first M3 pass took the measured horizon straight (#928b7b) and the
 * compound turned to milk: a fog colour brighter than most of the level lifts
 * every distant surface toward the sky's value, and contrast is the first thing
 * to die. The horizon band the fog has to match is the one BEHIND the compound,
 * which is the cooler, darker part of the arc.
 */
const FOG_COLOR = new THREE.Color(0x6f6a61);
/** The key light. Warmer and more saturated than the plate's own sun-side
 *  horizon (#c9bda1), on purpose: that pixel is haze-desaturated sky, whereas
 *  DIRECT light from a sun at 22° is the last of the warm end of the spectrum. */
const SUN_COLOR = new THREE.Color(0xffcf96);
/** Hemisphere sky + the cool anti-sun fill. Taken from the new plate's
 *  desaturated slate zenith (#454d5a), lifted so it can actually fill. M2's
 *  0x5b7fae was a cobalt sampled from a plate that no longer exists. */
const SKY_FILL_COLOR = new THREE.Color(0x6b7a8f);
/**
 * Bounce from the ground — and this one is deliberately NOT sampled from the sky.
 * The plate's lower hemisphere is a grey quarry lake (#323438); OUR ground is
 * warm sand and a concrete apron. The hemisphere light's ground term models
 * light bouncing off the surface the player is standing on, not off the surface
 * in the photograph, so it stays the compound's own colour.
 */
const GROUND_BOUNCE_COLOR = new THREE.Color(0x584636);

// --------------------------------------------------------- procedural fallback
const SKY_TOP = new THREE.Color(0x454d5a);
const SKY_HORIZON = new THREE.Color(0x928b7b);
const SKY_GLOW = new THREE.Color(0xe8d6b0);

const SKY_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(world.xyz - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uSunDir;
  varying vec3 vWorldDir;

  void main() {
    vec3 dir = normalize(vWorldDir);
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(h, 0.45));
    float sd = max(dot(dir, uSunDir), 0.0);
    col += uGlow * pow(sd, 3.5) * 0.30;
    col += uGlow * pow(sd, 90.0) * 1.9;
    col += uGlow * 0.16 * pow(1.0 - abs(dir.y), 4.0);
    col = mix(col, uHorizon * 0.32, smoothstep(0.0, -0.3, dir.y));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildEnvironment(scene: THREE.Scene): EnvironmentHandles {
  const sunDir = directionFrom(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG);

  // Fog is tuned so the perimeter wall (≤ 28 m away) is essentially unfogged
  // while the terrain berm beyond it (60–140 m) dissolves into the sky. Density
  // lives in config next to everything else that is tunable.
  scene.fog = new THREE.FogExp2(FOG_COLOR.getHex(), SKY.fogDensity);
  scene.background = FOG_COLOR.clone();

  // ------------------------------------------------ procedural fallback sky
  const skyGeo = new THREE.SphereGeometry(ARENA.size * 8, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: SKY_TOP },
      uHorizon: { value: SKY_HORIZON },
      uGlow: { value: SKY_GLOW },
      uSunDir: { value: sunDir },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
  const proceduralSky = new THREE.Mesh(skyGeo, skyMat);
  proceduralSky.name = 'procedural-sky-fallback';
  proceduralSky.frustumCulled = false;
  proceduralSky.layers.set(LAYER.WORLD);
  scene.add(proceduralSky);

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight(
    SKY_FILL_COLOR.getHex(),
    GROUND_BOUNCE_COLOR.getHex(),
    SKY.hemiIntensity,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(SUN_COLOR.getHex(), SKY.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(80);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  const c = sun.shadow.camera;
  /**
   * THE SHADOW CAMERA MUST COVER EVERY SURFACE A SHADOW CAN LAND ON, not just
   * the playable footprint. (DECISIONS §35 — this is one of two causes of the
   * reported terrain flicker.)
   *
   * M2 sized this at `ARENA.size * 0.8` = ±32 m, which covers the 40 m compound
   * comfortably. But the terrain berm starts at r = 28 m and is
   * `receiveShadow = true`, and a 6 m perimeter wall under a 22° sun throws a
   * 6/tan(22°) ≈ 14.9 m shadow — so wall shadows genuinely reach r ≈ 35 m, onto
   * berm that sits OUTSIDE the shadow frustum.
   *
   * three's shadow shader returns "fully lit" for any fragment outside the
   * frustum, so the result was a hard circular discontinuity in the terrain's
   * lighting at exactly r = 32 m, with fragments right on the boundary flipping
   * between shadowed and lit as the camera moved. That reads precisely as
   * "the dunes have lighting issues and flicker".
   *
   * ±40 m covers the compound plus the whole band wall shadows can reach. The
   * cost is shadow-map density: 2048² over 80 m is 3.9 cm/texel instead of
   * 3.1 cm, which is invisible at the scales this level uses.
   */
  const R = ARENA.size;
  c.left = -R;
  c.right = R;
  c.top = R;
  c.bottom = -R;
  c.near = 1;
  c.far = 220;
  c.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // Cool bounce from the anti-sun side. No shadows — pure fill, so shadowed
  // faces carry form instead of collapsing to flat black.
  const fill = new THREE.DirectionalLight(SKY_FILL_COLOR.getHex(), SKY.fillIntensity);
  fill.position.copy(sunDir).multiplyScalar(-60).setY(30);
  scene.add(fill);

  return { sun, hemi, fill, proceduralSky, sunDirection: sunDir };
}

/**
 * Swap the procedural fallback for the loaded photographic sky and rebuild the
 * image-based lighting from it.
 *
 * IBL is not decoration. Metallic materials with no environment render BLACK —
 * no diffuse term, nothing to reflect — and that is exactly how a weapon
 * viewmodel ends up as an unlit silhouette (this project's own first render did
 * it; DECISIONS §2.2). Every metal surface in the game, in BOTH scenes,
 * reflects this map.
 */
export function applySky(
  renderer: THREE.WebGLRenderer,
  scenes: THREE.Scene[],
  env: EnvironmentHandles,
  assets: Assets,
): { applied: boolean; source: 'hdri' | 'procedural' } {
  const source = assets.skyEquirect;
  if (!source) {
    // Degraded, not broken: keep the procedural dome. The asset report already
    // carries the failure and the smoke suite fails the build on it.
    return { applied: false, source: 'procedural' };
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(source).texture;
  pmrem.dispose();

  for (const scene of scenes) {
    scene.environment = envMap;
    // `environmentIntensity` is the honest knob for "how much does the sky light
    // the world". Reaching for `toneMappingExposure` instead would brighten the
    // sky IMAGE too and wash the dusk out of the picture.
    scene.environmentIntensity = SKY.environmentIntensity;
    // The IBL is rotated by the SAME derived angle as the background, so the
    // ambient light arrives from the same side as the visible sun.
    scene.environmentRotation.set(0, SKY_ROTATION_Y, 0);
  }

  const world = scenes[0];
  if (assets.skyCube) {
    world.background = assets.skyCube;
    world.backgroundIntensity = SKY.backgroundIntensity;
    world.backgroundRotation.set(0, SKY_ROTATION_Y, 0);
    env.proceduralSky.visible = false;
  }
  return { applied: true, source: 'hdri' };
}

/** Configure a renderer for the dusk look. Kept next to the lighting it serves. */
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = SKY.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}
