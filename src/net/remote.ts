import * as THREE from 'three';
import { LAYER, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import { RiggedSoldier } from '../player/soldier';
import { buildWorldCarbine } from '../weapons/carbine';
import type { Assets } from '../world/assets';
import { PF } from './protocol';
import type { RemotePlayerState } from './client';

/**
 * Another player, drawn in this client's world.
 *
 * It is the SAME `RiggedSoldier` the hostiles and the third-person avatar use,
 * carrying the same generated carbine, because a co-op teammate that is a
 * different species from everything else in the level reads as a bug. The only
 * differences are a friendly tint and a name tag.
 *
 * The locomotion parameters are RECONSTRUCTED from consecutive snapshots rather
 * than sent: the server does not transmit "is walking", it transmits positions,
 * and the speed between two of them is what the animation blend actually wants.
 * Sending an animation state as well would be a second source of truth for
 * something already implied by the first, and the two would eventually disagree.
 */

const TAG_WIDTH = 256;
const TAG_HEIGHT = 64;

function nameTag(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = TAG_WIDTH;
  canvas.height = TAG_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, TAG_WIDTH, TAG_HEIGHT);
  ctx.font = '600 34px "DIN Alternate", "Bahnschrift", "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A dark stroke under the fill so the tag stays readable against both the
  // bright sand and the dark sky — the two things it will be seen against.
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(6, 9, 12, 0.92)';
  ctx.strokeText(name, TAG_WIDTH / 2, TAG_HEIGHT / 2);
  ctx.fillStyle = '#7ce0a4'; // the HUD's "friendly" green
  ctx.fillText(name, TAG_WIDTH / 2, TAG_HEIGHT / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      // Tags read THROUGH walls on purpose: knowing where your teammate is, is
      // the entire point of a co-op tag, and this is PvE so it gives nothing
      // away.
      depthTest: false,
      sizeAttenuation: true,
    }),
  );
  sprite.renderOrder = 30;
  sprite.scale.set(1.5, 0.375, 1);
  return sprite;
}

export class RemotePlayer {
  readonly id: string;
  readonly name: string;
  readonly group = new THREE.Group();
  private readonly soldier: RiggedSoldier | null;
  private readonly tag: THREE.Sprite;
  private readonly fallback: THREE.Mesh | null = null;
  private readonly prev = new THREE.Vector3();
  private speed = 0;
  private elapsed = 0;
  private hadPrev = false;

  constructor(state: RemotePlayerState, scene: THREE.Scene, assets: Assets) {
    this.id = state.id;
    this.name = state.name;
    this.group.name = `remote-${state.id}`;

    const s = new RiggedSoldier(assets, {
      height: PLAYER.height,
      // Teammates are tinted toward the HUD's friendly green so a glance
      // distinguishes them from the olive hostiles without a HUD element.
      tint: 0x9fd9b4,
      visor: false,
      weapon: buildWorldCarbine(assets, 0.86),
    });
    if (s.valid) {
      this.soldier = s;
      this.group.add(s.object);
    } else {
      this.soldier = null;
      // Degraded, not broken — the same rule the rest of the asset layer uses.
      const geo = new THREE.CapsuleGeometry(0.34, PLAYER.height - 0.68, 6, 12);
      const mat = new THREE.MeshStandardMaterial({ color: 0x9fd9b4, roughness: 0.8 });
      this.fallback = new THREE.Mesh(geo, mat);
      this.fallback.position.y = PLAYER.height / 2;
      this.group.add(this.fallback);
    }

    this.tag = nameTag(state.name);
    this.tag.position.y = PLAYER.height + 0.36;
    this.group.add(this.tag);

    this.group.traverse((o) => o.layers.set(LAYER.WORLD));
    // The tag must not be shadow-casting geometry.
    this.tag.castShadow = false;
    this.group.position.copy(state.position);
    this.prev.copy(state.position);
    scene.add(this.group);
  }

  update(dt: number, state: RemotePlayerState): void {
    this.elapsed += dt;

    // Speed from consecutive interpolated positions — see the class note.
    if (this.hadPrev && dt > 1e-4) {
      const moved = Math.hypot(
        state.position.x - this.prev.x,
        state.position.z - this.prev.z,
      );
      // Smoothed, because snapshot spacing is not frame spacing and the raw
      // quotient flickers between 0 and a spike.
      this.speed += (moved / dt - this.speed) * Math.min(1, dt * 8);
    }
    this.hadPrev = true;
    this.prev.copy(state.position);

    this.group.position.copy(state.position);
    // The model faces +Z in rig space and `RiggedSoldier` already applies the
    // π yaw offset, so this is the same convention the local avatar uses.
    this.group.rotation.y = state.yaw;

    const dead = (state.flags & PF.DEAD) !== 0;
    this.soldier?.update(dt, {
      speed: this.speed,
      locomotion: clamp(this.speed / PLAYER.sprintSpeed, 0, 1),
      stance: (state.flags & PF.CROUCHING) !== 0 ? 'crouch' : 'stand',
      pitch: state.pitch,
      firing: false,
      aiming: (state.flags & PF.AIMING) !== 0,
      reloading: false,
      dead,
      elapsed: this.elapsed,
    });
    this.tag.visible = !dead;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.soldier?.dispose();
    this.tag.material.map?.dispose();
    this.tag.material.dispose();
    this.fallback?.geometry.dispose();
  }
}
