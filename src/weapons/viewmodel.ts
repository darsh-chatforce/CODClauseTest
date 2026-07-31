import * as THREE from 'three';
import { CAMERA, VIEWMODEL } from '../config';
import { clamp, damp, easeOutCubic } from '../core/mathx';
import { rng } from '../core/rng';
import { markBloom } from '../fx/postfx';
import { flashTexture } from '../fx/textures';

/**
 * First-person weapon viewmodel.
 *
 * THE ARCHITECTURE, and why it is this one — the pipeline shipped an unlit black
 * blob covering ~25% of the frame, twice, and every one of these choices is a
 * direct answer to that failure:
 *
 *  1. SEPARATE SCENE + SEPARATE CAMERA. The gun lives in its own `THREE.Scene`
 *     rendered by its own camera in a second, depth-cleared pass. Consequences:
 *     the gun can never clip through a wall; its FOV is tuned independently of
 *     the world FOV (so an ADS FOV pull does not warp the gun); and world fog
 *     cannot desaturate it.
 *  2. DEDICATED VIEWMODEL LIGHTING. That scene carries its own three-point rig.
 *     A first-person weapon that depends on world lighting *will* eventually be
 *     a silhouette; here it is structurally impossible.
 *  3. POSE BLENDING, NOT HARDCODED TRANSFORMS. Hip / ADS / sprint are named
 *     poses in `config.ts`, blended by weights. Sway, bob, recoil and the reload
 *     animation are additive layers on top. A real GLB at M2 replaces
 *     `buildPlaceholderRifle()` only; every layer above keeps working.
 *  4. A MEASURED SCREEN BUDGET. `screenCoverage()` projects the model's bounds
 *     through the viewmodel camera and returns the fraction of the frame it
 *     occupies; `tools/smoke.mjs` asserts it stays under
 *     `VIEWMODEL.maxScreenCoverage` (15%). The budget is a test, not a comment.
 *
 * Convention: the viewmodel camera sits at the origin looking down −Z, so the
 * barrel points at −Z — INTO the scene, under the crosshair.
 */

export interface ViewmodelState {
  /** 0 = hip, 1 = fully aimed. */
  adsT: number;
  /** 0 = normal, 1 = sprint carry pose. */
  sprintT: number;
  /** Horizontal speed / sprint speed, 0..1. */
  speedNorm: number;
  moving: boolean;
  grounded: boolean;
  /** Look angular velocity, rad/s — drives counter-sway. */
  lookVelX: number;
  lookVelY: number;
  /** 0..1 while reloading, null otherwise. */
  reloadProgress: number | null;
  elapsed: number;
}

const MAT_METAL = new THREE.MeshStandardMaterial({
  color: 0x3c4046,
  roughness: 0.44,
  metalness: 0.72,
});
const MAT_POLY = new THREE.MeshStandardMaterial({
  color: 0x4c5049,
  roughness: 0.78,
  metalness: 0.05,
});
const MAT_ACCENT = new THREE.MeshStandardMaterial({
  color: 0x6d6455,
  roughness: 0.66,
  metalness: 0.2,
});
const MAT_GLASS = new THREE.MeshStandardMaterial({
  color: 0x0b1a22,
  roughness: 0.16,
  metalness: 0.4,
  emissive: 0x123040,
  emissiveIntensity: 0.6,
});
const MAT_RETICLE = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.95 });

/** Optic centre height in model space — ADS aligns THIS to the screen centre. */
export const SIGHT_HEIGHT = 0.093;

/** Muzzle flash duration (ms). ONE number, shared by the sprite, the viewmodel
 *  light and the world light, so the three cannot drift out of sync. */
export const FLASH_MS = 45;

const SHELL_CAPACITY = 8;

interface Shell {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

export class Viewmodel {
  /** Rendered by `render()` in a second, depth-cleared pass. */
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA.viewmodelFov, 1, 0.01, 12);

