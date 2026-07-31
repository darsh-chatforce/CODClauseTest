import * as THREE from 'three';
import { WEAPON } from '../config';
import { clamp, DEG, damp } from '../core/mathx';
import { rng } from '../core/rng';
import type { CollisionWorld } from '../world/collision';
import { rayCapsule, raySphere } from '../world/collision';

/**
 * Hitscan carbine.
 *
 * Everything that makes automatic fire feel like a weapon rather than a
 * damage-per-second dispenser lives here:
 *  - a LEARNABLE recoil PATTERN (not noise) — the first rounds climb, then the
 *    muzzle drifts right and back left, so a player who pulls down is rewarded;
 *  - a retained fraction of recoil (22%) that the player must actively
 *    compensate, with the rest spring-recovering;
 *  - spread bloom that grows per shot and bleeds off, on top of a stance-derived
 *    base spread (ADS ≪ standing < moving < jumping < sprinting);
 *  - a real reload with a duration, a longer empty-mag variant, and a cancel
 *    path, driving both the HUD bar and the viewmodel animation.
 */

export interface HitTarget {
  readonly id: number;
  alive: boolean;
  /** Feet position. */
  readonly position: THREE.Vector3;
  readonly radius: number;
  readonly height: number;
}

export interface WeaponHit {
  target: HitTarget;
  point: THREE.Vector3;
  headshot: boolean;
  damage: number;
}

export interface ShotEvents {
  onShot(origin: THREE.Vector3, dir: THREE.Vector3, distance: number, adsT: number): void;
  onTargetHit(hit: WeaponHit): void;
  onWorldHit(point: THREE.Vector3, normal: THREE.Vector3): void;
  onDryFire(): void;
  onReloadStart(durationMs: number): void;
  onReloadEnd(): void;
}

/** Yaw multipliers per shot index — the gun's signature climb-and-drift. */
const RECOIL_PATTERN = [
  0.0, 0.05, -0.1, 0.2, 0.45, 0.7, 0.85, 0.95, 0.8, 0.4, -0.15, -0.6, -0.9, -1.0, -0.85, -0.5,
  -0.1, 0.3, 0.65, 0.85, 0.9, 0.7, 0.35, -0.05, -0.45, -0.75, -0.9, -0.8, -0.45, 0.0,
];

export type WeaponStance = {
  moving: boolean;
  sprinting: boolean;
  grounded: boolean;
  crouching: boolean;
};

export class Rifle {
  mag: number = WEAPON.magSize;
  reserve: number = WEAPON.startReserve;

  /** 0..1 aim-down-sights blend. */
  adsT = 0;
  adsWanted = false;

  /** Additive view offsets (radians) that spring back to zero. */
  recoilPitch = 0;
  recoilYaw = 0;

  /** Current cone half-angle in degrees. */
  spread: number = WEAPON.spreadBase;
  private bloom = 0;
  private shotIndex = 0;

  private cooldownMs = 0;
  private reloadMsLeft = 0;
  private reloadMsTotal = 0;

