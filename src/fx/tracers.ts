import * as THREE from 'three';
import { LAYER, WEAPON } from '../config';
import { markBloom } from './postfx';

/**
 * Tracer pool.
 *
 * The weapon is hitscan — damage resolves on the frame the trigger breaks — but
 * a shooter with invisible bullets reads as broken, so every shot also spawns a
 * visible streak that flies the real path at a real speed. One InstancedMesh per
 * pool means any number of tracers costs one draw call.
 */

const SEGMENT = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);

interface Tracer {
  active: boolean;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  head: number;
  distance: number;
  life: number;
}

export class TracerPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly tracers: Tracer[] = [];
  private next = 0;

  constructor(
    scene: THREE.Scene,
    capacity = 48,
    color = 0xffd08a,
    private readonly thickness = 0.035,
  ) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(SEGMENT, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = 5;
    // An authored emitter: a tracer IS a burning particle, so it is on the bloom
    // allow-list. This is also the cue that survives at 40 m when the muzzle
    // flash itself is two pixels wide.
    markBloom(this.mesh);
    scene.add(this.mesh);

    for (let i = 0; i < capacity; i++) {
      this.tracers.push({
        active: false,
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, -1),
        head: 0,
        distance: 0,
        life: 0,
      });
      this.hide(i);
    }
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, distance: number): void {
    const t = this.tracers[this.next];
    this.next = (this.next + 1) % this.tracers.length;
    t.active = true;
    t.origin.copy(origin);
    t.dir.copy(dir).normalize();
    t.head = 0;
    t.distance = distance;
    t.life = 0;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (!t.active) continue;
      t.head += WEAPON.tracerSpeed * dt;
      t.life += dt;
      if (t.head - WEAPON.tracerLength > t.distance || t.life > 1.2) {
        t.active = false;
        this.hide(i);
        dirty = true;
        continue;
      }
      const tail = Math.max(0, t.head - WEAPON.tracerLength);
      const head = Math.min(t.head, t.distance);
      const len = head - tail;
      if (len <= 0.001) {
        this.hide(i);
        dirty = true;
        continue;
      }
      _pos.copy(t.origin).addScaledVector(t.dir, tail + len * 0.5);
      _q.setFromUnitVectors(_up, t.dir);
      _scale.set(this.thickness, this.thickness, len);
      _m.compose(_pos, _q, _scale);
      this.mesh.setMatrixAt(i, _m);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.tracers.length; i++) {
      this.tracers[i].active = false;
      this.hide(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private hide(i: number): void {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _m);
  }
}