  /** Pose + sway + recoil layer. */
  private readonly root = new THREE.Group();
  /** Animation layer (reload). Child of root so it composes cleanly. */
  private readonly anim = new THREE.Group();
  /** The gun itself — replaced wholesale at M2. */
  private model: THREE.Object3D;
  private magazine: THREE.Object3D | null = null;
  private readonly muzzle = new THREE.Object3D();
  /**
   * A marker parented to the weapon at the optic's optical axis.
   *
   * It exists so the ADS alignment can be PROVEN rather than eyeballed: project
   * this through the viewmodel camera in the settled ADS pose and it must land on
   * the crosshair. See `projectOptic()`.
   */
  private readonly optic = new THREE.Object3D();
  /** Where the shells come out. Parented to the weapon, like the muzzle. */
  private readonly ejectionPort = new THREE.Object3D();

  private readonly flashSprite: THREE.Sprite;
  private readonly flashLight: THREE.PointLight;
  private flashTimer = 0;
  private readonly shells: Shell[] = [];
  private shellNext = 0;

  // Additive layers.
  private kickBack = 0;
  private kickPitch = 0;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private readonly pose = new THREE.Vector3();
  private readonly poseRot = new THREE.Euler();
  private coverageTarget: THREE.WebGLRenderTarget | null = null;
  private coverageBuffer: Uint8Array | null = null;

