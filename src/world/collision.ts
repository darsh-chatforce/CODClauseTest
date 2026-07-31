import * as THREE from 'three';

/**
 * Axis-aligned box collision world.
 *
 * The whole compound is boxes, so an AABB world is not a compromise — it is
 * exact, allocation-free and trivially debuggable. Characters are vertical
 * cylinders; elevation change is handled by a step-up rule (boxes whose top is
 * within `stepHeight` of the feet are walkable surfaces, not walls), which is
 * what makes stairs work without any slope maths.
 */

export interface Collider {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Excluded from hitscan (none today; kept so triggers/volumes can be added). */
  noHit?: boolean;
}

export interface RayHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  collider: Collider;
}

export interface GroundResult {
  grounded: boolean;
  /** Surface height under the character, or -Infinity if nothing below. */
  groundY: number;
}

const _tmpMin = new THREE.Vector3();
const _tmpMax = new THREE.Vector3();

export class CollisionWorld {
  readonly boxes: Collider[] = [];

  addBox(center: THREE.Vector3, size: THREE.Vector3, opts: { noHit?: boolean } = {}): Collider {
    const half = size.clone().multiplyScalar(0.5);
    const box: Collider = {
      min: center.clone().sub(half),
      max: center.clone().add(half),
      noHit: opts.noHit,
    };
    this.boxes.push(box);
    return box;
  }

  clear(): void {
    this.boxes.length = 0;
  }

  /**
   * Highest walkable surface under a cylinder footprint.
   * "Walkable" = the box top is at most `stepHeight` above the current feet, so
   * a character can be lifted onto it this frame (stairs, kerbs, crate tops).
   */
  groundHeight(x: number, z: number, radius: number, feetY: number, stepHeight: number): number {
    const ceiling = feetY + stepHeight;
    let best = -Infinity;
    for (const b of this.boxes) {
      if (b.max.y > ceiling || b.max.y <= best) continue;
      const cx = Math.max(b.min.x, Math.min(x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(z, b.max.z));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz <= radius * radius) best = b.max.y;
    }
    return best;
  }

