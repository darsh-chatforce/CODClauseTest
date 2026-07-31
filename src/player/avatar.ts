import * as THREE from 'three';
import { LAYER, PLAYER } from '../config';
import { damp } from '../core/mathx';
import type { Assets } from '../world/assets';
import { RiggedSoldier } from './soldier';
import { buildWorldCarbine } from '../weapons/carbine';

/**
 * The player's body — visible in the third-person inspect view (T) and, at M2,
 * the drop-in point for a real rigged character.
 *
 * The pipeline's build shipped a cyan debug cube here because it never called
 * its own `registerPlayerAvatar` seam. So this file defines the seam as an
 * *interface with a working default*, not a TODO: `AvatarModel` is exactly what
 * a GLB-backed implementation has to satisfy (an Object3D plus an animation
 * update that receives real locomotion parameters), and `GrayboxAvatar` is a
 * conforming implementation you can delete in one line at M2:
 *
 *     avatar.setModel(new GltfAvatar(gltf));   // <- M2
 */

export type AvatarStance = 'stand' | 'crouch' | 'air';

export interface AvatarAnimParams {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Speed normalised against sprint speed, 0..1 — the locomotion blend weight. */
  locomotion: number;
  stance: AvatarStance;
  /** Aim pitch in radians, for spine/weapon aiming. */
  pitch: number;
  /** Fires for one frame when the weapon discharges. */
  firing: boolean;
  /** Weapon is up and braced — selects the aim pose over the locomotion blend.
   *  Added at M2: the rigged model needs to know the difference between "moving"
   *  and "planted with the weapon up", which is precisely the enemy doctrine's
   *  own distinction, so one flag serves the player avatar and the AI alike. */
  aiming: boolean;
  reloading: boolean;
  dead: boolean;
  /** Accumulated game time — drives cycles deterministically. */
  elapsed: number;
}

export interface AvatarModel {
  readonly object: THREE.Object3D;
  /** Height of the model's eye line, used to align the FP camera at M2. */
  readonly eyeHeight: number;
  update(dt: number, p: AvatarAnimParams): void;
  dispose(): void;
}

/** Container: owns placement, visibility and the model swap. */
export class PlayerAvatar {
  readonly group = new THREE.Group();
  private model: AvatarModel | null = null;

  constructor(scene: THREE.Scene, assets?: Assets) {
    this.group.name = 'player-avatar';
    this.group.visible = false;
    scene.add(this.group);

    // M2: THE SEAM IS USED. M1 defined `AvatarModel` as an interface with a
    // working graybox default precisely so this line could be the whole change,
    // and it is. The player is the SAME rigged soldier the hostiles are, in a
    // different tint — friendly forces wear the same kit, and it means the model
    // the player inspects is the model they have been shooting at.
    if (assets?.soldier) {
      const s = new RiggedSoldier(assets, {
        height: PLAYER.height,
        tint: 0x8fa7c8,
        visor: false,
        // M3: the inspect view shows the player holding the same carbine the
        // viewmodel holds. Without it, pressing T shows a soldier miming a
        // weapon — and "the third-person body is a different game from the
        // first-person one" is exactly the incoherence this avatar exists to
        // avoid.
        weapon: buildWorldCarbine(assets, 0.86),
      });
      if (s.valid) {
        this.setModel(s);
        return;
      }
    }
    this.setModel(new GrayboxAvatar());
  }

  /** THE SEAM. Swap the graybox for a rigged GLB at M2 — nothing else changes. */
  setModel(model: AvatarModel): void {
    if (this.model) {
      this.group.remove(this.model.object);
      this.model.dispose();
    }
    this.model = model;
    this.group.add(model.object);
  }

  get eyeHeight(): number {
    return this.model?.eyeHeight ?? PLAYER.eyeHeight;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  update(dt: number, position: THREE.Vector3, yaw: number, params: AvatarAnimParams): void {
    this.group.position.copy(position);
    this.group.rotation.y = yaw;
    if (this.group.visible) this.model?.update(dt, params);
  }
}

// ---------------------------------------------------------------------------

const MAT_BODY = new THREE.MeshStandardMaterial({ color: 0x4d5a49, roughness: 0.82 });
const MAT_GEAR = new THREE.MeshStandardMaterial({ color: 0x33383c, roughness: 0.7 });
const MAT_SKIN = new THREE.MeshStandardMaterial({ color: 0x8a6a52, roughness: 0.9 });
const MAT_MARK = new THREE.MeshStandardMaterial({
  color: 0xffb648,
  roughness: 0.5,
  emissive: 0x805214,
  emissiveIntensity: 1,
});

/**
 * Graybox stand-in: a blocked-out soldier (torso, head, two arms, two legs)
 * driven by a hand-written locomotion cycle. It exists to prove the seam and to
 * make the inspect view readable — it is NOT the M2 art.
 */
export class GrayboxAvatar implements AvatarModel {
  readonly object = new THREE.Group();
  readonly eyeHeight = PLAYER.eyeHeight;