  constructor() {
    this.scene.add(this.root);
    this.root.add(this.anim);

    const built = buildPlaceholderRifle();
    this.model = built.group;
    this.magazine = built.magazine;
    this.muzzle.position.copy(built.muzzle);
    this.optic.position.set(0, SIGHT_HEIGHT, -0.045);
    this.ejectionPort.position.set(0.05, 0.02, 0.02);
    this.model.add(this.muzzle, this.optic, this.ejectionPort);
    this.anim.add(this.model);

    // ---- shell ejection ----------------------------------------------------
    // Cheap in the literal sense the brief asks for: eight pooled 8 mm boxes on
    // one shared geometry and one shared material, living in the viewmodel scene
    // (so they inherit its lighting and can never collide with the world). They
    // cost nothing and they are one of the strongest "this weapon is real" cues
    // available — brass tumbling out of frame on every round.
    const shellGeo = new THREE.CylinderGeometry(0.0045, 0.005, 0.0185, 6);
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xb08442,
      roughness: 0.36,
      metalness: 0.85,
    });
    for (let i = 0; i < SHELL_CAPACITY; i++) {
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.shells.push({
        mesh,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        life: 0,
      });
    }

    // ---- dedicated three-point lighting (see note 2 above) ----------------
    const key = new THREE.DirectionalLight(0xffd0a0, 3.0);
    key.position.set(-0.7, 1.1, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fa0d8, 1.15);
    fill.position.set(1.0, 0.2, 0.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffe6c4, 1.5);
    rim.position.set(0.2, 0.6, -1.0);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x4a5568, 1.1));

    // ---- muzzle flash ------------------------------------------------------
    this.flashSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: flashTexture(),
        color: 0xffd9a0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        transparent: true,
        opacity: 0,
      }),
    );
    this.flashSprite.scale.setScalar(0.001);
    this.muzzle.add(this.flashSprite);
    // An authored emitter: the muzzle flash is on the bloom allow-list.
    markBloom(this.flashSprite);

    this.flashLight = new THREE.PointLight(0xffb060, 0, 2.2, 2);
    this.muzzle.add(this.flashLight);

    this.pose.set(VIEWMODEL.hip.x, VIEWMODEL.hip.y, VIEWMODEL.hip.z);
    this.root.position.copy(this.pose);
  }

  /**
   * The M1 seam, USED at M3: drop in the generated carbine without touching any
   * layer above it.
   *
   * Everything the weapon does — pose blending, sway, bob, the recoil spring,
   * the reload with its mag swap, the muzzle flash, the screen budget — is
   * defined against `model` / `muzzle` / `magazine` / `optic` and nothing else.
   * That is why M1 could ship a box-built rifle and M3 can replace it in one
   * call: the seam was designed as an interface with a working implementation
   * rather than as a TODO, and the working implementation is still the fallback.
   */
  setModel(
    object: THREE.Object3D,
    muzzleLocal: THREE.Vector3,
    magazine: THREE.Object3D | null,
    opticLocal: THREE.Vector3,
    ejectLocal?: THREE.Vector3,
  ): void {
    this.anim.remove(this.model);
    this.model = object;
    this.magazine = magazine;
    this.muzzle.removeFromParent();
    this.optic.removeFromParent();
    this.ejectionPort.removeFromParent();
    this.muzzle.position.copy(muzzleLocal);
    this.optic.position.copy(opticLocal);
    this.ejectionPort.position.copy(
      ejectLocal ?? new THREE.Vector3(muzzleLocal.x + 0.05, opticLocal.y - 0.05, 0.02),
    );
    this.model.add(this.muzzle, this.optic, this.ejectionPort);
    this.anim.add(this.model);
  }

  /** World-space muzzle position, for world-side flash lights and tracers. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.muzzle.getWorldPosition(out);
    return out;
  }

  /**
   * THE ADS ALIGNMENT PROOF.
   *
   * Projects the optic's optical axis through the real viewmodel camera and
   * returns its position in normalised device coordinates. In the settled ADS
   * pose this must be (0, 0) — the crosshair — and `tools/smoke.mjs` asserts it
   * to within a couple of pixels.
   *
   * WHY THIS ASSERTION EXISTS. DECISIONS §2.5 claims the ADS alignment is
   * geometric rather than eyeballed, and until M3 that claim rested on the
   * placeholder rifle having been BUILT with its optic at `SIGHT_HEIGHT`. Once a
   * generated mesh arrives — arbitrary origin, arbitrary scale, optic wherever
   * the generator put it — the claim needs a measurement behind it or it is just
   * a comment. This is that measurement, and it is the assertion that would fail
   * if someone ever "fixed" a misaligned sight by nudging the pose.
   */
  projectOptic(): { x: number; y: number } {
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const p = this.optic.getWorldPosition(_tmpVec);
    p.project(this.camera);
    return { x: p.x, y: p.y };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Fire kick — the only thing the weapon calls on a shot. */
  punch(adsT: number): void {
    const scale = 1 - adsT * 0.45;
    this.kickBack += VIEWMODEL.kickBack * scale;
    this.kickPitch += VIEWMODEL.kickPitch * scale;
    this.flashTimer = FLASH_MS / 1000;
    this.flashSprite.material.rotation = rng() * Math.PI;
    this.ejectShell();
  }

  /** One brass case, up-and-right out of the ejection port and out of frame. */
  private ejectShell(): void {
    const s = this.shells[this.shellNext];
    this.shellNext = (this.shellNext + 1) % this.shells.length;
    this.ejectionPort.getWorldPosition(s.mesh.position);
    s.mesh.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    s.mesh.visible = true;
    // Right, up and slightly back — a real ejection pattern, in camera space.
    s.vel.set(rng.range(1.15, 1.65), rng.range(0.75, 1.15), rng.range(0.25, 0.6));
    s.spin.set(rng.signed(26), rng.signed(20), rng.signed(26));
    s.life = 0.85;
  }

  update(dt: number, s: ViewmodelState): void {
    // ---- pose blend -------------------------------------------------------
    const ads = s.adsT;
    const sprint = s.sprintT * (1 - ads);
    const px =
      VIEWMODEL.hip.x * (1 - ads - sprint) + VIEWMODEL.ads.x * ads + VIEWMODEL.sprint.x * sprint;
    const py =
      VIEWMODEL.hip.y * (1 - ads - sprint) + VIEWMODEL.ads.y * ads + VIEWMODEL.sprint.y * sprint;
    const pz =
      VIEWMODEL.hip.z * (1 - ads - sprint) + VIEWMODEL.ads.z * ads + VIEWMODEL.sprint.z * sprint;

    this.pose.x = damp(this.pose.x, px, VIEWMODEL.poseTau, dt);
    this.pose.y = damp(this.pose.y, py, VIEWMODEL.poseTau, dt);
    this.pose.z = damp(this.pose.z, pz, VIEWMODEL.poseTau, dt);

    this.poseRot.x = damp(this.poseRot.x, VIEWMODEL.sprintRot.x * sprint, VIEWMODEL.poseTau, dt);
    this.poseRot.y = damp(this.poseRot.y, VIEWMODEL.sprintRot.y * sprint, VIEWMODEL.poseTau, dt);
    this.poseRot.z = damp(this.poseRot.z, VIEWMODEL.sprintRot.z * sprint, VIEWMODEL.poseTau, dt);

    // ---- look sway (counter-motion) ---------------------------------------
    const swayScale = 1 - ads * 0.7;
    const targetSwayX = clamp(
      -s.lookVelX * VIEWMODEL.swayAmount * swayScale,
      -VIEWMODEL.swayMax,
      VIEWMODEL.swayMax,
    );
    const targetSwayY = clamp(
      -s.lookVelY * VIEWMODEL.swayAmount * swayScale,
      -VIEWMODEL.swayMax,
      VIEWMODEL.swayMax,
    );
    this.swayX = damp(this.swayX, targetSwayX, VIEWMODEL.swayTau, dt);
    this.swayY = damp(this.swayY, targetSwayY, VIEWMODEL.swayTau, dt);

    // ---- walk bob ----------------------------------------------------------
    const bobActive = s.moving && s.grounded ? s.speedNorm : 0;
    this.bobPhase += dt * Math.PI * 2 * VIEWMODEL.bobRate * (0.6 + bobActive);
    const bobAmp = VIEWMODEL.bobAmount * bobActive * (1 - ads * 0.75);
    const bobX = Math.sin(this.bobPhase) * bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmp * 0.85;

    // ---- recoil spring -----------------------------------------------------
    this.kickBack = damp(this.kickBack, 0, VIEWMODEL.kickTau, dt);
    this.kickPitch = damp(this.kickPitch, 0, VIEWMODEL.kickTau, dt);

    // ---- compose -----------------------------------------------------------
    this.root.position.set(
      this.pose.x + this.swayX + bobX,
      this.pose.y + this.swayY + bobY,
      this.pose.z + this.kickBack,
    );
    this.root.rotation.set(
      this.poseRot.x + this.kickPitch,
      this.poseRot.y - this.swayX * 2.2,
      this.poseRot.z + this.swayX * 1.6,
    );

    // ---- reload animation (stub, but a real one: lower / tilt / mag swap) ---
    if (s.reloadProgress !== null) {
      const t = s.reloadProgress;
      // Down on the first 22%, hold, back up over the last 26%.
      const down = t < 0.22 ? easeOutCubic(t / 0.22) : t > 0.74 ? 1 - easeOutCubic((t - 0.74) / 0.26) : 1;
      this.anim.position.set(down * 0.055, down * -0.11, down * 0.03);
      this.anim.rotation.set(down * 0.46, down * 0.3, down * -0.22);
      if (this.magazine) {
        // Mag drops out at 25%, new mag seats at 62%.
        const magOut = t < 0.25 ? t / 0.25 : t < 0.62 ? 1 - (t - 0.25) / 0.37 : 0;
        this.magazine.position.y = -magOut * 0.14;
        this.magazine.rotation.z = magOut * 0.4;
        this.magazine.visible = !(t > 0.3 && t < 0.5);
      }
    } else if (this.anim.position.lengthSq() > 1e-8 || Math.abs(this.anim.rotation.x) > 1e-4) {
      this.anim.position.set(
        damp(this.anim.position.x, 0, 0.08, dt),
        damp(this.anim.position.y, 0, 0.08, dt),
        damp(this.anim.position.z, 0, 0.08, dt),
      );
      this.anim.rotation.set(
        damp(this.anim.rotation.x, 0, 0.08, dt),
        damp(this.anim.rotation.y, 0, 0.08, dt),
        damp(this.anim.rotation.z, 0, 0.08, dt),
      );
      if (this.magazine) {
        this.magazine.position.y = 0;
        this.magazine.rotation.z = 0;
        this.magazine.visible = true;
      }
    }

    // ---- muzzle flash decay -------------------------------------------------
    // The sprite and the LIGHT are driven from the SAME timer and the same
    // normalised curve `k`, which is the whole of "muzzle-flash light sync": a
    // flash whose sprite and light run on different clocks reads as a flicker
    // that does not belong to the gun. The world-side flash light in
    // `fx/impacts.ts` is fired from the same `onPlayerShot` callback and decays
    // over the same 45 ms window, so all three agree.
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      const k = this.flashTimer / (FLASH_MS / 1000);
      this.flashSprite.material.opacity = k;
      this.flashSprite.scale.setScalar(0.1 + 0.14 * k);
      this.flashLight.intensity = 9 * k;
    } else if (this.flashLight.intensity !== 0) {
      this.flashSprite.material.opacity = 0;
      this.flashSprite.scale.setScalar(0.001);
      this.flashLight.intensity = 0;
    }

    // ---- shells -------------------------------------------------------------
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      s.vel.y -= 5.4 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
    }
  }

  /** Hide any in-flight brass — called on restart so a new mission is clean. */
  clearShells(): void {
    for (const s of this.shells) {
      s.life = 0;
      s.mesh.visible = false;
    }
  }

  /**
   * EXACT silhouette coverage: renders the viewmodel scene alone into a small
   * offscreen target and counts covered pixels. Not an estimate from bounding
   * boxes — the real rasterised footprint, so the 15% budget cannot be gamed.
   *
   * Debug/test path only (one 192×108 render + a readPixels); never per frame.
   */
  measureScreenCoverage(renderer: THREE.WebGLRenderer): number {
    if (!this.coverageTarget) {
      this.coverageTarget = new THREE.WebGLRenderTarget(192, 108, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.coverageBuffer = new Uint8Array(192 * 108 * 4);
    }
    const target = this.coverageTarget;
    const buffer = this.coverageBuffer!;

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(_tmpColor).clone();
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);
    renderer.readRenderTargetPixels(target, 0, 0, 192, 108, buffer);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;

    let covered = 0;
    for (let i = 3; i < buffer.length; i += 4) {
      if (buffer[i] > 8) covered++;
    }
    return covered / (192 * 108);
  }
}