  /** Lifetime stats for the end-of-mission card. */
  shotsFired = 0;
  shotsHit = 0;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly events: ShotEvents,
  ) {}

  reset(): void {
    this.mag = WEAPON.magSize;
    this.reserve = WEAPON.startReserve;
    this.adsT = 0;
    this.adsWanted = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bloom = 0;
    this.shotIndex = 0;
    this.cooldownMs = 0;
    this.reloadMsLeft = 0;
    this.reloadMsTotal = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
  }

  get reloading(): boolean {
    return this.reloadMsLeft > 0;
  }

  /** 0..1 while reloading, null otherwise — drives HUD bar + viewmodel anim. */
  get reloadProgress(): number | null {
    if (this.reloadMsLeft <= 0) return null;
    return 1 - this.reloadMsLeft / this.reloadMsTotal;
  }

  get canFire(): boolean {
    return this.mag > 0 && !this.reloading && this.cooldownMs <= 0;
  }

  get accuracy(): number {
    return this.shotsFired === 0 ? 0 : this.shotsHit / this.shotsFired;
  }

  // ------------------------------------------------------------------ input

  startReload(): boolean {
    if (this.reloading || this.reserve <= 0 || this.mag >= WEAPON.magSize) return false;
    this.reloadMsTotal = this.mag === 0 ? WEAPON.reloadEmptyMs : WEAPON.reloadMs;
    this.reloadMsLeft = this.reloadMsTotal;
    this.events.onReloadStart(this.reloadMsTotal);
    return true;
  }

  cancelReload(): void {
    if (this.reloading) {
      this.reloadMsLeft = 0;
      this.reloadMsTotal = 0;
    }
  }

  // ----------------------------------------------------------------- update

  update(dt: number, stance: WeaponStance): void {
    this.cooldownMs = Math.max(0, this.cooldownMs - dt * 1000);

    // ADS blend (ADS is cancelled by sprinting).
    const wantAds = this.adsWanted && !stance.sprinting;
    const step = (dt * 1000) / WEAPON.adsTimeMs;
    this.adsT = clamp(this.adsT + (wantAds ? step : -step), 0, 1);

    // Reload timer.
    if (this.reloadMsLeft > 0) {
      this.reloadMsLeft -= dt * 1000;
      if (this.reloadMsLeft <= 0) {
        const need = WEAPON.magSize - this.mag;
        const taken = Math.min(need, this.reserve);
        this.mag += taken;
        this.reserve -= taken;
        this.reloadMsLeft = 0;
        this.events.onReloadEnd();
      }
    }

    // Recoil spring.
    this.recoilPitch = damp(this.recoilPitch, 0, WEAPON.recoilRecoverTau, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, WEAPON.recoilRecoverTau, dt);

    // Spread: stance base + bloom.
    this.bloom = Math.max(0, this.bloom - WEAPON.spreadRecoverPerSec * dt);
    let base: number;
    if (stance.sprinting) base = WEAPON.spreadSprint;
    else if (!stance.grounded) base = WEAPON.spreadJumping;
    else if (stance.moving) base = WEAPON.spreadMoving;
    else base = WEAPON.spreadBase;
    if (this.adsT > 0) base = base + (WEAPON.spreadAds - base) * this.adsT;
    if (stance.crouching) base *= 0.7;
    this.spread = Math.min(WEAPON.spreadMax, base + this.bloom);

    // The recoil pattern only resets once the player stops shooting.
    if (this.cooldownMs <= 0 && this.bloom <= 0.001) this.shotIndex = 0;
  }

  /**
   * Attempt to fire. Returns true if a round left the barrel.
   * `origin`/`dir` come from the camera; `aimAdjust` receives the recoil the
   * player has to compensate for (applied to their own aim).
   */
  fire(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    targets: readonly HitTarget[],
    aimAdjust: (pitch: number, yaw: number) => void,
  ): boolean {
    if (this.reloading) return false;
    if (this.cooldownMs > 0) return false;
    if (this.mag <= 0) {
      this.cooldownMs = 180;
      this.events.onDryFire();
      return false;
    }

    this.mag--;
    this.cooldownMs = WEAPON.fireIntervalMs;
    this.shotsFired++;

    // ---- direction with spread -------------------------------------------
    const coneRad = this.spread * DEG;
    const shotDir = _dir.copy(dir).normalize();
    if (coneRad > 1e-5) {
      // Uniform in a small cone: pick a perpendicular basis and offset.
      _perpA.set(0, 1, 0);
      if (Math.abs(shotDir.y) > 0.95) _perpA.set(1, 0, 0);
      _perpA.crossVectors(shotDir, _perpA).normalize();
      _perpB.crossVectors(shotDir, _perpA).normalize();
      const angle = rng() * Math.PI * 2;
      const radius = Math.tan(coneRad) * Math.sqrt(rng());
      shotDir
        .addScaledVector(_perpA, Math.cos(angle) * radius)
        .addScaledVector(_perpB, Math.sin(angle) * radius)
        .normalize();
    }

    // ---- resolve the hit ---------------------------------------------------
    const worldHit = this.collision.raycast(origin, shotDir, WEAPON.range);
    const worldDist = worldHit ? worldHit.distance : WEAPON.range;

    let best: WeaponHit | null = null;
    let bestDist = worldDist;
    for (const t of targets) {
      if (!t.alive) continue;
      const headY = t.position.y + t.height - t.radius * 0.62;
      const headT = raySphere(
        origin,
        shotDir,
        t.position.x,
        headY,
        t.position.z,
        t.radius * 0.62,
        bestDist,
      );
      const bodyT = rayCapsule(
        origin,
        shotDir,
        t.position.x,
        t.position.y,
        t.position.z,
        t.height,
        t.radius,
        bestDist,
      );
      const isHead = headT !== null && (bodyT === null || headT <= bodyT + 1e-4);
      const dist = isHead ? headT : bodyT;
      if (dist === null || dist >= bestDist) continue;
      bestDist = dist;
      best = {
        target: t,
        point: origin.clone().addScaledVector(shotDir, dist),
        headshot: isHead,
        damage: WEAPON.damage * (isHead ? WEAPON.headshotMultiplier : 1),
      };
    }

    const travel = best ? bestDist : worldDist;
    this.events.onShot(origin, shotDir, travel, this.adsT);

    if (best) {
      this.shotsHit++;
      this.events.onTargetHit(best);
    } else if (worldHit) {
      this.events.onWorldHit(worldHit.point, worldHit.normal);
    }

    // ---- recoil ------------------------------------------------------------
    const adsScale = 1 - this.adsT * (1 - WEAPON.recoilAdsScale);
    const pat = RECOIL_PATTERN[this.shotIndex % RECOIL_PATTERN.length];
    this.shotIndex++;
    const kickPitch = WEAPON.recoilPitch * adsScale * rng.range(0.85, 1.15);
    const kickYaw = WEAPON.recoilYaw * adsScale * (pat + rng.signed(0.18));

    this.recoilPitch += kickPitch * (1 - WEAPON.recoilRetain);
    this.recoilYaw += kickYaw * (1 - WEAPON.recoilRetain);
    aimAdjust(kickPitch * WEAPON.recoilRetain, kickYaw * WEAPON.recoilRetain);

    this.bloom = Math.min(WEAPON.spreadMax, this.bloom + WEAPON.spreadPerShot);
    return true;
  }
}

const _dir = new THREE.Vector3();
const _perpA = new THREE.Vector3();
const _perpB = new THREE.Vector3();
