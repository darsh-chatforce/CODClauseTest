import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LAYER } from '../config';
import { damp } from '../core/mathx';
import { markBloom } from '../fx/postfx';
import type { Assets, SoldierClip } from '../world/assets';
import type { AvatarAnimParams, AvatarModel } from './avatar';

/**
 * The rigged soldier — ONE model class, used by both the player avatar and every
 * enemy.
 *
 * Provenance: a Tripo text-to-3D generation in a strict T-pose (the pose mandate
 * is quoted verbatim from the backend's `TPOSE_TEMPLATE`, because that wording is
 * load-bearing for what comes next), auto-rigged by the backend's bpy sidecar
 * onto the canonical 66-joint Mesh2Motion skeleton, then carrying six CC0 clips
 * copied natively onto that skeleton. See `assetgen/rig_soldier.py`.
 *
 * The reason player and enemies share this class is not code thrift — it is that
 * they must be the SAME soldier. A game where the thing you inspect in third
 * person is a different species from the things you shoot reads as two different
 * games, and the pipeline's build had exactly that (a cyan cube for the player,
 * capsules for the enemies).
 */

/** Measured, not guessed — see the note on `YAW_OFFSET`. */
const YAW_OFFSET = Math.PI;

/**
 * WHY π.
 *
 * The rigged GLB faces +Z in three.js; the game's forward is -Z (every forward
 * vector in the project is `(-sin yaw, 0, -cos yaw)`). That was established by
 * MEASUREMENT, not by looking at a render and guessing: the `foot_l → ball_l`
 * bone vector is the toe direction, it points Blender -Y, and the Blender→glTF
 * axis conversion `(x, y, z) → (x, z, -y)` maps that to +Z.
 *
 * Recorded because getting this wrong is silent and awful: the soldiers walk
 * backwards, aim away from you, and their death animations fold the wrong way —
 * and none of it throws, so it survives every automated check that is not a
 * screenshot.
 */

/** Reference ground speeds the locomotion clips were authored at (m/s). Playback
 *  is rate-matched to these so feet do not skate. */
const WALK_REF_SPEED = 1.45;
const RUN_REF_SPEED = 4.1;
/** Normalised locomotion below/above which the blend is pure idle / pure run. */
const WALK_IN = 0.06;
const RUN_IN = 0.62;

export interface SoldierOptions {
  /** Target standing height in metres — the model is normalised to it. */
  height: number;
  /** Multiplied over every albedo. This is how the player and the hostiles are
   *  told apart while staying the same soldier. */
  tint?: number;
  /** Emissive colour of the visor telegraph strip. */
  visorColor?: number;
  /** Whether to build the visor telegraph at all (enemies yes, player no). */
  visor?: boolean;
  /** A world-space weapon to put in the right hand. Caller-owned. */
  weapon?: THREE.Object3D | null;
}

/**
 * The visor, authored in METRES.
 *
 * A human head is about 155 mm across and 195 mm front-to-back, so a goggle band
 * that wraps it sits at roughly an 88 mm radius. `eyeUp` / `eyeForward` place the
 * band's axis on the skull relative to the head BONE, whose origin sits at the
 * base of the skull — hence a small forward offset and a ~85 mm rise.
 */
const VISOR = {
  radius: 0.088,
  lensHeight: 0.036,
  /** Arc of the lit strip (radians) — ~120°, a real goggle wrap. */
  arc: 2.1,
  /** Extra height of the matte housing around the lens. */
  housing: 0.02,
  eyeUp: 0.085,
  eyeForward: 0.018,
} as const;

/** Emissive intensity at rest and at full telegraph. The RATIO is the point:
 *  M2 rested at 0.9 and peaked at 4.5, a 5x swing from an already-blown start. */
const VISOR_REST = 0.35;
const VISOR_HOT = 4.2;

const MAT_VISOR_HOUSING = new THREE.MeshStandardMaterial({
  color: 0x1a1c1f,
  roughness: 0.85,
  metalness: 0.05,
});

