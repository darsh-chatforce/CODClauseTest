import * as THREE from 'three';
import { LAYER } from '../config';
import { rng } from '../core/rng';
import { decalTexture, dotTexture } from './textures';

/**
 * Impact feedback: sparks, bullet-hole decals and short-lived world flash
 * lights. All pooled and allocation-free after construction.
 *
 * Rounds that MISS still have to say so — a shooter where only hits produce
 * feedback teaches the player nothing about where their spread went.
 */

const SPARK_CAPACITY = 320;
const DECAL_CAPACITY = 64;
const LIGHT_CAPACITY = 4;

export class ImpactFx {
  // ---- sparks -------------------------------------------------------------
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly sparkPos: Float32Array;
  private readonly sparkVel: Float32Array;
  private readonly sparkLife: Float32Array;
  private sparkNext = 0;

  // ---- decals -------------------------------------------------------------
  private readonly decals: THREE.Mesh[] = [];
  private readonly decalLife: number[] = [];
  private decalNext = 0;

  // ---- lights -------------------------------------------------------------
  private readonly lights: THREE.PointLight[] = [];
  private readonly lightLife: number[] = [];
  private lightNext = 0;

  constructor(scene: THREE.Scene) {
    this.sparkPos = new Float32Array(SPARK_CAPACITY * 3);
    this.sparkVel = new Float32Array(SPARK_CAPACITY * 3);
    this.sparkLife = new Float32Array(SPARK_CAPACITY);
    this.sparkPos.fill(-999);
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));

    const sparkMat = new THREE.PointsMaterial({
      size: 0.09,
      map: dotTexture(),
      color: 0xffc27a,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      fog: false,
    });
    const points = new THREE.Points(this.sparkGeo, sparkMat);
    points.frustumCulled = false;
    points.layers.set(LAYER.WORLD);
    points.renderOrder = 4;
    scene.add(points);

    const decalGeo = new THREE.PlaneGeometry(0.24, 0.24);
    const decalMat = new THREE.MeshBasicMaterial({
      map: decalTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      opacity: 0.9,
    });
    for (let i = 0; i < DECAL_CAPACITY; i++) {
      const m = new THREE.Mesh(decalGeo, decalMat);
      m.visible = false;
      m.layers.set(LAYER.WORLD);
      m.renderOrder = 3;
      scene.add(m);
      this.decals.push(m);
      this.decalLife.push(0);
    }

    for (let i = 0; i < LIGHT_CAPACITY; i++) {
      const l = new THREE.PointLight(0xffb266, 0, 6, 2);
      scene.add(l);
      this.lights.push(l);
      this.lightLife.push(0);
    }
  }

  /** A round hit world geometry: sparks along the normal + a lingering hole. */
  worldHit(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.burst(point, normal, 9, 3.4);
    const idx = this.decalNext;
    this.decalNext = (this.decalNext + 1) % this.decals.length;
    const d = this.decals[idx];
    d.position.copy(point).addScaledVector(normal, 0.012);
    d.lookAt(_tmp.copy(point).add(normal));
    d.rotateZ(rng() * Math.PI);
    d.visible = true;
    d.scale.setScalar(rng.range(0.7, 1.15));
    this.decalLife[idx] = 1;
  }

  /** A round hit an enemy: a tighter, faster, redder burst and no decal. */
  fleshHit(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.burst(point, normal, 12, 2.2);
  }

  /** Brief world light at a muzzle — this is what makes shots read at dusk. */
  muzzleLight(position: THREE.Vector3, intensity = 7): void {
    const i = this.lightNext;
    this.lightNext = (this.lightNext + 1) % this.lights.length;
    this.lights[i].position.copy(position);
    this.lights[i].intensity = intensity;
    this.lightLife[i] = 0.06;
  }

  private burst(point: THREE.Vector3, normal: THREE.Vector3, count: number, speed: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.sparkNext;
      this.sparkNext = (this.sparkNext + 1) % SPARK_CAPACITY;
      this.sparkPos[i * 3] = point.x;
      this.sparkPos[i * 3 + 1] = point.y;
      this.sparkPos[i * 3 + 2] = point.z;
      const jx = rng.signed(1);
      const jy = rng.signed(1);
      const jz = rng.signed(1);
      const s = speed * rng.range(0.35, 1);
      this.sparkVel[i * 3] = (normal.x + jx * 0.85) * s;
      this.sparkVel[i * 3 + 1] = (normal.y + jy * 0.85) * s + 0.6;
      this.sparkVel[i * 3 + 2] = (normal.z + jz * 0.85) * s;
      this.sparkLife[i] = rng.range(0.18, 0.42);
    }
  }

  update(dt: number): void {
    let sparkDirty = false;
    for (let i = 0; i < SPARK_CAPACITY; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      if (this.sparkLife[i] <= 0) {
        this.sparkPos[i * 3 + 1] = -999;
        sparkDirty = true;
        continue;
      }
      this.sparkVel[i * 3 + 1] -= 14 * dt;
      this.sparkPos[i * 3] += this.sparkVel[i * 3] * dt;
      this.sparkPos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
      this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
      sparkDirty = true;
    }
    if (sparkDirty) this.sparkGeo.attributes.position.needsUpdate = true;

    for (let i = 0; i < this.decals.length; i++) {
      if (this.decalLife[i] <= 0) continue;
      this.decalLife[i] -= dt / 14; // decals linger ~14 s
      if (this.decalLife[i] <= 0) this.decals[i].visible = false;
    }

    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightLife[i] <= 0) continue;
      this.lightLife[i] -= dt;
      this.lights[i].intensity = Math.max(0, this.lights[i].intensity - dt * 120);
      if (this.lightLife[i] <= 0) this.lights[i].intensity = 0;
    }
  }

  clear(): void {
    this.sparkLife.fill(0);
    this.sparkPos.fill(-999);
    this.sparkGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < this.decals.length; i++) {
      this.decals[i].visible = false;
      this.decalLife[i] = 0;
    }
    for (const l of this.lights) l.intensity = 0;
  }
}

const _tmp = new THREE.Vector3();