  /**
   * Push a cylinder out of every box it is inside, in place.
   * Three passes so concave corners settle instead of oscillating.
   */
  resolveHorizontal(
    pos: THREE.Vector3,
    radius: number,
    height: number,
    feetY: number,
    stepHeight: number,
  ): void {
    const walkTop = feetY + stepHeight;
    const headY = feetY + height;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const b of this.boxes) {
        if (b.max.y <= walkTop) continue; // steppable surface, not a wall
        if (b.min.y >= headY) continue; // clears the head
        const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;

        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // Centre is inside the rect: escape along the least-penetrating axis.
          const toMinX = pos.x - b.min.x;
          const toMaxX = b.max.x - pos.x;
          const toMinZ = pos.z - b.min.z;
          const toMaxZ = b.max.z - pos.z;
          const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
          if (m === toMinX) pos.x = b.min.x - radius;
          else if (m === toMaxX) pos.x = b.max.x + radius;
          else if (m === toMinZ) pos.z = b.min.z - radius;
          else pos.z = b.max.z + radius;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  /** Is a cylinder free of every wall at this position? (spawn/reposition tests) */
  isClear(x: number, z: number, radius: number, feetY: number, height: number): boolean {
    const headY = feetY + height;
    for (const b of this.boxes) {
      if (b.max.y <= feetY + 0.05) continue;
      if (b.min.y >= headY) continue;
      const cx = Math.max(b.min.x, Math.min(x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(z, b.max.z));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return false;
    }
    return true;
  }

  /** Slab-method ray/AABB over the whole world. Returns the nearest hit. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): RayHit | null {
    let bestT = maxDistance;
    let bestBox: Collider | null = null;
    let bestAxis = 0;
    let bestSign = 1;

    const invX = 1 / (dir.x || 1e-12);
    const invY = 1 / (dir.y || 1e-12);
    const invZ = 1 / (dir.z || 1e-12);

    for (const b of this.boxes) {
      if (b.noHit) continue;
      _tmpMin.copy(b.min);
      _tmpMax.copy(b.max);

      let t0 = (_tmpMin.x - origin.x) * invX;
      let t1 = (_tmpMax.x - origin.x) * invX;
      let axis = 0;
      let sign = invX < 0 ? 1 : -1;
      if (t0 > t1) {
        const s = t0;
        t0 = t1;
        t1 = s;
      }
      let tMin = t0;
      let tMax = t1;

      let u0 = (_tmpMin.y - origin.y) * invY;
      let u1 = (_tmpMax.y - origin.y) * invY;
      const ySign = invY < 0 ? 1 : -1;
      if (u0 > u1) {
        const s = u0;
        u0 = u1;
        u1 = s;
      }
      if (u0 > tMin) {
        tMin = u0;
        axis = 1;
        sign = ySign;
      }
      if (u1 < tMax) tMax = u1;
      if (tMax < tMin) continue;

      let v0 = (_tmpMin.z - origin.z) * invZ;
      let v1 = (_tmpMax.z - origin.z) * invZ;
      const zSign = invZ < 0 ? 1 : -1;
      if (v0 > v1) {
        const s = v0;
        v0 = v1;
        v1 = s;
      }
      if (v0 > tMin) {
        tMin = v0;
        axis = 2;
        sign = zSign;
      }
      if (v1 < tMax) tMax = v1;
      if (tMax < tMin) continue;

      const t = tMin >= 0 ? tMin : tMax;
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      bestBox = b;
      bestAxis = axis;
      bestSign = sign;
    }

    if (!bestBox) return null;
    const normal = new THREE.Vector3();
    normal.setComponent(bestAxis, bestSign);
    return {
      distance: bestT,
      point: origin.clone().addScaledVector(dir, bestT),
      normal,
      collider: bestBox,
    };
  }

  /** Unobstructed line of sight between two points (walls only). */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dir = _losDir.subVectors(to, from);
    const dist = dir.length();
    if (dist < 1e-4) return true;
    dir.multiplyScalar(1 / dist);
    const hit = this.raycast(from, dir, dist - 0.05);
    return hit === null;
  }
}

const _losDir = new THREE.Vector3();

/**
 * Ray vs vertical capsule (segment `base`→`base+height*Y`, radius `r`).
 * Used for enemy hit detection: a capsule reads far better than an AABB when the
 * player is grazing a shoulder, and it costs a dozen flops.
 * Returns the ray distance to the hit, or null.
 */
export function rayCapsule(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  baseX: number,
  baseY: number,
  baseZ: number,
  height: number,
  radius: number,
  maxDistance: number,
): number | null {
  // Infinite-cylinder test in XZ, then clamp against the capsule's Y band and
  // fall back to sphere caps.
  const ox = origin.x - baseX;
  const oz = origin.z - baseZ;
  const a = dir.x * dir.x + dir.z * dir.z;
  let best = Infinity;

  if (a > 1e-9) {
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0 || t > maxDistance || t >= best) continue;
        const y = origin.y + dir.y * t - baseY;
        if (y >= radius && y <= height - radius) best = t;
      }
    }
  }

  // Spherical caps at the bottom and top of the segment.
  for (const capY of [baseY + radius, baseY + height - radius]) {
    const dx = origin.x - baseX;
    const dy = origin.y - capY;
    const dz = origin.z - baseZ;
    const b = 2 * (dx * dir.x + dy * dir.y + dz * dir.z);
    const c = dx * dx + dy * dy + dz * dz - radius * radius;
    const disc = b * b - 4 * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-b - sq) / 2, (-b + sq) / 2]) {
      if (t >= 0 && t <= maxDistance && t < best) best = t;
    }
  }

  return best === Infinity ? null : best;
}

/** Ray vs sphere — the enemy head volume (headshots). */
export function raySphere(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxDistance: number,
): number | null {
  const dx = origin.x - cx;
  const dy = origin.y - cy;
  const dz = origin.z - cz;
  const b = 2 * (dx * dir.x + dy * dir.y + dz * dir.z);
  const c = dx * dx + dy * dy + dz * dz - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / 2;
  const t1 = (-b + sq) / 2;
  const t = t0 >= 0 ? t0 : t1;
  return t >= 0 && t <= maxDistance ? t : null;
}