/** Where the carbine sits in the right hand, in metres/radians of hand-bone
 *  space. Tuned against the rig's pistol-grip aim pose — see `attachWeapon`. */
const WEAPON_MOUNT = {
  x: 0.02,
  y: -0.04,
  z: 0.12,
  rx: 0.06,
  ry: 0.0,
  rz: 0.0,
} as const;

export class RiggedSoldier implements AvatarModel {
  readonly object = new THREE.Group();
  readonly eyeHeight: number;
  /** True when a real GLB backed this instance. False = caller should fall back. */
  readonly valid: boolean;

  private readonly mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<SoldierClip, THREE.AnimationAction>();
  private readonly weights = new Map<SoldierClip, number>();
  private visorMat: THREE.MeshStandardMaterial | null = null;
  private weaponMount: THREE.Object3D | null = null;
  private muzzleMarker: THREE.Object3D | null = null;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private fireTimer = 0;
  private deathStarted = false;

  constructor(assets: Assets, opts: SoldierOptions) {
    const gltf = assets.soldier;
    if (!gltf) {
      this.valid = false;
      this.eyeHeight = opts.height * 0.93;
      return;
    }

    // SkeletonUtils.clone — a plain Object3D.clone() shares the Skeleton, so
    // every instance would play the LAST instance's animation. That bug looks
    // like "the AI is synchronised", which is easy to mistake for a design
    // choice rather than a defect.
    const root = cloneSkinned(gltf.scene) as THREE.Object3D;

    // ---- normalise scale to the gameplay height ---------------------------
    // The collision cylinder is authored at ENEMY.height / PLAYER.height. A
    // model at Tripo's arbitrary export scale would either float or sink, and
    // the hit capsule would stop matching the silhouette — which is a fairness
    // bug, not a cosmetic one. So the model is MEASURED and fitted.
    root.updateMatrixWorld(true);
    // `precise = true` walks actual vertices instead of trusting each mesh's
    // cached bounding box. For a SkinnedMesh those cached bounds are inflated to
    // cover the deformable range, so the non-precise box sits BELOW the feet and
    // the seating step lifts the whole soldier off the ground — which is exactly
    // what the first integration did, by about 20 cm.
    const box = new THREE.Box3().setFromObject(root, true);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.y > 1e-4 ? opts.height / size.y : 1;
    root.scale.multiplyScalar(scale);
    root.updateMatrixWorld(true);

    // Seat the feet on y = 0 after scaling.
    const seated = new THREE.Box3().setFromObject(root, true);
    root.position.y -= seated.min.y;
    root.rotation.y = YAW_OFFSET;

    this.object.add(root);
    this.eyeHeight = opts.height * 0.93;
    this.valid = true;

    // ---- materials --------------------------------------------------------
    root.traverse((o) => {
      o.layers.set(LAYER.WORLD);
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      // Skinned meshes are culled against their REST bounds unless told
      // otherwise, so an animated soldier can vanish at the frame edge. This is
      // a classic and it is invisible until someone strafes.
      m.frustumCulled = false;
      const src = Array.isArray(m.material) ? m.material : [m.material];
      const out = src.map((mm) => {
        const c = (mm as THREE.MeshStandardMaterial).clone();
        if (opts.tint !== undefined) c.color.multiply(new THREE.Color(opts.tint));
        // Tripo PBR comes back glossier than a dusty soldier should be.
        c.roughness = Math.min(1, (c.roughness ?? 0.8) * 1.15 + 0.1);
        this.materials.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? out : out[0];
    });

    // ---- visor telegraph --------------------------------------------------
    // M1 established (DECISIONS §7.3/§7.4) that a soldier winding up to fire
    // needs a readable cue, and that ONE cue is not enough at 30 m. The rigged
    // model solves half of it for free — a human silhouette reads its own facing
    // far better than a capsule ever did — but the "I am about to shoot"
    // telegraph is not a facing cue, it is a STATE cue, and the model has no way
    // to show state. So the emissive visor survives the art pass, parented to
    // the head bone so it tracks every animation for free.
    //
    // M3 REBUILT IT. See `buildVisor()`: M2's version was a flat box floating
    // clear of the face, which is a HUD element wearing a soldier's head.
    if (opts.visor) {
      const head = root.getObjectByName('head') ?? findBone(root, 'head');
      if (head) this.buildVisor(head, opts);
    }

    // ---- weapon in hand ---------------------------------------------------
    if (opts.weapon) {
      this.attachWeapon(root, opts.weapon);
    }

    // ---- animation --------------------------------------------------------
    this.mixer = new THREE.AnimationMixer(root);
    for (const [name, clip] of assets.soldierClips) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.setEffectiveWeight(0);
      if (name === 'death' || name === 'fire') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.play();
      this.actions.set(name, action);
      this.weights.set(name, 0);
    }
    this.weights.set('idle', 1);
    this.actions.get('idle')?.setEffectiveWeight(1);
  }

  /**
   * The visor telegraph — an integrated goggle strip, not a floating plate.
   *
   * WHAT WAS WRONG WITH M2's VERSION. It was a `BoxGeometry(0.16, 0.045, 0.03)`
   * at `(0, 0.05, 0.1)` in head-bone units, emissive at intensity 0.9 in a
   * saturated orange. Three separate mistakes stacked:
   *
   *  1. THE UNITS WERE NOT METRES. Head-bone space is un-scaled rig space, and
   *     this rig is authored at roughly 1 unit tall then scaled to 1.8 m — so
   *     "0.16 wide" was ~0.29 m and "0.1 forward" was ~0.18 m. A 29 cm plate
   *     18 cm in front of the face is not a visor, it is a signboard, and that is
   *     exactly how it reads in `shots/07_enemy_closeup.png`.
   *  2. IT WAS FLAT. A box across a head reads as a box across a head from every
   *     angle. A visor is a curved surface that wraps, and the wrap is most of
   *     what makes it read as part of the helmet.
   *  3. IT WAS ALREADY BRIGHT AT REST. `emissiveIntensity: 0.9` on a saturated
   *     orange tone-maps to near-white through ACES, so the IDLE state was
   *     already a cream slab and the 400 ms telegraph had almost no headroom
   *     left to brighten INTO. A telegraph that is always on is not a telegraph.
   *
   * The fix addresses all three. The geometry is a wrapped cylinder segment sized
   * in real metres — the conversion factor is MEASURED off the head bone's own
   * world matrix rather than assumed, so it is correct for any rig scale. It sits
   * in a matte housing so it reads as recessed glass. And it rests DARK: a deep
   * ember at intensity 0.35 that climbs to 4.2 across the wind-up, which is a
   * ~12x swing the player can actually read, and which the selective bloom then
   * sells as a light source rather than as a bright surface.
   */
  private buildVisor(head: THREE.Object3D, opts: SoldierOptions): void {
    head.updateWorldMatrix(true, false);
    // METRES PER BONE UNIT, measured. `matrixWorld` carries the whole parent
    // chain including the model-normalisation scale applied above, so the length
    // of its X basis vector is exactly the conversion factor. Authoring in metres
    // and dividing by this is why the visor is head-sized on any rig.
    const perUnit = new THREE.Vector3()
      .setFromMatrixColumn(head.matrixWorld, 0)
      .length();
    const toBone = perUnit > 1e-5 ? 1 / perUnit : 1;

    const color = opts.visorColor ?? 0xff4a12;
    this.visorMat = new THREE.MeshStandardMaterial({
      // Dark tinted glass. The COLOUR is what it looks like unlit; the EMISSIVE
      // is what it looks like lit. M2 had them the same, so it had no unlit look.
      color: 0x0b0d10,
      emissive: color,
      emissiveIntensity: VISOR_REST,
      roughness: 0.22,
      metalness: 0.1,
    });

    const group = new THREE.Group();
    group.name = 'visor';

    // A wrapped lens: a cylinder segment about the head's own vertical axis.
    // theta = 0 faces +Z (the model's forward), so the arc is centred on the
    // face by construction.
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(
        VISOR.radius,
        VISOR.radius,
        VISOR.lensHeight,
        18,
        1,
        true,
        -VISOR.arc / 2,
        VISOR.arc,
      ),
      this.visorMat,
    );
    group.add(lens);

    // Matte housing: the same arc, marginally larger and taller, so the lit strip
    // reads as glass set INTO a helmet rather than as a glowing band stuck on it.
    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(
        VISOR.radius * 0.985,
        VISOR.radius * 0.985,
        VISOR.lensHeight + VISOR.housing,
        18,
        1,
        true,
        -VISOR.arc / 2 - 0.14,
        VISOR.arc + 0.28,
      ),
      MAT_VISOR_HOUSING,
    );
    group.add(housing);