const _tmpColor = new THREE.Color();
const _tmpVec = new THREE.Vector3();

/**
 * Placeholder rifle, built from boxes/cylinders.
 *
 * It is graybox art but a REAL silhouette: receiver, handguard, barrel,
 * suppressor, magazine, stock, pistol grip and a red-dot optic whose glass sits
 * at `SIGHT_HEIGHT` so the ADS pose lands it exactly on the screen centre.
 * Origin is at the receiver; −Z is downrange.
 */
function buildPlaceholderRifle(): {
  group: THREE.Group;
  muzzle: THREE.Vector3;
  magazine: THREE.Object3D;
} {
  const g = new THREE.Group();
  g.name = 'viewmodel-rifle';

  const box = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  };

  // Receiver — the visual anchor.
  g.add(box(0.062, 0.075, 0.3, MAT_METAL, 0, 0.012, 0.0));
  // Handguard.
  g.add(box(0.056, 0.06, 0.26, MAT_POLY, 0, 0.012, -0.28));
  // Barrel + suppressor.
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.011, 0.16, 10),
    MAT_METAL,
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.016, -0.48);
  g.add(barrel);
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, 0.15, 12), MAT_ACCENT);
  can.rotation.x = Math.PI / 2;
  can.position.set(0, 0.016, -0.62);
  g.add(can);

  // Stock + buffer tube.
  g.add(box(0.03, 0.045, 0.1, MAT_METAL, 0, 0.02, 0.19));
  g.add(box(0.05, 0.085, 0.13, MAT_POLY, 0, 0.012, 0.29));
  // Pistol grip (angled back).
  const grip = box(0.042, 0.115, 0.05, MAT_POLY, 0, -0.062, 0.075);
  grip.rotation.x = -0.28;
  g.add(grip);

  // Magazine — animated on reload.
  const magazine = box(0.036, 0.13, 0.075, MAT_ACCENT, 0, -0.078, -0.045);
  magazine.rotation.x = 0.1;
  g.add(magazine);

  // Optic: rail block, tube ring, glass and a floating red dot.
  g.add(box(0.03, 0.028, 0.12, MAT_METAL, 0, 0.062, -0.02));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.021, 0.005, 8, 18), MAT_METAL);
  ring.position.set(0, SIGHT_HEIGHT, -0.05);
  g.add(ring);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.019, 20), MAT_GLASS);
  glass.position.set(0, SIGHT_HEIGHT, -0.045);
  g.add(glass);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0028, 10), MAT_RETICLE);
  dot.position.set(0, SIGHT_HEIGHT, -0.043);
  markBloom(dot);
  g.add(dot);
  // Rear iron so the sight line reads from the side too.
  g.add(box(0.026, 0.02, 0.016, MAT_METAL, 0, 0.062, 0.075));

  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
    }
  });

  return { group: g, muzzle: new THREE.Vector3(0, 0.016, -0.7), magazine };
}