  private readonly root = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private cycle = 0;
  private fireKick = 0;

  constructor() {
    this.object.add(this.root);

    const box = (
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      y = 0,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.y = y;
      m.castShadow = true;
      m.receiveShadow = true;
      m.layers.set(LAYER.WORLD);
      return m;
    };

    // Torso + chest rig.
    this.torso = box(0.46, 0.62, 0.27, MAT_BODY, 1.28);
    this.root.add(this.torso);
    const vest = box(0.5, 0.4, 0.31, MAT_GEAR, 1.32);
    this.root.add(vest);

    // Head + helmet.
    this.head = box(0.21, 0.24, 0.22, MAT_SKIN, 1.71);
    this.root.add(this.head);
    const helmet = box(0.26, 0.13, 0.28, MAT_GEAR, 1.8);
    this.root.add(helmet);
    // Facing indicator: a bright visor strip on the FRONT of the head, so the
    // orientation of the body is unambiguous from any angle.
    const visor = box(0.19, 0.05, 0.03, MAT_MARK, 1.73);
    visor.position.z = -0.115;
    this.root.add(visor);

    const limb = (side: number, upper: number, len: number, mat: THREE.Material): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(side, upper, 0);
      const m = box(0.14, len, 0.15, mat, -len / 2);
      g.add(m);
      this.root.add(g);
      return g;
    };

    this.armL = limb(-0.27, 1.48, 0.56, MAT_BODY);
    this.armR = limb(0.27, 1.48, 0.56, MAT_BODY);
    this.legL = limb(-0.12, 0.9, 0.9, MAT_GEAR);
    this.legR = limb(0.12, 0.9, 0.9, MAT_GEAR);

    // Carried weapon stub — same silhouette family as the viewmodel so the two
    // read as the same gun from both cameras.
    const rifle = box(0.07, 0.1, 0.72, MAT_GEAR, 0);
    rifle.position.set(0.15, 1.2, -0.33);
    this.root.add(rifle);
  }

  update(dt: number, p: AvatarAnimParams): void {
    if (p.dead) {
      // Collapse: fold forward and sink. A rigged model plays a death clip here.
      this.root.rotation.x = damp(this.root.rotation.x, -1.45, 0.22, dt);
      this.root.position.y = damp(this.root.position.y, -0.55, 0.28, dt);
      return;
    }

    // Locomotion cycle: stride rate scales with speed, amplitude with blend.
    const stride = 1.1 + p.locomotion * 5.2;
    this.cycle += dt * stride;
    const swing = Math.sin(this.cycle) * (0.15 + p.locomotion * 0.75);
    const counter = Math.sin(this.cycle + Math.PI) * (0.15 + p.locomotion * 0.75);
    const airborne = p.stance === 'air';

    this.legL.rotation.x = airborne ? -0.35 : swing;
    this.legR.rotation.x = airborne ? 0.2 : counter;
    // Arms hold the weapon, so they counter-swing far less than the legs.
    this.armL.rotation.x = -0.72 + counter * 0.2;
    this.armR.rotation.x = -0.68 + swing * 0.2;

    // Bob + forward lean under acceleration.
    const bob = Math.abs(Math.sin(this.cycle)) * 0.045 * p.locomotion;
    const crouch = p.stance === 'crouch' ? -0.4 : 0;
    this.root.position.y = damp(this.root.position.y, bob + crouch, 0.08, dt);
    this.root.rotation.x = damp(
      this.root.rotation.x,
      -p.locomotion * 0.12 - (p.stance === 'crouch' ? 0.2 : 0),
      0.12,
      dt,
    );

    // Spine aim: the torso tracks the aim pitch so the body agrees with the
    // first-person camera.
    this.torso.rotation.x = -p.pitch * 0.35;
    this.head.rotation.x = -p.pitch * 0.55;

    // Fire kick recoils the upper body.
    if (p.firing) this.fireKick = 1;
    this.fireKick = damp(this.fireKick, 0, 0.09, dt);
    this.armR.rotation.x -= this.fireKick * 0.22;
    this.armL.rotation.x -= this.fireKick * 0.18;

    if (p.reloading) {
      this.armL.rotation.x = -1.5 + Math.sin(p.elapsed * 9) * 0.25;
    }
  }

  dispose(): void {
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}