    // A brow strap running round the back of the head closes the loop, so the
    // goggles read as WORN from the side and from behind instead of appearing
    // only when a soldier happens to be facing you.
    const strap = new THREE.Mesh(
      new THREE.CylinderGeometry(
        VISOR.radius * 0.94,
        VISOR.radius * 0.94,
        VISOR.lensHeight * 0.62,
        20,
        1,
        true,
        VISOR.arc / 2,
        Math.PI * 2 - VISOR.arc,
      ),
      MAT_VISOR_HOUSING,
    );
    group.add(strap);

    for (const m of [lens, housing, strap]) {
      m.layers.set(LAYER.WORLD);
      m.frustumCulled = false;
      m.castShadow = false;
    }
    // The LENS is an authored emitter and is on the bloom allow-list. The
    // housing and strap deliberately are not — a bloom halo around matte plastic
    // is the tell that someone bloomed by brightness instead of by intent.
    markBloom(lens);

    // Authored in metres, converted into bone units on the way in.
    group.scale.setScalar(toBone);
    group.position.set(0, VISOR.eyeUp * toBone, VISOR.eyeForward * toBone);
    head.add(group);
  }

  /**
   * Put the generated carbine in the soldier's right hand.
   *
   * The offsets are hand-tuned against the rig's `Pistol_Idle` aim clip, which is
   * the compromise DECISIONS §15.1 already records: the CC0 animation library has
   * no rifle clips, so the hands come to a pistol grip and the carbine is fitted
   * to THAT pose rather than the pose being fitted to the carbine. It reads
   * correctly from gameplay distance and it is honest about why.
   */
  private attachWeapon(root: THREE.Object3D, weapon: THREE.Object3D): void {
    const hand = root.getObjectByName('hand_r') ?? findBone(root, 'hand_r');
    if (!hand) return;
    hand.updateWorldMatrix(true, false);
    const perUnit = new THREE.Vector3()
      .setFromMatrixColumn(hand.matrixWorld, 0)
      .length();
    const toBone = perUnit > 1e-5 ? 1 / perUnit : 1;

    const holder = new THREE.Group();
    holder.name = 'weapon-mount';
    holder.add(weapon);
    holder.scale.setScalar(toBone);
    holder.position.set(
      WEAPON_MOUNT.x * toBone,
      WEAPON_MOUNT.y * toBone,
      WEAPON_MOUNT.z * toBone,
    );
    holder.rotation.set(WEAPON_MOUNT.rx, WEAPON_MOUNT.ry, WEAPON_MOUNT.rz);
    hand.add(holder);
    this.weaponMount = holder;
    this.muzzleMarker = weapon.getObjectByName('muzzle') ?? null;
  }

  /** World position of the held weapon's muzzle. False = no weapon; the caller
   *  keeps its analytic chest-offset estimate. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.muzzleMarker) return false;
    this.muzzleMarker.getWorldPosition(out);
    return true;
  }

  /**
   * Let go of the weapon.
   *
   * A soldier who dies still gripping a rifle that then rotates with the corpse
   * is one of the loudest "this is a prototype" cues there is. Detaching it —
   * preserving its world transform — hands the caller a free prop to drop, and
   * costs one matrix decompose.
   */
  dropWeapon(): THREE.Object3D | null {
    const mount = this.weaponMount;
    if (!mount) return null;
    mount.updateWorldMatrix(true, false);
    const world = mount.matrixWorld.clone();
    mount.removeFromParent();
    world.decompose(mount.position, mount.quaternion, mount.scale);
    this.weaponMount = null;
    this.muzzleMarker = null;
    return mount;
  }

  /** Telegraph brightness, 0..1. Enemies drive this from their aim wind-up. */
  setTelegraph(t: number): void {
    if (this.visorMat) {
      this.visorMat.emissiveIntensity = VISOR_REST + t * (VISOR_HOT - VISOR_REST);
    }
  }

  /** Flash the whole body on a hit, and fade it. */
  setFlash(v: number): void {
    for (const m of this.materials) {
      m.emissive.setHex(v > 0 ? 0xffffff : 0x000000);
      m.emissiveIntensity = v;
    }
  }

  update(dt: number, p: AvatarAnimParams): void {
    if (!this.mixer) return;

    const target = new Map<SoldierClip, number>([
      ['idle', 0],
      ['walk', 0],
      ['run', 0],
      ['aim', 0],
      ['fire', 0],
      ['death', 0],
    ]);

    if (p.dead) {
      target.set('death', 1);
      if (!this.deathStarted) {
        this.deathStarted = true;
        const a = this.actions.get('death');
        // A death clip must start from frame 0 on the frame the soldier dies —
        // it has been "playing" at weight 0 since load, so without the reset it
        // pops in halfway through the fall.
        a?.reset();
        a?.setEffectiveTimeScale(1);
        a?.play();
      }
    } else {
      if (this.fireTimer > 0) this.fireTimer -= dt;
      if (p.firing) {
        this.fireTimer = 0.22;
        const a = this.actions.get('fire');
        a?.reset();
        a?.setEffectiveTimeScale(2.4);
        a?.play();
      }
      const fireW = this.fireTimer > 0 ? 1 : 0;

      if (p.aiming) {
        target.set('aim', 1 - fireW);
        target.set('fire', fireW);
      } else {
        // Locomotion blend. Rate-matched below so the feet do not skate.
        const l = p.locomotion;
        if (l <= WALK_IN) {
          target.set('idle', 1);
        } else if (l < RUN_IN) {
          const t = (l - WALK_IN) / (RUN_IN - WALK_IN);
          target.set('idle', 1 - t);
          target.set('walk', t);
        } else {
          const t = Math.min(1, (l - RUN_IN) / (1 - RUN_IN));
          target.set('walk', 1 - t);
          target.set('run', t);
        }
        target.set('fire', fireW);
      }

      // Foot-skate control: play the locomotion clips at the rate the body is
      // actually travelling. A walk cycle at a fixed rate under a variable
      // controller speed is the most common "this is a prototype" animation
      // tell, and it costs one division to fix.
      const walk = this.actions.get('walk');
      const run = this.actions.get('run');
      if (walk) walk.setEffectiveTimeScale(clampScale(p.speed / WALK_REF_SPEED));
      if (run) run.setEffectiveTimeScale(clampScale(p.speed / RUN_REF_SPEED));
    }

    // Smooth every weight rather than crossfading between named states: a weight
    // field cannot get stuck in a half-finished transition the way a crossfade
    // state machine can, and the AI changes state faster than a crossfade runs.
    for (const [name, action] of this.actions) {
      const want = target.get(name) ?? 0;
      const now = damp(this.weights.get(name) ?? 0, want, 0.09, dt);
      this.weights.set(name, now);
      action.setEffectiveWeight(now);
    }

    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    for (const m of this.materials) m.dispose();
    this.visorMat?.dispose();
    this.weaponMount?.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
  }
}

function clampScale(v: number): number {
  return Math.max(0.35, Math.min(2.2, v || 1));
}

function findBone(root: THREE.Object3D, needle: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name.toLowerCase() === needle) found = o;
  });
  if (found) return found;
  root.traverse((o) => {
    if (!found && o.name.toLowerCase().includes(needle)) found = o;
  });
  return found;
}
